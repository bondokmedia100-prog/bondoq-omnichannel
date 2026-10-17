import assert from "node:assert/strict";
import test from "node:test";
import { formatEgyptianPhone, normalizePhoneNumber, phoneNumberLookupVariants, phoneNumbersMatch } from "./egyptianPhoneFormatter";
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

test("accepts international numbers with different country-code lengths", () => {
  assert.equal(normalizePhoneNumber("+1 415 555 2671"), "14155552671");
  assert.equal(normalizePhoneNumber("+91 98765 43210"), "919876543210");
});

test("matches international WhatsApp IDs and differently formatted phone values", () => {
  assert.equal(phoneNumbersMatch("+20 10 1234 5678", "201012345678@s.whatsapp.net"), true);
  assert.equal(phoneNumbersMatch("0044 7911 123456", "+44 (0) 7911 123456"), true);
  assert.equal(phoneNumbersMatch("unknown@lid", "+968 9123 4567"), false);
});

test("creates equivalent lookup variants for Egyptian customer numbers", () => {
  assert.deepEqual(phoneNumberLookupVariants("٠١٠١٢٣٤٥٦٧٨"), [
    "201012345678", "00201012345678", "01012345678", "1012345678"
  ]);
  assert.deepEqual(phoneNumberLookupVariants("+968 9123 4567"), ["96891234567", "0096891234567"]);
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

test("parses Kalemly temporary voice-note media IDs", () => {
  const [message] = parseKalemlyWebhook({
    event: "message.inbound",
    data: {
      from: "201001234567@s.whatsapp.net",
      phone: "201001234567",
      message_type: "voice_note",
      media: {
        available: true,
        id: "voice-media-1",
        mime_type: "audio/ogg; codecs=opus",
        size_bytes: 24576,
        voice_note: true,
        expires_at: "2026-10-15T12:00:00.000Z"
      }
    }
  });

  assert.equal(message.kind, "AUDIO");
  assert.equal(message.mediaUrl, undefined);
  assert.equal(message.metadata?.mediaId, "voice-media-1");
  assert.equal(message.metadata?.mediaMimeType, "audio/ogg; codecs=opus");
  assert.equal(message.metadata?.voiceNote, true);
});

test("parses Kalemly media metadata for inbound images", () => {
  const [message] = parseKalemlyWebhook({
    event: "message.inbound",
    data: {
      from: "201001234567@s.whatsapp.net",
      phone: "201001234567",
      message_type: "image",
      media: { available: true, id: "image-media-1", mime_type: "image/jpeg", size_bytes: 128000 }
    }
  });

  assert.equal(message.kind, "IMAGE");
  assert.equal(message.metadata?.mediaId, "image-media-1");
  assert.equal(message.metadata?.mediaAvailable, true);
});
