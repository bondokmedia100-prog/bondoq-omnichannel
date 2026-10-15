import assert from "node:assert/strict";
import test from "node:test";
import { mergeMessages, messageNotificationPreview } from "./messageHelpers";

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

test("uses message content or a useful media label for notifications", () => {
  assert.equal(messageNotificationPreview({ text: "  هل لديكم توصيل؟  " }), "هل لديكم توصيل؟");
  assert.equal(messageNotificationPreview({ kind: "AUDIO" }), "رسالة صوتية جديدة");
  assert.equal(messageNotificationPreview({ kind: "IMAGE" }), "صورة جديدة");
  assert.equal(messageNotificationPreview({ kind: "STICKER" }), "ملصق جديد");
  assert.equal(messageNotificationPreview(), "رسالة جديدة");
});
