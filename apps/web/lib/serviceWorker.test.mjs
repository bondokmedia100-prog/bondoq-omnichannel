import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));

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

test("shows a branded system notification with the conversation target and OS sound enabled", async () => {
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
  assert.equal(notifications[0].options.icon, "/icon-192.png");
  assert.equal(notifications[0].options.badge, "/icon-192.png");
  assert.equal(notifications[0].options.silent, false);
  assert.equal(notifications[0].options.data.url, "/agent/workspace?conversation=abc");
});

test("manifest uses available PNG icons for installable apps", async () => {
  assert.deepEqual(manifest.icons.map(({ src, sizes, type, purpose }) => ({ src, sizes, type, purpose })), [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
  ]);
  for (const icon of manifest.icons) {
    const iconFile = await stat(new URL(`../public/${icon.src.slice(1)}`, import.meta.url));
    assert.ok(iconFile.size > 0, `${icon.src} should exist`);
  }
});
