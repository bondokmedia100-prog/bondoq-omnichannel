import assert from "node:assert/strict";
import test from "node:test";
import { hasMessageTextLinks, latestOutgoingTextMessage, mergeMessages, mergePendingMessage, messageNotificationPreview, splitMessageTextLinks } from "./messageHelpers";

test("merges duplicate real-time messages and retains chronological order", () => {
  const result = mergeMessages([
    { id: "later", createdAt: "2026-01-01T00:00:02.000Z", text: "later" },
    { id: "same", createdAt: "2026-01-01T00:00:01.000Z", text: "old" }
  ], [
    { id: "same", createdAt: "2026-01-01T00:00:01.000Z", text: "updated" },
    { id: "first", createdAt: "2026-01-01T00:00:00.000Z", text: "first" }
  ]);
  assert.deepEqual(result.map((message) => message.id), ["first", "same", "later"]);
  assert.equal(result[1].text, "updated");
});

test("reconciles a pending media bubble with its server message without losing the preview", () => {
  const result = mergePendingMessage([{
    id: "pending-123-abc",
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "AUDIO",
    localPreviewUrl: "blob:voice-preview",
    deliveryStatus: "UPLOADING"
  }], {
    id: "server-456",
    createdAt: "2026-01-01T00:00:01.000Z",
    kind: "AUDIO",
    mediaAssetId: "asset-789",
    deliveryStatus: "QUEUED"
  }, "pending-123-abc");

  assert.deepEqual(result.map((message) => message.id), ["server-456"]);
  assert.equal(result[0].localPreviewUrl, "blob:voice-preview");
  assert.equal(result[0].deliveryStatus, "QUEUED");
});

test("recalls the latest successfully sent text by the current agent", () => {
  const messages = [
    { id: "mine-1", direction: "OUTBOUND", authorId: "agent-1", kind: "TEXT", text: "Earlier", deliveryStatus: "READ" },
    { id: "theirs", direction: "INBOUND", authorId: "customer", kind: "TEXT", text: "Reply", deliveryStatus: "SENT" },
    { id: "failed", direction: "OUTBOUND", authorId: "agent-1", kind: "TEXT", text: "Unsent", deliveryStatus: "FAILED" },
    { id: "mine-2", direction: "OUTBOUND", authorId: "agent-1", kind: "TEXT", text: "Most recent", deliveryStatus: "DELIVERED" }
  ];

  assert.equal(latestOutgoingTextMessage(messages, "agent-1")?.id, "mine-2");
  assert.equal(latestOutgoingTextMessage(messages, undefined), undefined);
});

test("uses message content or a useful media label for notifications", () => {
  assert.equal(messageNotificationPreview({ text: "  هل لديكم توصيل؟  " }), "هل لديكم توصيل؟");
  assert.equal(messageNotificationPreview({ kind: "AUDIO" }), "رسالة صوتية جديدة");
  assert.equal(messageNotificationPreview({ kind: "IMAGE" }), "صورة جديدة");
  assert.equal(messageNotificationPreview({ kind: "STICKER" }), "ملصق جديد");
  assert.equal(messageNotificationPreview(), "رسالة جديدة");
});

test("linkifies only safe web URLs and leaves trailing punctuation as text", () => {
  const parts = splitMessageTextLinks("شوف https://example.com/path. وبعدها www.example.org!");
  assert.deepEqual(parts, [
    { text: "شوف " },
    { text: "https://example.com/path", href: "https://example.com/path" },
    { text: ". وبعدها " },
    { text: "www.example.org", href: "https://www.example.org/" },
    { text: "!" }
  ]);
  assert.equal(hasMessageTextLinks("javascript:alert(1)"), false);
});
