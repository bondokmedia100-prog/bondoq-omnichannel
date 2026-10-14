import test from "node:test";
import assert from "node:assert/strict";
import { chooseLeastLoadedAgent } from "./routingSelection";

test("round-robins ties among the least-loaded agents", () => {
  const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const counts = new Map([["a", 1], ["b", 1], ["c", 3]]);
  assert.deepEqual([0, 1, 2, 3].map((turn) => chooseLeastLoadedAgent(agents, counts, turn)?.id), ["a", "b", "a", "b"]);
});

test("returns no assignee for an empty online pool", () => {
  assert.equal(chooseLeastLoadedAgent([], new Map(), 0), undefined);
});
