import assert from "node:assert/strict";
import test from "node:test";
import { accessibleConversationSearchScope, messageContentSearchWhere, normalizeSearchDigits } from "./search";

test("normalizes Arabic and Persian phone digits for search", () => {
  assert.equal(normalizeSearchDigits("+٢٠ (١٠) ١٢٣٤-٥٦٧٨"), "201012345678");
  assert.equal(normalizeSearchDigits("۰۱۰۱۲۳۴۵۶۷۸"), "01012345678");
  assert.equal(normalizeSearchDigits("Mona 123"), "123");
});

test("searches message text and audio transcription case-insensitively", () => {
  assert.deepEqual(messageContentSearchWhere("  order update  "), {
    OR: [
      { text: { contains: "order update", mode: "insensitive" } },
      { transcription: { contains: "order update", mode: "insensitive" } }
    ]
  });
});

test("keeps historical search within the agent's readable conversations", () => {
  assert.deepEqual(accessibleConversationSearchScope("agent-1", "branch-1", ["MESSENGER"]), {
    branchId: "branch-1",
    OR: [
      { assignedAgentId: "agent-1" },
      { channel: { in: ["MESSENGER"] } },
      { assignmentHistory: { some: { agentId: "agent-1" } } },
      { messages: { some: { authorId: "agent-1" } } },
      { internalNotes: { some: { authorId: "agent-1" } } },
      { whatsappCallSessions: { some: { agentId: "agent-1" } } }
    ]
  });
});
