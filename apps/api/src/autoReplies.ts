export type AutoReplyRuleMatch = {
  keywords: string[];
  responseText: string;
  routingDepartment?: string | null;
};

export const AUTO_REPLY_MENU_TEXT = "أهلاً بك في حلواني بندق، برجاء اختيار الخدمة المطلوبة بإرسال رقم الخدمة:\n1. الفروع\n2. طلب أوردر جديد\n3. خدمة العملاء\n4. الشكاوى\n5. التواصل مع الإدارة\n6. طلبات الجملة";
export const AUTO_REPLY_HANDOFF_TEXT = "برجاء الانتظار لحظات، سيتم تحويلك إلى ممثل خدمة العملاء.";
export const AUTO_REPLY_RESTART_MS = 12 * 60 * 60 * 1000;

export type ServiceChoice = { number: number; label: string; routingDepartment: "CUSTOMER_CARE" | "DELIVERY" | "QUALITY" | "HEADQUARTERS"; isComplaint: boolean };

const serviceChoices: Record<number, ServiceChoice> = {
  1: { number: 1, label: "الفروع", routingDepartment: "CUSTOMER_CARE", isComplaint: false },
  2: { number: 2, label: "طلب أوردر جديد", routingDepartment: "DELIVERY", isComplaint: false },
  3: { number: 3, label: "خدمة العملاء", routingDepartment: "CUSTOMER_CARE", isComplaint: false },
  4: { number: 4, label: "الشكاوى", routingDepartment: "QUALITY", isComplaint: true },
  5: { number: 5, label: "التواصل مع الإدارة", routingDepartment: "HEADQUARTERS", isComplaint: false },
  6: { number: 6, label: "طلبات الجملة", routingDepartment: "HEADQUARTERS", isComplaint: false }
};

const servicePayloads: Record<string, number> = {
  route_branches: 1,
  route_menu: 1,
  route_delivery: 2,
  route_cakes: 2,
  route_customer_care: 3,
  route_quality: 4,
  route_admin: 5,
  route_wholesale: 6
};

function normalizeArabic(value: string) {
  return value.toLocaleLowerCase("ar-EG")
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[\u064B-\u065F\u0670ـ]/g, "")
    .replace(/\s+/g, " ").trim();
}

export function getServiceChoice(value?: string | null): ServiceChoice | undefined {
  if (!value?.trim()) return undefined;
  const normalized = normalizeArabic(value);
  const payloadNumber = servicePayloads[normalized];
  if (payloadNumber) return serviceChoices[payloadNumber];
  const departmentChoice: Record<string, number> = { delivery: 2, quality: 4, headquarters: 5, customer_care: 3 };
  if (departmentChoice[normalized]) return serviceChoices[departmentChoice[normalized]];
  const match = normalized.match(/^(?:رقم\s*)?([1-6])(?:\s*[.)\-:]\s*.*)?$/u);
  return match ? serviceChoices[Number(match[1])] : undefined;
}

export function findMatchingAutoReply<T extends AutoReplyRuleMatch>(rules: T[], text?: string) {
  if (!text?.trim()) return undefined;
  const normalizedText = normalizeArabic(text);
  return rules.find((rule) => rule.keywords.some((keyword) => {
    const normalizedKeyword = normalizeArabic(keyword);
    return normalizedKeyword.length > 0 && normalizedText.includes(normalizedKeyword);
  }));
}
