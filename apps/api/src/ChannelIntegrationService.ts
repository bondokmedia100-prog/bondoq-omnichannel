import { prisma } from "./prisma";
import { config } from "./config";
import { decryptKalemlySecret, encryptKalemlySecret } from "./KalemlyWaService";

const messengerId = "messenger";
const telegramId = "telegram";

export async function getMessengerSettings() {
  const saved = await prisma.integrationSetting.findUnique({ where: { id: messengerId } });
  return {
    pageId: saved?.instanceId || "",
    pageAccessToken: saved?.apiKeyCiphertext ? decryptKalemlySecret(saved.apiKeyCiphertext) : config.metaPageToken,
    appSecret: saved?.appSecretCiphertext ? decryptKalemlySecret(saved.appSecretCiphertext) : config.metaAppSecret,
    verifyToken: saved?.verifyTokenCiphertext ? decryptKalemlySecret(saved.verifyTokenCiphertext) : config.metaVerifyToken
  };
}

export async function saveMessengerSettings(input: { pageId?: string; pageAccessToken?: string; appSecret?: string; verifyToken?: string }) {
  await prisma.integrationSetting.upsert({
    where: { id: messengerId },
    update: {
      endpoint: "https://graph.facebook.com/v21.0",
      ...(input.pageId === undefined ? {} : { instanceId: input.pageId.trim() || null }),
      ...(input.pageAccessToken?.trim() ? { apiKeyCiphertext: encryptKalemlySecret(input.pageAccessToken.trim()) } : {}),
      ...(input.appSecret?.trim() ? { appSecretCiphertext: encryptKalemlySecret(input.appSecret.trim()) } : {}),
      ...(input.verifyToken?.trim() ? { verifyTokenCiphertext: encryptKalemlySecret(input.verifyToken.trim()) } : {})
    },
    create: {
      id: messengerId,
      endpoint: "https://graph.facebook.com/v21.0",
      instanceId: input.pageId?.trim() || null,
      apiKeyCiphertext: input.pageAccessToken?.trim() ? encryptKalemlySecret(input.pageAccessToken.trim()) : null,
      appSecretCiphertext: input.appSecret?.trim() ? encryptKalemlySecret(input.appSecret.trim()) : null,
      verifyTokenCiphertext: input.verifyToken?.trim() ? encryptKalemlySecret(input.verifyToken.trim()) : null
    }
  });
  return getMessengerSettings();
}

export async function getTelegramSettings() {
  const saved = await prisma.integrationSetting.findUnique({ where: { id: telegramId } });
  return {
    botUsername: saved?.instanceId || "",
    botToken: saved?.apiKeyCiphertext ? decryptKalemlySecret(saved.apiKeyCiphertext) : config.telegramToken,
    webhookSecret: saved?.verifyTokenCiphertext ? decryptKalemlySecret(saved.verifyTokenCiphertext) : process.env.TELEGRAM_WEBHOOK_SECRET || ""
  };
}

export async function saveTelegramSettings(input: { botUsername?: string; botToken?: string; webhookSecret?: string }) {
  await prisma.integrationSetting.upsert({
    where: { id: telegramId },
    update: {
      endpoint: "https://api.telegram.org",
      ...(input.botUsername === undefined ? {} : { instanceId: input.botUsername.trim().replace(/^@/, "") || null }),
      ...(input.botToken?.trim() ? { apiKeyCiphertext: encryptKalemlySecret(input.botToken.trim()) } : {}),
      ...(input.webhookSecret?.trim() ? { verifyTokenCiphertext: encryptKalemlySecret(input.webhookSecret.trim()) } : {})
    },
    create: {
      id: telegramId,
      endpoint: "https://api.telegram.org",
      instanceId: input.botUsername?.trim().replace(/^@/, "") || null,
      apiKeyCiphertext: input.botToken?.trim() ? encryptKalemlySecret(input.botToken.trim()) : null,
      verifyTokenCiphertext: input.webhookSecret?.trim() ? encryptKalemlySecret(input.webhookSecret.trim()) : null
    }
  });
  return getTelegramSettings();
}
