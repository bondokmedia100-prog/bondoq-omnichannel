import { spawn } from "node:child_process";
import { mkdir, rm, chmod } from "node:fs/promises";
import path from "node:path";
import makeWASocket, { DisconnectReason, downloadMediaMessage, useMultiFileAuthState, type WASocket } from "@whiskeysockets/baileys";
import { Channel, MessageKind } from "@prisma/client";
import QRCode from "qrcode";
import { prisma } from "./prisma";
import { config } from "./config";
import { io } from "./realtime";
import { normalizePhoneNumber } from "./egyptianPhoneFormatter";
import { sendPushNotification } from "./pushNotifications";

export type WhatsAppMode = "BAILEYS" | "API";
export type WhatsAppConnectionState = {
  mode: WhatsAppMode;
  status: "DISCONNECTED" | "CONNECTING" | "AWAITING_QR" | "CONNECTED";
  qrDataUrl: string;
  phoneNumber: string;
  accountName: string;
  lastError: string;
};

const settingId = "kalemlywa";
const authDir = path.resolve(process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "data", "whatsapp-auth"));
const inboundMediaLimit = 12 * 1024 * 1024;
const outboundMediaLimit = 32 * 1024 * 1024;
const defaultCallReply = "أهلاً بك، نحن متاحون للرد على رسائلك الكتابية والصوتية هنا فوراً، أو يمكنك الاتصال بنا هاتفياً على رقم خدمة العملاء.";
let socket: WASocket | null = null;
let startPromise: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let stopRequested = false;
let reconnectDelay = 2000;
let callReplyText = defaultCallReply;
const pendingCalls = new Map<string, { callId: string; callerJid: string; phoneNumber: string; conversationId?: string; assignedAgentId?: string; customerName: string; isVideo: boolean; receivedAt: string }>();

let state: WhatsAppConnectionState = {
  mode: "BAILEYS", status: "DISCONNECTED", qrDataUrl: "", phoneNumber: "", accountName: "", lastError: ""
};

function callKey(callId: string, callerJid: string) { return `${callId}:${callerJid}`; }

function emitState() {
  io?.to("admins").emit("whatsapp:status", { ...state });
}

async function saveState(patch: Partial<WhatsAppConnectionState>) {
  state = { ...state, ...patch };
  emitState();
  try {
    await prisma.integrationSetting.upsert({
      where: { id: settingId },
      update: {
        endpoint: config.kalemlyApiUrl,
        whatsappMode: state.mode,
        whatsappConnectionStatus: state.status,
        whatsappPhoneNumber: state.phoneNumber || null
      },
      create: {
        id: settingId,
        endpoint: config.kalemlyApiUrl,
        whatsappMode: state.mode,
        whatsappConnectionStatus: state.status,
        whatsappPhoneNumber: state.phoneNumber || null
      }
    });
  } catch (error) {
    console.warn("Could not persist WhatsApp connection state", error);
  }
}

export async function getWhatsAppMode(): Promise<WhatsAppMode> {
  const setting = await prisma.integrationSetting.findUnique({ where: { id: settingId }, select: { whatsappMode: true } });
  return setting?.whatsappMode === "API" ? "API" : "BAILEYS";
}

export async function getWhatsAppCallReply() {
  const setting = await prisma.integrationSetting.findUnique({ where: { id: settingId }, select: { whatsappCallReplyText: true } });
  return setting?.whatsappCallReplyText || defaultCallReply;
}

export async function saveWhatsAppCallReply(text: string) {
  callReplyText = text.trim() || defaultCallReply;
  await prisma.integrationSetting.upsert({
    where: { id: settingId },
    update: { whatsappCallReplyText: callReplyText },
    create: { id: settingId, endpoint: config.kalemlyApiUrl, whatsappMode: "BAILEYS", whatsappCallReplyText: callReplyText }
  });
  return callReplyText;
}

export function getBaileysWhatsAppState() { return { ...state }; }

