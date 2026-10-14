import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";

export const uploadLimitBytes = 12 * 1024 * 1024;

export const allowedMediaTypes = new Set([
  "image/jpeg", "image/png", "image/webp",
  "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/aac",
  "video/mp4", "video/3gpp", "video/quicktime",
  "application/pdf", "text/plain",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);

export function safeFileName(value: string) {
  const normalized = value.normalize("NFKC").replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim();
  return (normalized || "attachment").slice(0, 160);
}

export function imageSignatureMatches(contentType: string, bytes: Buffer) {
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === "image/webp") return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return !contentType.startsWith("image/");
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
