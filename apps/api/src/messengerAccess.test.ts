import assert from "node:assert/strict";
import test from "node:test";
import { Channel, Department, MessengerAccessMode, Role } from "@prisma/client";
import { canReplyMessenger, canViewMessenger, effectiveChannelAccess, effectiveMessengerAccess } from "./messengerAccess";

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

test("WhatsApp and Telegram inherit the same department access modes as Messenger", () => {
  for (const channel of [Channel.WHATSAPP, Channel.TELEGRAM]) {
    assert.equal(effectiveChannelAccess(principal({ department: Department.WORK_FROM_HOME }), channel), MessengerAccessMode.FULL);
    assert.equal(effectiveChannelAccess(principal({ department: Department.CUSTOMER_CARE }), channel), MessengerAccessMode.READ_ONLY);
    assert.equal(effectiveChannelAccess(principal({ department: Department.DELIVERY }), channel), MessengerAccessMode.DISABLED);
    for (const department of [Department.HEADQUARTERS, Department.BRANCH, Department.ADMINISTRATION, Department.CAKES, Department.QUALITY]) {
      assert.equal(effectiveChannelAccess(principal({ department }), channel), MessengerAccessMode.DISABLED);
    }
  }
});

test("Messenger keeps the deployed department default matrix", () => {
  assert.equal(effectiveMessengerAccess(principal({ department: Department.WORK_FROM_HOME })), MessengerAccessMode.FULL);
  assert.equal(effectiveMessengerAccess(principal({ department: Department.CUSTOMER_CARE })), MessengerAccessMode.READ_ONLY);
  for (const department of [Department.HEADQUARTERS, Department.BRANCH, Department.ADMINISTRATION, Department.CAKES, Department.DELIVERY, Department.QUALITY]) {
    assert.equal(effectiveMessengerAccess(principal({ department })), MessengerAccessMode.DISABLED);
  }
});

test("WhatsApp and Telegram overrides take precedence over inherited access", () => {
  const principalWithModes = (overrides: Partial<Parameters<typeof effectiveChannelAccess>[0]>) => ({
    ...principal({ department: Department.WORK_FROM_HOME }),
    canReceiveWhatsApp: false,
    canReceiveTelegram: false,
    departmentWhatsAppAccess: MessengerAccessMode.FULL,
    departmentTelegramAccess: MessengerAccessMode.FULL,
    ...overrides
  });

  assert.equal(effectiveChannelAccess(principalWithModes({}), Channel.WHATSAPP), MessengerAccessMode.READ_ONLY);
  assert.equal(effectiveChannelAccess(principalWithModes({ whatsappAccess: MessengerAccessMode.FULL }), Channel.WHATSAPP), MessengerAccessMode.FULL);
  assert.equal(effectiveChannelAccess(principalWithModes({ telegramAccess: MessengerAccessMode.DISABLED }), Channel.TELEGRAM), MessengerAccessMode.DISABLED);
});
