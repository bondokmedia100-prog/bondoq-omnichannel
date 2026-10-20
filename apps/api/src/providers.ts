import { Channel, MessageKind } from "@prisma/client";
import { enqueueKalemlyMessage, getKalemlySettings } from "./KalemlyWaService";
import { AUTO_REPLY_MENU_TEXT } from "./autoReplies";
import { getMessengerSettings, getTelegramSettings } from "./ChannelIntegrationService";
import { deleteBaileysWhatsAppMessage, editBaileysWhatsAppMessage, getWhatsAppMode, reactToBaileysWhatsAppMessage, transcodeAnimatedWebpToTelegramSticker, transcodeVoiceToOgg } from "./BaileysWhatsAppService";
import { routeChoice } from "./kalemlyWebhookParser";
import type { NormalizedInbound } from "./kalemlyWebhookParser";
import { isAnimatedWebp } from "./webpSticker";
export { parseKalemlyWebhook } from "./kalemlyWebhookParser";
export type { NormalizedInbound } from "./kalemlyWebhookParser";

export function channelRecipient(channel: Channel, conversationId: string, customerId: string) {
  return channel === Channel.TELEGRAM ? conversationId : customerId;
}

async function postJson(url: string, payload: unknown, token: string) {
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Provider send failed (${response.status}): ${await response.text()}`);
  return response.json();
}

export async function sendToChannel(input: { channel: Channel; recipient: string; text?: string; kind?: MessageKind; mediaUrl?: string; mediaAssetId?: string; mediaContentType?: string; mediaBuffer?: Uint8Array; latitude?: number; longitude?: number; pollOptions?: string[]; contactCard?: { name: string; phone: string }; outboundMessageId?: string }) {
  const kind = input.kind || MessageKind.TEXT;
  if (input.contactCard && input.channel !== Channel.WHATSAPP) throw new Error("بطاقات جهات الاتصال متاحة عبر WhatsApp فقط");
  if (input.channel === Channel.WHATSAPP) {
    if (kind === MessageKind.STICKER && await getWhatsAppMode() !== "BAILEYS") throw new Error("ملصقات WhatsApp غير مدعومة عبر وضع API الحالي؛ استخدم وضع Baileys");
    if (kind === MessageKind.POLL && await getWhatsAppMode() !== "BAILEYS") throw new Error("استطلاعات WhatsApp غير مدعومة عبر وضع API الحالي؛ استخدم وضع Baileys");
    const message = kind === MessageKind.LOCATION
      ? `${input.text || "موقع العميل"}\nhttps://maps.google.com/?q=${input.latitude},${input.longitude}`
      : input.text || "";
    return enqueueKalemlyMessage({
      to: input.recipient, message,
      ...(input.pollOptions ? { pollOptions: input.pollOptions } : {}),
      ...(input.contactCard ? { contactCard: input.contactCard } : {}),
      ...(input.mediaUrl ? { file: input.mediaUrl } : {}),
      ...(input.mediaAssetId ? { mediaAssetId: input.mediaAssetId } : {}),
      ...(input.mediaUrl || input.mediaAssetId ? { mediaType: kind === MessageKind.STICKER ? "sticker" : kind === MessageKind.IMAGE ? "image" : kind === MessageKind.AUDIO ? "audio" : kind === MessageKind.VIDEO ? "video" : "document" } : {})
    }, input.outboundMessageId);
  }
  if (input.channel === Channel.MESSENGER) {
    if (kind === MessageKind.POLL || kind === MessageKind.STICKER) throw new Error("الاستطلاعات والملصقات غير مدعومة في Messenger");
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
  const audioContentType = input.mediaContentType?.split(";")[0].toLowerCase();
  const convertTelegramVoice = kind === MessageKind.AUDIO && Boolean(input.mediaBuffer) && !["audio/mpeg", "audio/mp4"].includes(audioContentType || "");
  const audioMethod = convertTelegramVoice ? "sendVoice" : kind !== MessageKind.AUDIO || !audioContentType ? "sendAudio"
    : audioContentType === "audio/ogg" ? "sendVoice"
      : audioContentType === "audio/mpeg" || audioContentType === "audio/mp4" ? "sendAudio" : "sendDocument";
  const method = kind === MessageKind.POLL ? "sendPoll" : kind === MessageKind.STICKER ? "sendSticker" : kind === MessageKind.IMAGE ? "sendPhoto" : kind === MessageKind.AUDIO ? audioMethod : kind === MessageKind.FILE ? "sendDocument" : kind === MessageKind.LOCATION ? "sendLocation" : "sendMessage";
  const payload = kind === MessageKind.LOCATION ? { chat_id: input.recipient, latitude: input.latitude, longitude: input.longitude }
    : kind === MessageKind.POLL ? { chat_id: input.recipient, question: input.text || "", options: input.pollOptions || [], is_anonymous: true, allows_multiple_answers: false }
    : kind === MessageKind.STICKER ? { chat_id: input.recipient, sticker: input.mediaUrl }
    : kind === MessageKind.IMAGE ? { chat_id: input.recipient, photo: input.mediaUrl, caption: input.text }
    : kind === MessageKind.AUDIO ? { chat_id: input.recipient, [audioMethod === "sendVoice" ? "voice" : audioMethod === "sendDocument" ? "document" : "audio"]: input.mediaUrl, caption: input.text }
    : kind === MessageKind.FILE ? { chat_id: input.recipient, document: input.mediaUrl, caption: input.text }
    : { chat_id: input.recipient, text: input.text || "" };
  let response: Response;
  if (kind === MessageKind.STICKER && input.mediaBuffer) {
    const animated = isAnimatedWebp(input.mediaBuffer);
    const sticker = animated ? await transcodeAnimatedWebpToTelegramSticker(Buffer.from(input.mediaBuffer)) : Buffer.from(input.mediaBuffer);
    const form = new FormData();
    form.set("chat_id", input.recipient);
    const contentType = animated ? "video/webm" : "image/webp";
    form.set("sticker", new Blob([Uint8Array.from(sticker)], { type: contentType }), animated ? "sticker.webm" : "sticker.webp");
    response = await fetch(`https://api.telegram.org/bot${settings.botToken}/${method}`, { method: "POST", body: form, signal: AbortSignal.timeout(45_000) });
  } else if (convertTelegramVoice) {
    const audio = await transcodeVoiceToOgg(Buffer.from(input.mediaBuffer!), audioContentType || "audio/webm");
    const form = new FormData();
    form.set("chat_id", input.recipient);
    form.set("voice", new Blob([Uint8Array.from(audio)], { type: "audio/ogg" }), "voice.ogg");
    if (input.text) form.set("caption", input.text);
    response = await fetch(`https://api.telegram.org/bot${settings.botToken}/${method}`, { method: "POST", body: form, signal: AbortSignal.timeout(45_000) });
  } else {
    response = await fetch(`https://api.telegram.org/bot${settings.botToken}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  }
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || result.ok === false) throw new Error(`Telegram send failed (${response.status}): ${result.description || "provider rejected the request"}`);
  return result;
}

export async function editProviderMessage(input: { channel: Channel; recipient: string; externalId: string; text: string; direction: "INBOUND" | "OUTBOUND" }) {
  if (input.direction !== "OUTBOUND") throw new Error("يمكن تعديل الرسائل التي أرسلها الفريق فقط");
  if (input.channel === Channel.WHATSAPP) return editBaileysWhatsAppMessage({ recipient: input.recipient, externalId: input.externalId, text: input.text });
  if (input.channel !== Channel.TELEGRAM) throw new Error("لا يتيح Messenger تعديل الرسالة بعد إرسالها؛ لم نرسل بديلًا حتى لا نفقد الرسالة الأصلية.");
  const settings = await getTelegramSettings();
  if (!settings.botToken) throw new Error("Telegram bot token is not configured");
  const messageId = input.externalId.split(":").at(-1);
  if (!messageId || !/^\d+$/.test(messageId)) throw new Error("معرّف رسالة Telegram غير صالح");
  const response = await fetch(`https://api.telegram.org/bot${settings.botToken}/editMessageText`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: input.recipient, message_id: Number(messageId), text: input.text })
  });
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !result.ok) throw new Error(result.description || "تعذر تعديل رسالة Telegram");
  return result;
}

