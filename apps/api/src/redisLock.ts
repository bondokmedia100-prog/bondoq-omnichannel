import { randomUUID } from "node:crypto";
import type IORedis from "ioredis";

const releaseScript = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const renewScript = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
type LockClient = Pick<IORedis, "set" | "eval">;

export async function withRedisLock<T>(
  redis: LockClient,
  key: string,
  work: () => Promise<T>,
  options: { leaseMs?: number; waitMs?: number; retryMs?: number } = {}
): Promise<T> {
  const leaseMs = options.leaseMs ?? 60_000;
  const deadline = Date.now() + (options.waitMs ?? 10_000);
  const retryMs = options.retryMs ?? 25;
  const token = randomUUID();

  while (await redis.set(key, token, "PX", leaseMs, "NX") !== "OK") {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out acquiring Redis lock: ${key}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryMs, remaining)));
  }

  let renewalPending = false;
  const renewal = setInterval(() => {
    if (renewalPending) return;
    renewalPending = true;
    void redis.eval(renewScript, 1, key, token, String(leaseMs)).catch(() => {}).finally(() => { renewalPending = false; });
  }, Math.max(10, Math.floor(leaseMs / 3)));
  renewal.unref?.();

  try {
    return await work();
  } finally {
    clearInterval(renewal);
    await redis.eval(releaseScript, 1, key, token).catch(() => {});
  }
}
