import { prisma } from "./prisma";
import { DEFAULT_CHATBOT_SETTINGS, type ChatbotSettings } from "./autoReplies";

const settingsId = "default";

export async function getChatbotSettings(): Promise<ChatbotSettings> {
  const existing = await prisma.chatbotSettings.findUnique({ where: { id: settingsId } });
  if (existing) {
    const migrated: Partial<Pick<ChatbotSettings, "option1ReplyText" | "option3ReplyText" | "option4ReplyText">> = {};
    if (existing.option1ReplyText === "لم تُضف بيانات الفروع ومواعيد العمل بعد.") migrated.option1ReplyText = DEFAULT_CHATBOT_SETTINGS.option1ReplyText;
    if (existing.option3ReplyText === "برجاء الانتظار لحظات، سيتم تحويلك إلى ممثل طلبات الجملة المختص.") migrated.option3ReplyText = DEFAULT_CHATBOT_SETTINGS.option3ReplyText;
    if (existing.option4ReplyText === "برجاء الانتظار لحظات، سيتم تحويلك إلى ممثل الشكاوى والاقتراحات المختص.") migrated.option4ReplyText = DEFAULT_CHATBOT_SETTINGS.option4ReplyText;
    if (Object.keys(migrated).length) return prisma.chatbotSettings.update({ where: { id: settingsId }, data: migrated });
    return existing;
  }

  const legacyWelcome = await prisma.autoReplyRule.findFirst({ where: { isWelcome: true }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] });
  return prisma.chatbotSettings.upsert({
    where: { id: settingsId },
    create: {
      id: settingsId,
      ...DEFAULT_CHATBOT_SETTINGS,
      ...(legacyWelcome ? { enabled: legacyWelcome.isActive, welcomeText: legacyWelcome.responseText } : {})
    },
    update: {}
  });
}

export async function saveChatbotSettings(settings: ChatbotSettings) {
  return prisma.chatbotSettings.upsert({
    where: { id: settingsId },
    create: { id: settingsId, ...settings },
    update: settings
  });
}