export async function deleteProviderMessage(input: { channel: Channel; recipient: string; externalId: string }) {
  const providerId = input.externalId.replace(/^(?:WHATSAPP|MESSENGER|TELEGRAM):/, "");
  if (!providerId) throw new Error("معرّف رسالة القناة غير صالح");
  if (input.channel === Channel.WHATSAPP) {
    if (await getWhatsAppMode() !== "BAILEYS") throw new Error("حذف رسائل WhatsApp غير مدعوم في وضع API الحالي");
    return deleteBaileysWhatsAppMessage({ recipient: input.recipient, externalId: providerId });
  }
  if (input.channel === Channel.MESSENGER) {
    const settings = await getMessengerSettings();
    if (!settings.pageAccessToken) throw new Error("Meta Page access token is not configured");
    const response = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(providerId)}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${settings.pageAccessToken}` }
    });
    const result = await response.json() as { error?: { message?: string } };
    if (!response.ok || result.error) throw new Error(result.error?.message || `Messenger delete failed (${response.status})`);
    return result;
  }
  const settings = await getTelegramSettings();
  if (!settings.botToken) throw new Error("Telegram bot token is not configured");
  const messageId = providerId.split(":").at(-1);
  if (!messageId || !/^\d+$/.test(messageId)) throw new Error("معرّف رسالة Telegram غير صالح");
  const response = await fetch(`https://api.telegram.org/bot${settings.botToken}/deleteMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: input.recipient, message_id: Number(messageId) })
  });
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !result.ok) throw new Error(result.description || "تعذر حذف رسالة Telegram");
  return result;
}

