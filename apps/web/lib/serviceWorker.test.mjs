import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");

function createWorker() {
  const listeners = new Map();
  const notifications = [];
  const self = {
    addEventListener: (name, listener) => listeners.set(name, listener),
    location: { origin: "https://bondoq.example" },
    registration: { showNotification: async (title, options) => notifications.push({ title, options }) },
    clients: { matchAll: async () => [], openWindow: async () => null }
  };
  vm.runInNewContext(source, { self, URL, Promise, caches: {}, fetch: async () => ({ ok: true }) });
  return { listeners, notifications };
}

test("shows a system notification with the conversation target and default OS sound enabled", async () => {
  const { listeners, notifications } = createWorker();
  let completed;
  listeners.get("push")({
    data: { json: () => ({ title: "عميل جديد", body: "أريد طلبًا", url: "/agent/workspace?conversation=abc", tag: "inbound-abc" }) },
    waitUntil: (promise) => { completed = promise; }
  });
  await completed;

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "عميل جديد");
  assert.equal(notifications[0].options.body, "أريد طلبًا");
  assert.equal(notifications[0].options.silent, false);
  assert.equal(notifications[0].options.data.url, "/agent/workspace?conversation=abc");
});
