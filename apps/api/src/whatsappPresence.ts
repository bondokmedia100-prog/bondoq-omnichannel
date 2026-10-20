import { normalizePhoneNumber, phoneNumberLookupVariants } from "./egyptianPhoneFormatter";
import { isWhatsAppGroupJid } from "./whatsappGroup";

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
