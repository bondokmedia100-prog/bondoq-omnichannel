import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";

export const uploadLimitBytes = 12 * 1024 * 1024;

export const allowedMediaTypes = new Set([
  "image/jpeg", "image/png", "image/webp",
  "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/aac",
  "application/pdf", "text/plain",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);

export function safeFileName(value: string) {
  const normalized = value.normalize("NFKC").replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim();
  return (normalized || "attachment").slice(0, 160);
}

function signatureFor(assetId: string, expires: number) {
  return createHmac("sha256", config.mediaSigningSecret).update(`${assetId}:${expires || "permanent"}`).digest("hex");
}

export function publicMediaUrl(assetId: string, lifetimeSeconds = 24 * 60 * 60) {
  const baseUrl = config.apiPublicUrl || (process.env.NODE_ENV === "production" ? "" : `http://localhost:${config.port}`);
  if (!baseUrl) throw new Error("API_PUBLIC_URL must be set to send uploaded media");
  const parsedBase = new URL(baseUrl);
  const localHttpAllowed = process.env.NODE_ENV !== "production" && parsedBase.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsedBase.hostname);
  if (parsedBase.protocol !== "https:" && !localHttpAllowed || parsedBase.pathname !== "/" || parsedBase.search || parsedBase.hash || parsedBase.username || parsedBase.password) {
    throw new Error("API_PUBLIC_URL must be an HTTPS API origin");
  }
  const expires = lifetimeSeconds === 0 ? 0 : Math.floor(Date.now() / 1000) + lifetimeSeconds;
  const token = signatureFor(assetId, expires);
  return `${parsedBase.origin}/public-media/${encodeURIComponent(assetId)}?expires=${expires}&signature=${token}`;
}

export function verifyPublicMediaUrl(assetId: string, expiresValue: unknown, supplied: unknown) {
  if (typeof expiresValue !== "string" || typeof supplied !== "string" || !/^\d+$/.test(expiresValue)) return false;
  const expires = Number(expiresValue);
  const now = Math.floor(Date.now() / 1000);
  if (expires !== 0 && (expires < now || expires > now + 366 * 24 * 60 * 60)) return false;
  const expected = Buffer.from(signatureFor(assetId, expires));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
