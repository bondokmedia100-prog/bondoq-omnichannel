import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Job, Queue, QueueEvents, Worker } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "./prisma";
import { config } from "./config";
import { normalizePhoneNumber } from "./egyptianPhoneFormatter";
import { io } from "./realtime";
import { getWhatsAppMode, sendBaileysWhatsAppMessage } from "./BaileysWhatsAppService";
import { serializeBaileysMessageKey } from "./baileysMessageKey";

const queueName = "kalemlywa-outbound";
const redis = () => new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const sendQueue = new Queue(queueName, { connection: redis() });
const queueEvents = new QueueEvents(queueName, { connection: redis() });
const settingId = "kalemlywa";

export type KalemlyWaMessage = {
  to: string;
  message: string;
  file?: string;
  mediaType?: "image" | "audio" | "video" | "document" | "sticker";
  pollOptions?: string[];
};

type QueuedKalemlyWaMessage = KalemlyWaMessage & { outboundMessageId?: string };

export function encryptKalemlySecret(value: string): string {
  const key = createHash("sha256").update(config.kalemlyEncryptionKey).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptKalemlySecret(value: string): string {
  const [ivHex, tagHex, ciphertextHex] = value.split(":");
  const key = createHash("sha256").update(config.kalemlyEncryptionKey).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]).toString("utf8");
}

function parseKalemlyCredentials(value: string) {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.authKey === "string" && typeof parsed.appKey === "string") return parsed as { authKey: string; appKey: string };
  } catch {}
  return { authKey: value, appKey: value };
}

export async function getKalemlySettings() {
  const saved = await prisma.integrationSetting.findUnique({ where: { id: settingId } });
  const credentials = saved?.apiKeyCiphertext ? parseKalemlyCredentials(decryptKalemlySecret(saved.apiKeyCiphertext)) : null;
  return {
    endpoint: saved?.endpoint || config.kalemlyApiUrl,
    authKey: credentials?.authKey || config.kalemlyAuthKey,
    appKey: credentials?.appKey || config.kalemlyAppKey,
    qrCodePayload: saved?.qrCodePayloadCiphertext ? decryptKalemlySecret(saved.qrCodePayloadCiphertext) : ""
  };
}

export async function saveKalemlySettings(input: { authKey?: string; appKey?: string; qrCodePayload?: string; clearQrCode?: boolean }) {
  const current = await getKalemlySettings();
  const authKey = input.authKey?.trim() || current.authKey;
  const appKey = input.appKey?.trim() || current.appKey;
  const credentialsCiphertext = authKey || appKey ? encryptKalemlySecret(JSON.stringify({ authKey, appKey })) : null;
  await prisma.integrationSetting.upsert({
    where: { id: settingId },
    update: {
      endpoint: config.kalemlyApiUrl,
      ...(credentialsCiphertext ? { apiKeyCiphertext: credentialsCiphertext } : {}),
      ...(input.clearQrCode ? { qrCodePayloadCiphertext: null } : input.qrCodePayload === undefined ? {} : { qrCodePayloadCiphertext: input.qrCodePayload.trim() ? encryptKalemlySecret(input.qrCodePayload.trim()) : null })
    },
    create: {
      id: settingId,
      endpoint: config.kalemlyApiUrl,
      apiKeyCiphertext: credentialsCiphertext,
      qrCodePayloadCiphertext: input.qrCodePayload?.trim() ? encryptKalemlySecret(input.qrCodePayload.trim()) : null
    }
  });
  return getKalemlySettings();
}

async function postMessage(input: KalemlyWaMessage) {
  if (await getWhatsAppMode() === "BAILEYS") return sendBaileysWhatsAppMessage(input);
  if (input.pollOptions?.length) throw new Error("استطلاعات WhatsApp غير مدعومة عبر تكامل API الحالي");
  if (input.mediaType === "sticker") throw new Error("ملصقات WhatsApp غير مدعومة عبر تكامل API الحالي");
  const settings = await getKalemlySettings();
  if (!settings.authKey || !settings.appKey) throw new Error("أكمل authkey وappkey في إعدادات KalemlyWA أولًا");
  const to = normalizePhoneNumber(input.to);
  const endpoint = new URL(settings.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "whatsapp.kalemly.com") throw new Error("KalemlyWA endpoint must use the verified HTTPS host whatsapp.kalemly.com");
  const headers = { "Content-Type": "application/json" };
  const payload = {
    authkey: settings.authKey,
    appkey: settings.appKey,
    to,
    type: input.file ? input.mediaType || "document" : "text",
    message: input.message,
    ...(input.file ? { media_url: input.file } : {})
  };
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(45_000) });
  const raw = await response.text();
  let result: any;
  try { result = raw ? JSON.parse(raw) : {}; } catch { result = { responseText: raw }; }
  if (!response.ok) {
    let detail = JSON.stringify(safeProviderResponse(result)) || "no response body";
    for (const sensitive of [settings.authKey, settings.appKey, to, input.file].filter(Boolean)) {
      detail = detail.replaceAll(sensitive!, "[redacted]");
    }
    throw new Error(`KalemlyWA رفض الإرسال (${response.status}): ${detail.slice(0, 1000)}`);
  }
  if (result?.success === false || result?.status === "error") throw new Error("KalemlyWA لم يؤكد إرسال الرسالة");
  return result;
}

