import type { IceServerConfig } from "./webCallSecurity";

export type MeteredTurnCredential = { username: string; password: string };

type CachedCredential = MeteredTurnCredential & { expiresAt: number; usableAt: number };

const expiryInSeconds = Math.max(600, Number.parseInt(process.env.METERED_TURN_CREDENTIAL_EXPIRY_SECONDS || "3600", 10) || 3600);
const provider = process.env.METERED_TURN_DOMAIN && process.env.METERED_TURN_SECRET_KEY
  ? createMeteredTurnCredentialProvider({ domain: process.env.METERED_TURN_DOMAIN, secretKey: process.env.METERED_TURN_SECRET_KEY, expiryInSeconds })
  : null;
let currentCredential: MeteredTurnCredential | null = null;

if (provider) {
  const poll = async () => {
    currentCredential = await provider.getCredential();
    const timer = setTimeout(() => void poll(), currentCredential ? 30_000 : 5_000);
    timer.unref?.();
  };
  void poll();
}

export function getMeteredTurnCredential() {
  return currentCredential;
}

export function createMeteredTurnCredentialProvider(options: {
  domain: string;
  secretKey: string;
  expiryInSeconds: number;
  fetcher?: typeof fetch;
  now?: () => number;
  propagationDelayMs?: number;
}) {
  const domain = options.domain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const isMeteredDomain = /^[a-z0-9-]+\.metered\.live$/i.test(domain);
  const fetcher = options.fetcher || fetch;
  const now = options.now || Date.now;
  const propagationDelayMs = options.propagationDelayMs ?? 120_000;
  const refreshAheadMs = Math.min(10 * 60_000, options.expiryInSeconds * 1000 / 3);
  let active: CachedCredential | null = null;
  let pending: CachedCredential | null = null;
  let refreshPromise: Promise<void> | null = null;
  let retryAfter = 0;

  async function refresh() {
    if (!isMeteredDomain || !options.secretKey || refreshPromise || now() < retryAfter) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const response = await fetcher(`https://${domain}/api/v1/turn/credential?secretKey=${encodeURIComponent(options.secretKey)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expiryInSeconds: options.expiryInSeconds, label: "bondoq-web-call" })
        });
        if (!response.ok) throw new Error("Metered TURN credential request failed");
        const result = await response.json() as { username?: unknown; password?: unknown; expiryInSeconds?: unknown };
        if (typeof result.username !== "string" || !result.username || typeof result.password !== "string" || !result.password) {
          throw new Error("Metered TURN credential response is invalid");
        }
        const ttl = typeof result.expiryInSeconds === "number" && Number.isInteger(result.expiryInSeconds) && result.expiryInSeconds > 0
          ? result.expiryInSeconds
          : options.expiryInSeconds;
        const createdAt = now();
        pending = { username: result.username, password: result.password, expiresAt: createdAt + ttl * 1000, usableAt: createdAt + propagationDelayMs };
        retryAfter = 0;
      } catch {
        retryAfter = now() + 30_000;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  async function getCredential(): Promise<MeteredTurnCredential | null> {
    let currentTime = now();
    if (pending && pending.usableAt <= currentTime) {
      active = pending;
      pending = null;
    }
    if (!active && !pending) await refresh();
    currentTime = now();
    if (pending && pending.usableAt <= currentTime) {
      active = pending;
      pending = null;
    }
    if (active && active.expiresAt > currentTime) {
      if (!pending && active.expiresAt - currentTime <= refreshAheadMs) void refresh();
      return { username: active.username, password: active.password };
    }
    return null;
  }

  return { getCredential };
}

export function createMeteredIceServers(stunUrls: string[], credential: MeteredTurnCredential): IceServerConfig[] {
  const urls = [...new Set([
    "turn:global.relay.metered.ca:80",
    "turn:global.relay.metered.ca:80?transport=tcp",
    "turn:global.relay.metered.ca:443",
    "turns:global.relay.metered.ca:443?transport=tcp"
  ])];
  const stuns = [...new Set([...stunUrls, "stun:stun.relay.metered.ca:80"])];
  return [
    ...stuns.map((url) => ({ urls: url })),
    { urls, username: credential.username, credential: credential.password, credentialType: "password" }
  ];
}
