export type AutoReplyRuleMatch = {
  keywords: string[];
  responseText: string;
  routingDepartment?: string | null;
};

export type BotState = "BOT_MENU" | "ASSIGNED_TO_AGENT";
export type ChatbotSettings = {
  enabled: boolean;
  welcomeText: string;
  invalidChoiceText: string;
  option1Label: string;
  option2Label: string;
  option3Label: string;
  option4Label: string;
  option5Label: string;
  option1ReplyText: string;
  option2ReplyText: string;
  option3ReplyText: string;
  option4ReplyText: string;
  option5ReplyText: string;
};

export const DEFAULT_CHATBOT_SETTINGS: ChatbotSettings = {
  enabled: true,
  welcomeText: "أهلاً بك في حلواني بندق.",
  invalidChoiceText: "عذرًا، يرجى إرسال رقم الاختيار المطلوب فقط (من 1 إلى 5) لنتمكن من توجيهك للقسم الصحيح.",
  option1Label: "الفروع ومواعيد العمل",
  option2Label: "خدمة العملاء",
  option3Label: "طلبات الجملة",
  option4Label: "الشكاوى والاقتراحات",
  option5Label: "غير ذلك",
  option1ReplyText: "لم تُضف بيانات الفروع ومواعيد العمل بعد.",
  option2ReplyText: "برجاء الانتظار لحظات، سيتم تحويلك إلى ممثل خدمة العملاء المختص.",
  option3ReplyText: "برجاء الانتظار لحظات، سيتم تحويلك إلى ممثل طلبات الجملة المختص.",
  option4ReplyText: "برجاء الانتظار لحظات، سيتم تحويلك إلى ممثل الشكاوى والاقتراحات المختص.",
  option5ReplyText: "برجاء الانتظار لحظات، سيتم تحويلك إلى ممثل خدمة العملاء المختص."
};

export const AUTO_REPLY_MENU_TEXT = buildRoutingMenuText(DEFAULT_CHATBOT_SETTINGS);

export type ServiceChoice = { number: number; label: string; routingDepartment: "CUSTOMER_CARE" | "DELIVERY" | "QUALITY" | "HEADQUARTERS"; isComplaint: boolean };

const serviceDepartments: Record<number, ServiceChoice["routingDepartment"]> = {
  1: "CUSTOMER_CARE",
  2: "CUSTOMER_CARE",
  3: "HEADQUARTERS",
  4: "QUALITY",
  5: "CUSTOMER_CARE"
};

const legacyPayloadChoices: Record<string, number> = {
  route_branches: 1,
  route_menu: 1,
  route_customer_care: 2,
  route_wholesale: 3,
  route_quality: 4,
  route_other: 5,
  route_delivery: 2,
  route_cakes: 2,
  route_admin: 5
};

function normalizeArabic(value: string) {
  return value.toLocaleLowerCase("ar-EG")
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[\u064B-\u065F\u0670ـ]/g, "")
    .replace(/\s+/g, " ").trim();
}

export function buildRoutingMenuText(settings: ChatbotSettings = DEFAULT_CHATBOT_SETTINGS) {
  return `${settings.welcomeText.trim() || DEFAULT_CHATBOT_SETTINGS.welcomeText}\nيرجى اختيار رقم الخدمة المطلوبة:\n1. ${settings.option1Label}\n2. ${settings.option2Label}\n3. ${settings.option3Label}\n4. ${settings.option4Label}\n5. ${settings.option5Label}`;
}

export function getServiceChoice(value?: string | null, settings: ChatbotSettings = DEFAULT_CHATBOT_SETTINGS): ServiceChoice | undefined {
  if (!value?.trim()) return undefined;
  const normalized = normalizeArabic(value);
  const payloadNumber = legacyPayloadChoices[normalized];
  const match = normalized.match(/^(?:رقم\s*)?([1-5])(?:\s*[.)\-:]\s*.*)?$/u);
  const number = payloadNumber || (match ? Number(match[1]) : undefined);
  if (!number) return undefined;
  const labels = [settings.option1Label, settings.option2Label, settings.option3Label, settings.option4Label, settings.option5Label];
  return { number, label: labels[number - 1], routingDepartment: serviceDepartments[number], isComplaint: number === 4 };
}

export type BotDecision =
  | { action: "MENU"; nextState: "BOT_MENU" }
  | { action: "BRANCHES"; nextState: "BOT_MENU"; choice: ServiceChoice }
  | { action: "HANDOFF"; nextState: "ASSIGNED_TO_AGENT"; choice: ServiceChoice }
  | { action: "INVALID"; nextState: "BOT_MENU" }
  | { action: "BYPASS"; nextState: "ASSIGNED_TO_AGENT" }
  | { action: "NONE"; nextState: BotState };

export function decideBotAction(input: { enabled: boolean; state: BotState; starting: boolean; text?: string | null; settings: ChatbotSettings }): BotDecision {
  if (!input.enabled) return input.starting || input.state === "BOT_MENU"
    ? { action: "BYPASS", nextState: "ASSIGNED_TO_AGENT" }
    : { action: "NONE", nextState: input.state };
  if (input.starting) return { action: "MENU", nextState: "BOT_MENU" };
  if (input.state !== "BOT_MENU") return { action: "NONE", nextState: input.state };
  const choice = getServiceChoice(input.text, input.settings);
  if (!choice) return { action: "INVALID", nextState: "BOT_MENU" };
  if (choice.number === 1) return { action: "BRANCHES", nextState: "BOT_MENU", choice };
  return { action: "HANDOFF", nextState: "ASSIGNED_TO_AGENT", choice };
}

export function buildBranchReplyText(settings: ChatbotSettings) {
  return `${settings.option1ReplyText.trim()}\n\nللتحدث مع ممثل خدمة العملاء أرسل الرقم 2.`;
}

export function findMatchingAutoReply<T extends AutoReplyRuleMatch>(rules: T[], text?: string) {
  if (!text?.trim()) return undefined;
  const normalizedText = normalizeArabic(text);
  return rules.find((rule) => rule.keywords.some((keyword) => {
    const normalizedKeyword = normalizeArabic(keyword);
    return normalizedKeyword.length > 0 && normalizedText.includes(normalizedKeyword);
  }));
}
