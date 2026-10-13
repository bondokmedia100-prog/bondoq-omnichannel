import { Channel, Department, MessageKind } from "@prisma/client";
import { config } from "./config";
import { enqueueKalemlyMessage } from "./KalemlyWaService";
import { formatEgyptianPhone } from "./egyptianPhoneFormatter";

export type NormalizedInbound = {
  channel: Channel;
  externalConversationId: string;
  externalCustomerId: string;
  customerPhone?: string;
  customerName?: string;
  profilePictureUrl?: string;
  text?: string;
  kind: MessageKind;
  mediaUrl?: string;
  latitude?: number;
  longitude?: number;
  externalId: string;
  metadata?: Record<string, unknown>;
  routingDepartment?: Department;
  isComplaint?: boolean;
};

const routeChoice = (payload?: string): { routingDepartment: Department; isComplaint: boolean } | undefined => {
  if (payload === "route_delivery" || payload === "1") return { routingDepartment: Department.DELIVERY, isComplaint: false };
  if (payload === "route_cakes" || payload === "2") return { routingDepartment: Department.CAKES, isComplaint: false };
  if (["route_menu", "route_branches", "3"].includes(payload || "")) return { routingDepartment: Department.CUSTOMER_CARE, isComplaint: false };
  if (payload === "route_quality" || payload === "4") return { routingDepartment: Department.QUALITY, isComplaint: true };
  return undefined;
};

async function postJson(url: string, payload: unknown, token: string) {
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Provider send failed (${response.status}): ${await response.text()}`);
  return response.json();
}

export async function sendToChannel(input: { channel: Channel; recipient: string; text?: string; kind?: MessageKind; mediaUrl?: string; latitude?: number; longitude?: number }) {
  const kind = input.kind || MessageKind.TEXT;
  if (input.channel === Channel.WHATSAPP) {
    const message = kind === MessageKind.LOCATION
      ? `${input.text || "موقع العميل"}\nhttps://maps.google.com/?q=${input.latitude},${input.longitude}`
      : input.text || "";
    return enqueueKalemlyMessage({
      to: formatEgyptianPhone(input.recipient), message,
      ...(input.mediaUrl ? { file: input.mediaUrl, mediaType: kind === MessageKind.IMAGE ? "image" : kind === MessageKind.AUDIO ? "audio" : "document" } : {})
    });
  }
  if (input.channel === Channel.MESSENGER) {
    if (!config.metaPageToken) throw new Error("Meta Page access token is not configured");
    const attachmentType = kind === MessageKind.IMAGE ? "image" : kind === MessageKind.AUDIO ? "audio" : "file";
    const message = kind === MessageKind.TEXT ? { text: input.text || "" }
      : kind === MessageKind.LOCATION ? { text: `موقع: https://maps.google.com/?q=${input.latitude},${input.longitude}` }
      : { attachment: { type: attachmentType, payload: { url: input.mediaUrl, is_reusable: true } } };
    const result = await postJson("https://graph.facebook.com/v21.0/me/messages", {
      recipient: { id: input.recipient }, messaging_type: "RESPONSE", message
    }, config.metaPageToken);
    if (kind === MessageKind.IMAGE && input.text?.trim()) {
      try {
        await postJson("https://graph.facebook.com/v21.0/me/messages", {
          recipient: { id: input.recipient }, messaging_type: "RESPONSE", message: { text: input.text }
        }, config.metaPageToken);
      } catch (error) {
        return { ...result, captionDelivery: "failed", captionError: error instanceof Error ? error.message : "unknown" };
      }
    }
    return result;
  }
  if (!config.telegramToken) throw new Error("Telegram bot token is not configured");
  const method = kind === MessageKind.IMAGE ? "sendPhoto" : kind === MessageKind.AUDIO ? "sendAudio" : kind === MessageKind.FILE ? "sendDocument" : kind === MessageKind.LOCATION ? "sendLocation" : "sendMessage";
  const payload = kind === MessageKind.LOCATION ? { chat_id: input.recipient, latitude: input.latitude, longitude: input.longitude }
    : kind === MessageKind.IMAGE ? { chat_id: input.recipient, photo: input.mediaUrl, caption: input.text }
    : kind === MessageKind.AUDIO ? { chat_id: input.recipient, audio: input.mediaUrl, caption: input.text }
    : kind === MessageKind.FILE ? { chat_id: input.recipient, document: input.mediaUrl, caption: input.text }
    : { chat_id: input.recipient, text: input.text || "" };
  const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Telegram send failed (${response.status}): ${await response.text()}`);
  return response.json();
}

export async function sendRoutingMenu(channel: Channel, recipient: string) {
  const prompt = "أهلًا بك في حلواني بندق. اكتب رقم الخدمة التي تحتاجها:\n1- طلب دليفري سريع\n2- حجز تورتة مناسبات\n3- المنيو والفروع\n4- شكوى أو مقترح";
  const choices = [
    { id: "route_delivery", title: "1- دليفري" },
    { id: "route_cakes", title: "2- تورتة" },
    { id: "route_menu", title: "3- المنيو والفروع" },
    { id: "route_quality", title: "4- شكوى" }
  ];
  if (channel === Channel.WHATSAPP) {
    return sendToChannel({ channel, recipient: formatEgyptianPhone(recipient), text: prompt });
  }
  if (channel === Channel.MESSENGER) {
    if (!config.metaPageToken) throw new Error("Meta Page access token is not configured");
    return postJson("https://graph.facebook.com/v21.0/me/messages", {
      recipient: { id: recipient }, messaging_type: "RESPONSE",
      message: { text: prompt, quick_replies: choices.map((item) => ({ content_type: "text", title: item.title, payload: item.id })) }
    }, config.metaPageToken);
  }
  if (!config.telegramToken) throw new Error("Telegram bot token is not configured");
  const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: recipient, text: prompt, reply_markup: { inline_keyboard: [choices.map((item) => ({ text: item.title, callback_data: item.id }))] } })
  });
  if (!response.ok) throw new Error(`Telegram menu send failed (${response.status}): ${await response.text()}`);
  return response.json();
}

export async function answerTelegramCallback(callbackId: string) {
  if (!config.telegramToken) return;
  await fetch(`https://api.telegram.org/bot${config.telegramToken}/answerCallbackQuery`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: callbackId })
  });
}

