import { Channel, Department, MessageKind } from "@prisma/client";
import { getServiceChoice } from "./autoReplies";
import { normalizePhoneNumber } from "./egyptianPhoneFormatter";

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

export const routeChoice = (payload?: string): { routingDepartment: Department; isComplaint: boolean } | undefined => {
  const choice = getServiceChoice(payload);
  return choice ? { routingDepartment: choice.routingDepartment as Department, isComplaint: choice.isComplaint } : undefined;
};

export function parseKalemlyWebhook(body: any): NormalizedInbound[] {
  if (body?.event && body.event !== "message.inbound") return [];
  const root = body?.data ?? body?.payload ?? body;
  const candidates = root?.messages ?? root?.data?.messages ?? body?.messages;
  const records = Array.isArray(candidates) ? candidates : [root];
  const messages: NormalizedInbound[] = [];

  for (const record of records) {
    if (!record || record.key?.fromMe || record.fromMe || record.isFromMe) continue;
    const envelope = record.data ?? record;
    const key = envelope.key ?? record.key ?? {};
    if (key.fromMe || key.from_me || envelope.fromMe || envelope.isFromMe) continue;

    const phoneCandidates = [
      envelope.phone, record.phone,
      envelope.sender, record.sender,
      envelope.from, record.from,
      envelope.number, record.number,
      envelope.remoteJid, key.remoteJid
    ];
    let rawPhone: string | undefined;
    let phone: string | undefined;
    for (const candidate of phoneCandidates) {
      if (typeof candidate !== "string" && typeof candidate !== "number") continue;
      try {
        phone = normalizePhoneNumber(String(candidate));
        rawPhone = String(candidate);
        break;
      } catch {}
    }
    if (!phone || !rawPhone) continue;

    const rawMessage = envelope.message ?? record.message ?? {};
    const content = typeof rawMessage === "object" ? rawMessage : {};
    const media = content.media || envelope.media || record.media;
    const messageType = String(envelope.message_type || record.message_type || content.message_type || "").toLowerCase();
    const mediaMimeType = String(media?.mime_type || media?.mimeType || "").toLowerCase();
    const isVoiceNote = messageType === "voice_note" || media?.voice_note === true;
    const isImage = messageType === "image" || mediaMimeType.startsWith("image/");
    const isAudio = messageType === "audio" || isVoiceNote || mediaMimeType.startsWith("audio/");
    const isDocument = messageType === "document" || messageType === "file";
    const image = content.imageMessage || envelope.image || record.image || (isImage ? media : undefined);
    const audio = content.audioMessage || content.pttMessage || envelope.audio || envelope.voice || record.audio || (isAudio ? media : undefined);
    const document = content.documentMessage || envelope.document || record.document || record.file || (isDocument ? media : undefined);
    const location = content.locationMessage || envelope.location || record.location;
    const extendedText = content.extendedTextMessage?.text || content.buttonsResponseMessage?.selectedDisplayText || content.templateButtonReplyMessage?.selectedDisplayText;
    const text = typeof rawMessage === "string" ? rawMessage
      : content.conversation || extendedText || image?.caption || audio?.caption || document?.caption || media?.caption || envelope.text || envelope.body || envelope.message_text || record.text || record.body || record.message_text || record.caption || record.buttonReply?.id || record.buttonReply?.title;
    const route = routeChoice(String(record.buttonReply?.id || record.buttonReply?.title || envelope.selectedButtonId || text || "").trim());
    const file = image || audio || document || media;
    const kind = location ? MessageKind.LOCATION : image || isImage ? MessageKind.IMAGE : audio || isAudio ? MessageKind.AUDIO : document || isDocument || media ? MessageKind.FILE : MessageKind.TEXT;
    const externalId = key.id || envelope.messageId || envelope.message_id || envelope.id || record.messageId || record.message_id || record.id || media?.id || `${phone}:${envelope.messageTimestamp || record.timestamp || Date.now()}`;
    const avatarUrl = envelope.profilePictureUrl || envelope.profilePicUrl || envelope.avatarUrl || record.profilePictureUrl || record.avatarUrl;
    const mediaUrl = file?.url || file?.link || file?.mediaUrl || envelope.mediaUrl || record.mediaUrl;

    messages.push({
      channel: Channel.WHATSAPP, externalConversationId: phone, externalCustomerId: phone, customerPhone: phone,
      customerName: envelope.pushName || envelope.name || envelope.contact?.name || record.pushName || record.name,
      profilePictureUrl: avatarUrl ? String(avatarUrl) : undefined,
      text: text === undefined ? undefined : String(text), kind,
      mediaUrl,
      latitude: location?.degreesLatitude ?? location?.latitude,
      longitude: location?.degreesLongitude ?? location?.longitude,
      externalId: `kalemly:${String(externalId)}`,
      metadata: {
        provider: "kalemlywa", originalJid: rawPhone, mediaId: file?.id || file?.media_id,
        mediaUrl, mediaMimeType: media?.mime_type || media?.mimeType, mediaExpiresAt: media?.expires_at,
        mediaSizeBytes: media?.size_bytes, mediaAvailable: media?.available, voiceNote: isVoiceNote
      },
      ...(route || {})
    });
  }

  return messages;
}
