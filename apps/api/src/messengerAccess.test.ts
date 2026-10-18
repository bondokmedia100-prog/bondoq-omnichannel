import assert from "node:assert/strict";
import test from "node:test";
import { Department, MessengerAccessMode, Role } from "@prisma/client";
import { canReplyMessenger, canViewMessenger, effectiveMessengerAccess } from "./messengerAccess";

const principal = (overrides: Partial<Parameters<typeof effectiveMessengerAccess>[0]> = {}) => ({
  role: Role.AGENT,
  department: Department.HEADQUARTERS,
  messengerAccess: null,
  ...overrides
});

test("Messenger defaults route work-from-home to reply and customer care to view-only", () => {
  const workFromHome = principal({ department: Department.WORK_FROM_HOME });
  const customerCare = principal({ department: Department.CUSTOMER_CARE });
  const otherTeam = principal({ department: Department.DELIVERY });

  assert.equal(effectiveMessengerAccess(workFromHome), MessengerAccessMode.FULL);
  assert.equal(canReplyMessenger(workFromHome), true);
  assert.equal(effectiveMessengerAccess(customerCare), MessengerAccessMode.READ_ONLY);
  assert.equal(canViewMessenger(customerCare), true);
  assert.equal(canReplyMessenger(customerCare), false);
  assert.equal(canViewMessenger(otherTeam), false);
});

test("individual Messenger permission overrides the department mode", () => {
  const enabled = principal({ department: Department.CUSTOMER_CARE, messengerAccess: MessengerAccessMode.FULL });
  const excluded = principal({ department: Department.WORK_FROM_HOME, messengerAccess: MessengerAccessMode.DISABLED });

  assert.equal(canReplyMessenger(enabled), true);
  assert.equal(canViewMessenger(excluded), false);
});

test("a legacy routing opt-out prevents replies without overriding an explicit access mode", () => {
  const inherited = principal({ department: Department.WORK_FROM_HOME, canReceiveMessenger: false });
  const explicit = principal({ department: Department.WORK_FROM_HOME, canReceiveMessenger: false, messengerAccess: MessengerAccessMode.FULL });

  assert.equal(effectiveMessengerAccess(inherited), MessengerAccessMode.READ_ONLY);
  assert.equal(canReplyMessenger(inherited), false);
  assert.equal(canReplyMessenger(explicit), true);
});
