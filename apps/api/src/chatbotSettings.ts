import { prisma } from "./prisma";
import { DEFAULT_CHATBOT_SETTINGS, type ChatbotSettings } from "./autoReplies";

const settingsId = "default";

type MigratedSetting = "welcomeText" | "option1Label" | "option3Label" | "option4Label"
  | "option1ReplyText" | "option2ReplyText" | "option3ReplyText" | "option4ReplyText" | "option5ReplyText";

export function migrateLegacyChatbotSettings(existing: ChatbotSettings): Partial<Pick<ChatbotSettings, MigratedSetting>> {
  const migrated: Partial<Pick<ChatbotSettings, MigratedSetting>> = {};
  if (existing.welcomeText === "أهلاً بك في حلواني بندق.") migrated.welcomeText = DEFAULT_CHATBOT_SETTINGS.welcomeText;
  if (existing.option1Label === "الفروع ومواعيد العمل") migrated.option1Label = DEFAULT_CHATBOT_SETTINGS.option1Label;
  if (existing.option3Label === "طلبات الجملة") migrated.option3Label = DEFAULT_CHATBOT_SETTINGS.option3Label;
  if (existing.option4Label === "الشكاوى والاقتراحات") migrated.option4Label = DEFAULT_CHATBOT_SETTINGS.option4Label;
  const oldGenericReply = "برجاء الانتظار لحظات، سيتم تحويلك إلى ممثل خدمة العملاء المختص.";
  if (existing.option1ReplyText === oldGenericReply || existing.option1ReplyText === "لم تُضف بيانات الفروع ومواعيد العمل بعد.") migrated.option1ReplyText = DEFAULT_CHATBOT_SETTINGS.option1ReplyText;
  if (existing.option2ReplyText === oldGenericReply) migrated.option2ReplyText = DEFAULT_CHATBOT_SETTINGS.option2ReplyText;
  if (existing.option3ReplyText === oldGenericReply || existing.option3ReplyText === "برجاء الانتظار لحظات، سيتم تحويلك إلى ممثل طلبات الجملة المختص.") migrated.option3ReplyText = DEFAULT_CHATBOT_SETTINGS.option3ReplyText;
  if (existing.option4ReplyText === oldGenericReply || existing.option4ReplyText === "برجاء الانتظار لحظات، سيتم تحويلك إلى ممثل الشكاوى والاقتراحات المختص.") migrated.option4ReplyText = DEFAULT_CHATBOT_SETTINGS.option4ReplyText;
  if (existing.option5ReplyText === oldGenericReply) migrated.option5ReplyText = DEFAULT_CHATBOT_SETTINGS.option5ReplyText;
  return migrated;
}

export async function getChatbotSettings(): Promise<ChatbotSettings> {
  const existing = await prisma.chatbotSettings.findUnique({ where: { id: settingsId } });
  if (existing) {
    const migrated = migrateLegacyChatbotSettings(existing);
    if (Object.keys(migrated).length) return prisma.chatbotSettings.update({ where: { id: settingsId }, data: migrated });
    return existing;
  }

  const legacyWelcome = await prisma.autoReplyRule.findFirst({ where: { isWelcome: true }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] });
  return prisma.chatbotSettings.upsert({
    where: { id: settingsId },
    create: {
      id: settingsId,
      ...DEFAULT_CHATBOT_SETTINGS,
      ...(legacyWelcome ? {
        enabled: legacyWelcome.isActive,
        welcomeText: legacyWelcome.responseText === "أهلاً بك في حلواني بندق." ? DEFAULT_CHATBOT_SETTINGS.welcomeText : legacyWelcome.responseText
      } : {})
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
