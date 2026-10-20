import { Channel, ConversationStatus, Department, MessageDirection, MessengerAccessMode, Presence, Role } from "@prisma/client";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { loadSessionUser } from "./auth";
import { config } from "./config";
import { prisma } from "./prisma";
import { connectedUserIds, emitConversationEvent, io, setAgentDisconnectHandler } from "./realtime";
import { canViewChannel, channelAssignmentWhere, effectiveChannelAccess, getDepartmentChannelModes } from "./messengerAccess";
import { chooseLeastLoadedAgent, isEligibleForAutomaticAssignment, shouldReassignUnansweredConversation } from "./routingSelection";
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

function withAgentAssignmentLock<T>(agentId: string, work: () => Promise<T>) {
  return withRedisLock(connection, `assignment:agent:${agentId}`, work, { leaseMs: 120_000, waitMs: 30_000 });
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
    const candidateWhere = {
      role: isMessenger ? Role.AGENT : isBranchQueue ? Role.BRANCH_USER : Role.AGENT,
      isActive: true,
      presence: Presence.ONLINE,
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
    };
    const candidateSelect = { id: true, role: true, isActive: true, presence: true, department: true, whatsappAccess: true, messengerAccess: true, telegramAccess: true, canReceiveWhatsApp: true, canReceiveMessenger: true, canReceiveTelegram: true } as const;
    const candidates = await prisma.user.findMany({
      where: { ...candidateWhere, ...await channelAssignmentWhere(currentConversation.channel) },
      select: candidateSelect,
      orderBy: { id: "asc" }
    });
    const connected = await connectedUserIds(candidates.map((agent) => agent.id));
    const departmentModes = await getDepartmentChannelModes(currentConversation.channel);
    const agents = candidates.filter((agent) => {
      const departmentAccess = agent.department ? departmentModes[agent.department] : MessengerAccessMode.DISABLED;
      const principal = {
        ...agent,
        departmentWhatsAppAccess: currentConversation.channel === Channel.WHATSAPP ? departmentAccess : undefined,
        departmentMessengerAccess: currentConversation.channel === Channel.MESSENGER ? departmentAccess : undefined,
        departmentTelegramAccess: currentConversation.channel === Channel.TELEGRAM ? departmentAccess : undefined
      };
      return isEligibleForAutomaticAssignment({
        isActive: agent.isActive,
        presence: agent.presence,
        connected: connected.has(agent.id),
        fullAccess: effectiveChannelAccess(principal, currentConversation.channel) === MessengerAccessMode.FULL
      });
    });
    if (previousAgentId && agents.some((agent) => agent.id === previousAgentId) && !options.forceReassign) return currentConversation;
    const assignableAgents = options.forceReassign && previousAgentId ? agents.filter((agent) => agent.id !== previousAgentId) : agents;
    if (options.forceReassign && previousAgentId && agents.some((agent) => agent.id === previousAgentId) && !assignableAgents.length) return currentConversation;

    if (!assignableAgents.length) {
      const released = await prisma.$transaction(async (tx) => {
        const result = await tx.conversation.updateMany({
          where: { id: conversationId, assignedAgentId: previousAgentId, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING, ConversationStatus.QUEUED] } },
          data: { assignedAgentId: null, status: ConversationStatus.QUEUED }
        });
        if (result.count && previousAgentId) await tx.conversationAssignment.upsert({
          where: { conversationId_agentId: { conversationId, agentId: previousAgentId } },
          create: { conversationId, agentId: previousAgentId },
          update: { lastAssignedAt: new Date() }
        });
        return result.count;
      });
      const waiting = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      if (released && previousAgentId) {
        try {
          if (await canNotifyAgentOfChannel(previousAgentId, waiting.channel)) io?.to(`agent:${previousAgentId}`).emit("conversation:unassigned", waiting);
        } catch (error) { console.warn("Ineligible agent unassignment notification failed", previousAgentId, conversationId, error); }
      }
      if (waiting.status === ConversationStatus.QUEUED && !waiting.assignedAgentId) {
        try { await emitConversationEvent(waiting.id, waiting.channel, "conversation:queued", waiting); }
        catch (error) { console.warn("Queued conversation notification failed", conversationId, error); }
      }
      return waiting;
    }

    const { agent, claimed, assignedConversation } = await withRedisLock(connection, "assignment:allocation", async () => {
      const activeAssignments = await prisma.conversation.groupBy({
        by: ["assignedAgentId"],
        where: {
          assignedAgentId: { in: assignableAgents.map((candidate) => candidate.id) },
          status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] }
        },
        _count: { _all: true }
      });
      const activeCounts = new Map<string, number>();
      for (const { assignedAgentId, _count } of activeAssignments) {
        if (assignedAgentId) activeCounts.set(assignedAgentId, _count._all);
      }
      const turn = await connection.incr("assignment:round-robin:global") - 1;
      let remainingAgents = [...assignableAgents];
      while (remainingAgents.length) {
        const agent = chooseLeastLoadedAgent(remainingAgents, activeCounts, turn);
        if (!agent) break;
        const attempt = await withAgentAssignmentLock(agent.id, async () => {
          const freshAgent = await prisma.user.findFirst({
            where: { ...candidateWhere, ...await channelAssignmentWhere(currentConversation.channel), id: agent.id },
            select: candidateSelect
          });
          if (!freshAgent) return { eligible: false, assignedConversation: null };
          const [connected, departmentModes] = await Promise.all([
            connectedUserIds([agent.id]),
            getDepartmentChannelModes(currentConversation.channel)
          ]);
          const departmentAccess = freshAgent.department ? departmentModes[freshAgent.department] : MessengerAccessMode.DISABLED;
          const principal = {
            ...freshAgent,
            departmentWhatsAppAccess: currentConversation.channel === Channel.WHATSAPP ? departmentAccess : undefined,
            departmentMessengerAccess: currentConversation.channel === Channel.MESSENGER ? departmentAccess : undefined,
            departmentTelegramAccess: currentConversation.channel === Channel.TELEGRAM ? departmentAccess : undefined
          };
          if (!isEligibleForAutomaticAssignment({
            isActive: freshAgent.isActive,
            presence: freshAgent.presence,
            connected: connected.has(agent.id),
            fullAccess: effectiveChannelAccess(principal, currentConversation.channel) === MessengerAccessMode.FULL
          })) return { eligible: false, assignedConversation: null };
          const assignedConversation = await prisma.$transaction(async (tx) => {
            const result = await tx.conversation.updateMany({
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
            if (!result.count) return null;
            const assignedAt = new Date();
            if (previousAgentId) await tx.conversationAssignment.upsert({
              where: { conversationId_agentId: { conversationId, agentId: previousAgentId } },
              create: { conversationId, agentId: previousAgentId },
              update: { lastAssignedAt: assignedAt }
            });
            await tx.conversationAssignment.upsert({
              where: { conversationId_agentId: { conversationId, agentId: agent.id } },
              create: { conversationId, agentId: agent.id },
              update: { lastAssignedAt: assignedAt }
            });
            await tx.auditLog.create({ data: { conversationId, action: previousAgentId ? "CONVERSATION_AUTO_REASSIGNED" : "CONVERSATION_AUTO_ASSIGNED", details: { from: previousAgentId, agentId: agent.id } } });
            return tx.conversation.findUniqueOrThrow({ where: { id: conversationId } });
          });
          return { eligible: true, assignedConversation };
        });
        if (!attempt.eligible) {
          remainingAgents = remainingAgents.filter((candidate) => candidate.id !== agent.id);
          continue;
        }
        return { agent, claimed: Number(Boolean(attempt.assignedConversation)), assignedConversation: attempt.assignedConversation };
      }
      return { agent: null, claimed: 0, assignedConversation: null };
    }, { leaseMs: 120_000, waitMs: 120_000 });
    if (!agent) return currentConversation;
    if (!claimed) return prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    const conversation = assignedConversation || await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    if (previousAgentId && previousAgentId !== agent.id) {
      try {
        if (await canNotifyAgentOfChannel(previousAgentId, conversation.channel)) io?.to(`agent:${previousAgentId}`).emit("conversation:unassigned", conversation);
      } catch (error) { console.warn("Previous agent unassignment notification failed", previousAgentId, conversationId, error); }
    }
    io?.to(`agent:${agent.id}`).emit("conversation:assigned", { ...conversation, isAutoReassignment: Boolean(options.expectedUnanswered) });
    try { await emitConversationEvent(conversation.id, conversation.channel, "conversation:updated", conversation); }
    catch (error) { console.warn("Conversation assignment notification failed", conversationId, error); }
    return conversation;
  });
}

