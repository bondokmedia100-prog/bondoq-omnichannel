import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { Department, Role } from "@prisma/client";
import { canReadConversation, canReadTeamConversations, canReceivePrivateConversationNote, canViewAllPrivateConversationNotes, canViewPrivateConversationNote, canWorkOnConversation, hasPermission, signToken, type SessionUser } from "./auth";

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: "user-1", role: Role.AGENT, name: "Test", authVersion: 0, department: Department.HEADQUARTERS, branchId: null,
    canViewAllConversations: null, canTransferConversations: null, canManageCatalog: null, canViewReports: null, canManageTeam: null,
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

test("frontline staff can work shared WhatsApp groups inside their branch scope", () => {
  const group = { externalConversationId: "120363000000000000@g.us", assignedAgentId: null, branchId: null };
  assert.equal(canWorkOnConversation(user(), group), true);
  const branchUser = user({ role: Role.BRANCH_USER, branchId: "branch-a" });
  assert.equal(canWorkOnConversation(branchUser, { ...group, branchId: "branch-a" }), true);
  assert.equal(canWorkOnConversation(branchUser, { ...group, branchId: "branch-b" }), false);
  assert.equal(canWorkOnConversation(user({ role: Role.SUPERVISOR, canViewAllConversations: false }), group), false);
});

test("private conversation notes are limited to participants and conversation-wide admins", () => {
  const note = { authorId: "author", recipientId: "recipient" };
  assert.equal(canViewPrivateConversationNote(user({ id: "author" }), note), true);
  assert.equal(canViewPrivateConversationNote(user({ id: "recipient" }), note), true);
  assert.equal(canViewPrivateConversationNote(user({ id: "other" }), note), false);
  assert.equal(canViewPrivateConversationNote(user({ id: "admin", role: Role.ADMIN }), note), true);
  assert.equal(canViewPrivateConversationNote(user({ id: "manager", role: Role.SUPERVISOR }), note), true);
  assert.equal(canViewAllPrivateConversationNotes(user({ id: "restricted-manager", role: Role.SUPERVISOR, canViewAllConversations: false })), false);
});

test("private conversation note recipients must be active and inside the conversation branch", () => {
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
