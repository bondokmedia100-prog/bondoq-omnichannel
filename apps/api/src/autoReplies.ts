export type AutoReplyRuleMatch = {
  keywords: string[];
  responseText: string;
  routingDepartment?: string | null;
};

const DEFAULT_MENU_GREETING = "أهلاً بك في حلواني بندق، برجاء اختيار الخدمة المطلوبة بإرسال رقم الخدمة:";
const SERVICE_MENU_OPTIONS = "1. الفروع\n2. خدمة العملاء\n3. طلبات الجملة\n4. الشكاوى والاقتراحات\n5. غير ذلك";

export function buildRoutingMenuText(greeting?: string | null) {
  return `${greeting?.trim() || DEFAULT_MENU_GREETING}\n${SERVICE_MENU_OPTIONS}`;
}

export const AUTO_REPLY_MENU_TEXT = buildRoutingMenuText();
export const AUTO_REPLY_HANDOFF_TEXT = "برجاء الانتظار لحظات، سيتم تحويلك إلى ممثل خدمة العملاء.";
export const AUTO_REPLY_RESTART_MS = 12 * 60 * 60 * 1000;

export type ServiceChoice = { number: number; label: string; routingDepartment: "CUSTOMER_CARE" | "DELIVERY" | "QUALITY" | "HEADQUARTERS"; isComplaint: boolean };

const serviceChoices: Record<number, ServiceChoice> = {
  1: { number: 1, label: "الفروع", routingDepartment: "CUSTOMER_CARE", isComplaint: false },
  2: { number: 2, label: "خدمة العملاء", routingDepartment: "CUSTOMER_CARE", isComplaint: false },
  3: { number: 3, label: "طلبات الجملة", routingDepartment: "HEADQUARTERS", isComplaint: false },
  4: { number: 4, label: "الشكاوى والاقتراحات", routingDepartment: "QUALITY", isComplaint: true },
  5: { number: 5, label: "غير ذلك", routingDepartment: "CUSTOMER_CARE", isComplaint: false }
};

const legacyPayloadChoices: Record<string, ServiceChoice> = {
  route_delivery: { number: 2, label: "طلب أوردر جديد", routingDepartment: "DELIVERY", isComplaint: false },
  route_cakes: { number: 2, label: "طلب أوردر جديد", routingDepartment: "DELIVERY", isComplaint: false },
  route_admin: { number: 5, label: "التواصل مع الإدارة", routingDepartment: "HEADQUARTERS", isComplaint: false }
};

const servicePayloads: Record<string, number> = {
  route_branches: 1,
  route_menu: 1,
  route_customer_care: 2,
  route_wholesale: 3,
  route_quality: 4,
  route_other: 5
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
  if (legacyPayloadChoices[normalized]) return legacyPayloadChoices[normalized];
  const payloadNumber = servicePayloads[normalized];
  if (payloadNumber) return serviceChoices[payloadNumber];
  const departmentChoice: Record<string, number> = { quality: 4, headquarters: 3, customer_care: 2 };
  if (departmentChoice[normalized]) return serviceChoices[departmentChoice[normalized]];
  const match = normalized.match(/^(?:رقم\s*)?([1-5])(?:\s*[.)\-:]\s*.*)?$/u);
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
