import test from "node:test";
import assert from "node:assert/strict";
import { chooseRoundRobinAgent } from "./routingSelection";

test("round-robins across every online agent in order", () => {
  const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual([0, 1, 2, 3, 4].map((turn) => chooseRoundRobinAgent(agents, turn)?.id), ["a", "b", "c", "a", "b"]);
  assert.equal(chooseRoundRobinAgent(agents, -1)?.id, "c");
});

test("returns no assignee for an empty online pool", () => {
  assert.equal(chooseRoundRobinAgent([], 0), undefined);
});
