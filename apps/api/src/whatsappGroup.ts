export const WHATSAPP_GROUP_JID_SUFFIX = "@g.us";

export function isWhatsAppGroupJid(value: unknown): value is string {
  return typeof value === "string" && value.toLowerCase().endsWith(WHATSAPP_GROUP_JID_SUFFIX);
}

export function shouldAutoAssignConversation(channel: unknown, externalConversationId: unknown) {
  return channel !== "WHATSAPP" || !isWhatsAppGroupJid(externalConversationId);
}
