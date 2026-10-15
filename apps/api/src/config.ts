import "dotenv/config";

const required = (key: string, fallback?: string) => {
  const value = process.env[key] || fallback;
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
};

export const config = {
  port: Number(process.env.PORT || 4000),
  apiPublicUrl: (process.env.API_PUBLIC_URL || "").replace(/\/+$/, ""),
  webOrigin: process.env.WEB_ORIGIN || "http://localhost:3000",
  resendApiKey: process.env.RESEND_API_KEY || "",
  emailFrom: process.env.EMAIL_FROM || "",
  passwordResetRecoveryEmail: process.env.PASSWORD_RESET_RECOVERY_EMAIL || "mahmoudsalamagsm@gmail.com",
  jwtSecret: required("JWT_SECRET", process.env.NODE_ENV === "production" ? undefined : "local-dev-only-change-me"),
  kalemlyApiUrl: process.env.KALEMLYWA_API_URL || "https://whatsapp.kalemly.com/api/send-message",
  kalemlyAuthKey: process.env.KALEMLYWA_AUTH_KEY || process.env.KALEMLYWA_API_KEY || "",
  kalemlyAppKey: process.env.KALEMLYWA_APP_KEY || process.env.KALEMLYWA_API_KEY || "",
  kalemlyWebhookSecret: process.env.KALEMLYWA_WEBHOOK_SECRET || "",
  kalemlyEncryptionKey: process.env.KALEMLYWA_CONFIG_ENCRYPTION_KEY || process.env.JWT_SECRET || "local-dev-only-change-me",
  mediaSigningSecret: process.env.MEDIA_SIGNING_SECRET || process.env.KALEMLYWA_CONFIG_ENCRYPTION_KEY || process.env.JWT_SECRET || "local-dev-only-change-me",
  metaAppSecret: process.env.META_APP_SECRET || "",
  metaVerifyToken: process.env.META_VERIFY_TOKEN || (process.env.NODE_ENV === "production" ? "" : "bondoq-webhook-verify"),
  metaPageToken: process.env.META_PAGE_ACCESS_TOKEN || "",
  whatsappCloudPhoneNumberId: process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID || "",
  whatsappCloudAccessToken: process.env.WHATSAPP_CLOUD_ACCESS_TOKEN || "",
  whatsappCloudApiVersion: process.env.WHATSAPP_CLOUD_API_VERSION || "v23.0",
  whatsappCloudVerifyToken: process.env.WHATSAPP_CLOUD_VERIFY_TOKEN || "",
  whatsappCloudAppSecret: process.env.WHATSAPP_CLOUD_APP_SECRET || "",
  whatsappCloudCallPermissionTemplate: process.env.WHATSAPP_CLOUD_CALL_PERMISSION_TEMPLATE || "",
  whatsappCloudCallPermissionLanguage: process.env.WHATSAPP_CLOUD_CALL_PERMISSION_LANGUAGE || "ar",
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiTranscriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1",
  slaResponseMinutes: Math.max(1, Number.parseInt(process.env.SLA_RESPONSE_MINUTES || "5", 10) || 5),
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || "",
  vapidSubject: process.env.VAPID_SUBJECT || "mailto:admin@bondoq.com"
};
