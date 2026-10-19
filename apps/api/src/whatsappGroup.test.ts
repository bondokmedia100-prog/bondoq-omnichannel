import assert from "node:assert/strict";
import test from "node:test";
import { isWhatsAppGroupJid } from "./whatsappGroup";

test("recognizes WhatsApp group JIDs without treating individual chats as groups", () => {
  assert.equal(isWhatsAppGroupJid("120363012345678901@g.us"), true);
  assert.equal(isWhatsAppGroupJid("120363012345678901@G.US"), true);
  assert.equal(isWhatsAppGroupJid("201001234567@s.whatsapp.net"), false);
  assert.equal(isWhatsAppGroupJid("status@broadcast"), false);
  assert.equal(isWhatsAppGroupJid(null), false);
});