export async function setWhatsAppMode(mode: WhatsAppMode) {
  state = { ...state, mode };
  await prisma.integrationSetting.upsert({
    where: { id: settingId },
    update: { endpoint: config.kalemlyApiUrl, whatsappMode: mode },
    create: { id: settingId, endpoint: config.kalemlyApiUrl, whatsappMode: mode }
  });
  if (mode === "API") await stopBaileysWhatsApp();
  else await startBaileysWhatsApp();
  return { mode, state: getBaileysWhatsAppState() };
}

function normalizeJid(value: string) {
  const input = value.trim();
  if (/@(?:s\.whatsapp\.net|lid|g\.us)$/i.test(input)) return input;
  return `${normalizePhoneNumber(input)}@s.whatsapp.net`;
}

function phoneFromJid(value?: string) {
  if (!value) return "";
  const match = value.match(/^([1-9]\d{6,14})@s\.whatsapp\.net$/i);
  return match?.[1] || "";
}

function unwrapMessage(message: any) {
  let content = message?.message || {};
  for (let depth = 0; depth < 5; depth++) {
    const wrapped = content.ephemeralMessage?.message || content.viewOnceMessage?.message || content.viewOnceMessageV2?.message || content.documentWithCaptionMessage?.message;
    if (!wrapped) break;
    content = wrapped;
  }
  return content;
}

async function transcodeVoiceToOgg(buffer: Buffer, contentType: string) {
  const inputFormat = contentType.includes("webm") ? "webm"
    : contentType.includes("mp4") ? "mp4"
      : contentType.includes("wav") ? "wav"
        : contentType.includes("mpeg") ? "mp3"
          : contentType.includes("aac") ? "aac" : "ogg";
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", inputFormat, "-i", "pipe:0", "-vn", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-f", "ogg", "pipe:1"]);
    const chunks: Buffer[] = [];
    let outputSize = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > outboundMediaLimit) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.on("error", (error) => reject(new Error(`Voice-note conversion requires ffmpeg: ${error.message}`)));
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("تعذر تحويل التسجيل الصوتي إلى OGG/Opus")));
    child.stdin.on("error", () => {});
    child.stdin.end(buffer);
  });
}

async function readMediaFile(url: string) {
  const parsed = new URL(url);
  const localHttp = process.env.NODE_ENV !== "production" && parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) throw new Error("يجب أن يكون رابط الوسائط HTTPS");
  const response = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`تعذر تحميل الملف المرفق (${response.status})`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > outboundMediaLimit) throw new Error("حجم الملف يتجاوز الحد المسموح");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > outboundMediaLimit) throw new Error("الملف فارغ أو يتجاوز الحد المسموح");
  return { buffer, contentType: (response.headers.get("content-type") || "application/octet-stream").split(";")[0].toLowerCase() };
}

export async function sendBaileysWhatsAppMessage(input: { to: string; message: string; file?: string; mediaType?: "image" | "audio" | "video" | "document" }) {
  if (!socket || state.status !== "CONNECTED") throw new Error("محرك WhatsApp الداخلي غير متصل. افتح إعدادات واتساب وأعد الاتصال.");
  const jid = normalizeJid(input.to);
  if (!input.file) return socket.sendMessage(jid, { text: input.message || " " });
  const media = await readMediaFile(input.file);
  if (input.mediaType === "image" || media.contentType.startsWith("image/")) {
    return socket.sendMessage(jid, { image: media.buffer, caption: input.message || undefined, mimetype: media.contentType });
  }
  if (input.mediaType === "audio" || media.contentType.startsWith("audio/")) {
    const audio = await transcodeVoiceToOgg(media.buffer, media.contentType);
    return socket.sendMessage(jid, { audio, mimetype: "audio/ogg; codecs=opus", ptt: true });
  }
  if (input.mediaType === "video" || media.contentType.startsWith("video/")) {
    return socket.sendMessage(jid, { video: media.buffer, caption: input.message || undefined, mimetype: media.contentType });
  }
  const fileName = decodeURIComponent(new URL(input.file).pathname.split("/").pop() || "attachment");
  return socket.sendMessage(jid, { document: media.buffer, fileName, mimetype: media.contentType, caption: input.message || undefined });
}

