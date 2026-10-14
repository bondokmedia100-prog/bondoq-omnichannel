import assert from "node:assert/strict";
import test from "node:test";
import { customerProfileSchema } from "./customerProfile";

test("customer profile accepts a name and trimmed notes", () => {
  assert.deepEqual(customerProfileSchema.parse({ displayName: "  آية  ", notes: "  تفضل الاتصال مساءً  " }), {
    displayName: "آية", notes: "تفضل الاتصال مساءً"
  });
});

test("customer profile accepts contact details and can clear them", () => {
  assert.deepEqual(customerProfileSchema.parse({ phone: "  +201001234567 ", email: "  user@example.com " }), {
    phone: "+201001234567", email: "user@example.com"
  });
  assert.deepEqual(customerProfileSchema.parse({ phone: "", email: null }), { phone: null, email: null });
  assert.equal(customerProfileSchema.safeParse({ email: "not-an-email" }).success, false);
});

test("customer profile can clear values and rejects empty or unknown updates", () => {
  assert.deepEqual(customerProfileSchema.parse({ displayName: "", notes: null }), { displayName: null, notes: null });
  assert.equal(customerProfileSchema.safeParse({}).success, false);
  assert.equal(customerProfileSchema.safeParse({ displayName: "عميل", extra: true }).success, false);
  assert.equal(customerProfileSchema.safeParse({ notes: "x".repeat(4001) }).success, false);
});
