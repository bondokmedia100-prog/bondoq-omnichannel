import test from "node:test";
import assert from "node:assert/strict";
import { canReceiveChannel, channelEligibilityWhere, chooseRoundRobinAgent, isEligibleForAutomaticAssignment, shouldReassignUnansweredConversation } from "./routingSelection";

test("round-robins across every online agent in order", () => {
  const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual([0, 1, 2, 3, 4].map((turn) => chooseRoundRobinAgent(agents, turn)?.id), ["a", "b", "c", "a", "b"]);
  assert.deepEqual([0, 1, 2, 3].map((turn) => chooseRoundRobinAgent(agents.slice(0, 2), turn)?.id), ["a", "b", "a", "b"]);
  assert.equal(chooseRoundRobinAgent(agents, -1)?.id, "c");
});

test("returns no assignee for an empty online pool", () => {
  assert.equal(chooseRoundRobinAgent([], 0), undefined);
});

test("maps supported channels to the matching agent eligibility field", () => {
  const agent = { canReceiveWhatsApp: true, canReceiveMessenger: false, canReceiveTelegram: true };
  assert.deepEqual(channelEligibilityWhere("WHATSAPP"), { canReceiveWhatsApp: true });
  assert.deepEqual(channelEligibilityWhere("MESSENGER"), { canReceiveMessenger: true });
  assert.deepEqual(channelEligibilityWhere("TELEGRAM"), { canReceiveTelegram: true });
  assert.equal(canReceiveChannel(agent, "WHATSAPP"), true);
  assert.equal(canReceiveChannel(agent, "MESSENGER"), false);
  assert.equal(canReceiveChannel(agent, "TELEGRAM"), true);
  assert.equal(canReceiveChannel({}, "WHATSAPP"), false);
});

test("automatic assignment requires active, online, connected agents with full access", () => {
  const base = { isActive: true, presence: "ONLINE", connected: true, fullAccess: true };
  assert.equal(isEligibleForAutomaticAssignment(base), true);
  assert.equal(isEligibleForAutomaticAssignment({ ...base, presence: "BREAK" }), false);
  assert.equal(isEligibleForAutomaticAssignment({ ...base, presence: "OFFLINE" }), false);
  assert.equal(isEligibleForAutomaticAssignment({ ...base, connected: false }), false);
  assert.equal(isEligibleForAutomaticAssignment({ ...base, isActive: false }), false);
  assert.equal(isEligibleForAutomaticAssignment({ ...base, fullAccess: false }), false);
});

test("reassigns only the same active conversation when its latest inbound is unanswered", () => {
  const inboundAt = new Date("2026-10-16T00:00:00.000Z");
  const expected = { assignedAgentId: "agent-a", inboundAt };
  const conversation = { status: "OPEN", assignedAgentId: "agent-a", lastInboundAt: inboundAt, lastAgentResponseAt: null };
  assert.equal(shouldReassignUnansweredConversation(conversation, expected), true);
  assert.equal(shouldReassignUnansweredConversation({ ...conversation, assignedAgentId: "agent-b" }, expected), false);
  assert.equal(shouldReassignUnansweredConversation({ ...conversation, lastInboundAt: new Date(inboundAt.getTime() + 1) }, expected), false);
  assert.equal(shouldReassignUnansweredConversation({ ...conversation, lastAgentResponseAt: inboundAt }, expected), false);
  assert.equal(shouldReassignUnansweredConversation({ ...conversation, status: "RESOLVED" }, expected), false);
});
