import { ConversationStatus, Department, Presence } from "@prisma/client";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config";
import { prisma } from "./prisma";
import { io } from "./realtime";

const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
export const slaQueue = new Queue("conversation-sla", { connection });

export async function assignConversation(conversationId: string, department?: Department | null) {
  const currentConversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  if (currentConversation.awaitingRouting) return currentConversation;
  const targetDepartment = department ?? currentConversation.routingDepartment;
  const agents = await prisma.user.findMany({
    where: { role: "AGENT", isActive: true, presence: Presence.ONLINE, ...(targetDepartment ? { department: targetDepartment } : {}) },
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
  const agent = agents.sort((a, b) => (load.get(a.id) || 0) - (load.get(b.id) || 0))[0];
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

export async function scheduleSla(conversationId: string, messageId: string) {
  await slaQueue.add("check-first-response", { conversationId, messageId }, { delay: 3 * 60_000, removeOnComplete: true, removeOnFail: 100 });
}
