import assert from "node:assert/strict";
import test from "node:test";
import { createMeteredIceServers, createMeteredTurnCredentialProvider } from "./meteredTurn";

test("Metered TURN credentials become available after propagation and are cached", async () => {
  let currentTime = 1_800_000_000_000;
  let requests = 0;
  const provider = createMeteredTurnCredentialProvider({
    domain: "bondoq.metered.live",
    secretKey: "server-secret",
    expiryInSeconds: 3600,
    now: () => currentTime,
    fetcher: async () => {
      requests += 1;
      return { ok: true, json: async () => ({ username: "turn-user", password: "turn-password", expiryInSeconds: 3600 }) } as Response;
    }
  });

  assert.equal(await provider.getCredential(), null);
  assert.equal(requests, 1);
  currentTime += 120_000;
  assert.deepEqual(await provider.getCredential(), { username: "turn-user", password: "turn-password" });
  assert.deepEqual(await provider.getCredential(), { username: "turn-user", password: "turn-password" });
  assert.equal(requests, 1);
});

test("Metered ICE servers include global UDP, TCP, and TLS relays", () => {
  const servers = createMeteredIceServers(["stun:stun.example.test"], { username: "turn-user", password: "turn-password" });
  assert.deepEqual(servers, [
    { urls: "stun:stun.example.test" },
    { urls: "stun:stun.relay.metered.ca:80" },
    {
      urls: [
        "turn:global.relay.metered.ca:80",
        "turn:global.relay.metered.ca:80?transport=tcp",
        "turn:global.relay.metered.ca:443",
        "turns:global.relay.metered.ca:443?transport=tcp"
      ],
      username: "turn-user",
      credential: "turn-password",
      credentialType: "password"
    }
  ]);
});
