import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { Presence, Role } from "@prisma/client";
import { config } from "./config";
import { prisma } from "./prisma";

export let io: Server;

export function initRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: config.webOrigin, credentials: true } });
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token as string;
      if (!token) return next(new Error("unauthorized"));
      const claims = jwt.verify(token, config.jwtSecret, { issuer: "bondoq-support" }) as { id: string; authVersion: number };
      const user = await prisma.user.findFirst({ where: { id: claims.id, isActive: true }, select: { id: true, role: true, name: true, authVersion: true } });
      if (!user || user.authVersion !== claims.authVersion) return next(new Error("unauthorized"));
      socket.data.user = user;
      next();
    } catch { next(new Error("unauthorized")); }
  });
  io.on("connection", (socket) => {
    const user = socket.data.user as { id: string; role: Role };
    socket.join(`user:${user.id}`);
    socket.join(user.role === Role.ADMIN || user.role === Role.SUPERVISOR ? "admins" : `agent:${user.id}`);
    socket.on("conversation:join", async (conversationId: string) => {
      const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { assignedAgentId: true } });
      if (!conversation || (user.role === Role.AGENT && conversation.assignedAgentId !== user.id)) return;
      socket.join(`conversation:${conversationId}`);
      if (user.role !== Role.AGENT) {
        io.to(`conversation:${conversationId}`).emit("admin:viewing", { viewing: true, userId: user.id });
      }
    });
    socket.on("conversation:leave", (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`);
      if (user.role !== Role.AGENT) io.to(`conversation:${conversationId}`).emit("admin:viewing", { viewing: false, userId: user.id });
    });
    socket.on("disconnect", () => {
      if (user.role !== Role.AGENT) return;
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
        } catch (error) { console.error("Agent disconnect cleanup failed", error); }
      }, 30_000);
    });
  });
  return io;
}
