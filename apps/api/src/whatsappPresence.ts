import { normalizePhoneNumber, phoneNumberLookupVariants } from "./egyptianPhoneFormatter";
import { isWhatsAppGroupJid } from "./whatsappGroup";

export type CustomerPresenceState = "typing" | "recording" | "paused";

export type KalemlyPresenceUpdate = {
  rawJid: string;
  cleanPhone: string;
  state: CustomerPresenceState;
  conversationId?: string;
};

export function baileysPresenceIdentity(value: string) {
  const raw = value.trim();
  if (!raw || isWhatsAppGroupJid(raw)) return null;

  if (/@lid$/i.test(raw)) return { jid: raw, jidAliases: [raw], phoneAliases: [] as string[] };

  try {
    const phone = normalizePhoneNumber(raw);
    return {
      jid: `${phone}@s.whatsapp.net`,
      jidAliases: [...new Set([raw, `${phone}@s.whatsapp.net`])],
      phoneAliases: phoneNumberLookupVariants(phone)
    };
  } catch {
    return null;
  }
}

export function normalizeCustomerPresenceState(value: unknown): CustomerPresenceState | null {
  const state = String(value || "").trim().toLowerCase().replace(/[ -]/g, "_");
  if (["composing", "typing", "chatting"].includes(state)) return "typing";
  if (["recording", "recording_audio", "recording_ptt"].includes(state)) return "recording";
  if (["paused", "available", "unavailable", "inactive", "idle"].includes(state)) return "paused";
  return null;
}

function isPresenceEvent(value: unknown) {
  const event = String(value || "").trim().toLowerCase().replace(/[._\s-]/g, "");
  return ["presenceupdate", "presence", "chatstate", "typing", "recording"].includes(event);
}

function stringField(record: any, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" || typeof value === "number") {
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
  }
  return "";
}

export function parseKalemlyPresenceUpdates(body: any): KalemlyPresenceUpdate[] {
  const roots = [body, body?.data, body?.payload, body?.data?.data, body?.data?.payload, body?.payload?.data, body?.payload?.payload]
    .filter((value) => value && typeof value === "object");
  const eventValues = roots.flatMap((record) => [record.event, record.type, record.eventType, record.event_type, record.action]);
  if (!eventValues.some(isPresenceEvent)) return [];

  const records: any[] = [];
  for (const root of roots) {
    for (const key of ["updates", "presences", "participants", "chats"]) {
      const value = root?.[key];
      if (Array.isArray(value)) records.push(...value);
      else if (value && typeof value === "object") {
        records.push(...Object.entries(value).map(([jid, presence]) => ({ ...(presence as any), remoteJid: (presence as any)?.remoteJid || jid })));
      }
    }
    records.push(root);
  }

  const updates = new Map<string, KalemlyPresenceUpdate>();
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const nestedPresence = record.presence && typeof record.presence === "object" ? record.presence : undefined;
    const stateValue = stringField(record, ["state", "status", "activity", "chat_state", "chatState", "lastKnownPresence"])
      || (typeof record.presence === "string" ? record.presence : "")
      || stringField(nestedPresence, ["state", "status", "activity", "lastKnownPresence"])
      || eventValues.find((value) => normalizeCustomerPresenceState(value));
    const state = normalizeCustomerPresenceState(stateValue);
    if (!state) continue;

    const participant = record.participant && typeof record.participant === "object" ? record.participant : undefined;
    const contact = record.contact && typeof record.contact === "object" ? record.contact : undefined;
    const sender = record.sender && typeof record.sender === "object" ? record.sender : undefined;
    const rawJid = stringField(record, ["remoteJid", "remote_jid", "remoteJidAlt", "remote_jid_alt", "jid", "participantJid", "participant_jid", "waId", "wa_id", "chatId", "chat_id", "from", "phone", "phoneNumber", "number", "id"])
      || stringField(participant, ["remoteJid", "jid", "phone", "number", "id"])
      || (typeof record.participant === "string" ? record.participant.trim() : "")
      || stringField(contact, ["remoteJid", "jid", "phone", "number", "id"])
      || stringField(sender, ["remoteJid", "jid", "phone", "number", "id"])
      || stringField(nestedPresence, ["remoteJid", "jid", "phone", "number", "id"]);
    const phoneValue = stringField(record, ["phone", "phoneNumber", "phone_number", "number"])
      || stringField(participant, ["phone", "phoneNumber", "phone_number", "number"])
      || stringField(contact, ["phone", "phoneNumber", "phone_number", "number"])
      || stringField(sender, ["phone", "phoneNumber", "phone_number", "number"]);
    const phoneIdentity = phoneValue ? baileysPresenceIdentity(phoneValue) : null;
    const resolvedRawJid = rawJid || phoneValue;
    const rawIdentity = baileysPresenceIdentity(resolvedRawJid);
    const cleanPhone = phoneIdentity?.phoneAliases[0] || rawIdentity?.phoneAliases[0] || "";
    const explicitConversationId = stringField(record, ["conversationId", "conversation_id", "internalConversationId"]);
    const chatId = stringField(record, ["chatId", "chat_id"]);
    const conversationId = explicitConversationId || (chatId && !baileysPresenceIdentity(chatId) ? chatId : "");
    if (!resolvedRawJid && !conversationId) continue;

    const update = { rawJid: resolvedRawJid || conversationId, cleanPhone, state, ...(conversationId ? { conversationId } : {}) };
    updates.set(`${update.rawJid}:${update.state}:${conversationId}`, update);
  }
  return [...updates.values()];
}
