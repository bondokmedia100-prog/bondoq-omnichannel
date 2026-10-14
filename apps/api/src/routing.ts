import { ConversationStatus, Department, Presence, Role } from "@prisma/client";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config";
import { prisma } from "./prisma";
import { io } from "./realtime";
import { chooseLeastLoadedAgent } from "./routingSelection";

const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
export const slaQueue = new Queue("conversation-sla", { connection });

export async function assignConversation(conversationId: string, department?: Department | null) {
  const currentConversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  if (currentConversation.awaitingRouting) return currentConversation;
  const targetDepartment = department ?? currentConversation.routingDepartment;
  const hqAndRemote = targetDepartment === Department.HEADQUARTERS || targetDepartment === Department.WORK_FROM_HOME;
  const isBranchQueue = targetDepartment === Department.BRANCH || Boolean(currentConversation.branchId);
  const agents = await prisma.user.findMany({
    where: {
      role: isBranchQueue ? Role.BRANCH_USER : Role.AGENT,
      isActive: true,
      presence: Presence.ONLINE,
      ...(isBranchQueue
        ? { branchId: currentConversation.branchId || "__unassigned_branch__" }
        : hqAndRemote
          ? { department: { in: [Department.HEADQUARTERS, Department.WORK_FROM_HOME, Department.CUSTOMER_CARE] } }
          : targetDepartment
            ? { department: { in: [targetDepartment, Department.HEADQUARTERS, Department.WORK_FROM_HOME] } }
            : { department: { not: Department.ADMINISTRATION } })
    },
    select: { id: true },
    orderBy: { id: "asc" }
  });
  if (!agents.length) {
    await prisma.conversation.updateMany({ where: { id: conversationId, assignedAgentId: null, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING, ConversationStatus.QUEUED] } }, data: { status: ConversationStatus.QUEUED } });
    const waiting = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    if (waiting.status === ConversationStatus.QUEUED && !waiting.assignedAgentId) io?.to("admins").emit("conversation:queued", waiting);
    return waiting;
  }
  const activeCounts = await prisma.conversation.groupBy({
    by: ["assignedAgentId"],
    where: { assignedAgentId: { in: agents.map((agent) => agent.id) }, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } },
    _count: { _all: true }
  });
  const load = new Map(activeCounts.map((entry) => [entry.assignedAgentId!, entry._count._all]));
  const turnKey = isBranchQueue ? `branch:${currentConversation.branchId || "unassigned"}` : hqAndRemote ? "hq-wfh" : targetDepartment || "all";
  const turn = await connection.incr(`assignment:round-robin:${turnKey}`) - 1;
  const agent = chooseLeastLoadedAgent(agents, load, turn);
  if (!agent) return currentConversation;
  const claimed = await prisma.conversation.updateMany({ where: { id: conversationId, assignedAgentId: null, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING, ConversationStatus.QUEUED] } }, data: { assignedAgentId: agent.id, status: ConversationStatus.OPEN } });
  if (!claimed.count) return prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  await prisma.auditLog.create({ data: { conversationId, action: "CONVERSATION_AUTO_ASSIGNED", details: { agentId: agent.id } } });
  io?.to(`agent:${agent.id}`).emit("conversation:assigned", conversation);
  io?.to("admins").emit("conversation:updated", conversation);
  return conversation;
}

export async function dispatchQueued() {
  while (true) {
    const waiting = await prisma.conversation.findMany({ where: { status: ConversationStatus.QUEUED, assignedAgentId: null, awaitingRouting: false }, orderBy: { lastMessageAt: "asc" }, take: 50 });
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
  const assigned = await prisma.conversation.findMany({
    where: { assignedAgentId: agentId, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } },
    select: { id: true }
  });
  if (!assigned.length) return 0;
  await prisma.conversation.updateMany({
    where: { assignedAgentId: agentId, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } },
    data: { assignedAgentId: null, status: ConversationStatus.QUEUED }
  });
  for (const { id } of assigned) io?.to("admins").emit("conversation:updated", { id, assignedAgentId: null, status: ConversationStatus.QUEUED });
  await dispatchQueued();
  return assigned.length;
}

export async function scheduleSla(conversationId: string, messageId: string) {
  await slaQueue.add("check-first-response", { conversationId, messageId }, { delay: config.slaResponseMinutes * 60_000, removeOnComplete: true, removeOnFail: 100 });
}