export async function sendCsatPrompt(channel: Channel, recipient: string, windowExpired: boolean) {
  const text = "شكرًا لاختيارك حلواني بندق. كيف تقيّم خدمتنا؟ أرسل رقمًا من 1 إلى 5، حيث 5 ممتاز و1 يحتاج إلى تحسين.";
  if (channel === Channel.MESSENGER && windowExpired) throw new Error("Messenger's 24-hour messaging window expired; wait for the customer to message again before sending CSAT");
  return sendToChannel({ channel, recipient, text });
}

function firstMedia(message: any): { kind: MessageKind; mediaUrl?: string } {
  if (message?.attachments?.length) {
    const attachment = message.attachments[0];
    const kind = attachment.type === "image" ? MessageKind.IMAGE : attachment.type === "audio" ? MessageKind.AUDIO : MessageKind.FILE;
    return { kind, mediaUrl: attachment.payload?.url };
  }
  return { kind: MessageKind.TEXT };
}

export function parseKalemlyWebhook(body: any): NormalizedInbound[] {
  const root = body?.data ?? body?.payload ?? body;
  const candidates = root?.messages ?? root?.data?.messages ?? body?.messages;
  const records = Array.isArray(candidates) ? candidates : [root];
  const messages: NormalizedInbound[] = [];
  for (const record of records) {
    if (!record || record.key?.fromMe || record.fromMe || record.isFromMe) continue;
    const envelope = record.data ?? record;
    const key = envelope.key ?? record.key ?? {};
    if (key.fromMe || key.from_me || envelope.fromMe || envelope.isFromMe) continue;
    const rawMessage = envelope.message ?? record.message ?? {};
    const content = typeof rawMessage === "object" ? rawMessage : {};
    const rawPhone = envelope.from || envelope.sender || envelope.phone || envelope.number || envelope.remoteJid || key.remoteJid || record.from || record.sender || record.phone || record.number;
    if (!rawPhone) continue;
    let phone: string;
    try { phone = formatEgyptianPhone(String(rawPhone)); } catch { continue; }

    const image = content.imageMessage || envelope.image || record.image;
    const audio = content.audioMessage || content.pttMessage || envelope.audio || envelope.voice || record.audio;
    const document = content.documentMessage || envelope.document || record.document || record.file;
    const location = content.locationMessage || envelope.location || record.location;
    const extendedText = content.extendedTextMessage?.text || content.buttonsResponseMessage?.selectedDisplayText || content.templateButtonReplyMessage?.selectedDisplayText;
    const text = typeof rawMessage === "string" ? rawMessage
      : content.conversation || extendedText || image?.caption || document?.caption || envelope.text || envelope.body || record.text || record.body || record.caption || record.buttonReply?.id || record.buttonReply?.title;
    const route = routeChoice(String(record.buttonReply?.id || record.buttonReply?.title || envelope.selectedButtonId || text || "").trim());
    const file = image || audio || document;
    const kind = location ? MessageKind.LOCATION : image ? MessageKind.IMAGE : audio ? MessageKind.AUDIO : document ? MessageKind.FILE : MessageKind.TEXT;
    const externalId = key.id || envelope.messageId || envelope.id || record.messageId || record.id || `${phone}:${envelope.messageTimestamp || record.timestamp || Date.now()}`;
    const avatarUrl = envelope.profilePictureUrl || envelope.profilePicUrl || envelope.avatarUrl || record.profilePictureUrl || record.avatarUrl;

    messages.push({
      channel: Channel.WHATSAPP, externalConversationId: phone, externalCustomerId: phone, customerPhone: phone,
      customerName: envelope.pushName || envelope.name || envelope.contact?.name || record.pushName || record.name,
      profilePictureUrl: avatarUrl ? String(avatarUrl) : undefined,
      text: text === undefined ? undefined : String(text), kind,
      mediaUrl: file?.url || file?.link || file?.mediaUrl || envelope.mediaUrl || record.mediaUrl,
      latitude: location?.degreesLatitude ?? location?.latitude,
      longitude: location?.degreesLongitude ?? location?.longitude,
      externalId: `kalemly:${String(externalId)}`,
      metadata: { provider: "kalemlywa", originalJid: String(rawPhone), mediaId: file?.id, mediaUrl: file?.url || envelope.mediaUrl },
      ...(route || {})
    });
  }
  return messages;
}

