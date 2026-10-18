import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { Channel, Department, Presence, Role } from "@prisma/client";
import { canReadConversation, canReadTeamConversations, hasPermission, loadSessionUser, type SessionUser } from "./auth";
import { config } from "./config";
import { channelViewerWhere } from "./messengerAccess";
import { prisma } from "./prisma";

export let io: Server;

export async function emitConversationEvent(
  conversationId: string,
  channel: Channel,
  event: string,
  payload: unknown,
  options: { audience?: "viewers" | "managers"; extraRooms?: string[] } = {}
) {
  if (!io) return;
  const audience = options.audience || "viewers";
  const rooms = new Set<string>();
  if (audience === "viewers") rooms.add(`conversation:${conversationId}`);
  const recipients = await prisma.user.findMany({
    where: { isActive: true, OR: [{ role: Role.ADMIN }, await channelViewerWhere(channel)] },
    select: { id: true, role: true, canViewAllConversations: true }
  });
  const allowedRecipients = recipients.filter((recipient) =>
    audience === "viewers" || recipient.role === Role.ADMIN || recipient.role === Role.SUPERVISOR && recipient.canViewAllConversations !== false
  );
  for (const recipient of allowedRecipients) rooms.add(`user:${recipient.id}`);
  for (const room of options.extraRooms || []) {
    const userId = /^(?:user|agent):(.+)$/.exec(room)?.[1];
    if (userId && !allowedRecipients.some((recipient) => recipient.id === userId)) continue;
    rooms.add(room);
  }
  const [firstRoom, ...otherRooms] = rooms;
  if (!firstRoom) return;
  let targets = io.to(firstRoom);
  for (const room of otherRooms) targets = targets.to(room);
  targets.emit(event, payload);
}

export function broadcastPresence(userId: string, presence: Presence, department?: Department | null) {
  if (!io) return;
  let recipients = io.to("admins");
  if (department) recipients = recipients.to(`department:${department}`);
  recipients.emit("presence:updated", { userId, presence });
}

export async function revokeConversationRoomAccess(conversationId: string, conversation: { assignedAgentId: string | null; branchId?: string | null; channel?: import("@prisma/client").Channel }) {
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

export async function refreshChannelAccessForDepartments(channel: Channel, departments: Department[]) {
  if (!io || !departments.length) return;
  const users = await prisma.user.findMany({ where: { department: { in: departments }, isActive: true }, select: { id: true } });
  const refreshed = new Map<string, SessionUser>();
  for (const { id } of users) {
    const user = await loadSessionUser(id);
    if (user) refreshed.set(id, user);
  }
  const channelConversations = new Map<string, { assignedAgentId: string | null; branchId: string | null; channel: Channel }>();
  for (const socket of io.sockets.sockets.values()) {
    const previous = socket.data.user as SessionUser | undefined;
    const user = previous && refreshed.get(previous.id);
    if (!user) continue;
    socket.data.user = user;
    for (const room of socket.rooms) {
      if (!room.startsWith("conversation:")) continue;
      const conversationId = room.slice("conversation:".length);
       let conversation = channelConversations.get(conversationId);
       if (!conversation) {
         const found = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { assignedAgentId: true, branchId: true, channel: true } });
         if (!found || found.channel !== channel) continue;
         conversation = found;
         channelConversations.set(conversationId, conversation);
      }
      if (!canReadConversation(user, conversation) && !canReadTeamConversations(user, conversation)) {
        socket.emit("conversation:access-revoked", { conversationId });
        await socket.leave(room);
      }
    }
     socket.emit("channel:permissions-updated", { channel });
  }
}

export function initRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: config.webOrigin, credentials: true } });
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token as string;
      if (!token) return next(new Error("unauthorized"));
      const claims = jwt.verify(token, config.jwtSecret, { issuer: "bondoq-support" }) as { id: string; authVersion: number };
      const user = await loadSessionUser(claims.id);
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
      const currentUser = socket.data.user as SessionUser;
      const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { assignedAgentId: true, branchId: true, status: true, channel: true } });
      if (!conversation || !canReadConversation(currentUser, conversation) && !canReadTeamConversations(currentUser, conversation)) return;
      socket.join(`conversation:${conversationId}`);
      if (canObserveAllConversations) {
        io.to(`conversation:${conversationId}`).emit("admin:viewing", { viewing: true, userId: currentUser.id });
      }
    });
    socket.on("conversation:leave", (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`);
      if (canObserveAllConversations) io.to(`conversation:${conversationId}`).emit("admin:viewing", { viewing: false, userId: user.id });
    });
  });
  return io;
}
