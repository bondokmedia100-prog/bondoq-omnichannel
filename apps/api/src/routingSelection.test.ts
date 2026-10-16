import test from "node:test";
import assert from "node:assert/strict";
import { canReceiveChannel, channelEligibilityWhere, chooseRoundRobinAgent } from "./routingSelection";

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