export async function dispatchQueued() {
  let cursor: { lastMessageAt: Date; id: string } | undefined;
  while (true) {
    const waiting = await prisma.conversation.findMany({
      where: {
        status: ConversationStatus.QUEUED, assignedAgentId: null, awaitingRouting: false, botState: "ASSIGNED_TO_AGENT",
        ...(cursor ? { OR: [
          { lastMessageAt: { gt: cursor.lastMessageAt } },
          { lastMessageAt: cursor.lastMessageAt, id: { gt: cursor.id } }
        ] } : {})
      },
      orderBy: [{ lastMessageAt: "asc" }, { id: "asc" }],
      take: 50
    });
    if (!waiting.length) return;
    let progressed = false;
    for (const conversation of waiting) {
      const assigned = await assignConversation(conversation.id);
      if (assigned.status !== ConversationStatus.QUEUED || assigned.assignedAgentId) {
        if (assigned.assignedAgentId) {
          const inbound = await prisma.message.findFirst({ where: { conversationId: assigned.id, direction: MessageDirection.INBOUND }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
          if (inbound) await scheduleUnansweredReassignment(assigned.id, inbound.id, assigned.assignedAgentId);
        }
        progressed = true;
        break;
      }
    }
    if (progressed) cursor = undefined;
    else {
      const last = waiting[waiting.length - 1];
      cursor = { lastMessageAt: last.lastMessageAt, id: last.id };
    }
  }
}

export async function releaseAgentConversations(agentId: string) {
  const assigned = await withAgentAssignmentLock(agentId, () => prisma.$transaction(async (tx) => {
    const current = await tx.conversation.findMany({
      where: { assignedAgentId: agentId, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } },
      select: { id: true, channel: true }
    });
    if (!current.length) return current;
    await tx.conversationAssignment.createMany({ data: current.map(({ id }) => ({ conversationId: id, agentId })), skipDuplicates: true });
    await tx.conversation.updateMany({
      where: { assignedAgentId: agentId, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } },
      data: { assignedAgentId: null, status: ConversationStatus.QUEUED }
    });
    return current;
  }));
  if (!assigned.length) return 0;
  for (const conversation of assigned) {
    try {
      if (await canNotifyAgentOfChannel(agentId, conversation.channel)) io?.to(`agent:${agentId}`).emit("conversation:unassigned", { id: conversation.id, assignedAgentId: null, status: ConversationStatus.QUEUED });
      await emitConversationEvent(conversation.id, conversation.channel, "conversation:updated", { id: conversation.id, assignedAgentId: null, status: ConversationStatus.QUEUED });
    } catch (error) {
      console.warn("Agent conversation release notification failed", agentId, conversation.id, error);
    }
  }
  await dispatchQueued();
  return assigned.length;
}

setAgentDisconnectHandler(async (agentId) => {
  await releaseAgentConversations(agentId);
});

export async function scheduleSla(conversationId: string, messageId: string) {
  await slaQueue.add("check-first-response", { conversationId, messageId }, {
    delay: config.slaResponseMinutes * 60_000, attempts: 5, backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: true, removeOnFail: 100
  });
}

export async function scheduleUnansweredReassignment(conversationId: string, messageId: string, assignedAgentId: string) {
  const inbound = await prisma.message.findFirst({ where: { id: messageId, conversationId, direction: MessageDirection.INBOUND }, select: { createdAt: true } });
  if (!inbound) return;
  await reassignmentQueue.add("reassign-unanswered", { conversationId, messageId, assignedAgentId }, {
    delay: config.unansweredReassignMinutes * 60_000, attempts: 5, backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: true, removeOnFail: 100
  });
}
