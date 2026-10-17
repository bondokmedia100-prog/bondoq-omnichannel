export type AutoReplyRuleMatch = {
  keywords: string[];
  responseText: string;
  routingDepartment?: string | null;
};

export type BotState = "BOT_MENU" | "ASSIGNED_TO_AGENT";
export const BOT_MENU_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
export type ChatbotSettings = {
  enabled: boolean;
  welcomeText: string;
  agentHandoffGreeting: string;
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
  businessHoursEnabled: boolean;
  businessDays: string[];
  businessStart: string;
  businessEnd: string;
  offHoursReplyEnabled: boolean;
  offHoursReplyText: string;
};

export const DEFAULT_CHATBOT_SETTINGS: ChatbotSettings = {
  enabled: true,
  welcomeText: "برجاء اختيار الاختيار المناسب لحضرتك",
  agentHandoffGreeting: "أهلاً {customer}، معاك {agent} من خدمة العملاء في حلواني بندق. كيف أستطيع مساعدتك؟",
  invalidChoiceText: "عذرًا، يرجى إرسال رقم الاختيار المطلوب فقط (من 1 إلى 5) لنتمكن من توجيهك للقسم الصحيح.",
  option1Label: "الفروع",
  option2Label: "خدمة العملاء",
  option3Label: "طلبات الجمله",
  option4Label: "الشكاوي والاقتراحات",
  option5Label: "غير ذلك",
  option1ReplyText: "برجاء الانتظار لحظات، سيتم توجيهك إلى ممثل خدمة العملاء المختص بالفروع ومواعيد العمل.",
  option2ReplyText: "برجاء الانتظار لحظات، سيتم تحويلك إلى ممثل خدمة العملاء المختص.",
  option3ReplyText: "برجاء الانتظار لحظات، سيتم توجيهك إلى ممثل خدمة العملاء المختص بطلبات الجملة.",
  option4ReplyText: "برجاء الانتظار لحظات، سيتم توجيهك إلى ممثل خدمة العملاء المختص بالشكاوي والاقتراحات.",
  option5ReplyText: "برجاء الانتظار لحظات، سيتم توجيهك إلى ممثل خدمة العملاء لمساعدتك.",
  businessHoursEnabled: false,
  businessDays: ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY"],
  businessStart: "09:00",
  businessEnd: "17:00",
  offHoursReplyEnabled: true,
  offHoursReplyText: "شكرًا لتواصلك معنا. أوقات العمل انتهت، وسنعاود الرد عليك في أقرب وقت عمل."
};

export const AUTO_REPLY_MENU_TEXT = buildRoutingMenuText(DEFAULT_CHATBOT_SETTINGS);

export type ServiceChoice = { number: number; label: string; routingDepartment: "CUSTOMER_CARE"; isComplaint: boolean };

const serviceDepartments: Record<number, ServiceChoice["routingDepartment"]> = {
  1: "CUSTOMER_CARE",
  2: "CUSTOMER_CARE",
  3: "CUSTOMER_CARE",
  4: "CUSTOMER_CARE",
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
  return [
    settings.welcomeText.trim() || DEFAULT_CHATBOT_SETTINGS.welcomeText,
    `1 ${settings.option1Label}`,
    `2 ${settings.option2Label}`,
    `3 ${settings.option3Label}`,
    `4 ${settings.option4Label}`,
    `5 ${settings.option5Label}`
  ].join("\n");
}

export function formatAgentHandoffGreeting(template: string, customerName: string | null | undefined, agentName: string | null | undefined) {
  return (template.trim() || DEFAULT_CHATBOT_SETTINGS.agentHandoffGreeting)
    .replaceAll("{customer}", customerName?.trim() || "")
    .replaceAll("{agent}", agentName?.trim() || "فريق خدمة العملاء")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([،,])/g, "$1");
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
  return { action: "HANDOFF", nextState: "ASSIGNED_TO_AGENT", choice };
}

export function shouldStartBotFlow(lastInboundAt: Date | null | undefined, isTerminal: boolean, currentAt: Date, manuallyInitiated = false) {
  if (manuallyInitiated) return false;
  if (isTerminal || !lastInboundAt) return true;
  return currentAt.getTime() - lastInboundAt.getTime() >= BOT_MENU_IDLE_TIMEOUT_MS;
}

export function findMatchingAutoReply<T extends AutoReplyRuleMatch>(rules: T[], text?: string) {
  if (!text?.trim()) return undefined;
  const normalizedText = normalizeArabic(text);
  return rules.find((rule) => rule.keywords.some((keyword) => {
    const normalizedKeyword = normalizeArabic(keyword);
    return normalizedKeyword.length > 0 && normalizedText.includes(normalizedKeyword);
  }));
}
