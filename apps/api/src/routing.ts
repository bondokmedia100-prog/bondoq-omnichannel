import { Channel, ConversationStatus, Department, MessageDirection, Presence, Role } from "@prisma/client";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { canViewChannel, loadSessionUser } from "./auth";
import { config } from "./config";
import { prisma } from "./prisma";
import { emitConversationEvent, io } from "./realtime";
import { chooseRoundRobinAgent, shouldReassignUnansweredConversation } from "./routingSelection";
import { channelAssignmentWhere } from "./messengerAccess";
import { withRedisLock } from "./redisLock";

const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
export const slaQueue = new Queue("conversation-sla", { connection });
const reassignmentQueue = new Queue("conversation-reassignment", { connection });

type AssignmentOptions = {
  allowAwaitingRouting?: boolean;
  reassignIfIneligible?: boolean;
  forceReassign?: boolean;
  expectedUnanswered?: { messageId: string; assignedAgentId: string };
};

async function canNotifyAgentOfChannel(agentId: string, channel: Channel) {
  const agent = await loadSessionUser(agentId);
  return Boolean(agent && canViewChannel(agent, channel));
}

export function withInboundConversationLock<T>(channel: string, externalConversationId: string, work: () => Promise<T>) {
  return withRedisLock(connection, `inbound:${channel}:${externalConversationId}`, work, { leaseMs: 120_000, waitMs: 120_000 });
}

export function withConversationAssignmentLock<T>(conversationId: string, work: () => Promise<T>) {
  return withRedisLock(connection, `assignment:conversation:${conversationId}`, work, { leaseMs: 120_000 });
}

export function recordConversationAssignment(conversationId: string, agentId: string) {
  return prisma.conversationAssignment.upsert({
    where: { conversationId_agentId: { conversationId, agentId } },
    create: { conversationId, agentId },
    update: { lastAssignedAt: new Date() }
  });
}

