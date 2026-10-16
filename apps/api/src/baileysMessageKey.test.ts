import assert from "node:assert/strict";
import test from "node:test";
import { parseStoredBaileysMessageKey, serializeBaileysMessageKey } from "./baileysMessageKey";

test("Baileys outbound keys round-trip without losing provider fields", () => {
  const key = { remoteJid: "123:4@s.whatsapp.net", id: "ABC:DEF", fromMe: true, participant: "agent@s.whatsapp.net" };
  const externalId = serializeBaileysMessageKey(key)!;
  assert.deepEqual(parseStoredBaileysMessageKey(`WHATSAPP:${externalId}`, "OUTBOUND"), key);
});

test("legacy inbound Baileys IDs still reconstruct their remote JID", () => {
  assert.deepEqual(parseStoredBaileysMessageKey("WHATSAPP:baileys:123@s.whatsapp.net:ABC", "INBOUND"), {
    remoteJid: "123@s.whatsapp.net", id: "ABC", fromMe: false
  });
});

test("only complete outbound provider keys are serialized", () => {
  assert.equal(serializeBaileysMessageKey({ remoteJid: "123@s.whatsapp.net", id: "ABC", fromMe: false }), undefined);
  assert.equal(serializeBaileysMessageKey({ remoteJid: "123@s.whatsapp.net", fromMe: true }), undefined);
  assert.equal(parseStoredBaileysMessageKey("WHATSAPP:baileys-key:invalid", "OUTBOUND"), null);
  const inboundKey = `WHATSAPP:baileys-key:${Buffer.from(JSON.stringify({ remoteJid: "123@s.whatsapp.net", id: "ABC", fromMe: false })).toString("base64url")}`;
  assert.equal(parseStoredBaileysMessageKey(inboundKey, "OUTBOUND"), null);
});
