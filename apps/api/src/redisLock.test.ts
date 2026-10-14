import assert from "node:assert/strict";
import test from "node:test";
import type IORedis from "ioredis";
import { withRedisLock } from "./redisLock";

function createLockClient(): IORedis {
  const locks = new Map<string, string>();
  return {
    set: async (key: string, token: string) => {
      if (locks.has(key)) return null;
      locks.set(key, token);
      return "OK";
    },
    eval: async (_script: string, _keys: number, key: string, token: string) => {
      if (locks.get(key) === token) locks.delete(key);
      return 1;
    }
  } as unknown as IORedis;
}

test("serializes work sharing the same Redis lock", async () => {
  const redis = createLockClient();
  let active = 0;
  let peak = 0;
  const run = (value: number) => withRedisLock(redis, "same-conversation", async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return value;
  }, { retryMs: 1, waitMs: 500 });

  assert.deepEqual(await Promise.all([run(1), run(2)]), [1, 2]);
  assert.equal(peak, 1);
});

test("releases the Redis lock when work throws", async () => {
  const redis = createLockClient();
  await assert.rejects(withRedisLock(redis, "same-conversation", async () => { throw new Error("failed"); }));
  assert.equal(await withRedisLock(redis, "same-conversation", async () => "released"), "released");
});
