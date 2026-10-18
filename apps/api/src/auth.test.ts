import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { Channel, Department, MessengerAccessMode, Role } from "@prisma/client";
import { canReadConversation, canReadTeamConversations, canReceivePrivateConversationNote, canViewAllPrivateConversationNotes, canViewPrivateConversationNote, canWorkOnConversation, hasPermission, signToken, type SessionUser } from "./auth";

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: "user-1", role: Role.AGENT, name: "Test", authVersion: 0, department: Department.HEADQUARTERS, branchId: null,
    canViewAllConversations: null, canTransferConversations: null, canManageCatalog: null, canViewReports: null, canManageTeam: null,
    messengerAccess: null, canReceiveMessenger: true, departmentMessengerAccess: MessengerAccessMode.DISABLED,
    ...overrides
  };
}

test("administrator and team leader permissions use safe defaults and explicit overrides", () => {
  const admin = user({ role: Role.ADMIN });
  const leader = user({ role: Role.SUPERVISOR });
  const restrictedLeader = user({ role: Role.SUPERVISOR, canViewAllConversations: false, canManageTeam: false });
  assert.equal(hasPermission(admin, "canManageTeam"), true);
  assert.equal(hasPermission(leader, "canViewReports"), true);
  assert.equal(hasPermission(leader, "canManageTeam"), true);
  assert.equal(hasPermission(restrictedLeader, "canViewAllConversations"), false);
  assert.equal(hasPermission(restrictedLeader, "canManageTeam"), false);
});

test("agents can read and work only assigned conversations even with the view-all flag", () => {
  const agent = user();
  const conversation = { assignedAgentId: "another-agent", branchId: null };
  assert.equal(canReadConversation(agent, conversation), false);
  assert.equal(canWorkOnConversation(agent, conversation), false);
  assert.equal(canReadConversation(user({ canViewAllConversations: true }), conversation), false);
  assert.equal(canWorkOnConversation(user({ canViewAllConversations: true }), conversation), false);
  assert.equal(canReadConversation(user({ role: Role.SUPERVISOR }), conversation), true);
  assert.equal(canWorkOnConversation(user({ role: Role.SUPERVISOR }), conversation), true);
  assert.equal(canReadConversation(user({ id: "assigned-agent" }), { assignedAgentId: "assigned-agent" }), true);
  assert.equal(canWorkOnConversation(user({ id: "assigned-agent" }), { assignedAgentId: "assigned-agent" }), true);
});

test("team conversation browsing is enabled for frontline staff only", () => {
  assert.equal(canReadTeamConversations(user()), true);
  const branchUser = user({ role: Role.BRANCH_USER, branchId: "branch-a" });
  assert.equal(canReadTeamConversations(branchUser), true);
  assert.equal(canReadTeamConversations(branchUser, { branchId: "branch-a" }), true);
  assert.equal(canReadTeamConversations(branchUser, { branchId: "branch-b" }), false);
  assert.equal(canReadConversation(branchUser, { assignedAgentId: branchUser.id, branchId: "branch-b" }), false);
  assert.equal(canWorkOnConversation(branchUser, { assignedAgentId: branchUser.id, branchId: "branch-b" }), false);
  assert.equal(canReadConversation(branchUser, { assignedAgentId: branchUser.id, branchId: "branch-a" }), true);
  assert.equal(canReadTeamConversations(user({ role: Role.BRANCH_USER }), { branchId: "branch-a" }), false);
  assert.equal(canReadTeamConversations(user({ role: Role.SUPERVISOR })), false);
  assert.equal(canReadTeamConversations(user({ role: Role.ADMIN })), false);
});

