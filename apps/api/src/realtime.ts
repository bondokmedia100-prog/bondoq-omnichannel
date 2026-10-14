import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { Presence, Role } from "@prisma/client";
import { canReadConversation, hasPermission, type SessionUser } from "./auth";
import { config } from "./config";
import { prisma } from "./prisma";
import { releaseAgentConversations } from "./routing";

export let io: Server;

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
    socket.join(`user:${user.id}`);
    socket.join(`agent:${user.id}`);
    if (user.role === Role.ADMIN || hasPermission(user, "canViewAllConversations")) socket.join("admins");
    socket.on("conversation:join", async (conversationId: string) => {
      const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { assignedAgentId: true, branchId: true } });
      if (!conversation || !canReadConversation(user, conversation)) return;
      socket.join(`conversation:${conversationId}`);
      if (user.role === Role.ADMIN || hasPermission(user, "canViewAllConversations")) {
        io.to(`conversation:${conversationId}`).emit("admin:viewing", { viewing: true, userId: user.id });
      }
    });
    socket.on("conversation:leave", (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`);
      if (user.role === Role.ADMIN || hasPermission(user, "canViewAllConversations")) io.to(`conversation:${conversationId}`).emit("admin:viewing", { viewing: false, userId: user.id });
    });
    socket.on("disconnect", () => {
      if (user.role !== Role.AGENT && user.role !== Role.BRANCH_USER) return;
      setTimeout(async () => {
        try {
          if ((await io.in(`agent:${user.id}`).fetchSockets()).length) return;
          const agent = await prisma.user.findFirst({ where: { id: user.id, presence: { not: Presence.OFFLINE } }, select: { id: true } });
          if (!agent) return;
          const endedAt = new Date();
          await prisma.$transaction([
            prisma.user.update({ where: { id: user.id }, data: { presence: Presence.OFFLINE, lastSeenAt: endedAt } }),
            prisma.agentSession.updateMany({ where: { userId: user.id, endedAt: null }, data: { endedAt, endState: Presence.OFFLINE } }),
            prisma.auditLog.create({ data: { actorId: user.id, action: "AGENT_DISCONNECTED" } })
          ]);
          io.to("admins").emit("presence:updated", { userId: user.id, presence: Presence.OFFLINE });
          await releaseAgentConversations(user.id);
        } catch (error) { console.error("Agent disconnect cleanup failed", error); }
      }, 30_000);
    });
  });
  return io;
}