async function handleIncomingMessage(message: any) {
  if (!message?.message || message.key?.fromMe) return;
  const content = unwrapMessage(message);
  const remoteJid = String(message.key?.remoteJid || "");
  if (!remoteJid || remoteJid === "status@broadcast" || remoteJid.endsWith("@g.us")) return;
  const alternateJid = String(message.key?.remoteJidAlt || message.key?.participantAlt || "");
  const phoneNumber = phoneFromJid(alternateJid) || phoneFromJid(remoteJid);
  const externalCustomerId = phoneNumber || remoteJid;
  const audio = content.audioMessage;
  const image = content.imageMessage;
  const video = content.videoMessage;
  const document = content.documentMessage;
  const location = content.locationMessage;
  const extended = content.extendedTextMessage?.text || content.buttonsResponseMessage?.selectedDisplayText || content.templateButtonReplyMessage?.selectedDisplayText;
  const text = content.conversation || extended || image?.caption || video?.caption || document?.caption || audio?.caption || "";
  const kind = location ? MessageKind.LOCATION : image ? MessageKind.IMAGE : video ? MessageKind.VIDEO : audio ? MessageKind.AUDIO : document ? MessageKind.FILE : MessageKind.TEXT;
  const mediaMessage = image || video || audio || document;
  let mediaBuffer: Buffer | undefined;
  let mediaContentType = String(mediaMessage?.mimetype || "application/octet-stream").split(";")[0].toLowerCase();
  if (mediaMessage) {
    mediaBuffer = await downloadMediaMessage(message, "buffer", {});
    if (mediaBuffer.length > inboundMediaLimit) throw new Error("رسالة واتساب الواردة تتجاوز حد التخزين البالغ 12 ميجابايت");
  }
  const id = String(message.key?.id || `${remoteJid}:${Date.now()}`);
  const inbound = {
    channel: Channel.WHATSAPP,
    externalConversationId: remoteJid,
    externalCustomerId,
    ...(phoneNumber ? { customerPhone: phoneNumber } : {}),
    customerName: message.pushName || undefined,
    text: String(text || ""),
    kind,
    latitude: location?.degreesLatitude,
    longitude: location?.degreesLongitude,
    externalId: `baileys:${remoteJid}:${id}`,
    ...(mediaBuffer ? { mediaBuffer, mediaContentType, mediaFileName: String(mediaMessage?.fileName || "") || undefined } : {}),
    metadata: {
      provider: "baileys",
      remoteJid,
      voiceNote: Boolean(audio?.ptt),
      mediaMimeType: mediaContentType,
      messageTimestamp: Number(message.messageTimestamp || 0)
    }
  };
  const { ingestMessage } = await import("./ingestion");
  await ingestMessage(inbound);
}

