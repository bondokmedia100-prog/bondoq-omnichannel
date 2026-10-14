import { Channel, MessageKind } from "@prisma/client";
import { enqueueKalemlyMessage } from "./KalemlyWaService";
import { AUTO_REPLY_MENU_TEXT } from "./autoReplies";
import { getMessengerSettings, getTelegramSettings } from "./ChannelIntegrationService";
import { normalizePhoneNumber } from "./egyptianPhoneFormatter";
import { routeChoice } from "./kalemlyWebhookParser";
import type { NormalizedInbound } from "./kalemlyWebhookParser";
export { parseKalemlyWebhook } from "./kalemlyWebhookParser";
export type { NormalizedInbound } from "./kalemlyWebhookParser";

async function postJson(url: string, payload: unknown, token: string) {
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Provider send failed (${response.status}): ${await response.text()}`);
  return response.json();
}

export async function sendToChannel(input: { channel: Channel; recipient: string; text?: string; kind?: MessageKind; mediaUrl?: string; mediaContentType?: string; latitude?: number; longitude?: number; outboundMessageId?: string }) {
  const kind = input.kind || MessageKind.TEXT;
  if (input.channel === Channel.WHATSAPP) {
    const message = kind === MessageKind.LOCATION
      ? `${input.text || "موقع العميل"}\nhttps://maps.google.com/?q=${input.latitude},${input.longitude}`
      : input.text || "";
    return enqueueKalemlyMessage({
      to: normalizePhoneNumber(input.recipient), message,
      ...(input.mediaUrl ? { file: input.mediaUrl, mediaType: kind === MessageKind.IMAGE ? "image" : kind === MessageKind.AUDIO ? "audio" : "document" } : {})
    }, input.outboundMessageId);
  }
  if (input.channel === Channel.MESSENGER) {
    const settings = await getMessengerSettings();
    if (!settings.pageAccessToken) throw new Error("Meta Page access token is not configured");
    const attachmentType = kind === MessageKind.IMAGE ? "image" : kind === MessageKind.AUDIO ? "audio" : "file";
    const message = kind === MessageKind.TEXT ? { text: input.text || "" }
      : kind === MessageKind.LOCATION ? { text: `موقع: https://maps.google.com/?q=${input.latitude},${input.longitude}` }
      : { attachment: { type: attachmentType, payload: { url: input.mediaUrl, is_reusable: true } } };
    const result = await postJson("https://graph.facebook.com/v21.0/me/messages", {
      recipient: { id: input.recipient }, messaging_type: "RESPONSE", message
    }, settings.pageAccessToken);
    if (kind === MessageKind.IMAGE && input.text?.trim()) {
      try {
        await postJson("https://graph.facebook.com/v21.0/me/messages", {
          recipient: { id: input.recipient }, messaging_type: "RESPONSE", message: { text: input.text }
        }, settings.pageAccessToken);
      } catch (error) {
        return { ...result, captionDelivery: "failed", captionError: error instanceof Error ? error.message : "unknown" };
      }
    }
    return result;
  }
  const settings = await getTelegramSettings();
  if (!settings.botToken) throw new Error("Telegram bot token is not configured");
  const audioMethod = kind !== MessageKind.AUDIO || !input.mediaContentType ? "sendAudio"
    : input.mediaContentType === "audio/ogg" ? "sendVoice"
      : input.mediaContentType === "audio/mpeg" || input.mediaContentType === "audio/mp4" ? "sendAudio" : "sendDocument";
  const method = kind === MessageKind.IMAGE ? "sendPhoto" : kind === MessageKind.AUDIO ? audioMethod : kind === MessageKind.FILE ? "sendDocument" : kind === MessageKind.LOCATION ? "sendLocation" : "sendMessage";
  const payload = kind === MessageKind.LOCATION ? { chat_id: input.recipient, latitude: input.latitude, longitude: input.longitude }
    : kind === MessageKind.IMAGE ? { chat_id: input.recipient, photo: input.mediaUrl, caption: input.text }
    : kind === MessageKind.AUDIO ? { chat_id: input.recipient, [audioMethod === "sendVoice" ? "voice" : audioMethod === "sendDocument" ? "document" : "audio"]: input.mediaUrl, caption: input.text }
    : kind === MessageKind.FILE ? { chat_id: input.recipient, document: input.mediaUrl, caption: input.text }
    : { chat_id: input.recipient, text: input.text || "" };
  const response = await fetch(`https://api.telegram.org/bot${settings.botToken}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Telegram send failed (${response.status}): ${await response.text()}`);
  return response.json();
}

export async function sendRoutingMenu(channel: Channel, recipient: string, prompt = AUTO_REPLY_MENU_TEXT) {
  const choices = [
    { id: "route_branches", title: "1- الفروع" },
    { id: "route_customer_care", title: "2- خدمة العملاء" },
    { id: "route_wholesale", title: "3- طلبات الجملة" },
    { id: "route_quality", title: "4- الشكاوى والاقتراحات" },
    { id: "route_other", title: "5- غير ذلك" }
  ];
  if (channel === Channel.WHATSAPP) {
    return sendToChannel({ channel, recipient, text: prompt });
  }
  if (channel === Channel.MESSENGER) {
    const settings = await getMessengerSettings();
    if (!settings.pageAccessToken) throw new Error("Meta Page access token is not configured");
    return postJson("https://graph.facebook.com/v21.0/me/messages", {
      recipient: { id: recipient }, messaging_type: "RESPONSE",
      message: { text: prompt, quick_replies: choices.map((item) => ({ content_type: "text", title: item.title, payload: item.id })) }
    }, settings.pageAccessToken);
  }
  const settings = await getTelegramSettings();
  if (!settings.botToken) throw new Error("Telegram bot token is not configured");
  const response = await fetch(`https://api.telegram.org/bot${settings.botToken}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: recipient, text: prompt, reply_markup: { inline_keyboard: [choices.map((item) => ({ text: item.title, callback_data: item.id }))] } })
  });
  if (!response.ok) throw new Error(`Telegram menu send failed (${response.status}): ${await response.text()}`);
  return response.json();
}

export async function answerTelegramCallback(callbackId: string) {
  const settings = await getTelegramSettings();
  if (!settings.botToken) return;
  await fetch(`https://api.telegram.org/bot${settings.botToken}/answerCallbackQuery`, {
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
  const telegramSettings = channel === Channel.TELEGRAM ? await getTelegramSettings() : null;
  if (channel === Channel.TELEGRAM && metadata.fileId && telegramSettings?.botToken) {
    const infoResponse = await fetch(`https://api.telegram.org/bot${telegramSettings.botToken}/getFile?file_id=${encodeURIComponent(String(metadata.fileId))}`);
    if (!infoResponse.ok) throw new Error(`Telegram file lookup failed (${infoResponse.status})`);
    const info = await infoResponse.json() as { result?: { file_path?: string } };
    if (!info.result?.file_path) throw new Error("Telegram file path is unavailable");
    url = `https://api.telegram.org/file/bot${telegramSettings.botToken}/${info.result.file_path}`;
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