test("Messenger department permissions separate reply, view-only, and excluded access", () => {
  const messenger = { assignedAgentId: "wfh", channel: Channel.MESSENGER };
  const workFromHome = user({ id: "wfh", department: Department.WORK_FROM_HOME, departmentMessengerAccess: MessengerAccessMode.FULL });
  const customerCare = user({ id: "care", department: Department.CUSTOMER_CARE, departmentMessengerAccess: MessengerAccessMode.READ_ONLY });
  const excluded = user({ id: "excluded", department: Department.DELIVERY, departmentMessengerAccess: MessengerAccessMode.DISABLED });

  assert.equal(canReadTeamConversations(workFromHome, messenger), true);
  assert.equal(canWorkOnConversation(workFromHome, messenger), true);
  assert.equal(canReadTeamConversations(customerCare, messenger), true);
  assert.equal(canReadConversation(customerCare, messenger), false);
  assert.equal(canWorkOnConversation(customerCare, messenger), false);
  assert.equal(canReadTeamConversations(excluded, messenger), false);
  assert.equal(canReadConversation(excluded, messenger), false);
});

test("an individual Messenger override takes precedence over department policy", () => {
  const messenger = { assignedAgentId: "staff", channel: Channel.MESSENGER };
  const personallyEnabled = user({ id: "staff", department: Department.CUSTOMER_CARE, departmentMessengerAccess: MessengerAccessMode.READ_ONLY, messengerAccess: MessengerAccessMode.FULL });
  const personallyExcluded = user({ id: "staff", department: Department.WORK_FROM_HOME, departmentMessengerAccess: MessengerAccessMode.FULL, messengerAccess: MessengerAccessMode.DISABLED });
  assert.equal(canWorkOnConversation(personallyEnabled, messenger), true);
  assert.equal(canReadConversation(personallyExcluded, messenger), false);
});

test("legacy Messenger routing opt-out makes inherited full access read-only", () => {
  const messenger = { assignedAgentId: "staff", channel: Channel.MESSENGER };
  const legacyOptOut = user({ id: "staff", department: Department.WORK_FROM_HOME, departmentMessengerAccess: MessengerAccessMode.FULL, canReceiveMessenger: false });
  const explicitOverride = user({ ...legacyOptOut, messengerAccess: MessengerAccessMode.FULL });

  assert.equal(canReadConversation(legacyOptOut, messenger), true);
  assert.equal(canWorkOnConversation(legacyOptOut, messenger), false);
  assert.equal(canWorkOnConversation(explicitOverride, messenger), true);
});

test("private conversation notes are visible only to participants and managers with access", () => {
  const note = { authorId: "author", recipientId: "recipient" };
  assert.equal(canViewPrivateConversationNote(user({ id: "author" }), note), true);
  assert.equal(canViewPrivateConversationNote(user({ id: "recipient" }), note), true);
  assert.equal(canViewPrivateConversationNote(user({ id: "other" }), note), false);
  assert.equal(canViewPrivateConversationNote(user({ id: "admin", role: Role.ADMIN }), note), true);
  assert.equal(canViewPrivateConversationNote(user({ id: "manager", role: Role.SUPERVISOR }), note), true);
  const restrictedManager = user({ id: "restricted", role: Role.SUPERVISOR, canViewAllConversations: false });
  assert.equal(canViewAllPrivateConversationNotes(restrictedManager), false);
  assert.equal(canViewPrivateConversationNote(restrictedManager, note), false);
});

test("private conversation note recipients must be active staff in the conversation scope", () => {
  const conversation = { branchId: "branch-a" };
  assert.equal(canReceivePrivateConversationNote({ role: Role.AGENT, branchId: null, isActive: true }, conversation), true);
  assert.equal(canReceivePrivateConversationNote({ role: Role.BRANCH_USER, branchId: "branch-a", isActive: true }, conversation), true);
  assert.equal(canReceivePrivateConversationNote({ role: Role.BRANCH_USER, branchId: "branch-b", isActive: true }, conversation), false);
  assert.equal(canReceivePrivateConversationNote({ role: Role.BRANCH_USER, branchId: "branch-a", isActive: false }, conversation), false);
  assert.equal(canReceivePrivateConversationNote({ role: Role.SUPERVISOR, branchId: null, isActive: true }, conversation), false);
});

test("login tokens do not expire automatically", () => {
  const { id, role, name, authVersion } = user();
  const payload = jwt.decode(signToken({ id, role, name, authVersion })) as jwt.JwtPayload;
  assert.equal(payload.exp, undefined);
  assert.equal(payload.iss, "bondoq-support");
});
