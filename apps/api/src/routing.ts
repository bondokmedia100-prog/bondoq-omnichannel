import { ConversationStatus, Department, Presence, Role } from "@prisma/client";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config";
import { prisma } from "./prisma";
import { io } from "./realtime";
import { chooseRoundRobinAgent } from "./routingSelection";
import { withRedisLock } from "./redisLock";

const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
export const slaQueue = new Queue("conversation-sla", { connection });

type AssignmentOptions = { allowAwaitingRouting?: boolean; reassignIfIneligible?: boolean };

export function withInboundConversationLock<T>(channel: string, externalConversationId: string, work: () => Promise<T>) {
  return withRedisLock(connection, `inbound:${channel}:${externalConversationId}`, work, { leaseMs: 120_000 });
}

export function recordConversationAssignment(conversationId: string, agentId: string) {
  return prisma.conversationAssignment.upsert({
    where: { conversationId_agentId: { conversationId, agentId } },
    create: { conversationId, agentId },
    update: { lastAssignedAt: new Date() }
  });
}

export async function assignConversation(conversationId: string, department?: Department | null, options: AssignmentOptions = {}) {
  return withRedisLock(connection, `assignment:conversation:${conversationId}`, async () => {
    const currentConversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    if (currentConversation.awaitingRouting && !options.allowAwaitingRouting) return currentConversation;
    if (currentConversation.assignedAgentId && !options.reassignIfIneligible) return currentConversation;

    const targetDepartment = department ?? currentConversation.routingDepartment;
    const hqAndRemote = targetDepartment === Department.HEADQUARTERS || targetDepartment === Department.WORK_FROM_HOME;
    const isBranchQueue = targetDepartment === Department.BRANCH || (!targetDepartment && Boolean(currentConversation.branchId));
    const agents = await prisma.user.findMany({
      where: {
        role: isBranchQueue ? Role.BRANCH_USER : Role.AGENT,
        isActive: true,
        presence: Presence.ONLINE,
        ...(isBranchQueue
          ? { branchId: currentConversation.branchId || "__unassigned_branch__" }
          : targetDepartment === Department.CUSTOMER_CARE
            ? { department: Department.CUSTOMER_CARE }
            : hqAndRemote
            ? { department: { in: [Department.HEADQUARTERS, Department.WORK_FROM_HOME, Department.CUSTOMER_CARE] } }
            : targetDepartment
              ? { department: { in: [targetDepartment, Department.HEADQUARTERS, Department.WORK_FROM_HOME] } }
              : { department: { not: Department.ADMINISTRATION } })
      },
      select: { id: true },
      orderBy: { id: "asc" }
    });
    const previousAgentId = currentConversation.assignedAgentId;
    if (previousAgentId && agents.some((agent) => agent.id === previousAgentId)) return currentConversation;

    if (!agents.length) {
      const released = await prisma.conversation.updateMany({
        where: { id: conversationId, assignedAgentId: previousAgentId, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING, ConversationStatus.QUEUED] } },
        data: { assignedAgentId: null, status: ConversationStatus.QUEUED }
      });
      const waiting = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      if (released.count && previousAgentId) {
        await recordConversationAssignment(conversationId, previousAgentId);
        io?.to(`agent:${previousAgentId}`).emit("conversation:unassigned", waiting);
      }
      if (waiting.status === ConversationStatus.QUEUED && !waiting.assignedAgentId) io?.to("admins").emit("conversation:queued", waiting);
      return waiting;
    }

    const turnKey = isBranchQueue ? `branch:${currentConversation.branchId || "unassigned"}` : hqAndRemote ? "hq-wfh" : targetDepartment || "all";
    const turn = await connection.incr(`assignment:round-robin:${turnKey}`) - 1;
    const agent = chooseRoundRobinAgent(agents, turn);
    if (!agent) return currentConversation;
    const claimed = await prisma.conversation.updateMany({
      where: { id: conversationId, assignedAgentId: previousAgentId, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING, ConversationStatus.QUEUED] } },
      data: { assignedAgentId: agent.id, status: ConversationStatus.OPEN }
    });
    if (!claimed.count) return prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    if (previousAgentId) await recordConversationAssignment(conversationId, previousAgentId);
    await recordConversationAssignment(conversationId, agent.id);
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    await prisma.auditLog.create({ data: { conversationId, action: previousAgentId ? "CONVERSATION_AUTO_REASSIGNED" : "CONVERSATION_AUTO_ASSIGNED", details: { from: previousAgentId, agentId: agent.id } } });
    if (previousAgentId && previousAgentId !== agent.id) io?.to(`agent:${previousAgentId}`).emit("conversation:unassigned", conversation);
    io?.to(`agent:${agent.id}`).emit("conversation:assigned", conversation);
    io?.to("admins").emit("conversation:updated", conversation);
    return conversation;
  });
}

export async function dispatchQueued() {
  while (true) {
    const waiting = await prisma.conversation.findMany({ where: { status: ConversationStatus.QUEUED, assignedAgentId: null, awaitingRouting: false, botState: "ASSIGNED_TO_AGENT" }, orderBy: { lastMessageAt: "asc" }, take: 50 });
    if (!waiting.length) return;
    let progressed = false;
    for (const conversation of waiting) {
      const assigned = await assignConversation(conversation.id);
      if (assigned.status !== ConversationStatus.QUEUED) { progressed = true; break; }
    }
    if (!progressed) return;
  }
}

export async function releaseAgentConversations(agentId: string) {
  const assigned = await prisma.$transaction(async (tx) => {
    const current = await tx.conversation.findMany({
      where: { assignedAgentId: agentId, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } },
      select: { id: true }
    });
    if (!current.length) return current;
    await tx.conversationAssignment.createMany({
      data: current.map(({ id }) => ({ conversationId: id, agentId })),
      skipDuplicates: true
    });
    await tx.conversation.updateMany({
      where: { assignedAgentId: agentId, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } },
      data: { assignedAgentId: null, status: ConversationStatus.QUEUED }
    });
    return current;
  });
  if (!assigned.length) return 0;
  for (const { id } of assigned) io?.to("admins").emit("conversation:updated", { id, assignedAgentId: null, status: ConversationStatus.QUEUED });
  await dispatchQueued();
  return assigned.length;
}

export async function scheduleSla(conversationId: string, messageId: string) {
  await slaQueue.add("check-first-response", { conversationId, messageId }, { delay: config.slaResponseMinutes * 60_000, removeOnComplete: true, removeOnFail: 100 });
}
