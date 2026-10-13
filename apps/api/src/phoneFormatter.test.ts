import assert from "node:assert/strict";
import test from "node:test";
import { formatEgyptianPhone, normalizePhoneNumber } from "./egyptianPhoneFormatter";
import { parseKalemlyWebhook } from "./kalemlyWebhookParser";

test("normalizes Egyptian local numbers without changing their stored identity", () => {
  assert.equal(normalizePhoneNumber("01012345678"), "201012345678");
  assert.equal(normalizePhoneNumber("٠١٠١٢٣٤٥٦٧٨"), "201012345678");
  assert.equal(formatEgyptianPhone("+20 10 1234 5678"), "201012345678");
});

test("accepts international E.164 numbers and WhatsApp JIDs", () => {
  assert.equal(normalizePhoneNumber("+968 9123 4567"), "96891234567");
  assert.equal(normalizePhoneNumber("96891234567:12@s.whatsapp.net"), "96891234567");
  assert.equal(normalizePhoneNumber("0044 7911 123456"), "447911123456");
});

test("rejects ambiguous non-Egyptian local numbers and non-person JIDs", () => {
  assert.throws(() => normalizePhoneNumber("02079460000"));
  assert.throws(() => normalizePhoneNumber("123456@g.us"));
  assert.throws(() => normalizePhoneNumber("+123456"));
});

test("prefers Kalemly's canonical phone field over a different JID", () => {
  const [message] = parseKalemlyWebhook({
    event: "message.inbound",
    data: {
      from: "96891234567@s.whatsapp.net",
      sender: "96891234567@s.whatsapp.net",
      phone: "201012345678",
      message: "مرحبا",
      id: "incoming-1"
    }
  });

  assert.equal(message.customerPhone, "201012345678");
  assert.equal(message.externalConversationId, "201012345678");
  assert.equal(message.text, "مرحبا");
});

test("falls through unparseable identities to another international sender field", () => {
  const [message] = parseKalemlyWebhook({
    event: "message.inbound",
    data: { phone: "123@g.us", sender: "unknown@lid", from: "+96891234567", text: "Hello" }
  });

  assert.equal(message.customerPhone, "96891234567");
});

test("does not treat delivery status events as inbound messages", () => {
  assert.deepEqual(parseKalemlyWebhook({ event: "message.status", data: { phone: "201012345678", text: "delivered" } }), []);
});
