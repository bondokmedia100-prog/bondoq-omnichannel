import { spawn } from "node:child_process";
import { mkdir, rm, chmod, readdir } from "node:fs/promises";
import path from "node:path";
import makeWASocket, { DisconnectReason, downloadMediaMessage, useMultiFileAuthState, type WASocket } from "@whiskeysockets/baileys";
import { Channel, ConversationBotState, ConversationStatus, Department, MessageKind } from "@prisma/client";
import QRCode from "qrcode";
import { prisma } from "./prisma";
import { config } from "./config";
import { io } from "./realtime";
import { normalizePhoneNumber } from "./egyptianPhoneFormatter";
import { sendPushNotification } from "./pushNotifications";
import { repacketizeOggOpusToCode3 } from "./oggOpus";
import { assignConversation, withInboundConversationLock } from "./routing";
import { parseStoredBaileysMessageKey, serializeBaileysMessageKey } from "./baileysMessageKey";

process.umask(0o077);

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
const profilePictureCache = new Map<string, { url: string | undefined; expiresAt: number }>();
const profilePictureRequests = new Map<string, Promise<string | undefined>>();
const groupSubjectCache = new Map<string, { subject: string; expiresAt: number }>();

export type BaileysWhatsAppGroup = {
  id: string;
  subject: string;
  participants: Array<{ id: string; phone: string | null; admin: string | null }>;
};

let state: WhatsAppConnectionState = {
  mode: "BAILEYS", status: "DISCONNECTED", qrDataUrl: "", phoneNumber: "", accountName: "", lastError: ""
};

function callKey(callId: string, callerJid: string) { return `${callId}:${callerJid}`; }

async function getProfilePictureUrl(currentSocket: WASocket, jid: string) {
  const cached = profilePictureCache.get(jid);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const pending = profilePictureRequests.get(jid);
  if (pending) return pending;

  let request: Promise<string | undefined>;
  request = Promise.resolve().then(() => currentSocket.profilePictureUrl(jid, "image")).then((url) => {
    if (!url) return undefined;
    return new URL(url).protocol === "https:" ? url : undefined;
  }).catch(() => undefined).then((url) => {
    profilePictureCache.set(jid, { url, expiresAt: Date.now() + (url ? 30 * 60_000 : 5 * 60_000) });
    if (profilePictureCache.size > 1000) profilePictureCache.delete(profilePictureCache.keys().next().value!);
    return url;
  }).finally(() => {
    if (profilePictureRequests.get(jid) === request) profilePictureRequests.delete(jid);
  });
  profilePictureRequests.set(jid, request);
  return request;
}

async function customerProfilePicture(currentSocket: WASocket, remoteJid: string, phoneNumber: string) {
  const remotePicture = await getProfilePictureUrl(currentSocket, remoteJid);
  if (remotePicture || !phoneNumber) return remotePicture;
  return getProfilePictureUrl(currentSocket, normalizeJid(phoneNumber));
}

async function refreshRecentCustomerProfilePictures(currentSocket: WASocket) {
  const conversations = await prisma.conversation.findMany({
    where: { channel: Channel.WHATSAPP, customer: { is: { avatarUrl: null } } },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
    select: { id: true, externalConversationId: true, externalCustomerId: true, assignedAgentId: true, customer: { select: { id: true, phone: true } } }
  });
  let adminUpdate: { conversationId: string; customer: { id: string; avatarUrl: string } } | undefined;
  const agentUpdates = new Map<string, { conversationId: string; customer: { id: string; avatarUrl: string } }>();
  for (const conversation of conversations) {
    if (socket !== currentSocket || state.status !== "CONNECTED") return;
    const phoneNumber = phoneFromJid(conversation.externalCustomerId) || conversation.customer.phone || "";
    const avatarUrl = await customerProfilePicture(currentSocket, conversation.externalConversationId, phoneNumber);
    if (!avatarUrl) continue;
    const saved = await prisma.customer.updateMany({ where: { id: conversation.customer.id, avatarUrl: null }, data: { avatarUrl } });
    if (!saved.count) continue;
    const update = { conversationId: conversation.id, customer: { id: conversation.customer.id, avatarUrl } };
    adminUpdate ||= update;
    if (conversation.assignedAgentId && !agentUpdates.has(conversation.assignedAgentId)) agentUpdates.set(conversation.assignedAgentId, update);
  }
  if (adminUpdate) io?.to("admins").emit("customer:updated", adminUpdate);
  for (const [agentId, update] of agentUpdates) io?.to(`agent:${agentId}`).emit("customer:updated", update);
}

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

