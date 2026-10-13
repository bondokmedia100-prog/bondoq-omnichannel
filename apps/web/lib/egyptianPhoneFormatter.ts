const westernDigits = "0123456789";
const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
const egyptianMobile = /^201[0125][0-9]{8}$/;

export function formatEgyptianPhone(phone: string): string {
  let digits = phone
    .trim()
    .replace(/:\d+(?=@)/, "")
    .replace(/@.*$/, "")
    .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(persianDigits.indexOf(digit)))
    .replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("20")) digits = digits.slice(2);
  if (digits.length === 10 && /^[125]/.test(digits)) digits = `0${digits}`;
  const formatted = `20${digits.replace(/^0/, "")}`;
  if (!egyptianMobile.test(formatted)) throw new RangeError("أدخل رقم موبايل مصريًا صحيحًا");
  return formatted;
}

export function displayEgyptianPhone(phone?: string | null): string {
  if (!phone) return "غير متوفر";
  try {
    const national = `0${formatEgyptianPhone(phone).slice(2)}`;
    return `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)} (+20)`;
  } catch {
    return phone;
  }
}

export function egyptianPhoneNetwork(phone?: string | null): string {
  if (!phone) return "";
  try {
    const national = `0${formatEgyptianPhone(phone).slice(2)}`;
    return ({ "010": "فودافون", "011": "اتصالات", "012": "أورنج", "015": "WE" } as Record<string, string>)[national.slice(0, 3)] || "مصر";
  } catch {
    return "";
  }
}

export function egyptianPhoneSearchDigits(phone: string): string {
  return phone
    .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(persianDigits.indexOf(digit)))
    .replace(/\D/g, "");
}
