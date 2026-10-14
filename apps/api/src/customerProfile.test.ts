import assert from "node:assert/strict";
import test from "node:test";
import { customerProfileSchema } from "./customerProfile";

test("customer profile accepts a name and trimmed notes", () => {
  assert.deepEqual(customerProfileSchema.parse({ displayName: "  آية  ", notes: "  تفضل الاتصال مساءً  " }), {
    displayName: "آية", notes: "تفضل الاتصال مساءً"
  });
});

test("customer profile can clear values and rejects empty or unknown updates", () => {
  assert.deepEqual(customerProfileSchema.parse({ displayName: "", notes: null }), { displayName: null, notes: null });
  assert.equal(customerProfileSchema.safeParse({}).success, false);
  assert.equal(customerProfileSchema.safeParse({ displayName: "عميل", extra: true }).success, false);
  assert.equal(customerProfileSchema.safeParse({ notes: "x".repeat(4001) }).success, false);
});