function connectedBaileysSocket() {
  if (!socket || state.mode !== "BAILEYS" || state.status !== "CONNECTED") throw new Error("إدارة جروبات WhatsApp متاحة فقط عند اتصال Baileys");
  return socket;
}

function groupInfo(metadata: any): BaileysWhatsAppGroup {
  return {
    id: String(metadata.id || ""),
    subject: String(metadata.subject || "مجموعة WhatsApp"),
    participants: (Array.isArray(metadata.participants) ? metadata.participants : []).flatMap((participant: any) => {
      const id = String(participant.id || participant.phoneNumber || "");
      const phone = String(participant.phoneNumber || (id.endsWith("@s.whatsapp.net") ? id : "")) || null;
      return id ? [{ id, phone, admin: participant.admin === "superadmin" || participant.admin === "admin" ? participant.admin : null }] : [];
    })
  };
}

export async function listBaileysWhatsAppGroups() {
  const currentSocket = connectedBaileysSocket();
  const groups = await currentSocket.groupFetchAllParticipating();
  return Object.values(groups).map(groupInfo).filter((group) => group.id.endsWith("@g.us"));
}

export async function getBaileysWhatsAppGroup(groupId: string) {
  const currentSocket = connectedBaileysSocket();
  if (!groupId.endsWith("@g.us")) throw new Error("معرّف مجموعة WhatsApp غير صالح");
  return groupInfo(await currentSocket.groupMetadata(groupId));
}

export async function createBaileysWhatsAppGroup(subject: string, participants: string[]) {
  const currentSocket = connectedBaileysSocket();
  const result = await currentSocket.groupCreate(subject, participants.map(normalizeJid));
  return groupInfo(result);
}

export async function updateBaileysWhatsAppGroupParticipants(groupId: string, participants: string[], action: "add" | "remove" | "promote" | "demote") {
  const currentSocket = connectedBaileysSocket();
  if (!groupId.endsWith("@g.us")) throw new Error("معرّف مجموعة WhatsApp غير صالح");
  await currentSocket.groupParticipantsUpdate(groupId, participants.map(normalizeJid), action);
  return getBaileysWhatsAppGroup(groupId);
}

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

function baileysMessageKey(input: { recipient: string; externalId: string; direction: "INBOUND" | "OUTBOUND" }) {
  const storedKey = parseStoredBaileysMessageKey(input.externalId, input.direction);
  if (storedKey) return storedKey;
  const raw = input.externalId.replace(/^WHATSAPP:/, "");
  if (raw.startsWith("baileys-key:")) throw new Error("معرّف مفتاح رسالة WhatsApp غير صالح");
  return { remoteJid: normalizeJid(input.recipient), id: raw, fromMe: input.direction === "OUTBOUND" };
}

export async function editBaileysWhatsAppMessage(input: { recipient: string; externalId: string; text: string }) {
  if (!socket || state.mode !== "BAILEYS" || state.status !== "CONNECTED") throw new Error("تعديل الرسائل متاح فقط عند اتصال WhatsApp بوضع Baileys");
  const key = baileysMessageKey({ ...input, direction: "OUTBOUND" });
  if (!key.id) throw new Error("معرّف رسالة WhatsApp غير صالح");
  return socket.sendMessage(key.remoteJid, { text: input.text, edit: key as any });
}

export async function deleteBaileysWhatsAppMessage(input: { recipient: string; externalId: string }) {
  if (!socket || state.mode !== "BAILEYS" || state.status !== "CONNECTED") throw new Error("حذف الرسائل متاح فقط عند اتصال WhatsApp بوضع Baileys");
  const key = baileysMessageKey({ ...input, direction: "OUTBOUND" });
  if (!key.id) throw new Error("معرّف رسالة WhatsApp غير صالح");
  return socket.sendMessage(key.remoteJid, { delete: key as any });
}

