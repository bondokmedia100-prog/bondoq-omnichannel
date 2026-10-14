import webpush = require("web-push");
import { prisma } from "./prisma";
import { config } from "./config";

const pushConfigured = Boolean(config.vapidPublicKey && config.vapidPrivateKey);
if (pushConfigured) webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);

export function getPushConfig() {
  return { configured: pushConfigured, publicKey: pushConfigured ? config.vapidPublicKey : "" };
}

export async function sendPushNotification(userIds: string[], payload: { title: string; body: string; url: string; tag: string }) {
  if (!pushConfigured || !userIds.length) return;
  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId: { in: [...new Set(userIds)] } } });
  await Promise.allSettled(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(payload), { TTL: 60 * 60 });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) await prisma.pushSubscription.deleteMany({ where: { id: subscription.id } });
      else console.warn("Web Push delivery failed", statusCode || "unknown");
    }
  }));
}
