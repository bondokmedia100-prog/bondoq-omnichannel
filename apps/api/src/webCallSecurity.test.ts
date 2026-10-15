import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { createIceServers, createWebCallToken, hashWebCallToken, isWebCallToken } from "./webCallSecurity";

test("web-call invite tokens are unguessable-format capabilities stored as hashes", () => {
  const token = createWebCallToken();
  assert.equal(isWebCallToken(token), true);
  assert.equal(hashWebCallToken(token).length, 64);
  assert.notEqual(hashWebCallToken(token), hashWebCallToken(`${token}x`));
  assert.equal(isWebCallToken("short-token"), false);
});

test("ICE configuration creates expiring coturn REST credentials", () => {
  const now = 1_800_000_000_000;
  const servers = createIceServers({
    stunUrls: ["stun:stun.example.test:3478"],
    turnUrls: ["turn:turn.example.test:3478?transport=udp"],
    turnSharedSecret: "unit-test-secret",
    subject: "call-session",
    now
  });
  const username = `${Math.floor(now / 1000) + 3600}:call-session`;
  assert.deepEqual(servers[0], { urls: "stun:stun.example.test:3478" });
  assert.deepEqual(servers[1], {
    urls: ["turn:turn.example.test:3478?transport=udp"],
    username,
    credential: createHmac("sha1", "unit-test-secret").update(username).digest("base64"),
    credentialType: "password"
  });
});

test("ICE configuration remains usable with STUN when TURN is not configured", () => {
  assert.deepEqual(createIceServers({ stunUrls: ["stun:example.test"], turnUrls: ["turn:example.test"], turnSharedSecret: "", subject: "call" }), [{ urls: "stun:example.test" }]);
});