export async function reactToBaileysWhatsAppMessage(input: { recipient: string; externalId: string; direction: "INBOUND" | "OUTBOUND"; emoji: string }) {
  if (!socket || state.mode !== "BAILEYS" || state.status !== "CONNECTED") throw new Error("تفاعلات WhatsApp متاحة فقط عند اتصال WhatsApp بوضع Baileys");
  const key = baileysMessageKey(input);
  if (!key.id) throw new Error("معرّف رسالة WhatsApp غير صالح");
  return socket.sendMessage(key.remoteJid, { react: { text: input.emoji, key: key as any } });
}

export async function markBaileysMessagesRead(externalIds: string[]) {
  if (!socket || state.mode !== "BAILEYS" || state.status !== "CONNECTED") return;
  const keys = externalIds.flatMap((externalId) => {
    if (!externalId.startsWith("WHATSAPP:baileys:")) return [];
    const value = externalId.slice("WHATSAPP:baileys:".length);
    const split = value.lastIndexOf(":");
    return split > 0 && split < value.length - 1 ? [{ remoteJid: value.slice(0, split), id: value.slice(split + 1), fromMe: false }] : [];
  });
  if (keys.length) await socket.readMessages(keys as any);
}

async function persistBaileysReceipt(update: any) {
  const key = update?.key;
  const id = String(key?.id || "");
  const remoteJid = String(key?.remoteJid || "");
  if (!id || !remoteJid) return;
  const receipt = update.receipt || update.update || {};
  const statusValue = update.update?.status ?? update.status;
  const statusText = String(statusValue || "").toUpperCase();
  const statusNumber = Number(statusValue);
  const deliveryStatus = receipt.readTimestamp || statusNumber >= 4 || statusText.includes("READ") ? "READ"
    : receipt.receiptTimestamp || statusNumber >= 3 || statusText.includes("DELIVERY_ACK") || statusText.includes("DELIVERED") ? "DELIVERED" : null;
  if (!deliveryStatus) return;
  const storedKey = serializeBaileysMessageKey({ remoteJid, id, fromMe: true });
  const storedIds = [`WHATSAPP:${id}`, `WHATSAPP:baileys:${remoteJid}:${id}`, ...(storedKey ? [`WHATSAPP:${storedKey}`] : [])];
  const message = await prisma.message.findFirst({ where: { externalId: { in: storedIds }, direction: "OUTBOUND" }, select: { id: true, conversationId: true, deliveryStatus: true } });
  if (!message || message.deliveryStatus === "READ" || message.deliveryStatus === deliveryStatus) return;
  const saved = await prisma.message.update({ where: { id: message.id }, data: { deliveryStatus } });
  io?.to(`conversation:${message.conversationId}`).to("admins").emit("message:status", { conversationId: message.conversationId, message: saved });
}

function phoneFromJid(value?: string) {
  if (!value) return "";
  const match = value.match(/^([1-9]\d{6,14})@s\.whatsapp\.net$/i);
  return match?.[1] || "";
}

