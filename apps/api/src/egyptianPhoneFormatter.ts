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

export function egyptianPhoneNetwork(phone: string): string {
  const national = `0${formatEgyptianPhone(phone).slice(2)}`;
  return ({ "010": "Vodafone", "011": "Etisalat", "012": "Orange", "015": "WE" } as Record<string, string>)[national.slice(0, 3)];
}
