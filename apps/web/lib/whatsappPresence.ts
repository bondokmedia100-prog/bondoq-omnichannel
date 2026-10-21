type PresencePayload = { chatId?: string; conversationId?: string; cleanPhone?: string };

function lastTenDigits(value: unknown) {
  const digits = String(value || "")
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function matchesCustomerPresence(conversation: any, payload: PresencePayload) {
  if (!conversation) return false;
  const chatId = String(payload.chatId || payload.conversationId || "");
  if (chatId && conversation.id === chatId) return true;
  const target = lastTenDigits(payload.cleanPhone);
  if (target.length < 7) return false;
  const identifiers = [
    conversation.externalConversationId,
    conversation.externalCustomerId,
    conversation.customer?.phone,
    conversation.customer?.channelIdentifiers?.whatsapp
  ];
  return identifiers.some((value) => lastTenDigits(value) === target);
}