async function syncWhatsAppContacts(currentSocket: WASocket, contacts: any[]) {
  if (!Array.isArray(contacts) || !contacts.length) return;
  let synced = 0;
  for (let offset = 0; offset < contacts.length; offset += 50) {
    if (socket !== currentSocket) return;
    const batch = contacts.slice(offset, offset + 50);
    const results = await Promise.allSettled(batch.map(async (contact) => {
      const jid = String(contact?.id || contact?.jid || "").trim();
      if (!jid || jid === "status@broadcast" || /@(?:g\.us|newsletter)$/i.test(jid)) return false;
      const phoneValue = [contact?.phoneNumber, contact?.phone, jid].find((value) => typeof value === "string" && value.trim());
      let phone = "";
      if (phoneValue) {
        try { phone = normalizePhoneNumber(String(phoneValue)); }
        catch { phone = phoneFromJid(jid); }
      }
      const externalCustomerId = phone || (/@lid$/i.test(jid) ? jid : "");
      if (!externalCustomerId) return false;
      const name = [contact?.name, contact?.verifiedName, contact?.notify].find((value) => typeof value === "string" && value.trim())?.trim();
      const id = `external_whatsapp_${externalCustomerId}`;
      await prisma.customer.upsert({
        where: { id },
        create: { id, name: name || null, phone: phone || null, channelIdentifiers: { whatsapp: externalCustomerId } },
        update: { ...(name ? { name } : {}), ...(phone ? { phone } : {}), channelIdentifiers: { whatsapp: externalCustomerId } },
        select: { id: true }
      });
      return true;
    }));
    synced += results.filter((result) => result.status === "fulfilled" && result.value).length;
    results.filter((result) => result.status === "rejected").forEach((result) => console.warn("WhatsApp contact could not be synchronized", result.reason));
  }
  if (synced) console.info("WhatsApp contacts synchronized", { received: contacts.length, synced });
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

export async function transcodeVoiceToOgg(buffer: Buffer, contentType: string) {
  const inputFormat = contentType.includes("webm") ? "webm"
    : contentType.includes("mp4") ? "mp4"
      : contentType.includes("wav") ? "wav"
        : contentType.includes("mpeg") ? "mp3"
          : contentType.includes("aac") ? "aac" : "ogg";
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", inputFormat, "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-frame_duration", "20", "-f", "ogg", "pipe:1"]);
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

export async function sendBaileysWhatsAppMessage(input: { to: string; message: string; file?: string; mediaType?: "image" | "audio" | "video" | "document" | "sticker"; pollOptions?: string[]; contactCard?: { name: string; phone: string } }) {
  if (!socket || state.status !== "CONNECTED") throw new Error("محرك WhatsApp الداخلي غير متصل. افتح إعدادات واتساب وأعد الاتصال.");
  const jid = normalizeJid(input.to);
  if (input.contactCard) {
    const phone = normalizePhoneNumber(input.contactCard.phone);
    const name = input.contactCard.name.trim().replace(/[\r\n]+/g, " ");
    const vcardText = (value: string) => value.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\r?\n/g, "\\n");
    const vcard = ["BEGIN:VCARD", "VERSION:3.0", `N:;${vcardText(name)};;;`, `FN:${vcardText(name)}`, `TEL;type=CELL;type=VOICE;waid=${phone}:+${phone}`, "END:VCARD"].join("\n");
    return socket.sendMessage(jid, { contacts: { displayName: name, contacts: [{ displayName: name, vcard }] } });
  }
  if (input.pollOptions?.length) {
    if (input.pollOptions.length < 2 || input.pollOptions.length > 10) throw new Error("يجب أن يحتوي الاستطلاع على خيارين إلى عشرة خيارات");
    return socket.sendMessage(jid, { poll: { name: input.message, values: input.pollOptions, selectableCount: 1 } });
  }
  if (!input.file) return socket.sendMessage(jid, { text: input.message || " " });
  const media = await readMediaFile(input.file);
  if (input.mediaType === "sticker") {
    if (media.contentType !== "image/webp") throw new Error("يجب أن يكون الملصق بصيغة WebP");
    return socket.sendMessage(jid, { sticker: media.buffer });
  }
  if (input.mediaType === "image" || media.contentType.startsWith("image/")) {
    return socket.sendMessage(jid, { image: media.buffer, caption: input.message || undefined, mimetype: media.contentType });
  }
  if (input.mediaType === "audio" || media.contentType.startsWith("audio/")) {
    const audio = repacketizeOggOpusToCode3(await transcodeVoiceToOgg(media.buffer, media.contentType));
    return socket.sendMessage(jid, { audio, mimetype: "audio/ogg; codecs=opus", ptt: true });
  }
  if (input.mediaType === "video" || media.contentType.startsWith("video/")) {
    return socket.sendMessage(jid, { video: media.buffer, caption: input.message || undefined, mimetype: media.contentType });
  }
  const fileName = decodeURIComponent(new URL(input.file).pathname.split("/").pop() || "attachment");
  return socket.sendMessage(jid, { document: media.buffer, fileName, mimetype: media.contentType, caption: input.message || undefined });
}

async function handleIncomingMessage(message: any, historySync = false) {
  if (!message?.message || (!historySync && message.key?.fromMe)) return;
  const content = unwrapMessage(message);
  const remoteJid = String(message.key?.remoteJid || "");
  if (!remoteJid || remoteJid === "status@broadcast") return;
  const isGroup = remoteJid.endsWith("@g.us");
  const currentSocket = socket;
  let groupSubject = "مجموعة WhatsApp";
  if (isGroup && currentSocket && state.status === "CONNECTED") {
    const cached = groupSubjectCache.get(remoteJid);
    if (cached && cached.expiresAt > Date.now()) groupSubject = cached.subject;
    else {
      try {
        groupSubject = String((await currentSocket.groupMetadata(remoteJid)).subject || groupSubject);
        groupSubjectCache.set(remoteJid, { subject: groupSubject, expiresAt: Date.now() + 5 * 60_000 });
      } catch {}
    }
  }
  const alternateJid = String(message.key?.remoteJidAlt || message.key?.participantAlt || "");
  const participantJid = String(message.key?.participant || message.key?.participantAlt || "");
  const phoneNumber = isGroup ? "" : phoneFromJid(alternateJid) || phoneFromJid(remoteJid);
  const externalCustomerId = isGroup ? remoteJid : phoneNumber || remoteJid;
  const profilePictureUrl = !historySync && !isGroup && currentSocket && state.status === "CONNECTED"
    ? await customerProfilePicture(currentSocket, remoteJid, phoneNumber)
    : undefined;
  const audio = content.audioMessage;
  const image = content.imageMessage;
  const video = content.videoMessage;
  const document = content.documentMessage;
  const sticker = content.stickerMessage;
  const poll = content.pollCreationMessageV3 || content.pollCreationMessageV2 || content.pollCreationMessage;
  const location = content.locationMessage;
  const extended = content.extendedTextMessage?.text || content.buttonsResponseMessage?.selectedDisplayText || content.templateButtonReplyMessage?.selectedDisplayText;
  const text = content.conversation || extended || poll?.name || image?.caption || video?.caption || document?.caption || audio?.caption || "";
  const kind = location ? MessageKind.LOCATION : poll ? MessageKind.POLL : sticker ? MessageKind.STICKER : image ? MessageKind.IMAGE : video ? MessageKind.VIDEO : audio ? MessageKind.AUDIO : document ? MessageKind.FILE : MessageKind.TEXT;
  const mediaMessage = image || video || audio || document || sticker;
  const id = String(message.key?.id || "");
  const externalId = message.key?.fromMe
    ? serializeBaileysMessageKey(message.key) || `baileys:${remoteJid}:${id}`
    : `baileys:${remoteJid}:${id}`;
  if (historySync) {
    if (!id || !text && !mediaMessage && !location && !poll) return;
    const storedIds = [`WHATSAPP:${externalId}`, ...(message.key?.fromMe ? [`WHATSAPP:${id}`] : [])];
    const duplicate = await prisma.message.findFirst({ where: { externalId: { in: storedIds }, ...(message.key?.fromMe ? { direction: "OUTBOUND" } : {}) }, select: { id: true } });
    if (duplicate) return;
  }
  const timestampSeconds = Number(message.messageTimestamp || 0);
  const messageTimestamp = timestampSeconds > 0 && timestampSeconds < Date.now() / 1000 + 300
    ? new Date(timestampSeconds * 1000) : undefined;
  let mediaBuffer: Buffer | undefined;
  let mediaContentType = String(mediaMessage?.mimetype || "application/octet-stream").split(";")[0].toLowerCase();
  if (mediaMessage) {
    const currentSocket = socket;
    const retrieval = currentSocket ? {
      reuploadRequest: (staleMessage: any) => currentSocket.updateMediaMessage(staleMessage),
      logger: { info: () => undefined } as any
    } : undefined;
    try {
      mediaBuffer = Buffer.from(await downloadMediaMessage(message, "buffer", {}, retrieval));
      if (!mediaBuffer.length) throw new Error("WhatsApp returned an empty media file");
      if (mediaBuffer.length > inboundMediaLimit) throw new Error("رسالة واتساب الواردة تتجاوز حد التخزين البالغ 12 ميجابايت");
    } catch (error) {
      if (!historySync) throw error;
      console.warn("Historical WhatsApp media is unavailable", error);
    }
  }
  const inbound = {
    channel: Channel.WHATSAPP,
    externalConversationId: remoteJid,
    externalCustomerId,
    ...(phoneNumber ? { customerPhone: phoneNumber } : {}),
    customerName: isGroup ? groupSubject : message.pushName || undefined,
    profilePictureUrl,
    text: String(text || ""),
    kind,
    latitude: location?.degreesLatitude,
    longitude: location?.degreesLongitude,
    externalId: id ? externalId : `baileys:${remoteJid}:${Date.now()}`,
    ...(historySync ? { direction: message.key?.fromMe ? "OUTBOUND" as const : "INBOUND" as const, isHistorySync: true, ...(messageTimestamp ? { messageTimestamp } : {}) } : {}),
    ...(mediaBuffer ? { mediaBuffer, mediaContentType, mediaFileName: String(mediaMessage?.fileName || "") || undefined } : {}),
    metadata: {
      provider: "baileys",
      remoteJid,
      ...(historySync ? { historySync: true } : {}),
      ...(isGroup ? {
        isWhatsAppGroup: true,
        groupSubject,
        groupParticipantJid: participantJid,
        groupParticipantPhone: phoneFromJid(String(message.key?.participantAlt || participantJid)) || undefined,
        groupParticipantName: String(message.pushName || "") || undefined
      } : {}),
      voiceNote: Boolean(audio?.ptt),
      mediaMimeType: mediaContentType,
      pollOptions: Array.isArray(poll?.options) ? poll.options.map((option: any) => String(option.optionName || option.name || "")).filter(Boolean) : undefined,
      messageTimestamp: timestampSeconds
    }
  };
  const { ingestMessage } = await import("./ingestion");
  return ingestMessage(inbound);
}

async function syncWhatsAppHistory(currentSocket: WASocket, messages: any[]) {
  if (!Array.isArray(messages) || !messages.length) return;
  const conversationIds = new Set<string>();
  for (let offset = 0; offset < messages.length; offset += 6) {
    if (socket !== currentSocket) return;
    const results = await Promise.allSettled(messages.slice(offset, offset + 6).map((message) => handleIncomingMessage(message, true)));
    for (const result of results) {
      if (result.status === "fulfilled" && result.value?.conversationId) conversationIds.add(result.value.conversationId);
      else if (result.status === "rejected") console.warn("Historical WhatsApp message could not be synchronized", result.reason);
    }
  }
  if (!conversationIds.size || socket !== currentSocket) return;
  const conversations = await prisma.conversation.findMany({ where: { id: { in: [...conversationIds] } }, select: { id: true, assignedAgentId: true } });
  const payload = { conversationIds: conversations.map((conversation) => conversation.id) };
  io?.to("admins").emit("whatsapp:history-synced", payload);
  for (const agentId of new Set(conversations.flatMap((conversation) => conversation.assignedAgentId ? [conversation.assignedAgentId] : []))) {
    io?.to(`agent:${agentId}`).emit("whatsapp:history-synced", payload);
  }
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
  const conversationCandidate = await withInboundConversationLock(Channel.WHATSAPP, callerJid, async () => {
    let existing = ids.length ? await prisma.conversation.findFirst({
      where: { channel: Channel.WHATSAPP, OR: [{ externalConversationId: { in: ids } }, { externalCustomerId: { in: ids } }] },
      include: { customer: { select: { name: true, displayName: true, phone: true } }, assignedAgent: { select: { id: true } } }
    }) : null;
    if (!existing) {
      const externalCustomerId = phoneNumber || callerJid;
      const customer = await prisma.customer.upsert({
        where: { id: `external_whatsapp_${externalCustomerId}` },
        update: { ...(phoneNumber ? { phone: phoneNumber } : {}), channelIdentifiers: { whatsapp: externalCustomerId } },
        create: {
          id: `external_whatsapp_${externalCustomerId}`, phone: phoneNumber || null,
          channelIdentifiers: { whatsapp: externalCustomerId }
        }
      });
      try {
        existing = await prisma.conversation.create({ data: {
          customerId: customer.id, channel: Channel.WHATSAPP, externalConversationId: callerJid, externalCustomerId,
          status: ConversationStatus.QUEUED, awaitingRouting: false, botState: ConversationBotState.ASSIGNED_TO_AGENT,
          routingDepartment: Department.CUSTOMER_CARE
        }, include: { customer: { select: { name: true, displayName: true, phone: true } }, assignedAgent: { select: { id: true } } } });
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
        existing = await prisma.conversation.findFirst({
          where: { channel: Channel.WHATSAPP, OR: [{ externalConversationId: { in: ids } }, { externalCustomerId: { in: ids } }] },
          include: { customer: { select: { name: true, displayName: true, phone: true } }, assignedAgent: { select: { id: true } } }
        });
      }
    }
    if (!existing) throw new Error("تعذر إنشاء محادثة للمكالمة الواردة");
    const terminal = existing.status === ConversationStatus.CLOSED || existing.status === ConversationStatus.RESOLVED;
    existing = await prisma.conversation.update({ where: { id: existing.id }, data: {
      ...(terminal ? { status: existing.assignedAgentId ? ConversationStatus.OPEN : ConversationStatus.QUEUED, closedAt: null } : {}),
      awaitingRouting: false, botState: ConversationBotState.ASSIGNED_TO_AGENT,
      lastMessageAt: new Date(), routingDepartment: existing.routingDepartment || Department.CUSTOMER_CARE
    }, include: { customer: { select: { name: true, displayName: true, phone: true } }, assignedAgent: { select: { id: true } } } });
    return existing;
  });
  await assignConversation(conversationCandidate.id, Department.CUSTOMER_CARE, { reassignIfIneligible: true });
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationCandidate.id }, include: {
    customer: { select: { name: true, displayName: true, phone: true } }, assignedAgent: { select: { id: true } }
  } });
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
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  await chmod(authDir, 0o700);
  const authFiles = await readdir(authDir, { withFileTypes: true });
  await Promise.all(authFiles.filter((entry) => entry.isFile()).map((entry) => chmod(path.join(authDir, entry.name), 0o600)));
  await saveState({ mode: "BAILEYS", status: "CONNECTING", qrDataUrl: "", lastError: "" });
  const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
  const current = makeWASocket({ auth, printQRInTerminal: false, syncFullHistory: true, markOnlineOnConnect: false, browser: ["Bondoq CRM", "Chrome", "1.0.0"] });
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
        reconnectDelay = 2000;
        const jid = current.user?.id || "";
        const phoneNumber = phoneFromJid(jid) || jid.split(":")[0].split("@")[0];
        await saveState({ mode: "BAILEYS", status: "CONNECTED", qrDataUrl: "", phoneNumber, accountName: current.user?.name || "WhatsApp", lastError: "" });
        void refreshRecentCustomerProfilePictures(current).catch((error) => console.warn("WhatsApp profile-picture sync failed", error));
      }
      if (update.connection === "close") {
        const statusCode = (update.lastDisconnect?.error as any)?.output?.statusCode;
        if (socket === current) socket = null;
        if (stopRequested || state.mode === "API") {
          await saveState({ status: "DISCONNECTED", qrDataUrl: "" });
          return;
        }
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        console.warn("Baileys WhatsApp connection closed", { statusCode, loggedOut });
        await saveState({ status: "DISCONNECTED", qrDataUrl: "", phoneNumber: loggedOut ? "" : state.phoneNumber, lastError: loggedOut ? "انتهت جلسة WhatsApp؛ جارٍ إنشاء QR جديد" : "انقطع الاتصال؛ ستتم إعادة المحاولة تلقائيًا" });
        if (loggedOut) await rm(authDir, { recursive: true, force: true }).catch(() => {});
        scheduleReconnect(loggedOut ? 500 : reconnectDelay);
      }
    })().catch((error) => console.warn("WhatsApp connection status update failed", error));
  });
  current.ev.on("messages.upsert", ({ messages, type }) => {
    if (type === "notify") {
      for (const message of messages) void handleIncomingMessage(message).catch((error) => console.warn("Baileys inbound message could not be stored", error));
    } else if (type === "append") {
      void syncWhatsAppHistory(current, messages).catch((error) => console.warn("WhatsApp appended history could not be synchronized", error));
    }
  });
  current.ev.on("contacts.upsert", (contacts) => { void syncWhatsAppContacts(current, contacts).catch((error) => console.warn("WhatsApp contact sync failed", error)); });
  current.ev.on("contacts.update", (contacts) => { void syncWhatsAppContacts(current, contacts).catch((error) => console.warn("WhatsApp contact update failed", error)); });
  current.ev.on("messaging-history.set", ({ contacts, messages }) => {
    void syncWhatsAppContacts(current, contacts).catch((error) => console.warn("Historical WhatsApp contact sync failed", error));
    void syncWhatsAppHistory(current, messages).catch((error) => console.warn("Historical WhatsApp message sync failed", error));
  });
  current.ev.on("messages.update", (updates) => {
    for (const update of updates) void persistBaileysReceipt(update).catch((error) => console.warn("Baileys delivery update could not be stored", error));
  });
  current.ev.on("message-receipt.update", (updates) => {
    for (const update of updates) void persistBaileysReceipt(update).catch((error) => console.warn("Baileys receipt could not be stored", error));
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