async function handleIncomingCall(currentSocket: WASocket, call: any) {
  if (call.status !== "offer") {
    const key = callKey(String(call.id), String(call.from));
    const pending = pendingCalls.get(key);
    if (pending) {
      let targets = io?.to("admins");
      if (pending.conversationId) targets = targets?.to(`conversation:${pending.conversationId}`);
      if (pending.assignedAgentId) targets = targets?.to(`agent:${pending.assignedAgentId}`);
      targets?.emit("whatsapp:call-ended", { callId: pending.callId, callerJid: pending.callerJid, status: call.status });
      pendingCalls.delete(key);
    }
    return;
  }
  const callerJid = String(call.from || call.chatId || "");
  if (!callerJid) return;
  const phoneNumber = phoneFromJid(String(call.callerPn || "")) || phoneFromJid(callerJid);
  const ids = [call.chatId, callerJid, phoneNumber].filter((value): value is string => typeof value === "string" && value.length > 0);
  const conversation = ids.length ? await prisma.conversation.findFirst({
    where: { channel: Channel.WHATSAPP, OR: [{ externalConversationId: { in: ids } }, { externalCustomerId: { in: ids } }] },
    include: { customer: { select: { name: true, displayName: true, phone: true } }, assignedAgent: { select: { id: true } } }
  }) : null;
  const callData = {
    callId: String(call.id), callerJid, phoneNumber: phoneNumber || conversation?.customer.phone || "",
    conversationId: conversation?.id,
    assignedAgentId: conversation?.assignedAgent?.id,
    customerName: conversation?.customer.displayName || conversation?.customer.name || phoneNumber || "عميل واتساب",
    isVideo: Boolean(call.isVideo), receivedAt: new Date().toISOString()
  };
  pendingCalls.set(callKey(callData.callId, callerJid), callData);
  io?.to("admins").emit("whatsapp:incoming-call", callData);
  if (conversation?.assignedAgent?.id) io?.to(`agent:${conversation.assignedAgent.id}`).emit("whatsapp:incoming-call", callData);
  else if (conversation?.id) io?.to(`conversation:${conversation.id}`).emit("whatsapp:incoming-call", callData);
  const recipients = conversation?.assignedAgent?.id ? [conversation.assignedAgent.id] : (await prisma.user.findMany({ where: { isActive: true, OR: [{ role: "ADMIN" }, { role: "SUPERVISOR", canViewAllConversations: true }, { role: "SUPERVISOR", canViewAllConversations: null }] }, select: { id: true } })).map((user) => user.id);
  const url = conversation?.assignedAgent?.id ? `/agent/workspace?conversation=${encodeURIComponent(conversation.id)}` : `/admin/dashboard?conversation=${encodeURIComponent(conversation?.id || "")}`;
  void sendPushNotification(recipients, { title: "مكالمة واتساب واردة", body: `${callData.customerName} يتصل الآن`, url, tag: `whatsapp-call-${callData.callId}` }).catch(() => {});
  void currentSocket;
}

function scheduleReconnect(delay = reconnectDelay) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void getWhatsAppMode().then((mode) => {
      if (mode === "BAILEYS") return startBaileysWhatsApp();
    }).catch((error) => console.warn("WhatsApp reconnect check failed", error));
  }, delay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
}

async function startSocket() {
  stopRequested = false;
  reconnectDelay = 2000;
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  await chmod(authDir, 0o700).catch(() => {});
  await saveState({ mode: "BAILEYS", status: "CONNECTING", qrDataUrl: "", lastError: "" });
  const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
  const current = makeWASocket({ auth, printQRInTerminal: false, syncFullHistory: false, markOnlineOnConnect: false, browser: ["Bondoq CRM", "Chrome", "1.0.0"] });
  socket = current;
  current.ev.on("creds.update", saveCreds);
  current.ev.on("connection.update", (update) => {
    void (async () => {
      if (socket !== current) return;
      if (update.qr) {
        const qrDataUrl = await QRCode.toDataURL(update.qr, { width: 300, margin: 2, errorCorrectionLevel: "M" });
        await saveState({ mode: "BAILEYS", status: "AWAITING_QR", qrDataUrl, lastError: "" });
      }
      if (update.connection === "connecting" && !update.qr) await saveState({ status: "CONNECTING", qrDataUrl: "" });
      if (update.connection === "open") {
        const jid = current.user?.id || "";
        const phoneNumber = phoneFromJid(jid) || jid.split(":")[0].split("@")[0];
        await saveState({ mode: "BAILEYS", status: "CONNECTED", qrDataUrl: "", phoneNumber, accountName: current.user?.name || "WhatsApp", lastError: "" });
      }
      if (update.connection === "close") {
        const statusCode = (update.lastDisconnect?.error as any)?.output?.statusCode;
        if (socket === current) socket = null;
        if (stopRequested || state.mode === "API") {
          await saveState({ status: "DISCONNECTED", qrDataUrl: "" });
          return;
        }
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        await saveState({ status: "DISCONNECTED", qrDataUrl: "", phoneNumber: loggedOut ? "" : state.phoneNumber, lastError: loggedOut ? "انتهت جلسة WhatsApp؛ جارٍ إنشاء QR جديد" : "انقطع الاتصال؛ ستتم إعادة المحاولة تلقائيًا" });
        if (loggedOut) await rm(authDir, { recursive: true, force: true }).catch(() => {});
        scheduleReconnect(loggedOut ? 500 : reconnectDelay);
      }
    })().catch((error) => console.warn("WhatsApp connection status update failed", error));
  });
  current.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const message of messages) void handleIncomingMessage(message).catch((error) => console.warn("Baileys inbound message could not be stored", error));
  });
  current.ev.on("call", (calls) => {
    for (const call of calls) void handleIncomingCall(current, call).catch((error) => console.warn("WhatsApp call notification failed", error));
  });
}