export async function assignConversation(conversationId: string, department?: Department | null, options: AssignmentOptions = {}) {
  return withConversationAssignmentLock(conversationId, async () => {
    const currentConversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    if (currentConversation.awaitingRouting && !options.allowAwaitingRouting) return currentConversation;
    let expectedInboundAt: Date | undefined;
    if (options.expectedUnanswered) {
      const inbound = await prisma.message.findUnique({ where: { id: options.expectedUnanswered.messageId }, select: { conversationId: true, direction: true, createdAt: true } });
      if (!inbound || inbound.conversationId !== currentConversation.id || inbound.direction !== MessageDirection.INBOUND
        || !shouldReassignUnansweredConversation(currentConversation, { assignedAgentId: options.expectedUnanswered.assignedAgentId, inboundAt: inbound.createdAt })) return currentConversation;
      expectedInboundAt = inbound.createdAt;
      const agentReply = await prisma.message.findFirst({ where: {
        conversationId: currentConversation.id, direction: MessageDirection.OUTBOUND, authorId: { not: null },
        createdAt: { gte: inbound.createdAt }, OR: [{ deliveryStatus: { not: "FAILED" } }, { deliveryStatus: null }]
      }, select: { id: true } });
      if (agentReply) return currentConversation;
    }
    if (currentConversation.assignedAgentId && !options.reassignIfIneligible && !options.forceReassign) return currentConversation;

    const targetDepartment = department ?? currentConversation.routingDepartment;
    const previousAgentId = currentConversation.assignedAgentId;
    const isMessenger = currentConversation.channel === Channel.MESSENGER;
    const hqAndRemote = !isMessenger && (targetDepartment === Department.HEADQUARTERS || targetDepartment === Department.WORK_FROM_HOME);
    const isBranchQueue = !isMessenger && (targetDepartment === Department.BRANCH || (!targetDepartment && Boolean(currentConversation.branchId)));
    const agents = await prisma.user.findMany({
      where: {
        role: isMessenger ? Role.AGENT : isBranchQueue ? Role.BRANCH_USER : Role.AGENT,
        isActive: true,
        presence: Presence.ONLINE,
        ...await channelAssignmentWhere(currentConversation.channel),
        ...(!isMessenger ? {
          ...(isBranchQueue
          ? { branchId: currentConversation.branchId || "__unassigned_branch__" }
          : targetDepartment === Department.CUSTOMER_CARE
            ? { department: Department.CUSTOMER_CARE }
            : hqAndRemote
            ? { department: { in: [Department.HEADQUARTERS, Department.WORK_FROM_HOME, Department.CUSTOMER_CARE] } }
            : targetDepartment
              ? { department: { in: [targetDepartment, Department.HEADQUARTERS, Department.WORK_FROM_HOME] } }
              : { department: { not: Department.ADMINISTRATION } })
        } : {})
      },
      select: { id: true },
      orderBy: { id: "asc" }
    });
    if (previousAgentId && agents.some((agent) => agent.id === previousAgentId) && !options.forceReassign) return currentConversation;
    const assignableAgents = options.forceReassign && previousAgentId ? agents.filter((agent) => agent.id !== previousAgentId) : agents;
    if (options.forceReassign && previousAgentId && agents.some((agent) => agent.id === previousAgentId) && !assignableAgents.length) return currentConversation;

    if (!assignableAgents.length) {
      const released = await prisma.conversation.updateMany({
        where: { id: conversationId, assignedAgentId: previousAgentId, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING, ConversationStatus.QUEUED] } },
        data: { assignedAgentId: null, status: ConversationStatus.QUEUED }
      });
      const waiting = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      if (released.count && previousAgentId) {
        await recordConversationAssignment(conversationId, previousAgentId);
        if (await canNotifyAgentOfChannel(previousAgentId, waiting.channel)) io?.to(`agent:${previousAgentId}`).emit("conversation:unassigned", waiting);
      }
      if (waiting.status === ConversationStatus.QUEUED && !waiting.assignedAgentId) await emitConversationEvent(waiting.id, waiting.channel, "conversation:queued", waiting);
      return waiting;
    }

    const turnKey = isMessenger ? "messenger" : isBranchQueue ? `branch:${currentConversation.branchId || "unassigned"}` : hqAndRemote ? "hq-wfh" : targetDepartment || "all";
    const turn = await connection.incr(`assignment:round-robin:${turnKey}`) - 1;
    const agent = chooseRoundRobinAgent(assignableAgents, turn);
    if (!agent) return currentConversation;
    const claimed = await prisma.conversation.updateMany({
      where: {
        id: conversationId, assignedAgentId: previousAgentId, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING, ConversationStatus.QUEUED] },
        ...(expectedInboundAt ? {
          lastInboundAt: expectedInboundAt,
          AND: [
            { OR: [{ lastAgentResponseAt: null }, { lastAgentResponseAt: { lt: expectedInboundAt } }] },
            { messages: { none: {
              direction: MessageDirection.OUTBOUND, authorId: { not: null }, createdAt: { gte: expectedInboundAt },
              OR: [{ deliveryStatus: { not: "FAILED" } }, { deliveryStatus: null }]
            } } },
            { messages: { none: {
              direction: MessageDirection.INBOUND, id: { not: options.expectedUnanswered!.messageId }, createdAt: { gte: expectedInboundAt }
            } } }
          ]
        } : {})
      },
      data: { assignedAgentId: agent.id, status: ConversationStatus.OPEN }
    });
    if (!claimed.count) return prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    if (previousAgentId) await recordConversationAssignment(conversationId, previousAgentId);
    await recordConversationAssignment(conversationId, agent.id);
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    await prisma.auditLog.create({ data: { conversationId, action: previousAgentId ? "CONVERSATION_AUTO_REASSIGNED" : "CONVERSATION_AUTO_ASSIGNED", details: { from: previousAgentId, agentId: agent.id } } });
    if (previousAgentId && previousAgentId !== agent.id && await canNotifyAgentOfChannel(previousAgentId, conversation.channel)) io?.to(`agent:${previousAgentId}`).emit("conversation:unassigned", conversation);
    io?.to(`agent:${agent.id}`).emit("conversation:assigned", { ...conversation, isAutoReassignment: Boolean(options.expectedUnanswered) });
    await emitConversationEvent(conversation.id, conversation.channel, "conversation:updated", conversation);
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
      if (assigned.status !== ConversationStatus.QUEUED) {
        if (assigned.assignedAgentId) {
          const inbound = await prisma.message.findFirst({ where: { conversationId: assigned.id, direction: MessageDirection.INBOUND }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
          if (inbound) await scheduleUnansweredReassignment(assigned.id, inbound.id, assigned.assignedAgentId);
        }
        progressed = true;
        break;
      }
    }
    if (!progressed) return;
  }
}

export async function releaseAgentConversations(agentId: string) {
  const assigned = await prisma.$transaction(async (tx) => {
    const current = await tx.conversation.findMany({
      where: { assignedAgentId: agentId, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } },
      select: { id: true, channel: true }
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
  for (const conversation of assigned) {
    if (await canNotifyAgentOfChannel(agentId, conversation.channel)) io?.to(`agent:${agentId}`).emit("conversation:unassigned", { id: conversation.id, assignedAgentId: null, status: ConversationStatus.QUEUED });
    await emitConversationEvent(conversation.id, conversation.channel, "conversation:updated", { id: conversation.id, assignedAgentId: null, status: ConversationStatus.QUEUED });
  }
  await dispatchQueued();
  return assigned.length;
}

export async function scheduleSla(conversationId: string, messageId: string) {
  await slaQueue.add("check-first-response", { conversationId, messageId }, { delay: config.slaResponseMinutes * 60_000, removeOnComplete: true, removeOnFail: 100 });
}

export async function scheduleUnansweredReassignment(conversationId: string, messageId: string, assignedAgentId: string) {
  const inbound = await prisma.message.findFirst({ where: { id: messageId, conversationId, direction: MessageDirection.INBOUND }, select: { createdAt: true } });
  if (!inbound) return;
  await reassignmentQueue.add("reassign-unanswered", { conversationId, messageId, assignedAgentId }, { delay: config.unansweredReassignMinutes * 60_000, removeOnComplete: true, removeOnFail: 100 });
}
