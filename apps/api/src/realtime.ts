import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { Department, Presence, Role } from "@prisma/client";
import { canReadConversation, canReadTeamConversations, hasPermission, type SessionUser } from "./auth";
import { config } from "./config";
import { prisma } from "./prisma";

export let io: Server;

export function broadcastPresence(userId: string, presence: Presence, department?: Department | null) {
  if (!io) return;
  let recipients = io.to("admins");
  if (department) recipients = recipients.to(`department:${department}`);
  recipients.emit("presence:updated", { userId, presence });
}

export async function revokeConversationRoomAccess(conversationId: string, conversation: { assignedAgentId: string | null; branchId?: string | null }) {
  if (!io) return;
  const room = `conversation:${conversationId}`;
  const sockets = await io.in(room).fetchSockets();
  for (const socket of sockets) {
    const user = socket.data.user as SessionUser | undefined;
    if (!user || !canReadConversation(user, conversation) && !canReadTeamConversations(user, conversation)) {
      socket.emit("conversation:access-revoked", { conversationId });
      await socket.leave(room);
    }
  }
}

export function initRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: config.webOrigin, credentials: true } });
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token as string;
      if (!token) return next(new Error("unauthorized"));
      const claims = jwt.verify(token, config.jwtSecret, { issuer: "bondoq-support" }) as { id: string; authVersion: number };
      const user = await prisma.user.findFirst({ where: { id: claims.id, isActive: true }, select: { id: true, role: true, name: true, authVersion: true, department: true, branchId: true, canViewAllConversations: true, canTransferConversations: true, canManageCatalog: true, canViewReports: true, canManageTeam: true } });
      if (!user || user.authVersion !== claims.authVersion) return next(new Error("unauthorized"));
      socket.data.user = user;
      next();
    } catch { next(new Error("unauthorized")); }
  });
  io.on("connection", (socket) => {
    const user = socket.data.user as SessionUser;
    const canObserveAllConversations = user.role === Role.ADMIN || user.role === Role.SUPERVISOR && hasPermission(user, "canViewAllConversations");
    socket.join(`user:${user.id}`);
    socket.join(`agent:${user.id}`);
    if (canObserveAllConversations) socket.join("admins");
    if (user.department) socket.join(`department:${user.department}`);
    socket.on("conversation:join", async (conversationId: string) => {
      const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { assignedAgentId: true, branchId: true, status: true } });
      if (!conversation || !canReadConversation(user, conversation) && !canReadTeamConversations(user, conversation)) return;
      socket.join(`conversation:${conversationId}`);
      if (canObserveAllConversations) {
        io.to(`conversation:${conversationId}`).emit("admin:viewing", { viewing: true, userId: user.id });
      }
    });
    socket.on("conversation:leave", (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`);
      if (canObserveAllConversations) io.to(`conversation:${conversationId}`).emit("admin:viewing", { viewing: false, userId: user.id });
    });
  });
  return io;
}
