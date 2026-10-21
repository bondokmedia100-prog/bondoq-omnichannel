import assert from "node:assert/strict";
import test from "node:test";
import { baileysDeliveryStatus, baileysReceiptDate, isDeliveryStatusAdvance } from "./baileysReceipt";

test("maps Baileys acknowledgement levels to delivery states", () => {
  assert.equal(baileysDeliveryStatus({ update: { status: 2 } }), null);
  assert.equal(baileysDeliveryStatus({ update: { status: 3 } }), "DELIVERED");
  assert.equal(baileysDeliveryStatus({ update: { status: 4 } }), "READ");
  assert.equal(baileysDeliveryStatus({ update: { status: 5 } }), "PLAYED");
});

test("maps receipt timestamps and named acknowledgements", () => {
  assert.equal(baileysDeliveryStatus({ receipt: { receiptTimestamp: 1 } }), "DELIVERED");
  assert.equal(baileysDeliveryStatus({ receipt: { readTimestamp: 1 } }), "READ");
  assert.equal(baileysDeliveryStatus({ receipt: { playedTimestamp: 1 } }), "PLAYED");
  assert.equal(baileysDeliveryStatus({ status: "DELIVERY_ACK" }), "DELIVERED");
  assert.equal(baileysDeliveryStatus({ status: "READ" }), "READ");
});

test("accepts only forward delivery-state transitions", () => {
  assert.equal(isDeliveryStatusAdvance("SENT", "DELIVERED"), true);
  assert.equal(isDeliveryStatusAdvance("DELIVERED", "READ"), true);
  assert.equal(isDeliveryStatusAdvance("READ", "PLAYED"), true);
  assert.equal(isDeliveryStatusAdvance("PLAYED", "READ"), false);
  assert.equal(isDeliveryStatusAdvance("DELIVERED", "DELIVERED"), false);
});

test("receipt timestamps are converted from provider seconds and invalid values fall back", () => {
  assert.equal(baileysReceiptDate({ receipt: { readTimestamp: 1_700_000_000 } }, "READ").toISOString(), "2023-11-14T22:13:20.000Z");
  const fallback = new Date("2024-01-01T00:00:00Z");
  assert.equal(baileysReceiptDate({ receipt: {} }, "DELIVERED", fallback), fallback);
});
