import "dotenv/config";

const required = (key: string, fallback?: string) => {
  const value = process.env[key] || fallback;
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
};

export const config = {
  port: Number(process.env.PORT || 4000),
  webOrigin: process.env.WEB_ORIGIN || "http://localhost:3000",
  jwtSecret: required("JWT_SECRET", process.env.NODE_ENV === "production" ? undefined : "local-dev-only-change-me"),
  kalemlyApiUrl: process.env.KALEMLYWA_API_URL || "https://whatsapp.kalemly.com/api/send-message",
  kalemlyApiKey: process.env.KALEMLYWA_API_KEY || "",
  kalemlyInstanceId: process.env.KALEMLYWA_INSTANCE_ID || "",
  kalemlyWebhookSecret: process.env.KALEMLYWA_WEBHOOK_SECRET || "",
  kalemlyEncryptionKey: process.env.KALEMLYWA_CONFIG_ENCRYPTION_KEY || process.env.JWT_SECRET || "local-dev-only-change-me",
  metaAppSecret: process.env.META_APP_SECRET || "",
  metaVerifyToken: process.env.META_VERIFY_TOKEN || (process.env.NODE_ENV === "production" ? "" : "bondoq-webhook-verify"),
  metaPageToken: process.env.META_PAGE_ACCESS_TOKEN || "",
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiTranscriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1"
};