export function parseMetaWebhook(body: any): NormalizedInbound[] {
  const messages: NormalizedInbound[] = [];
  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      if ((!event.message && !event.postback) || event.message?.is_echo) continue;
      const payload = event.message?.quick_reply?.payload || event.postback?.payload;
      const routing = routeChoice(payload);
      const message = event.message || {};
      const media = firstMedia(message);
      messages.push({ channel: Channel.MESSENGER, externalConversationId: event.sender.id, externalCustomerId: event.sender.id,
        customerName: event.sender.name, text: message.text || event.postback?.title || payload, ...media,
        externalId: message.mid || `${entry.id}:${event.timestamp || Date.now()}:${event.sender.id}:${payload || "postback"}`,
        metadata: { pageId: entry.id, attachmentUrl: message.attachments?.[0]?.payload?.url }, ...routing });
    }
  }
  return messages;
}

export function parseTelegramWebhook(body: any): NormalizedInbound[] {
  const callback = body.callback_query;
  if (callback?.message) {
    const chatId = String(callback.message.chat.id);
    const routing = routeChoice(callback.data);
    return [{ channel: Channel.TELEGRAM, externalConversationId: chatId, externalCustomerId: String(callback.from?.id || chatId),
      customerName: [callback.from?.first_name, callback.from?.last_name].filter(Boolean).join(" "), text: callback.data,
      kind: MessageKind.TEXT, externalId: `callback:${callback.id}`, metadata: { callbackId: callback.id, chatId }, ...routing }];
  }
  const message = body.message || body.edited_message;
  if (!message) return [];
  const photo = message.photo?.at(-1);
  const document = message.document;
  const audio = message.voice || message.audio;
  const location = message.location;
  const fileId = photo?.file_id || document?.file_id || audio?.file_id;
  return [{
    channel: Channel.TELEGRAM, externalConversationId: String(message.chat.id), externalCustomerId: String(message.from?.id || message.chat.id),
    customerName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" "), text: message.text || message.caption,
    kind: location ? MessageKind.LOCATION : photo ? MessageKind.IMAGE : audio ? MessageKind.AUDIO : document ? MessageKind.FILE : MessageKind.TEXT,
    latitude: location?.latitude, longitude: location?.longitude, externalId: `${message.chat.id}:${message.message_id}`, metadata: { fileId, chatId: message.chat.id }
  }];
}

export async function fetchInboundMedia(channel: Channel, metadata: Record<string, unknown>, mediaUrl?: string) {
  let url = mediaUrl || String(metadata.attachmentUrl || "");
  if (channel === Channel.TELEGRAM && metadata.fileId && config.telegramToken) {
    const infoResponse = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getFile?file_id=${encodeURIComponent(String(metadata.fileId))}`);
    if (!infoResponse.ok) throw new Error(`Telegram file lookup failed (${infoResponse.status})`);
    const info = await infoResponse.json() as { result?: { file_path?: string } };
    if (!info.result?.file_path) throw new Error("Telegram file path is unavailable");
    url = `https://api.telegram.org/file/bot${config.telegramToken}/${info.result.file_path}`;
  }
  if (!url) throw new Error("Media URL is unavailable for this message");
  const mediaAddress = new URL(url);
  if (mediaAddress.protocol !== "https:") throw new Error("Media must be loaded over HTTPS");
  const hostname = mediaAddress.hostname;
  const trustedMediaHost = hostname === "graph.facebook.com" || hostname.endsWith(".fbcdn.net") || hostname.endsWith(".fbsbx.com") || hostname === "api.telegram.org" || hostname === "whatsapp.kalemly.com" || hostname.endsWith(".kalemly.com");
  if (!trustedMediaHost) throw new Error("Media host is not trusted");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Media download failed (${response.status})`);
  return { body: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") || "application/octet-stream" };
}