export async function startBaileysWhatsApp() {
  if (socket && state.status !== "DISCONNECTED") return getBaileysWhatsAppState();
  if (startPromise) { await startPromise; return getBaileysWhatsAppState(); }
  startPromise = startSocket();
  try { await startPromise; }
  finally { startPromise = null; }
  return getBaileysWhatsAppState();
}

export async function stopBaileysWhatsApp() {
  stopRequested = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const current = socket;
  socket = null;
  if (current) {
    try { current.end(new Error("WhatsApp engine stopped")); } catch {}
  }
  await saveState({ status: "DISCONNECTED", qrDataUrl: "" });
  return getBaileysWhatsAppState();
}

export async function restartBaileysWhatsApp() {
  await stopBaileysWhatsApp();
  return startBaileysWhatsApp();
}

export async function logoutBaileysWhatsApp() {
  stopRequested = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const current = socket;
  socket = null;
  if (current) await current.logout().catch(() => {});
  await rm(authDir, { recursive: true, force: true });
  await saveState({ mode: "BAILEYS", status: "DISCONNECTED", qrDataUrl: "", phoneNumber: "", accountName: "", lastError: "" });
  return getBaileysWhatsAppState();
}

export async function initializeWhatsAppEngine() {
  const setting = await prisma.integrationSetting.findUnique({ where: { id: settingId }, select: { whatsappMode: true, whatsappConnectionStatus: true, whatsappPhoneNumber: true, whatsappCallReplyText: true } });
  callReplyText = setting?.whatsappCallReplyText || defaultCallReply;
  state = { ...state, mode: setting?.whatsappMode === "API" ? "API" : "BAILEYS", status: setting?.whatsappConnectionStatus as WhatsAppConnectionState["status"] || "DISCONNECTED", phoneNumber: setting?.whatsappPhoneNumber || "" };
  if (state.mode === "BAILEYS") await startBaileysWhatsApp();
}

export function getPendingBaileysCall(callId: string, callerJid: string) {
  return pendingCalls.get(callKey(callId, callerJid)) || null;
}

export async function rejectBaileysCall(callId: string, callerJid: string) {
  const pending = getPendingBaileysCall(callId, callerJid);
  if (!pending) throw new Error("المكالمة لم تعد واردة أو انتهت بالفعل");
  if (!socket || state.status !== "CONNECTED") throw new Error("انقطع اتصال WhatsApp قبل رفض المكالمة");
  await socket.rejectCall(callId, callerJid);
  pendingCalls.delete(callKey(callId, callerJid));
  let targets = io?.to("admins");
  if (pending.conversationId) targets = targets?.to(`conversation:${pending.conversationId}`);
  if (pending.assignedAgentId) targets = targets?.to(`agent:${pending.assignedAgentId}`);
  targets?.emit("whatsapp:call-ended", { callId, callerJid, status: "reject" });
  return pending;
}

export { defaultCallReply };