export async function reactToProviderMessage(input: { channel: Channel; recipient: string; externalId: string; direction: "INBOUND" | "OUTBOUND"; emoji: string }) {
  if (input.channel === Channel.WHATSAPP) {
    if (await getWhatsAppMode() !== "BAILEYS") return false;
    await reactToBaileysWhatsAppMessage({ recipient: input.recipient, externalId: input.externalId, direction: input.direction, emoji: input.emoji });
    return true;
  }
  if (input.channel !== Channel.TELEGRAM) return false;
  const settings = await getTelegramSettings();
  if (!settings.botToken) throw new Error("Telegram bot token is not configured");
  const messageId = input.externalId.split(":").at(-1);
  if (!messageId || !/^\d+$/.test(messageId)) return false;
  const response = await fetch(`https://api.telegram.org/bot${settings.botToken}/setMessageReaction`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: input.recipient, message_id: Number(messageId), reaction: input.emoji ? [{ type: "emoji", emoji: input.emoji }] : [] })
  });
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !result.ok) throw new Error(result.description || "تعذر مزامنة التفاعل مع Telegram");
  return true;
}

export function parseTelegramMessageId(externalId: string) {
  return externalId.split(":").at(-1) || "";
}

export async function sendRoutingMenu(channel: Channel, recipient: string, prompt = AUTO_REPLY_MENU_TEXT, optionLabels = ["الفروع ومواعيد العمل", "خدمة العملاء", "طلبات الجملة", "الشكاوى والاقتراحات", "غير ذلك"]) {
  const ids = ["route_branches", "route_customer_care", "route_wholesale", "route_quality", "route_other"];
  const choices = optionLabels.map((title, index) => ({ id: ids[index], title: `${index + 1}- ${title}` }));
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
      customerName: [callback.from?.first_name, callback.from?.last_name].filter(Boolean).join(" "), customerUsername: callback.from?.username, text: callback.data,
      kind: MessageKind.TEXT, externalId: `callback:${callback.id}`, metadata: { callbackId: callback.id, chatId }, ...routing }];
  }
  const message = body.message || body.edited_message;
  if (!message) return [];
  const photo = message.photo?.at(-1);
  const document = message.document;
  const audio = message.voice || message.audio;
  const sticker = message.sticker;
  const poll = message.poll;
  const location = message.location;
  const fileId = photo?.file_id || document?.file_id || audio?.file_id || sticker?.file_id;
  return [{
    channel: Channel.TELEGRAM, externalConversationId: String(message.chat.id), externalCustomerId: String(message.from?.id || message.chat.id),
     customerName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" "), customerUsername: message.from?.username, text: message.text || message.caption || poll?.question,
     kind: location ? MessageKind.LOCATION : poll ? MessageKind.POLL : sticker ? MessageKind.STICKER : photo ? MessageKind.IMAGE : audio ? MessageKind.AUDIO : document ? MessageKind.FILE : MessageKind.TEXT,
      latitude: location?.latitude, longitude: location?.longitude, externalId: `${message.chat.id}:${message.message_id}`, isEdit: Boolean(body.edited_message), metadata: { fileId, chatId: message.chat.id, pollId: poll?.id, pollOptions: poll?.options?.map((option: any) => option.text), telegramStickerIsVideo: sticker?.is_video === true }
  }];
}

