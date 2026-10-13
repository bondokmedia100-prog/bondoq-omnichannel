const westernDigits = "0123456789";
const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
const egyptianMobile = /^201[0125][0-9]{8}$/;

export function normalizePhoneNumber(phone: string): string {
  const normalized = phone.trim()
    .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(persianDigits.indexOf(digit)));
  if (!normalized || /@(?:g\.us|lid)$/i.test(normalized)) throw new RangeError("أدخل رقمًا دوليًا صحيحًا");

  const atIndex = normalized.indexOf("@");
  const subscriber = (atIndex < 0 ? normalized : normalized.slice(0, atIndex)).replace(/:\d+$/, "");
  const hasInternationalPrefix = subscriber.startsWith("+") || subscriber.startsWith("00");
  const isWhatsAppJid = atIndex >= 0 && /@(?:s\.whatsapp\.net|c\.us)$/i.test(normalized);
  let digits = subscriber.replace(/\D/g, "");

  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!hasInternationalPrefix && !isWhatsAppJid && /^(?:0?1[0125]\d{8})$/.test(digits)) {
    digits = `20${digits.replace(/^0/, "")}`;
  } else if (!hasInternationalPrefix && !isWhatsAppJid && digits.startsWith("0")) {
    throw new RangeError("استخدم رمز الدولة للأرقام غير المصرية، مثل ‎+968");
  }

  if (!/^[1-9]\d{6,14}$/.test(digits)) throw new RangeError("أدخل رقمًا دوليًا بصيغة E.164");
  return digits;
}

export function formatEgyptianPhone(phone: string): string {
  const formatted = normalizePhoneNumber(phone);
  if (!egyptianMobile.test(formatted)) throw new RangeError("أدخل رقم موبايل مصريًا صحيحًا");
  return formatted;
}

export function egyptianPhoneNetwork(phone: string): string {
  const national = `0${formatEgyptianPhone(phone).slice(2)}`;
  return ({ "010": "Vodafone", "011": "Etisalat", "012": "Orange", "015": "WE" } as Record<string, string>)[national.slice(0, 3)];
}
