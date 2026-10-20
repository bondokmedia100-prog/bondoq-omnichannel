import assert from "node:assert/strict";
import test from "node:test";
import { baileysPresenceIdentity } from "./whatsappPresence";

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