export async function fetchInboundMedia(channel: Channel, metadata: Record<string, unknown>, mediaUrl?: string) {
  const kalemlyMediaId = typeof metadata.mediaId === "string" ? metadata.mediaId : "";
  if (channel === Channel.WHATSAPP && metadata.provider === "kalemlywa" && kalemlyMediaId) {
    if (metadata.mediaAvailable === false) throw new Error("KalemlyWA inbound media is unavailable or expired");
    const settings = await getKalemlySettings();
    if (!settings.authKey || !settings.appKey) throw new Error("KalemlyWA media credentials are not configured");
    const endpoint = new URL("/api/inbound-media/download", settings.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.hostname !== "whatsapp.kalemly.com") throw new Error("KalemlyWA endpoint must use the verified HTTPS host whatsapp.kalemly.com");
    const response = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authkey: settings.authKey, appkey: settings.appKey, media_id: kalemlyMediaId }),
      signal: AbortSignal.timeout(45_000)
    });
    if (!response.ok) throw new Error(`KalemlyWA media download failed (${response.status})`);
    const maxBytes = 30 * 1024 * 1024;
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > maxBytes) throw new Error("KalemlyWA inbound media exceeds the 30 MiB limit");
    const body = Buffer.from(await response.arrayBuffer());
    if (!body.length) throw new Error("KalemlyWA returned an empty media file");
    if (body.length > maxBytes) throw new Error("KalemlyWA inbound media exceeds the 30 MiB limit");
    return { body, contentType: response.headers.get("content-type") || String(metadata.mediaMimeType || "application/octet-stream") };
  }

  let url = mediaUrl || String(metadata.attachmentUrl || "");
  const telegramSettings = channel === Channel.TELEGRAM ? await getTelegramSettings() : null;
  let telegramStickerPath = "";
  if (channel === Channel.TELEGRAM && metadata.fileId && telegramSettings?.botToken) {
    const infoResponse = await fetch(`https://api.telegram.org/bot${telegramSettings.botToken}/getFile?file_id=${encodeURIComponent(String(metadata.fileId))}`, { signal: AbortSignal.timeout(45_000) });
    if (!infoResponse.ok) throw new Error(`Telegram file lookup failed (${infoResponse.status})`);
    const info = await infoResponse.json() as { result?: { file_path?: string } };
    if (!info.result?.file_path) throw new Error("Telegram file path is unavailable");
    telegramStickerPath = info.result.file_path;
    url = `https://api.telegram.org/file/bot${telegramSettings.botToken}/${info.result.file_path}`;
  }
  if (!url) throw new Error("Media URL is unavailable for this message");
  const maxBytes = 12 * 1024 * 1024;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    let mediaAddress = new URL(url);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const hostname = mediaAddress.hostname;
      const trustedMediaHost = hostname === "graph.facebook.com" || hostname.endsWith(".fbcdn.net") || hostname.endsWith(".fbsbx.com") || hostname === "api.telegram.org" || hostname === "whatsapp.kalemly.com" || hostname.endsWith(".kalemly.com");
      if (mediaAddress.protocol !== "https:" || !trustedMediaHost || mediaAddress.username || mediaAddress.password) throw new Error("Media host is not trusted");
      const response = await fetch(mediaAddress, { redirect: "manual", signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirects === 3) throw new Error("Media redirect limit exceeded");
        mediaAddress = new URL(location, mediaAddress);
        continue;
      }
      if (!response.ok) throw new Error(`Media download failed (${response.status})`);
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > maxBytes) throw new Error("Inbound media exceeds the 12 MiB forwarding limit");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body || []) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes) {
          controller.abort();
          throw new Error("Inbound media exceeds the 12 MiB forwarding limit");
        }
        chunks.push(bytes);
      }
      const headerType = response.headers.get("content-type") || "application/octet-stream";
      const contentType = metadata.telegramStickerIsVideo === true && /\.webm$/i.test(telegramStickerPath) ? "video/webm" : headerType;
      return { body: Buffer.concat(chunks, size), contentType };
    }
    throw new Error("Media redirect limit exceeded");
  } finally {
    clearTimeout(timeout);
  }
}
