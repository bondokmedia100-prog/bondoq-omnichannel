import { prisma } from "./prisma";
import { DEFAULT_CHATBOT_SETTINGS, type ChatbotSettings } from "./autoReplies";

const settingsId = "default";

export async function getChatbotSettings(): Promise<ChatbotSettings> {
  const existing = await prisma.chatbotSettings.findUnique({ where: { id: settingsId } });
  if (existing) return existing;

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
