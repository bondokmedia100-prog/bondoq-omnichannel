import assert from "node:assert/strict";
import test from "node:test";
import { weeklyAgentPerformance } from "./weeklyAgentPerformance";

test("counts weekly authored replies and unique conversations", () => {
  assert.deepEqual(weeklyAgentPerformance(["agent-a", "agent-b", "agent-c"], [
    { authorId: "agent-a", count: 3 },
    { authorId: "agent-b", count: 1 }
  ], [
    { authorId: "agent-a", conversationId: "one" },
    { authorId: "agent-a", conversationId: "two" },
    { authorId: "agent-b", conversationId: "two" },
    { authorId: null, conversationId: "ignored" }
  ]), {
    "agent-a": { weeklyReplies: 3, weeklyConversations: 2 },
    "agent-b": { weeklyReplies: 1, weeklyConversations: 1 },
    "agent-c": { weeklyReplies: 0, weeklyConversations: 0 }
  });
});
