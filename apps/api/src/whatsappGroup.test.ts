import assert from "node:assert/strict";
import test from "node:test";
import { isWhatsAppGroupJid, shouldAutoAssignConversation } from "./whatsappGroup";

test("recognizes WhatsApp group JIDs without treating individual chats as groups", () => {
  assert.equal(isWhatsAppGroupJid("120363012345678901@g.us"), true);
  assert.equal(isWhatsAppGroupJid("120363012345678901@G.US"), true);
  assert.equal(isWhatsAppGroupJid("201001234567@s.whatsapp.net"), false);
  assert.equal(isWhatsAppGroupJid("status@broadcast"), false);
  assert.equal(isWhatsAppGroupJid(null), false);
});

test("keeps WhatsApp groups out of automatic assignment without affecting individual chats", () => {
  assert.equal(shouldAutoAssignConversation("WHATSAPP", "120363012345678901@g.us"), false);
  assert.equal(shouldAutoAssignConversation("WHATSAPP", "201001234567@s.whatsapp.net"), true);
  assert.equal(shouldAutoAssignConversation("TELEGRAM", "120363012345678901@g.us"), true);
});
