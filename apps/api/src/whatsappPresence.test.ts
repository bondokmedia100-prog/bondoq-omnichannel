import assert from "node:assert/strict";
import test from "node:test";
import { baileysPresenceIdentity, normalizeCustomerPresenceState, parseKalemlyPresenceUpdates } from "./whatsappPresence";

test("normalizes phone-only conversation IDs for Baileys subscriptions", () => {
  const identity = baileysPresenceIdentity("01012345678");
  assert.equal(identity?.jid, "201012345678@s.whatsapp.net");
  assert.deepEqual(identity?.phoneAliases, ["201012345678", "00201012345678", "01012345678", "1012345678"]);
});

test("normalizes device JIDs while retaining the stored identifier alias", () => {
  const identity = baileysPresenceIdentity("96891234567:12@s.whatsapp.net");
  assert.equal(identity?.jid, "96891234567@s.whatsapp.net");
  assert.deepEqual(identity?.jidAliases, ["96891234567:12@s.whatsapp.net", "96891234567@s.whatsapp.net"]);
});

test("keeps LIDs exact and excludes groups or invalid identities", () => {
  assert.deepEqual(baileysPresenceIdentity("unknown@lid"), {
    jid: "unknown@lid",
    jidAliases: ["unknown@lid"],
    phoneAliases: []
  });
  assert.equal(baileysPresenceIdentity("123@g.us"), null);
  assert.equal(baileysPresenceIdentity("not-a-phone"), null);
});

test("normalizes customer presence states from Baileys and Kalemly labels", () => {
  assert.equal(normalizeCustomerPresenceState("composing"), "typing");
  assert.equal(normalizeCustomerPresenceState("typing"), "typing");
  assert.equal(normalizeCustomerPresenceState("recording"), "recording");
  assert.equal(normalizeCustomerPresenceState("available"), "paused");
  assert.equal(normalizeCustomerPresenceState("paused"), "paused");
});

test("parses nested Kalemly presence events with normalized phone and status", () => {
  assert.deepEqual(parseKalemlyPresenceUpdates({
    event: "presence.update",
    data: { remoteJid: "+20 10 1234 5678@c.us", presence: { lastKnownPresence: "composing" } }
  }), [{ rawJid: "+20 10 1234 5678@c.us", cleanPhone: "201012345678", state: "typing" }]);
  assert.deepEqual(parseKalemlyPresenceUpdates({
    type: "chat_state",
    payload: { phone: "01012345678", state: "recording" }
  }), [{ rawJid: "01012345678", cleanPhone: "201012345678", state: "recording" }]);
});

test("parses internal chat identifiers and ignores unrelated Kalemly webhooks", () => {
  assert.deepEqual(parseKalemlyPresenceUpdates({
    event: "typing",
    data: { conversationId: "conversation-123" }
  }), [{ rawJid: "conversation-123", cleanPhone: "", state: "typing", conversationId: "conversation-123" }]);
  assert.deepEqual(parseKalemlyPresenceUpdates({
    event: "message.inbound",
    data: { phone: "201012345678", state: "typing" }
  }), []);
});
