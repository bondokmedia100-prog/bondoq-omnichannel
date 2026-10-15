import assert from "node:assert/strict";
import test from "node:test";
import { isIrishCloudPhoneNumber, normalizeCloudCallTarget, parseCloudCallPermission } from "./whatsappCalling";

test("requires the Irish Cloud API number for outbound calls", () => {
  assert.equal(isIrishCloudPhoneNumber("+353 87 123 4567"), true);
  assert.equal(isIrishCloudPhoneNumber("353871234567"), true);
  assert.equal(isIrishCloudPhoneNumber("+20 10 1234 5678"), false);
});

test("normalizes customer targets to Cloud API digits", () => {
  assert.equal(normalizeCloudCallTarget("+353 (87) 123-4567"), "353871234567");
  assert.equal(normalizeCloudCallTarget("٠١٠١٢٣٤٥٦٧٨"), "201012345678");
  assert.throws(() => normalizeCloudCallTarget("not-a-phone"), /رقم/);
});

test("reads permission status and call action limits from Meta", () => {
  assert.deepEqual(parseCloudCallPermission({ data: [{
    permission: { status: "temporary", expiration_timestamp: "1790000000" },
    actions: [
      { action_name: "start_call", can_perform_action: true },
      { action_name: "send_call_permission_request", can_perform_action: false }
    ]
  }] }), { status: "temporary", expiration: 1790000000, canStartCall: true, canRequestPermission: false });
});
