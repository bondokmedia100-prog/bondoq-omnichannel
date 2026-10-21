import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { Channel, Department, Presence, Role } from "@prisma/client";
import { canReadConversation, canReadTeamConversations, hasPermission, loadSessionUser, type SessionUser } from "./auth";
import { config } from "./config";
import { channelViewerWhere } from "./messengerAccess";
import { prisma } from "./prisma";

export let io: Server;
let onAgentDisconnected: ((userId: string) => Promise<void>) | undefined;

export function setAgentDisconnectHandler(handler: (userId: string) => Promise<void>) {
  onAgentDisconnected = handler;
}

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

export async function emitConversationActivity(
  conversation: { id: string; assignedAgentId: string | null; branchId: string | null; channel: Channel; externalConversationId?: string },
  event: string,
  payload: unknown
) {
  if (!io) return;
  const rooms = new Set([`conversation:${conversation.id}`]);
  for (const socket of io.sockets.sockets.values()) {
    const user = socket.data.user as SessionUser | undefined;
    if (user && (canReadConversation(user, conversation) || canReadTeamConversations(user, conversation))) rooms.add(`user:${user.id}`);
  }
  for (const room of rooms) io.to(room).emit(event, payload);
}

export async function subscribeWhatsAppPresenceForUser(conversationId: string, userId: string, remoteJid: string) {
  if (!io) return;
  const sockets = [...io.sockets.sockets.values()].filter((socket) => (socket.data.user as SessionUser | undefined)?.id === userId);
  if (!sockets.length) return;
  const { subscribeBaileysPresence } = await import("./BaileysWhatsAppService");
  await Promise.all(sockets.map((socket) => subscribeBaileysPresence(remoteJid, socket.id).catch((error) => {
    console.warn("WhatsApp customer presence API subscription failed", { conversationId, socketId: socket.id, error });
  })));
}

export async function connectedUserIds(userIds: string[]) {
  if (!io || !userIds.length) return new Set<string>();
  const sockets = await io.in(userIds.map((userId) => `user:${userId}`)).fetchSockets();
  return new Set(sockets.flatMap((socket) => {
    const user = socket.data.user as SessionUser | undefined;
    return user?.id ? [user.id] : [];
  }));
}

export async function isUserConnected(userId: string) {
  return (await connectedUserIds([userId])).has(userId);
}

export async function revokeConversationRoomAccess(conversationId: string, conversation: { assignedAgentId: string | null; branchId?: string | null; channel?: Channel; externalConversationId?: string }) {
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
  const channelConversations = new Map<string, { assignedAgentId: string | null; branchId: string | null; channel: Channel; externalConversationId: string }>();
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
          const found = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { assignedAgentId: true, branchId: true, channel: true, externalConversationId: true } });
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
    const whatsappPresenceJids = new Map<string, string>();
    const canObserveAllConversations = user.role === Role.ADMIN || user.role === Role.SUPERVISOR && hasPermission(user, "canViewAllConversations");
    socket.join(`user:${user.id}`);
    socket.join(`agent:${user.id}`);
    if (canObserveAllConversations) socket.join("admins");
    if (user.department) socket.join(`department:${user.department}`);
    socket.on("conversation:join", async (conversationId: string) => {
      const currentUser = socket.data.user as SessionUser;
      const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { assignedAgentId: true, branchId: true, status: true, channel: true, externalConversationId: true } });
      if (!conversation || !canReadConversation(currentUser, conversation) && !canReadTeamConversations(currentUser, conversation)) return;
      socket.join(`conversation:${conversationId}`);
      if (conversation.channel === Channel.WHATSAPP) {
        whatsappPresenceJids.set(conversationId, conversation.externalConversationId);
        try {
          const { subscribeBaileysPresence } = await import("./BaileysWhatsAppService");
          await subscribeBaileysPresence(conversation.externalConversationId, socket.id);
        } catch (error) { console.warn("WhatsApp customer presence subscription failed", { conversationId, error }); }
      }
      if (canObserveAllConversations) {
        io.to(`conversation:${conversationId}`).emit("admin:viewing", { viewing: true, userId: currentUser.id });
      }
    });
    socket.on("conversation:leave", (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`);
      const remoteJid = whatsappPresenceJids.get(conversationId);
      whatsappPresenceJids.delete(conversationId);
      if (remoteJid) void import("./BaileysWhatsAppService").then(({ unsubscribeBaileysPresence }) => unsubscribeBaileysPresence(remoteJid, socket.id)).catch((error) => console.warn("WhatsApp customer presence unsubscribe failed", { conversationId, error }));
      if (canObserveAllConversations) io.to(`conversation:${conversationId}`).emit("admin:viewing", { viewing: false, userId: user.id });
    });
    socket.on("disconnect", () => {
      whatsappPresenceJids.clear();
      void import("./BaileysWhatsAppService").then(({ unsubscribeAllBaileysPresence }) => unsubscribeAllBaileysPresence(socket.id)).catch((error) => console.warn("WhatsApp customer presence cleanup failed", error));
      if (user.role !== Role.AGENT && user.role !== Role.BRANCH_USER) return;
      setTimeout(async () => {
        try {
          if (await isUserConnected(user.id)) return;
          const now = new Date();
          const changed = await prisma.user.updateMany({
            where: { id: user.id, isActive: true, presence: Presence.ONLINE },
            data: { presence: Presence.OFFLINE, lastSeenAt: now }
          });
          if (!changed.count) return;
          if (await isUserConnected(user.id)) {
            const restored = await prisma.user.updateMany({ where: { id: user.id, isActive: true, presence: Presence.OFFLINE }, data: { presence: Presence.ONLINE, lastSeenAt: new Date() } });
            if (restored.count) {
              broadcastPresence(user.id, Presence.ONLINE, user.department);
            }
            return;
          }
          await prisma.agentSession.updateMany({ where: { userId: user.id, endedAt: null }, data: { endedAt: now, endState: Presence.OFFLINE } });
          broadcastPresence(user.id, Presence.OFFLINE, user.department);
          await onAgentDisconnected?.(user.id);
        } catch (error) { console.warn("Agent disconnect cleanup failed", error); }
      }, 1000);
    });
  });
  return io;
}