export async function enqueueKalemlyMessage(input: KalemlyWaMessage, outboundMessageId?: string) {
  const job = await sendQueue.add("send-message", {
    ...input,
    ...(outboundMessageId ? { outboundMessageId } : {})
  }, {
    delay: 0,
    attempts: 3,
    backoff: { type: "exponential", delay: 2500 },
    removeOnComplete: true,
    removeOnFail: 200
  });
  if (outboundMessageId) return { queued: true, jobId: String(job.id) };
  return job.waitUntilFinished(queueEvents, 300_000);
}

export async function sendKalemlyTest(to: string, message: string) {
  return enqueueKalemlyMessage({ to, message });
}

export function startKalemlyWaWorker() {
  const worker = new Worker<QueuedKalemlyWaMessage, any>(queueName, async (job: Job<QueuedKalemlyWaMessage>) => {
    const { outboundMessageId, ...payload } = job.data;
    const result = await postMessage(payload);
    if (outboundMessageId) await persistQueuedDelivery(outboundMessageId, "SENT", result);
    return result;
  }, {
    connection: redis(),
    concurrency: 1,
    limiter: { max: 1, duration: 1500 }
  });
  worker.on("failed", (job, error) => {
    if (!job?.data.outboundMessageId || job.attemptsMade < Number(job.opts.attempts || 1)) return;
    void persistQueuedDelivery(job.data.outboundMessageId, "FAILED").catch(() => {});
    console.error("Queued WhatsApp delivery failed", job.id, error);
  });
  return worker;
}

async function persistQueuedDelivery(messageId: string, deliveryStatus: "SENT" | "FAILED", result?: any) {
  const providerId = deliveryStatus === "SENT" ? kalemlyExternalMessageId(result) : undefined;
  try {
    await prisma.message.update({ where: { id: messageId }, data: {
      deliveryStatus,
      ...(providerId ? { externalId: `WHATSAPP:${providerId}` } : {})
    } });
  } catch (error) {
    if (providerId && (error as { code?: string }).code === "P2002") {
      try { await prisma.message.update({ where: { id: messageId }, data: { deliveryStatus } }); }
      catch (updateError) { console.warn("Could not persist queued WhatsApp delivery state", updateError); return; }
    } else {
      console.warn("Could not persist queued WhatsApp delivery state", error);
      return;
    }
  }
  const message = await prisma.message.findUnique({ where: { id: messageId }, include: { author: { select: { id: true, name: true } } } });
  if (!message) return;
  if (deliveryStatus === "SENT") {
    const conversation = await prisma.conversation.findUnique({ where: { id: message.conversationId }, select: { status: true, lastMessageAt: true, firstResponseAt: true } });
    if (conversation && conversation.status !== "CLOSED" && conversation.status !== "RESOLVED") {
      const deliveredAt = new Date();
      await prisma.conversation.update({ where: { id: message.conversationId }, data: {
        ...(message.createdAt > conversation.lastMessageAt ? { lastMessageAt: message.createdAt } : {}),
        lastAgentResponseAt: deliveredAt,
        firstResponseAt: conversation.firstResponseAt || deliveredAt,
        slaBreachedAt: null,
        ...(conversation.status === "QUEUED" ? { status: "OPEN" } : {})
      } });
    }
  }
  io?.to(`conversation:${message.conversationId}`).to("admins").emit("message:new", { conversationId: message.conversationId, message });
  if (message.authorId) io?.to(`agent:${message.authorId}`).emit("message:new", { conversationId: message.conversationId, message });
}

export function safeProviderResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeProviderResponse);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [/api.?key|appkey|authkey|authorization|token|secret/i.test(key) ? "credential" : key, /api.?key|appkey|authkey|authorization|token|secret/i.test(key) ? "[redacted]" : safeProviderResponse(item)]
    ));
  }
  return value;
}

export function kalemlyExternalMessageId(result: any): string | undefined {
  const baileysKey = serializeBaileysMessageKey(result?.key);
  if (baileysKey) return baileysKey;
  const id = result?.message_id || result?.id || result?.key?.id || result?.data?.id || result?.messages?.[0]?.id || result?.result?.message_id;
  return id ? String(id) : undefined;
}
