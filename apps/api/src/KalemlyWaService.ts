import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "node:crypto";
import { Job, Queue, QueueEvents, Worker } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "./prisma";
import { config } from "./config";
import { formatEgyptianPhone } from "./egyptianPhoneFormatter";

const queueName = "kalemlywa-outbound";
const redis = () => new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const sendQueue = new Queue(queueName, { connection: redis() });
const queueEvents = new QueueEvents(queueName, { connection: redis() });
const settingId = "kalemlywa";

export type KalemlyWaMessage = {
  to: string;
  message: string;
  file?: string;
  mediaType?: "image" | "audio" | "document";
};

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
  const settings = await getKalemlySettings();
  if (!settings.authKey || !settings.appKey) throw new Error("أكمل authkey وappkey في إعدادات KalemlyWA أولًا");
  const to = formatEgyptianPhone(input.to);
  const endpoint = new URL(settings.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "whatsapp.kalemly.com") throw new Error("KalemlyWA endpoint must use the verified HTTPS host whatsapp.kalemly.com");
  const headers = { "Content-Type": "application/json" };
  const payload = {
    authkey: settings.authKey,
    appkey: settings.appKey,
    to,
    type: input.file ? input.mediaType || "document" : "text",
    message: input.message,
    ...(input.file ? { file: input.file, media: input.mediaType || "document", media_type: input.mediaType || "document", caption: input.message } : {})
  };
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(45_000) });
  const raw = await response.text();
  let result: any;
  try { result = raw ? JSON.parse(raw) : {}; } catch { result = { responseText: raw }; }
  if (!response.ok) throw new Error(`KalemlyWA رفض الإرسال (${response.status})`);
  if (result?.success === false || result?.status === "error") throw new Error("KalemlyWA لم يؤكد إرسال الرسالة");
  return result;
}

export async function enqueueKalemlyMessage(input: KalemlyWaMessage) {
  const job = await sendQueue.add("send-message", input, {
    delay: randomInt(1500, 3501),
    attempts: 3,
    backoff: { type: "exponential", delay: 2500 },
    removeOnComplete: true,
    removeOnFail: 200
  });
  return job.waitUntilFinished(queueEvents, 300_000);
}

export async function sendKalemlyTest(to: string, message: string) {
  return enqueueKalemlyMessage({ to, message });
}

export function startKalemlyWaWorker() {
  return new Worker<KalemlyWaMessage, any>(queueName, (job: Job<KalemlyWaMessage>) => postMessage(job.data), {
    connection: redis(),
    concurrency: 1,
    limiter: { max: 1, duration: 1500 }
  });
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
  const id = result?.message_id || result?.id || result?.data?.id || result?.messages?.[0]?.id || result?.result?.message_id;
  return id ? String(id) : undefined;
}
