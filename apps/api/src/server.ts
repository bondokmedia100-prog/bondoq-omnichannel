import crypto from "node:crypto";
import http from "node:http";
import cors from "cors";
import express from "express";
import bcrypt from "bcryptjs";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { z } from "zod";
import { Channel, ConversationHandoffStatus, ConversationStatus, Department, MessageDirection, MessageKind, MessengerAccessMode, OrderStatus, PasswordResetStatus, Presence, Prisma, ProductCategory, Role } from "@prisma/client";
import { config } from "./config";
import { adminGuard, agentGuard, authenticate, AuthedRequest, canReadConversation, canReadTeamConversations, canReceivePrivateConversationNote, canRespondToHandoff, canViewAllPrivateConversationNotes, canViewPrivateConversationNote, canWorkOnConversation, hasPermission, loadSessionUser, permissionGuard, signToken } from "./auth";
import { prisma } from "./prisma";
import { broadcastPresence, connectedUserIds, emitConversationActivity, emitConversationEvent, initRealtime, io, isUserConnected, refreshChannelAccessForDepartments, revokeConversationRoomAccess, subscribeWhatsAppPresenceForUser } from "./realtime";
import { assignConversation, dispatchQueued, releaseAgentConversations, scheduleUnansweredReassignment, withConversationAssignmentLock, withInboundConversationLock } from "./routing";
import { answerTelegramCallback, channelRecipient, deleteProviderMessage, editProviderMessage, fetchInboundMedia, parseKalemlyWebhook, parseMetaWebhook, parseTelegramWebhook, reactToProviderMessage, sendCsatPrompt, sendToChannel } from "./providers";
import { ingestMessage, updateEditedInboundMessage } from "./ingestion";
import { getKalemlySettings, safeProviderResponse, saveKalemlySettings, sendKalemlyTest, startKalemlyWaWorker, kalemlyExternalMessageId } from "./KalemlyWaService";
import { defaultCallReply, getBaileysWhatsAppState, getPendingBaileysCall, getWhatsAppCallReply, getWhatsAppMode, initializeWhatsAppEngine, logoutBaileysWhatsApp, markBaileysMessagePlayed, markBaileysMessagesRead, publishWhatsAppCustomerPresence, rejectBaileysCall, restartBaileysWhatsApp, saveWhatsAppCallReply, sendBaileysPresence, setWhatsAppMode, startBaileysWhatsApp, stopBaileysWhatsApp, type WhatsAppMode } from "./BaileysWhatsAppService";
import { startOfCairoDay } from "./cairoTime";
import { getMessengerSettings, getTelegramSettings, saveMessengerSettings, saveTelegramSettings } from "./ChannelIntegrationService";
import { allowedMediaTypes, imageSignatureMatches, publicMediaUrl, safeFileName, uploadLimitBytes, verifyPublicMediaUrl } from "./mediaStorage";
import { getPushConfig, sendPushNotification } from "./pushNotifications";
import { customerProfileSchema } from "./customerProfile";
import { sendPasswordResetApprovalEmail, sendPasswordResetEmail } from "./email";
import { createPasswordResetToken, hashPasswordResetToken } from "./passwordResetToken";
import { getChatbotSettings, saveChatbotSettings } from "./chatbotSettings";
import { cloudCallWebhookSecret, cloudCallWebhookVerifyToken, getCloudCallPermission, normalizeCloudCallTarget, processCloudCallWebhooks, requestCloudCallPermission, startCloudCall, terminateCloudCall, WhatsAppCloudApiError } from "./whatsappCalling";
import { createIceServers, createWebCallToken, hashWebCallToken, isWebCallToken } from "./webCallSecurity";
import { weeklyAgentPerformance } from "./weeklyAgentPerformance";
import { canReplyChannel, canViewChannel, channelAssignmentWhere, channelDepartmentPolicies, channelViewerWhere, effectiveChannelAccess, effectiveMessengerAccess, messengerDepartmentPolicies, messengerDepartments } from "./messengerAccess";
import { formatAgentHandoffGreeting } from "./autoReplies";
import { normalizePhoneNumber, phoneNumberLookupVariants } from "./egyptianPhoneFormatter";
import { accessibleConversationSearchScope, messageContentSearchWhere, normalizeSearchDigits } from "./search";
import { isWhatsAppGroupJid, WHATSAPP_GROUP_JID_SUFFIX } from "./whatsappGroup";
import { parseKalemlyPresenceUpdates } from "./whatsappPresence";

const app = express();
const server = http.createServer(app);
initRealtime(server);
app.use(cors({ origin: config.webOrigin, credentials: true }));
app.use(express.json({ limit: "15mb", verify: (req: any, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
async function reservePasswordResetEmail() {
  const bucket = Math.floor(Date.now() / (60 * 60 * 1000));
  const key = `password-reset-email-limit:${bucket}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 3700);
  return count <= 20;
}

const audit = (actorId: string | null, action: string, conversationId?: string, details: Prisma.InputJsonValue = {}) =>
  prisma.auditLog.create({ data: { actorId, action, conversationId, details } });
async function getCallRecordingSettings() {
  return prisma.callRecordingSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
}
const MESSENGER_WINDOW_MS = 24 * 60 * 60 * 1000;
const terminalStatuses: ConversationStatus[] = [ConversationStatus.CLOSED, ConversationStatus.RESOLVED];
const httpsUrl = z.string().url().refine((value) => value.startsWith("https://"), "استخدم رابط HTTPS آمنًا");
const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,32}$/, "اسم المستخدم من 3 إلى 32 حرفًا، ويقبل الحروف الإنجليزية والأرقام والنقطة والشرطة");
const permissionFields = { canViewAllConversations: z.boolean().nullable().optional(), canTransferConversations: z.boolean().nullable().optional(), canManageCatalog: z.boolean().nullable().optional(), canViewReports: z.boolean().nullable().optional(), canManageTeam: z.boolean().nullable().optional() };
const channelPermissionFields = {
  canReceiveWhatsApp: z.boolean().optional(), canReceiveMessenger: z.boolean().optional(), canReceiveTelegram: z.boolean().optional(),
  whatsappAccess: z.nativeEnum(MessengerAccessMode).nullable().optional(), telegramAccess: z.nativeEnum(MessengerAccessMode).nullable().optional()
};
const staffSelect = { id: true, email: true, username: true, name: true, role: true, department: true, presence: true, isActive: true, canViewAllConversations: true, canTransferConversations: true, canManageCatalog: true, canViewReports: true, canManageTeam: true, canReceiveWhatsApp: true, canReceiveMessenger: true, canReceiveTelegram: true, whatsappAccess: true, messengerAccess: true, telegramAccess: true } as const;
const configurableChannels = [Channel.WHATSAPP, Channel.TELEGRAM] as const;
const accessControlledChannels = [Channel.WHATSAPP, Channel.MESSENGER, Channel.TELEGRAM];
function inaccessibleChannels(user: NonNullable<AuthedRequest["user"]>) {
  return accessControlledChannels.filter((channel) => !canViewChannel(user, channel));
}
function readOnlyChannels(user: NonNullable<AuthedRequest["user"]>) {
  return accessControlledChannels.filter((channel) => canViewChannel(user, channel) && !canReplyChannel(user, channel));
}
async function channelRecipientWhere(channel: Channel): Promise<Prisma.UserWhereInput> {
  return channelAssignmentWhere(channel);
}
async function isConnectedFullAgent(userId: string, channel: Channel) {
  const agent = await prisma.user.findFirst({
    where: { id: userId, role: Role.AGENT, isActive: true, presence: Presence.ONLINE, ...await channelRecipientWhere(channel) },
    select: { id: true }
  });
  return Boolean(agent && await isUserConnected(agent.id));
}
function encodePageCursor(date: Date, id: string) {
  return Buffer.from(`${date.toISOString()}|${id}`).toString("base64url");
}
function decodePageCursor(value: unknown) {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.indexOf("|");
    if (separator < 1) return null;
    const date = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    return Number.isNaN(date.getTime()) || !id || id.length > 128 ? null : { date, id };
  } catch { return null; }
}
function pageLimit(value: unknown, fallback = 50) {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : fallback;
}
function callIceServers(subject: string) {
  return createIceServers({ stunUrls: config.webRtcStunUrls, turnUrls: config.webRtcTurnUrls, turnSharedSecret: config.webRtcTurnSharedSecret, subject });
}
const isMessenger = (channel: Channel) => channel === Channel.MESSENGER;
const isUniqueConstraintError = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
const systemAdminGuard: express.RequestHandler[] = [authenticate as express.RequestHandler, ((req: express.Request, res: express.Response, next: express.NextFunction) => {
  if ((req as AuthedRequest).user?.role !== Role.ADMIN) return res.status(403).json({ error: "يتطلب هذا الإجراء صلاحية مدير النظام" });
  next();
}) as express.RequestHandler];
async function lastInboundAt(conversationId: string, stored?: Date | null) {
  if (stored) return stored;
  const latest = await prisma.message.findFirst({ where: { conversationId, direction: MessageDirection.INBOUND }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  return latest?.createdAt || null;
}
async function canReadConversationOrHistory(user: NonNullable<AuthedRequest["user"]>, conversation: { id: string; assignedAgentId: string | null; branchId?: string | null; status: ConversationStatus; channel?: Channel; externalConversationId?: string }) {
  if (conversation.channel === Channel.WHATSAPP && !conversation.externalConversationId) {
    const identity = await prisma.conversation.findUnique({ where: { id: conversation.id }, select: { externalConversationId: true } });
    conversation = { ...conversation, externalConversationId: identity?.externalConversationId };
  }
  if (conversation.channel === Channel.WHATSAPP && isWhatsAppGroupJid(conversation.externalConversationId)) return true;
  if (conversation.channel && !canViewChannel(user, conversation.channel)) return false;
  if (user.role === Role.BRANCH_USER && (!user.branchId || user.branchId !== conversation.branchId)) return false;
  if (canReadConversation(user, conversation) || canReadTeamConversations(user, conversation)) return true;
  if (user.role !== Role.AGENT && user.role !== Role.BRANCH_USER) return false;
  return Boolean(await prisma.conversation.findFirst({
    where: { id: conversation.id, OR: [
      { assignmentHistory: { some: { agentId: user.id } } },
      { messages: { some: { authorId: user.id } } },
      { internalNotes: { some: { authorId: user.id } } },
      { whatsappCallSessions: { some: { agentId: user.id } } }
    ] },
    select: { id: true }
  }));
}
class ContactConversationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function customersMatchingPhone(phone: string) {
  const variants = phoneNumberLookupVariants(phone);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Customer"
    WHERE regexp_replace(translate(COALESCE("phone", ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g') IN (${Prisma.join(variants)})
    LIMIT 50
  `);
  if (!rows.length) return [];
  return prisma.customer.findMany({
    where: { id: { in: rows.map((row) => row.id) } },
    select: { id: true, name: true, displayName: true, phone: true, email: true, avatarUrl: true, isBlocked: true },
    orderBy: { updatedAt: "desc" }
  });
}
async function conversationsMatchingPhone(phone: string, customerIds: string[] = []) {
  const variants = phoneNumberLookupVariants(phone);
  const externalIds = [...new Set([
    ...variants, `+${phone}`, ...variants.map((value) => `${value}@s.whatsapp.net`), ...variants.map((value) => `${value}@c.us`)
  ])];
  return prisma.conversation.findMany({
    where: { channel: Channel.WHATSAPP, OR: [
      { externalCustomerId: { in: externalIds } }, { externalConversationId: { in: externalIds } },
      ...(customerIds.length ? [{ customerId: { in: customerIds } }] : [])
    ] },
    include: { customer: true, assignedAgent: { select: { id: true, name: true } }, messages: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }], take: 30
  });
}
async function startWhatsAppConversation(actor: NonNullable<AuthedRequest["user"]>, rawPhone: string, displayName = "", preferredCustomerId?: string, source: "PHONE" | "CONTACT" = "PHONE") {
  if (!canReplyChannel(actor, Channel.WHATSAPP)) throw new ContactConversationError(403, "صلاحية حسابك لا تسمح ببدء محادثات WhatsApp");
  if (actor.role === Role.BRANCH_USER && !actor.branchId) throw new ContactConversationError(409, "اربط حسابك بفرع قبل بدء محادثة");

  let phone: string;
  try { phone = normalizePhoneNumber(rawPhone); }
  catch (error) { throw new ContactConversationError(400, error instanceof Error ? error.message : "أدخل رقمًا دوليًا صحيحًا"); }
  return withInboundConversationLock(Channel.WHATSAPP, phone, async () => {
  const customers = await customersMatchingPhone(phone);
  let preferredCustomer = preferredCustomerId ? customers.find((customer) => customer.id === preferredCustomerId) : undefined;
  if (preferredCustomerId && !preferredCustomer) {
    preferredCustomer = await prisma.customer.findUnique({ where: { id: preferredCustomerId }, select: { id: true, name: true, displayName: true, phone: true, email: true, avatarUrl: true, isBlocked: true } }) || undefined;
    if (!preferredCustomer) throw new ContactConversationError(404, "جهة الاتصال غير موجودة");
  }
  const customerIds = [...new Set([...customers.map((customer) => customer.id), ...(preferredCustomer ? [preferredCustomer.id] : [])])];
  const existingConversations = await conversationsMatchingPhone(phone, customerIds);
  let existing: (typeof existingConversations)[number] | undefined;
  for (const candidate of existingConversations) {
    if (await canReadConversationOrHistory(actor, candidate)) { existing = candidate; break; }
  }
  if (!existing && existingConversations.length) throw new ContactConversationError(403, "توجد محادثة واتساب لهذا الرقم خارج صلاحياتك");
  if (existing) {
    if (existing.customer.isBlocked) throw new ContactConversationError(409, "هذا العميل محظور ولا يمكن بدء محادثة معه");
    const previousInbound = await lastInboundAt(existing.id, existing.lastInboundAt);
    if (!previousInbound && existing.serviceTag !== "تواصل مباشر" && canWorkOnConversation(actor, existing)) {
      await prisma.conversation.update({ where: { id: existing.id }, data: { serviceTag: "تواصل مباشر" } });
    }
    return { conversationId: existing.id, created: false, readOnly: !canWorkOnConversation(actor, existing) };
  }

  let customer = preferredCustomer || customers[0];
  if (customer?.isBlocked) throw new ContactConversationError(409, "هذا العميل محظور ولا يمكن بدء محادثة معه");
  if (!customer) {
    const name = displayName.trim().slice(0, 120);
    customer = await prisma.customer.create({ data: { name: name || phone, displayName: name || null, phone }, select: { id: true, name: true, displayName: true, phone: true, email: true, avatarUrl: true, isBlocked: true } });
  }

  const externalConversationId = await getWhatsAppMode() === "BAILEYS" ? `${phone}@s.whatsapp.net` : phone;
  try {
    const conversation = await prisma.conversation.create({ data: {
      customerId: customer.id, channel: Channel.WHATSAPP, externalConversationId, externalCustomerId: phone,
      assignedAgentId: actor.id, status: ConversationStatus.OPEN, awaitingRouting: false, serviceTag: "تواصل مباشر",
      ...(actor.role === Role.BRANCH_USER ? { branchId: actor.branchId, routingDepartment: Department.BRANCH } : {})
    } });
    await audit(actor.id, `WHATSAPP_CONVERSATION_STARTED_FROM_${source}`, conversation.id, { customerId: customer.id, phone });
    io.to(`agent:${actor.id}`).emit("conversation:updated", conversation);
    io.to("admins").emit("conversation:updated", conversation);
    return { conversationId: conversation.id, created: true, readOnly: false };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const duplicate = await prisma.conversation.findUnique({ where: { channel_externalConversationId: { channel: Channel.WHATSAPP, externalConversationId } }, include: { customer: true, assignedAgent: { select: { id: true, name: true } }, messages: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } });
    if (!duplicate || !await canReadConversationOrHistory(actor, duplicate)) throw new ContactConversationError(409, "توجد محادثة واتساب لهذا الرقم لكنها ليست ضمن صلاحياتك");
    return { conversationId: duplicate.id, created: false, readOnly: !canWorkOnConversation(actor, duplicate) };
  }
  });
}
function messengerWindowOpen(channel: Channel, inboundAt: Date | null) {
  return !isMessenger(channel) || Boolean(inboundAt && Date.now() - inboundAt.getTime() < MESSENGER_WINDOW_MS);
}
async function queueWhatsAppMessage(messageId: string, conversationId: string, authorId: string | null, input: Parameters<typeof sendToChannel>[0], options: { clientMessageId?: string } = {}) {
  const emitMessage = (message: unknown) => {
    const targets = io.to(`conversation:${conversationId}`).to("admins");
    const payload = { conversationId, message, ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}) };
    if (authorId) targets.to(`agent:${authorId}`).emit("message:new", payload);
    else targets.emit("message:new", payload);
  };
  const queued = await prisma.message.findUnique({ where: { id: messageId }, include: { author: { select: { id: true, name: true } }, quotedMessage: { select: { id: true, text: true, kind: true } } } });
  if (queued) emitMessage(queued);
  try {
    await sendToChannel({ ...input, outboundMessageId: messageId });
  } catch (error) {
    console.warn("Could not enqueue WhatsApp delivery", messageId, error);
    const failed = await prisma.message.update({ where: { id: messageId }, data: { deliveryStatus: "FAILED" }, include: { author: { select: { id: true, name: true } } } });
    emitMessage(failed);
  }
  return prisma.message.findUnique({ where: { id: messageId }, include: { author: { select: { id: true, name: true } }, quotedMessage: { select: { id: true, text: true, kind: true } } } });
}

app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "bondoq-api" }));

app.post("/api/media", agentGuard, express.raw({ type: () => true, limit: uploadLimitBytes }), async (req: AuthedRequest, res: express.Response) => {
  try { publicMediaUrl("configuration-check", 3600); }
  catch { return res.status(503).json({ error: "لم يتم إعداد API_PUBLIC_URL صالح وآمن لاستقبال الوسائط" }); }
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "اختر ملفًا صالحًا" });
  const contentType = String(req.header("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!allowedMediaTypes.has(contentType)) return res.status(415).json({ error: "نوع الملف غير مدعوم" });
  if (!imageSignatureMatches(contentType, req.body)) return res.status(415).json({ error: "محتوى الصورة لا يطابق نوع الملف" });
  if (req.user!.role === Role.AGENT || req.user!.role === Role.BRANCH_USER) {
    const conversationId = req.header("x-conversation-id");
    if (!conversationId) return res.status(400).json({ error: "يلزم تحديد المحادثة قبل رفع الملف" });
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { assignedAgentId: true, branchId: true } });
    if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
    if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "ليس لديك صلاحية رفع ملف لهذه المحادثة" });
  }
  let fileName: string;
  try { fileName = safeFileName(decodeURIComponent(req.header("x-file-name") || "attachment")); }
  catch { return res.status(400).json({ error: "اسم الملف غير صالح" }); }
  const asset = await prisma.mediaAsset.create({ data: {
    fileName, contentType, size: req.body.length, data: Uint8Array.from(req.body), createdById: req.user!.id
  }, select: { id: true, fileName: true, contentType: true, size: true } });
  res.status(201).json(asset);
});

app.get("/public-media/:id", async (req, res) => {
  if (!verifyPublicMediaUrl(req.params.id, req.query.expires, req.query.signature)) return res.sendStatus(403);
  const asset = await prisma.mediaAsset.findUnique({ where: { id: req.params.id }, select: { data: true, contentType: true, fileName: true, size: true } });
  if (!asset) return res.sendStatus(404);
  res.set({
    "Content-Type": asset.contentType,
    "Content-Length": String(asset.size),
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`,
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff"
  }).send(Buffer.from(asset.data));
});

app.post("/api/auth/login", async (req, res) => {
  const parsed = z.object({ identifier: z.string().min(1), password: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "أدخل البريد أو اسم المستخدم وكلمة المرور" });
  const { identifier, password } = parsed.data;
  const user = await prisma.user.findFirst({ where: { OR: [{ email: identifier.toLowerCase() }, { username: identifier.toLowerCase() }] } });
  if (!user || !user.isActive || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });
  const isWorkUser = user.role === Role.AGENT || user.role === Role.BRANCH_USER;
  if (isWorkUser && user.presence === Presence.OFFLINE) {
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { presence: Presence.ONLINE, lastSeenAt: new Date() } }),
      prisma.agentSession.create({ data: { userId: user.id, startState: Presence.ONLINE } }),
      prisma.auditLog.create({ data: { actorId: user.id, action: "AGENT_LOGIN" } })
    ]);
    broadcastPresence(user.id, Presence.ONLINE, user.department);
  }
  if (isWorkUser) await dispatchQueued();
  const token = signToken({ id: user.id, role: user.role, name: user.name, authVersion: user.authVersion });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, username: user.username, role: user.role, department: user.department, branchId: user.branchId, canViewAllConversations: user.canViewAllConversations, canTransferConversations: user.canTransferConversations, canManageCatalog: user.canManageCatalog, canViewReports: user.canViewReports, canManageTeam: user.canManageTeam } });
});

app.post("/api/auth/logout", authenticate, async (req: AuthedRequest, res) => {
  const isAgent = req.user!.role === Role.AGENT || req.user!.role === Role.BRANCH_USER;
  await prisma.user.update({ where: { id: req.user!.id }, data: { authVersion: { increment: 1 }, ...(isAgent ? { presence: Presence.OFFLINE, lastSeenAt: new Date() } : {}) } });
  await prisma.auditLog.create({ data: { actorId: req.user!.id, action: isAgent ? "AGENT_LOGOUT" : "USER_LOGOUT" } });
  if (isAgent) {
    await prisma.agentSession.updateMany({ where: { userId: req.user!.id, endedAt: null }, data: { endedAt: new Date(), endState: Presence.OFFLINE } });
    broadcastPresence(req.user!.id, Presence.OFFLINE, req.user!.department);
    await releaseAgentConversations(req.user!.id);
  }
  io.in(`user:${req.user!.id}`).disconnectSockets(true);
  res.sendStatus(204);
});

app.get("/api/auth/me", authenticate, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { id: true, username: true, name: true, email: true, role: true, department: true, branchId: true, branch: { select: { name: true } }, presence: true, canViewAllConversations: true, canTransferConversations: true, canManageCatalog: true, canViewReports: true, canManageTeam: true, canReceiveWhatsApp: true, canReceiveMessenger: true, canReceiveTelegram: true, whatsappAccess: true, messengerAccess: true, telegramAccess: true } });
  if (!user) return res.status(401).json({ error: "الحساب غير موجود" });
  res.json({
    ...user,
    whatsappAccess: effectiveChannelAccess(req.user!, Channel.WHATSAPP),
    canReceiveWhatsApp: effectiveChannelAccess(req.user!, Channel.WHATSAPP) === MessengerAccessMode.FULL,
    whatsappAccessOverride: user.whatsappAccess,
    messengerAccessOverride: user.messengerAccess,
    messengerAccess: effectiveMessengerAccess(req.user!),
    canReceiveMessenger: effectiveMessengerAccess(req.user!) === MessengerAccessMode.FULL,
    telegramAccess: effectiveChannelAccess(req.user!, Channel.TELEGRAM),
    canReceiveTelegram: effectiveChannelAccess(req.user!, Channel.TELEGRAM) === MessengerAccessMode.FULL,
    telegramAccessOverride: user.telegramAccess
  });
});

app.patch("/api/auth/me", authenticate, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ username: usernameSchema.optional(), name: z.string().trim().min(2).max(120).optional() }).strict().refine((value) => value.username !== undefined || value.name !== undefined).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "أدخل اسمًا أو اسم مستخدم صالحًا" });
  try {
    const user = await prisma.user.update({ where: { id: req.user!.id }, data: parsed.data, select: { id: true, username: true, name: true, email: true, role: true, department: true, presence: true } });
    await audit(user.id, parsed.data.username ? "USERNAME_UPDATED" : "PROFILE_UPDATED", undefined, { nameChanged: parsed.data.name !== undefined, usernameChanged: parsed.data.username !== undefined });
    res.json(user);
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: "اسم المستخدم مستخدم بالفعل" });
    throw error;
  }
});

app.patch("/api/auth/me/password", authenticate, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(12).max(200) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "كلمة المرور الجديدة يجب أن تتكون من 12 حرفًا على الأقل" });
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { passwordHash: true } });
  if (!user || !(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) return res.status(401).json({ error: "كلمة المرور الحالية غير صحيحة" });
  await prisma.user.update({ where: { id: req.user!.id }, data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, 12), authVersion: { increment: 1 } } });
  await audit(req.user!.id, "PASSWORD_CHANGED");
  io.in(`user:${req.user!.id}`).disconnectSockets(true);
  res.sendStatus(204);
});

const genericPasswordResetRequestMessage = "إذا كانت البيانات تخص حسابًا نشطًا، فسيظهر طلب إعادة الضبط للموافقة.";
app.post("/api/auth/password-reset/request", async (req, res) => {
  const parsed = z.object({ identifier: z.string().trim().min(1).max(254) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "أدخل البريد المسجّل أو اسم المستخدم" });
  if (!config.resendApiKey || !config.emailFrom) return res.status(503).json({ error: "خدمة البريد غير مهيأة حاليًا. حاول لاحقًا." });
  const identifier = parsed.data.identifier.toLowerCase();
  const user = await prisma.user.findFirst({ where: { OR: [{ email: identifier }, { username: identifier }], isActive: true }, select: { id: true, name: true, email: true, username: true, role: true } });
  if (user) {
    const current = await prisma.passwordResetRequest.findUnique({ where: { userId: user.id } });
    const now = new Date();
    const canStartNewRequest = !current || current.status === PasswordResetStatus.REJECTED || current.status === PasswordResetStatus.USED || current.status === PasswordResetStatus.APPROVED && Boolean(current.expiresAt && current.expiresAt <= now);
    const canResendApproval = current?.status === PasswordResetStatus.PENDING && (!current.approvalTokenHash || !current.approvalExpiresAt || current.approvalExpiresAt <= now);
    if (canStartNewRequest || canResendApproval) {
      if (!await reservePasswordResetEmail()) return res.status(429).json({ error: "تم بلوغ حد إرسال رسائل الاستعادة مؤقتًا. حاول بعد ساعة." });
      const { token, tokenHash: approvalTokenHash } = createPasswordResetToken();
      const approvalExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
      const requestedAt = new Date();
      let requestId: string;
      if (current) {
        const updated = await prisma.passwordResetRequest.update({ where: { userId: user.id }, data: { status: PasswordResetStatus.PENDING, requestedAt, tokenHash: null, expiresAt: null, approvalTokenHash, approvalExpiresAt, reviewedAt: null, reviewerId: null, usedAt: null } });
        requestId = updated.id;
      } else {
        try {
          const created = await prisma.passwordResetRequest.create({ data: { userId: user.id, approvalTokenHash, approvalExpiresAt } });
          requestId = created.id;
        } catch (error) {
          if (!isUniqueConstraintError(error)) throw error;
          return res.json({ message: genericPasswordResetRequestMessage });
        }
      }
      const approvalUrl = new URL("/approve-password-reset", config.webOrigin);
      approvalUrl.searchParams.set("token", token);
      try {
        await sendPasswordResetApprovalEmail(config.passwordResetRecoveryEmail, user.name, `${user.email} · ${user.username} · ${user.role}`, approvalUrl.toString());
      } catch (error) {
        await prisma.passwordResetRequest.updateMany({ where: { id: requestId, approvalTokenHash }, data: { approvalTokenHash: null, approvalExpiresAt: null } });
        console.error("Password reset approval email could not be sent", error);
        return res.status(503).json({ error: "تعذر إرسال رسالة الموافقة. لم يتم تغيير كلمة المرور؛ حاول لاحقًا." });
      }
      await audit(null, "PASSWORD_RESET_REQUESTED", undefined, { userId: user.id });
    }
  }
  res.json({ message: genericPasswordResetRequestMessage });
});

app.get("/api/admin/password-reset-requests", systemAdminGuard, async (_req: express.Request, res: express.Response) => {
  const requests = await prisma.passwordResetRequest.findMany({
    where: { status: { in: [PasswordResetStatus.PENDING, PasswordResetStatus.APPROVED] } },
    select: { id: true, status: true, requestedAt: true, expiresAt: true, user: { select: { id: true, name: true, email: true, username: true, role: true, isActive: true } } },
    orderBy: { requestedAt: "asc" }
  });
  res.json(requests);
});

app.post("/api/admin/password-reset-requests/:id/approve", systemAdminGuard, async (req: AuthedRequest, res: express.Response) => {
  const request = await prisma.passwordResetRequest.findUnique({ where: { id: req.params.id }, include: { user: { select: { id: true, name: true, email: true, username: true, role: true, isActive: true } } } });
  if (!request) return res.status(404).json({ error: "طلب إعادة الضبط غير موجود" });
  if (request.userId === req.user!.id) return res.status(403).json({ error: "يجب أن يوافق مدير آخر على طلبك" });
  if (!request.user.isActive) return res.status(409).json({ error: "الحساب موقوف" });
  if (request.status !== PasswordResetStatus.PENDING && request.status !== PasswordResetStatus.APPROVED) return res.status(409).json({ error: "الطلب لم يعد متاحًا للموافقة" });
  if (!config.resendApiKey || !config.emailFrom) return res.status(503).json({ error: "لم يتم إعداد إرسال البريد. أضف RESEND_API_KEY و EMAIL_FROM أولًا." });
  if (!await reservePasswordResetEmail()) return res.status(429).json({ error: "تم بلوغ حد إرسال رسائل الاستعادة مؤقتًا. حاول بعد ساعة." });

  const { token, tokenHash } = createPasswordResetToken();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const previous = { status: request.status, tokenHash: request.tokenHash, expiresAt: request.expiresAt, approvalTokenHash: request.approvalTokenHash, approvalExpiresAt: request.approvalExpiresAt, reviewedAt: request.reviewedAt, reviewerId: request.reviewerId };
  await prisma.passwordResetRequest.update({ where: { id: request.id }, data: { status: PasswordResetStatus.APPROVED, tokenHash, expiresAt, approvalTokenHash: null, approvalExpiresAt: null, reviewedAt: new Date(), reviewerId: req.user!.id } });
  const resetUrl = new URL("/reset-password", config.webOrigin);
  resetUrl.searchParams.set("token", token);
  try {
    await sendPasswordResetEmail(config.passwordResetRecoveryEmail, resetUrl.toString());
  } catch (error) {
    await prisma.passwordResetRequest.updateMany({ where: { id: request.id, tokenHash }, data: previous });
    console.error("Password reset email could not be sent", error);
    return res.status(503).json({ error: "تعذر إرسال رسالة إعادة الضبط. لم يتغير الطلب، ويمكن إعادة المحاولة." });
  }
  await audit(req.user!.id, "PASSWORD_RESET_APPROVED", undefined, { targetUserId: request.userId, recoveryEmail: config.passwordResetRecoveryEmail });
  res.json({ message: `تمت الموافقة وإرسال رابط إعادة الضبط إلى ${config.passwordResetRecoveryEmail}.` });
});

app.post("/api/auth/password-reset/approve-by-email", async (req, res) => {
  const parsed = z.object({ token: z.string().min(40).max(100) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "رابط الموافقة غير صالح أو منتهي الصلاحية" });
  const approvalTokenHash = hashPasswordResetToken(parsed.data.token);
  const request = await prisma.passwordResetRequest.findUnique({ where: { approvalTokenHash }, include: { user: { select: { id: true, isActive: true } } } });
  const now = new Date();
  if (!request || request.status !== PasswordResetStatus.PENDING || !request.approvalExpiresAt || request.approvalExpiresAt <= now || !request.user.isActive) {
    return res.status(400).json({ error: "رابط الموافقة غير صالح أو منتهي الصلاحية" });
  }
  if (!await reservePasswordResetEmail()) return res.status(429).json({ error: "تم بلوغ حد إرسال رسائل الاستعادة مؤقتًا. حاول بعد ساعة." });

  const { token, tokenHash } = createPasswordResetToken();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const previous = { status: request.status, tokenHash: request.tokenHash, expiresAt: request.expiresAt, approvalTokenHash: request.approvalTokenHash, approvalExpiresAt: request.approvalExpiresAt, reviewedAt: request.reviewedAt, reviewerId: request.reviewerId };
  const claimed = await prisma.passwordResetRequest.updateMany({
    where: { id: request.id, status: PasswordResetStatus.PENDING, approvalTokenHash, approvalExpiresAt: { gt: new Date() } },
    data: { status: PasswordResetStatus.APPROVED, tokenHash, expiresAt, approvalTokenHash: null, approvalExpiresAt: null, reviewedAt: new Date(), reviewerId: null }
  });
  if (!claimed.count) return res.status(400).json({ error: "رابط الموافقة غير صالح أو منتهي الصلاحية" });
  const resetUrl = new URL("/reset-password", config.webOrigin);
  resetUrl.searchParams.set("token", token);
  try {
    await sendPasswordResetEmail(config.passwordResetRecoveryEmail, resetUrl.toString());
  } catch (error) {
    await prisma.passwordResetRequest.updateMany({ where: { id: request.id, tokenHash }, data: previous });
    console.error("Password reset email could not be sent", error);
    return res.status(503).json({ error: "تعذر إرسال رابط التغيير. أعد فتح رسالة الموافقة وحاول مجددًا." });
  }
  await audit(null, "PASSWORD_RESET_APPROVED", undefined, { targetUserId: request.userId, recoveryEmail: config.passwordResetRecoveryEmail, approvalMethod: "RECOVERY_EMAIL" });
  res.json({ message: `تمت الموافقة، وأُرسل رابط تغيير كلمة المرور إلى ${config.passwordResetRecoveryEmail}.` });
});

app.post("/api/admin/password-reset-requests/:id/reject", systemAdminGuard, async (req: AuthedRequest, res: express.Response) => {
  const result = await prisma.passwordResetRequest.updateMany({
    where: { id: req.params.id, status: { in: [PasswordResetStatus.PENDING, PasswordResetStatus.APPROVED] } },
    data: { status: PasswordResetStatus.REJECTED, tokenHash: null, expiresAt: null, approvalTokenHash: null, approvalExpiresAt: null, reviewedAt: new Date(), reviewerId: req.user!.id }
  });
  if (!result.count) return res.status(409).json({ error: "الطلب لم يعد متاحًا للرفض" });
  const request = await prisma.passwordResetRequest.findUnique({ where: { id: req.params.id }, select: { userId: true } });
  if (request) await audit(req.user!.id, "PASSWORD_RESET_REJECTED", undefined, { targetUserId: request.userId });
  res.json({ message: "تم رفض طلب إعادة ضبط كلمة المرور." });
});

app.post("/api/auth/password-reset/complete", async (req, res) => {
  const parsed = z.object({ token: z.string().min(40).max(100), newPassword: z.string().min(12).max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "كلمة المرور الجديدة يجب أن تتكون من 12 حرفًا على الأقل" });
  const tokenHash = hashPasswordResetToken(parsed.data.token);
  const request = await prisma.passwordResetRequest.findUnique({ where: { tokenHash }, include: { user: { select: { id: true, isActive: true } } } });
  const now = new Date();
  if (!request || request.status !== PasswordResetStatus.APPROVED || !request.expiresAt || request.expiresAt <= now || !request.user.isActive) {
    return res.status(400).json({ error: "رابط إعادة الضبط غير صالح أو منتهي الصلاحية" });
  }
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  let consumed = false;
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordResetRequest.updateMany({
      where: { id: request.id, status: PasswordResetStatus.APPROVED, tokenHash, expiresAt: { gt: new Date() } },
      data: { status: PasswordResetStatus.USED, usedAt: new Date() }
    });
    if (!claimed.count) return;
    await tx.user.update({ where: { id: request.userId }, data: { passwordHash, authVersion: { increment: 1 } } });
    consumed = true;
  });
  if (!consumed) return res.status(400).json({ error: "رابط إعادة الضبط غير صالح أو منتهي الصلاحية" });
  await audit(request.userId, "PASSWORD_RESET_COMPLETED");
  io.in(`user:${request.userId}`).disconnectSockets(true);
  res.json({ message: "تم تغيير كلمة المرور. يمكنك تسجيل الدخول الآن." });
});

app.get("/api/conversations", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const actor = req.user!;
  const canSeeAll = actor.role === Role.ADMIN || actor.role === Role.SUPERVISOR && hasPermission(actor, "canViewAllConversations");
  const teamView = req.query.team === "1" && canReadTeamConversations(actor);
  const historyOnly = req.query.history === "1" && !canSeeAll && !teamView;
  const deniedChannels = inaccessibleChannels(actor);
  const deniedChannelsForIndividualChats = deniedChannels.filter((channel) => channel !== Channel.WHATSAPP);
  const viewOnlyChannels = readOnlyChannels(actor);
  const scope: Prisma.ConversationWhereInput[] = canSeeAll ? [] : teamView
    ? actor.role === Role.BRANCH_USER ? [{ branchId: actor.branchId! }] : []
    : historyOnly ? [
    ...(actor.role === Role.BRANCH_USER ? [{ branchId: actor.branchId! }] : []),
    { OR: [{ assignedAgentId: null }, { assignedAgentId: { not: actor.id } }] },
    { OR: [
      { assignmentHistory: { some: { agentId: actor.id } } },
      { messages: { some: { authorId: actor.id } } },
      { internalNotes: { some: { authorId: actor.id } } },
      { whatsappCallSessions: { some: { agentId: actor.id } } }
    ] }
   ] : viewOnlyChannels.length ? [{ OR: [{ assignedAgentId: actor.id }, { channel: { in: viewOnlyChannels } }] }] : [{ assignedAgentId: actor.id }];
  const requestedChannel = typeof req.query.channel === "string" ? req.query.channel : undefined;
  const groupFilter = typeof req.query.whatsappGroups === "string" ? req.query.whatsappGroups : undefined;
  if (requestedChannel && requestedChannel !== "ALL" && !Object.values(Channel).includes(requestedChannel as Channel)) return res.status(400).json({ error: "قناة المحادثة غير صالحة" });
  if (groupFilter && !["0", "1"].includes(groupFilter)) return res.status(400).json({ error: "مرشح مجموعات WhatsApp غير صالح" });
  if (groupFilter && requestedChannel && !["ALL", Channel.WHATSAPP].includes(requestedChannel as any)) return res.status(400).json({ error: "مرشح المجموعات متاح لقناة WhatsApp فقط" });
  const channel = groupFilter ? Channel.WHATSAPP : requestedChannel;
  const groupFilterWhere: Prisma.ConversationWhereInput | undefined = groupFilter === "1"
    ? { externalConversationId: { endsWith: WHATSAPP_GROUP_JID_SUFFIX } }
    : groupFilter === "0" ? { NOT: { externalConversationId: { endsWith: WHATSAPP_GROUP_JID_SUFFIX } } } : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  if (req.query.archived !== undefined && !["0", "1"].includes(String(req.query.archived))) return res.status(400).json({ error: "مرشح الأرشيف غير صالح" });
  const archivedView = req.query.archived === "1";
  const paginated = req.query.limit !== undefined || req.query.cursor !== undefined;
  const cursor = req.query.cursor === undefined ? null : decodePageCursor(req.query.cursor);
  if (req.query.cursor !== undefined && !cursor) return res.status(400).json({ error: "مؤشر صفحة المحادثات غير صالح" });
  const limit = pageLimit(req.query.limit);
  const conversations = await prisma.conversation.findMany({
    where: {
      AND: [
        ...(canSeeAll ? scope : [{ OR: [
          { AND: [...scope, ...(deniedChannels.includes(Channel.WHATSAPP) ? [{ channel: { not: Channel.WHATSAPP } }] : [])] },
          { channel: Channel.WHATSAPP, externalConversationId: { endsWith: WHATSAPP_GROUP_JID_SUFFIX } }
        ] }]),
        ...(groupFilterWhere ? [groupFilterWhere] : []),
        ...(cursor ? [{ OR: [{ lastMessageAt: { lt: cursor.date } }, { lastMessageAt: cursor.date, id: { lt: cursor.id } }] }] : []),
        archivedView
          ? { personalPreferences: { some: { userId: actor.id, isArchived: true, isDeleted: false } } }
          : { NOT: { personalPreferences: { some: { userId: actor.id, OR: [{ isDeleted: true }, { isArchived: true }] } } } }
      ],
      ...(deniedChannelsForIndividualChats.length ? { NOT: deniedChannelsForIndividualChats.map((deniedChannel) => ({ channel: deniedChannel })) } : {}),
      ...(channel && channel !== "ALL" ? { channel: channel as Channel } : {}),
      ...(status && status !== "ALL" ? { status: status as ConversationStatus } : {}),
    },
    include: {
      customer: true,
      assignedAgent: { select: { id: true, name: true, presence: true } },
      personalPreferences: { where: { userId: actor.id } },
      messages: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 }
    },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }], take: paginated ? limit + 1 : 100
  });
  const readAtFilters = conversations.flatMap((conversation) => {
    const readAt = conversation.personalPreferences[0]?.readAt;
    return readAt ? [{ conversationId: conversation.id, createdAt: { gt: readAt } }] : [];
  });
  const inboundCounts = readAtFilters.length ? await prisma.message.groupBy({
    by: ["conversationId"],
    where: { direction: MessageDirection.INBOUND, OR: readAtFilters },
    _count: { _all: true }
  }) : [];
  const inboundCountByConversation = new Map(inboundCounts.map((row) => [row.conversationId, row._count._all]));
  const withPersonalState = (conversation: typeof conversations[number]) => {
    const { personalPreferences, ...item } = conversation;
    const personalState = personalPreferences[0] || null;
    const messages = personalState?.clearedAt ? item.messages.filter((message) => message.createdAt > personalState.clearedAt!) : item.messages;
    const unreadCount = personalState?.readAt ? inboundCountByConversation.get(item.id) || 0 : item.unreadCount;
    return { ...item, messages, personalState, unreadCount, readOnly: !canWorkOnConversation(actor, item) };
  };
  if (!paginated) return res.json(conversations.map(withPersonalState));
  const hasMore = conversations.length > limit;
  const items = conversations.slice(0, limit).map(withPersonalState);
  res.json({ items, hasMore, nextCursor: hasMore && items.length ? encodePageCursor(items[items.length - 1].lastMessageAt, items[items.length - 1].id) : null });
});

app.patch("/api/conversations/:id/personal-settings", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({
    isArchived: z.boolean().optional(),
    isMuted: z.boolean().optional(),
    isDeleted: z.boolean().optional(),
    markRead: z.boolean().optional(),
    clear: z.boolean().optional()
  }).strict().refine((value) => Object.keys(value).length > 0).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "إعدادات المحادثة غير صالحة" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, select: { id: true, assignedAgentId: true, branchId: true, status: true, channel: true, externalConversationId: true } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!await canReadConversationOrHistory(req.user!, conversation)) return res.status(403).json({ error: "هذه المحادثة ليست ضمن محادثاتك" });
  const { markRead, clear, ...values } = parsed.data;
  const data = {
    ...values,
    ...(markRead !== undefined ? { readAt: markRead ? new Date() : null } : {}),
    ...(clear ? { clearedAt: new Date() } : {})
  };
  const personalState = await prisma.conversationPreference.upsert({
    where: { userId_conversationId: { userId: req.user!.id, conversationId: conversation.id } },
    create: { userId: req.user!.id, conversationId: conversation.id, ...data },
    update: data
  });
  const action = parsed.data.isDeleted ? "CONVERSATION_HIDDEN_FOR_USER"
    : parsed.data.isArchived ? "CONVERSATION_ARCHIVED_FOR_USER"
      : clear ? "CONVERSATION_CLEARED_FOR_USER" : "CONVERSATION_PREFERENCE_UPDATED";
  await audit(req.user!.id, action, conversation.id, { ...parsed.data });
  res.json({ conversationId: conversation.id, personalState, unreadCount: markRead ? 0 : undefined });
});

app.get("/api/me/muted-conversations", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const preferences = await prisma.conversationPreference.findMany({ where: { userId: req.user!.id, isMuted: true }, select: { conversationId: true } });
  res.json({ conversationIds: preferences.map((preference) => preference.conversationId) });
});

app.get("/api/conversation-lists", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const lists = await prisma.conversationList.findMany({
    where: { userId: req.user!.id },
    include: { _count: { select: { items: true } } },
    orderBy: [{ createdAt: "asc" }, { name: "asc" }]
  });
  res.json(lists.map(({ _count, ...list }) => ({ ...list, itemCount: _count.items })));
});

app.post("/api/conversation-lists", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(48) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اسم القائمة غير صالح" });
  try {
    const list = await prisma.conversationList.create({ data: { userId: req.user!.id, name: parsed.data.name } });
    await audit(req.user!.id, "CONVERSATION_LIST_CREATED", undefined, { listId: list.id, name: list.name });
    res.status(201).json({ ...list, itemCount: 0 });
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: "لديك قائمة بهذا الاسم بالفعل" });
    throw error;
  }
});

app.put("/api/conversation-lists/:id/conversations", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ conversationId: z.string().min(1) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "المحادثة غير صالحة" });
  const [list, conversation] = await Promise.all([
    prisma.conversationList.findFirst({ where: { id: req.params.id, userId: req.user!.id }, select: { id: true, name: true } }),
    prisma.conversation.findUnique({ where: { id: parsed.data.conversationId }, select: { id: true, assignedAgentId: true, branchId: true, status: true, channel: true, externalConversationId: true } })
  ]);
  if (!list) return res.status(404).json({ error: "القائمة غير موجودة" });
  if (!conversation || !await canReadConversationOrHistory(req.user!, conversation)) return res.status(404).json({ error: "المحادثة غير موجودة أو ليست ضمن صلاحياتك" });
  await prisma.conversationListItem.upsert({
    where: { listId_conversationId: { listId: list.id, conversationId: conversation.id } },
    create: { listId: list.id, conversationId: conversation.id }, update: {}
  });
  await audit(req.user!.id, "CONVERSATION_ADDED_TO_PERSONAL_LIST", conversation.id, { listId: list.id, name: list.name });
  res.json({ listId: list.id, conversationId: conversation.id });
});

app.get("/api/conversations/favorites", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const canSeeAll = req.user!.role === Role.ADMIN || req.user!.role === Role.SUPERVISOR && hasPermission(req.user!, "canViewAllConversations");
  const deniedChannels = inaccessibleChannels(req.user!);
  const favorites = await prisma.conversationFavorite.findMany({
    where: { userId: req.user!.id, AND: [
      ...(!canSeeAll ? [{ conversation: { is: { OR: [
        { assignedAgentId: req.user!.id, ...(deniedChannels.includes(Channel.WHATSAPP) ? { channel: { not: Channel.WHATSAPP } } : {}) },
        { channel: Channel.WHATSAPP, externalConversationId: { endsWith: WHATSAPP_GROUP_JID_SUFFIX } }
      ] } } }] : []),
      { conversation: { is: { personalPreferences: { none: { userId: req.user!.id, isDeleted: true } } } } },
      ...(deniedChannels.filter((channel) => channel !== Channel.WHATSAPP).length ? [{ conversation: { is: { channel: { notIn: deniedChannels.filter((channel) => channel !== Channel.WHATSAPP) } } } }] : [])
    ] },
    include: { conversation: { include: { customer: true, assignedAgent: { select: { id: true, name: true, presence: true } }, messages: { orderBy: { createdAt: "desc" }, take: 1 } } } },
    orderBy: { createdAt: "desc" }, take: 100
  });
  res.json(favorites.map((favorite) => favorite.conversation));
});

app.get("/api/conversations/pins", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const canSeeAll = req.user!.role === Role.ADMIN || req.user!.role === Role.SUPERVISOR && hasPermission(req.user!, "canViewAllConversations");
  const deniedChannels = inaccessibleChannels(req.user!);
  const pins = await prisma.conversationPin.findMany({
    where: { userId: req.user!.id, AND: [
      ...(!canSeeAll ? [{ conversation: { is: { OR: [
        { assignedAgentId: req.user!.id, ...(deniedChannels.includes(Channel.WHATSAPP) ? { channel: { not: Channel.WHATSAPP } } : {}) },
        { channel: Channel.WHATSAPP, externalConversationId: { endsWith: WHATSAPP_GROUP_JID_SUFFIX } }
      ] } } }] : []),
      { conversation: { is: { personalPreferences: { none: { userId: req.user!.id, isDeleted: true } } } } },
      ...(deniedChannels.filter((channel) => channel !== Channel.WHATSAPP).length ? [{ conversation: { is: { channel: { notIn: deniedChannels.filter((channel) => channel !== Channel.WHATSAPP) } } } }] : [])
    ] },
    include: { conversation: { include: { customer: true, assignedAgent: { select: { id: true, name: true, presence: true } }, messages: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } } },
    orderBy: { createdAt: "desc" }, take: 100
  });
  res.json(pins.map((pin) => pin.conversation));
});

app.get("/api/conversations/search", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const actor = req.user!;
  if (actor.role === Role.BRANCH_USER && !actor.branchId) return res.status(403).json({ error: "يجب ربط الحساب بفرع قبل البحث في المحادثات" });
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
  const digits = normalizeSearchDigits(query);
  if (query.length < 2 && digits.length < 3) return res.status(400).json({ error: "اكتب حرفين على الأقل أو ثلاثة أرقام للبحث" });
  const offsetValue = typeof req.query.offset === "string" ? Number(req.query.offset) : 0;
  if (!Number.isSafeInteger(offsetValue) || offsetValue < 0 || offsetValue > 10_000) return res.status(400).json({ error: "صفحة البحث غير صالحة" });

  const canSeeAll = actor.role === Role.ADMIN || actor.role === Role.SUPERVISOR && hasPermission(actor, "canViewAllConversations");
  const teamView = req.query.team === "1" && canReadTeamConversations(actor);
  const historyOnly = req.query.history === "1" && !canSeeAll && !teamView;
  const deniedChannels = inaccessibleChannels(actor);
  const deniedChannelsForIndividualChats = deniedChannels.filter((channel) => channel !== Channel.WHATSAPP);
  const viewOnlyChannels = readOnlyChannels(actor);
  const scope: Prisma.ConversationWhereInput[] = canSeeAll ? [] : teamView
    ? actor.role === Role.BRANCH_USER ? [{ branchId: actor.branchId! }] : []
    : historyOnly ? [
      ...(actor.role === Role.BRANCH_USER ? [{ branchId: actor.branchId! }] : []),
      { OR: [{ assignedAgentId: null }, { assignedAgentId: { not: actor.id } }] },
      { OR: [
        { assignmentHistory: { some: { agentId: actor.id } } },
        { messages: { some: { authorId: actor.id } } },
        { internalNotes: { some: { authorId: actor.id } } },
        { whatsappCallSessions: { some: { agentId: actor.id } } }
      ] }
    ] : actor.role === Role.AGENT || actor.role === Role.BRANCH_USER
      ? [accessibleConversationSearchScope(actor.id, actor.role === Role.BRANCH_USER ? actor.branchId : undefined, viewOnlyChannels)]
      : [{ assignedAgentId: actor.id }];

  const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
  const messageMatch = messageContentSearchWhere(query);
  if (conversationId) {
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true, assignedAgentId: true, branchId: true, status: true, channel: true, externalConversationId: true } });
    if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
    if (deniedChannels.includes(conversation.channel) && !isWhatsAppGroupJid(conversation.externalConversationId)) return res.status(403).json({ error: "لا تملك صلاحية البحث في قناة هذه المحادثة" });
    if (!await canReadConversationOrHistory(actor, conversation)) return res.status(403).json({ error: "هذه المحادثة ليست ضمن محادثاتك" });
    const personalState = await prisma.conversationPreference.findUnique({ where: { userId_conversationId: { userId: actor.id, conversationId } }, select: { isDeleted: true, clearedAt: true } });
    if (personalState?.isDeleted) return res.status(404).json({ error: "المحادثة غير موجودة في قائمتك الشخصية" });
    const where = { conversationId, ...(personalState?.clearedAt ? { createdAt: { gt: personalState.clearedAt } } : {}), ...messageMatch };
    const [items, total] = await Promise.all([
      prisma.message.findMany({ where, select: { id: true, text: true, transcription: true, kind: true, direction: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: offsetValue, take: 50 }),
      prisma.message.count({ where })
    ]);
    return res.json({ items, total, hasMore: offsetValue + items.length < total, nextOffset: offsetValue + items.length });
  }

  let matchingCustomerIds: string[] = [];
  if (digits.length >= 3) {
    const matchingCustomers = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Customer"
      WHERE regexp_replace(translate(COALESCE("phone", ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g') LIKE ${`%${digits}%`}
      LIMIT 1000
    `);
    matchingCustomerIds = matchingCustomers.map((customer) => customer.id);
  }
  const customerMatches: Prisma.CustomerWhereInput[] = [
    { displayName: { contains: query, mode: "insensitive" } },
    { name: { contains: query, mode: "insensitive" } },
    ...(matchingCustomerIds.length ? [{ id: { in: matchingCustomerIds } }] : [])
  ];
  const requestedChannel = typeof req.query.channel === "string" ? req.query.channel : undefined;
  const groupFilter = typeof req.query.whatsappGroups === "string" ? req.query.whatsappGroups : undefined;
  if (requestedChannel && requestedChannel !== "ALL" && !Object.values(Channel).includes(requestedChannel as Channel)) return res.status(400).json({ error: "قناة المحادثة غير صالحة" });
  if (groupFilter && !["0", "1"].includes(groupFilter)) return res.status(400).json({ error: "مرشح مجموعات WhatsApp غير صالح" });
  if (groupFilter && requestedChannel && !["ALL", Channel.WHATSAPP].includes(requestedChannel as any)) return res.status(400).json({ error: "مرشح المجموعات متاح لقناة WhatsApp فقط" });
  const channel = groupFilter ? Channel.WHATSAPP : requestedChannel as Channel | undefined;
  const groupFilterWhere: Prisma.ConversationWhereInput | undefined = groupFilter === "1"
    ? { externalConversationId: { endsWith: WHATSAPP_GROUP_JID_SUFFIX } }
    : groupFilter === "0" ? { NOT: { externalConversationId: { endsWith: WHATSAPP_GROUP_JID_SUFFIX } } } : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const statusFilter: Prisma.ConversationWhereInput = status === "ACTIVE" ? { status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING, ConversationStatus.QUEUED] } }
    : status === "WAITING" ? { status: { in: [ConversationStatus.PENDING, ConversationStatus.QUEUED] } }
      : status === "DONE" ? { status: { in: [ConversationStatus.RESOLVED, ConversationStatus.CLOSED] } }
        : Object.values(ConversationStatus).includes(status as ConversationStatus) ? { status: status as ConversationStatus } : {};
  const clearedPreferences = await prisma.conversationPreference.findMany({
    where: { userId: actor.id, isDeleted: false, clearedAt: { not: null } },
    select: { conversationId: true, clearedAt: true }
  });
  const visibleMessageMatch: Prisma.ConversationWhereInput = { OR: [
    {
      AND: [
        { OR: [
          { personalPreferences: { none: { userId: actor.id } } },
          { personalPreferences: { some: { userId: actor.id, isDeleted: false, clearedAt: null } } }
        ] },
        { messages: { some: messageMatch } }
      ]
    },
    ...clearedPreferences.map((preference) => ({
      id: preference.conversationId,
      messages: { some: { AND: [messageMatch, { createdAt: { gt: preference.clearedAt! } }] } }
    }))
  ] };
  const where: Prisma.ConversationWhereInput = {
    AND: [
      ...(canSeeAll ? scope : [{ OR: [
        { AND: [...scope, ...(deniedChannels.includes(Channel.WHATSAPP) ? [{ channel: { not: Channel.WHATSAPP } }] : [])] },
        { channel: Channel.WHATSAPP, externalConversationId: { endsWith: WHATSAPP_GROUP_JID_SUFFIX } }
      ] }]),
      { NOT: { personalPreferences: { some: { userId: actor.id, isDeleted: true } } } },
      ...(deniedChannelsForIndividualChats.length ? [{ NOT: { channel: { in: deniedChannelsForIndividualChats } } }] : []),
      ...(groupFilterWhere ? [groupFilterWhere] : []),
      statusFilter,
      ...(channel ? [{ channel }] : []),
      ...(req.query.favorite === "1" ? [{ favorites: { some: { userId: actor.id } } }] : []),
      ...(req.query.pinned === "1" ? [{ pins: { some: { userId: actor.id } } }] : []),
      { OR: [
        { customer: { is: { OR: customerMatches } } },
        visibleMessageMatch
      ] }
    ]
  };
  const rows = await prisma.conversation.findMany({
    where,
    include: {
      customer: { select: { id: true, name: true, displayName: true, phone: true, avatarUrl: true, isBlocked: true, channelIdentifiers: true } },
      assignedAgent: { select: { id: true, name: true } },
      personalPreferences: { where: { userId: actor.id }, select: { isArchived: true, isMuted: true, isDeleted: true, clearedAt: true, readAt: true } },
      messages: { where: messageMatch, select: { id: true, text: true, transcription: true, kind: true, direction: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 3 }
    },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }], skip: offsetValue, take: 51
  });
  const hasMore = rows.length > 50;
  const items = rows.slice(0, 50).flatMap((conversation) => {
    const { personalPreferences, ...item } = conversation;
    const personalState = personalPreferences[0] || null;
    const messages = personalState?.clearedAt ? item.messages.filter((message) => message.createdAt > personalState.clearedAt!) : item.messages;
    const customerMatch = [conversation.customer.displayName, conversation.customer.name].some((name) => name?.toLocaleLowerCase().includes(query.toLocaleLowerCase())) || matchingCustomerIds.includes(conversation.customer.id);
    if (!customerMatch && !messages.length) return [];
    return [{ ...item, messages, personalState, readOnly: !canWorkOnConversation(actor, item), matchType: messages.length ? "MESSAGE" : "CUSTOMER" }];
  });
  res.json({ items, hasMore, nextOffset: offsetValue + items.length });
});

app.put("/api/conversations/:id/favorite", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ favorite: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "حالة المفضلة غير صالحة" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, select: { id: true, assignedAgentId: true, branchId: true, channel: true, externalConversationId: true } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canReadConversation(req.user!, conversation)) return res.status(403).json({ error: "هذه المحادثة ليست ضمن محادثاتك" });
  if (parsed.data.favorite) await prisma.conversationFavorite.upsert({ where: { userId_conversationId: { userId: req.user!.id, conversationId: conversation.id } }, create: { userId: req.user!.id, conversationId: conversation.id }, update: {} });
  else await prisma.conversationFavorite.deleteMany({ where: { userId: req.user!.id, conversationId: conversation.id } });
  await audit(req.user!.id, parsed.data.favorite ? "CONVERSATION_FAVORITED" : "CONVERSATION_UNFAVORITED", conversation.id);
  res.json({ conversationId: conversation.id, favorite: parsed.data.favorite });
});

app.put("/api/conversations/:id/pin", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ pinned: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "حالة التثبيت غير صالحة" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, select: { id: true, assignedAgentId: true, branchId: true, channel: true, externalConversationId: true } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canReadConversation(req.user!, conversation)) return res.status(403).json({ error: "هذه المحادثة ليست ضمن محادثاتك" });
  if (parsed.data.pinned) {
    await prisma.conversationPin.upsert({
      where: { userId_conversationId: { userId: req.user!.id, conversationId: conversation.id } },
      create: { userId: req.user!.id, conversationId: conversation.id }, update: {}
    });
  } else {
    await prisma.conversationPin.deleteMany({ where: { userId: req.user!.id, conversationId: conversation.id } });
  }
  await audit(req.user!.id, parsed.data.pinned ? "CONVERSATION_PINNED" : "CONVERSATION_UNPINNED", conversation.id);
  res.json({ conversationId: conversation.id, pinned: parsed.data.pinned });
});

app.get("/api/conversations/:id", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const messageLimit = req.query.messageLimit === undefined ? null : pageLimit(req.query.messageLimit);
  const canViewAllPrivateNotes = canViewAllPrivateConversationNotes(req.user!);
  const preferenceKey = { userId: req.user!.id, conversationId: req.params.id };
  const existingPersonalState = await prisma.conversationPreference.findUnique({
    where: { userId_conversationId: preferenceKey },
    select: { isArchived: true, isMuted: true, isDeleted: true, clearedAt: true, readAt: true }
  });
  if (existingPersonalState?.isDeleted) return res.status(404).json({ error: "المحادثة غير موجودة في قائمتك الشخصية" });
  let conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, include: {
    customer: { include: { orders: { orderBy: { createdAt: "desc" }, take: 10 }, tags: { include: { tag: true } } } }, assignedAgent: { select: { id: true, name: true } },
    messages: { ...(existingPersonalState?.clearedAt ? { where: { createdAt: { gt: existingPersonalState.clearedAt } } } : {}), include: { author: { select: { id: true, name: true } }, mediaAsset: { select: { fileName: true, contentType: true, size: true } }, quotedMessage: { select: { id: true, text: true, kind: true, createdAt: true, author: { select: { name: true } } } }, reactions: { include: { user: { select: { id: true, name: true } } } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: messageLimit ? messageLimit + 1 : 200 }, whisperNotes: { include: { author: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 100 }, internalNotes: { include: { author: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" }, take: 100 },
    privateNotes: { ...(canViewAllPrivateNotes ? {} : { where: { OR: [{ authorId: req.user!.id }, { recipientId: req.user!.id }] } }), include: { author: { select: { id: true, name: true } }, recipient: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" }, take: 100 },
    whatsappCallSessions: { orderBy: { createdAt: "desc" }, take: 50, select: { id: true, direction: true, transport: true, status: true, createdAt: true, endedAt: true, recording: { select: { durationSeconds: true } } } }
  } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  const readOnly = !canWorkOnConversation(req.user!, conversation);
  if (!await canReadConversationOrHistory(req.user!, conversation)) return res.status(403).json({ error: "هذه المحادثة ليست ضمن محادثاتك" });
  if (conversation.channel === Channel.WHATSAPP) await subscribeWhatsAppPresenceForUser(conversation.id, req.user!.id, conversation.externalConversationId).catch((error) => console.warn("WhatsApp customer presence subscription from conversation API failed", { conversationId: conversation.id, error }));
  conversation.privateNotes = conversation.privateNotes.filter((note) => canViewPrivateConversationNote(req.user!, note));
  if (!canReadConversation(req.user!, conversation)) conversation.whisperNotes = [];
  if (readOnly) conversation.customer.orders = conversation.customer.orders.filter((order) => order.conversationId === conversation!.id);
  if (existingPersonalState?.clearedAt) conversation.messages = conversation.messages.map((message) => message.quotedMessage && message.quotedMessage.createdAt <= existingPersonalState.clearedAt! ? { ...message, quotedMessage: null } : message);
  const openedConversation = conversation;
  if ((req.user!.role === Role.AGENT || req.user!.role === Role.BRANCH_USER) && openedConversation.assignedAgentId === req.user!.id && openedConversation.serviceTag && openedConversation.serviceTag !== "تواصل مباشر") {
    try {
      await withInboundConversationLock(openedConversation.channel, openedConversation.externalConversationId, async () => {
        const customerName = openedConversation.customer.displayName || openedConversation.customer.name;
        const chatbotSettings = await getChatbotSettings();
        const text = formatAgentHandoffGreeting(chatbotSettings.agentHandoffGreeting, customerName, req.user!.name);
        let greeting = await prisma.message.findFirst({
          where: { conversationId: openedConversation.id, direction: MessageDirection.OUTBOUND, metadata: { path: ["automation"], equals: "agent-handoff-greeting" } },
          include: { author: { select: { id: true, name: true } } }
        });
        if (greeting?.deliveryStatus !== "FAILED" && greeting) return;
        if (!greeting) {
          greeting = await prisma.message.create({ data: {
            conversationId: openedConversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND,
            kind: MessageKind.TEXT, text, deliveryStatus: "QUEUED", metadata: { automation: "agent-handoff-greeting" }
          }, include: { author: { select: { id: true, name: true } } } });
        } else {
          greeting = await prisma.message.update({ where: { id: greeting.id }, data: { authorId: req.user!.id, text, deliveryStatus: "QUEUED" }, include: { author: { select: { id: true, name: true } } } });
        }
        if (openedConversation.channel === Channel.WHATSAPP) {
          await queueWhatsAppMessage(greeting.id, openedConversation.id, req.user!.id, {
            channel: openedConversation.channel, recipient: openedConversation.externalCustomerId, text: greeting.text || ""
          });
          return;
        }
        try {
          const result: any = await sendToChannel({ channel: openedConversation.channel, recipient: channelRecipient(openedConversation.channel, openedConversation.externalConversationId, openedConversation.externalCustomerId), text: greeting.text || "" });
          const providerId = kalemlyExternalMessageId(result);
          const sent = await prisma.message.update({ where: { id: greeting.id }, data: {
            deliveryStatus: "SENT", ...(providerId ? { externalId: `${openedConversation.channel}:${providerId}` } : {})
          }, include: { author: { select: { id: true, name: true } } } });
          const sentAt = sent.createdAt;
          await prisma.conversation.update({ where: { id: openedConversation.id }, data: {
            lastMessageAt: sentAt, lastAgentResponseAt: sentAt, firstResponseAt: openedConversation.firstResponseAt || sentAt,
            slaBreachedAt: null, status: ConversationStatus.OPEN
          } });
          await audit(req.user!.id, "MESSAGE_SENT", openedConversation.id, { messageId: sent.id, automation: "agent-handoff-greeting" });
          io.to(`conversation:${openedConversation.id}`).to("admins").to(`agent:${req.user!.id}`).emit("message:new", { conversationId: openedConversation.id, message: sent });
        } catch (error) {
          const failed = await prisma.message.update({ where: { id: greeting.id }, data: { deliveryStatus: "FAILED" }, include: { author: { select: { id: true, name: true } } } });
          io.to(`conversation:${openedConversation.id}`).to("admins").to(`agent:${req.user!.id}`).emit("message:new", { conversationId: openedConversation.id, message: failed });
          throw error;
        }
      });
    } catch (error) {
      console.warn("Personalized handoff greeting failed", openedConversation.id, error);
    }
  }
  if (!conversation.lastInboundAt) {
    const receivedAt = await lastInboundAt(conversation.id);
    if (receivedAt) conversation = { ...conversation, lastInboundAt: receivedAt };
  }
  const personalState = !readOnly ? await prisma.conversationPreference.upsert({
    where: { userId_conversationId: preferenceKey },
    create: { ...preferenceKey, readAt: new Date() },
    update: { readAt: new Date() }
  }) : existingPersonalState;
  await audit(req.user!.id, "CONVERSATION_OPENED", conversation.id);
  const hasMoreMessages = Boolean(messageLimit && conversation.messages.length > messageLimit);
  if (hasMoreMessages) conversation.messages.pop();
  conversation.messages.reverse();
  if (existingPersonalState?.clearedAt) conversation.messages = conversation.messages.map((message) => message.quotedMessage && message.quotedMessage.createdAt <= existingPersonalState.clearedAt! ? { ...message, quotedMessage: null } : message);
  conversation.whisperNotes.reverse();
  conversation.internalNotes.reverse();
  conversation.privateNotes.reverse();
  if (!readOnly) void markBaileysMessagesRead(conversation.messages.filter((message) => message.direction === MessageDirection.INBOUND).map((message) => message.externalId || "")).catch((error) => console.warn("WhatsApp read receipt failed", error));
  const response = { ...conversation, personalState, ...(!readOnly ? { unreadCount: 0 } : {}), readOnly, canSendPrivateNote: !readOnly };
  res.json(messageLimit ? { ...response, hasMoreMessages } : response);
});

app.delete("/api/conversations/:id", systemAdminGuard, async (req: AuthedRequest, res: express.Response) => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: req.params.id },
    include: { messages: { select: { mediaAssetId: true } }, whatsappCallSessions: { select: { recording: { select: { mediaAssetId: true } } } } }
  });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  const assetIds = [...new Set([
    ...conversation.messages.map((message) => message.mediaAssetId),
    ...conversation.whatsappCallSessions.map((session) => session.recording?.mediaAssetId)
  ].filter((id): id is string => Boolean(id)))];
  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({ data: { actorId: req.user!.id, conversationId: conversation.id, action: "CONVERSATION_PERMANENTLY_DELETED", details: { deletedConversationId: conversation.id, customerId: conversation.customerId, channel: conversation.channel } } });
    await tx.conversation.delete({ where: { id: conversation.id } });
    for (const assetId of assetIds) await tx.mediaAsset.deleteMany({ where: { id: assetId, messages: { none: {} }, products: { none: {} }, quickReplies: { none: {} } } });
  });
  const event = { conversationId: conversation.id, customerId: conversation.customerId };
  await emitConversationEvent(conversation.id, conversation.channel, "conversation:deleted", event, {
    extraRooms: conversation.assignedAgentId ? [`agent:${conversation.assignedAgentId}`] : []
  });
  res.json({ conversationId: conversation.id, deleted: true });
});

app.get("/api/conversations/:id/messages", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, select: { id: true, assignedAgentId: true, branchId: true, status: true, channel: true, externalConversationId: true } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!await canReadConversationOrHistory(req.user!, conversation)) return res.status(403).json({ error: "هذه المحادثة ليست ضمن محادثاتك" });
  if (conversation.channel === Channel.WHATSAPP) await subscribeWhatsAppPresenceForUser(conversation.id, req.user!.id, conversation.externalConversationId).catch((error) => console.warn("WhatsApp customer presence subscription from messages API failed", { conversationId: conversation.id, error }));
  const personalState = await prisma.conversationPreference.findUnique({ where: { userId_conversationId: { userId: req.user!.id, conversationId: conversation.id } }, select: { isDeleted: true, clearedAt: true } });
  if (personalState?.isDeleted) return res.status(404).json({ error: "المحادثة غير موجودة في قائمتك الشخصية" });
  const limit = pageLimit(req.query.limit);
  let before: { createdAt: Date; id: string } | null = null;
  if (req.query.before !== undefined) {
    if (typeof req.query.before !== "string" || req.query.before.length > 128) return res.status(400).json({ error: "مؤشر الرسائل غير صالح" });
    before = await prisma.message.findFirst({ where: { id: req.query.before, conversationId: conversation.id, ...(personalState?.clearedAt ? { createdAt: { gt: personalState.clearedAt } } : {}) }, select: { createdAt: true, id: true } });
    if (!before) return res.status(400).json({ error: "مؤشر الرسائل غير صالح لهذه المحادثة" });
  }
  const messages = await prisma.message.findMany({
    where: {
      conversationId: conversation.id,
      ...(personalState?.clearedAt ? { createdAt: { gt: personalState.clearedAt } } : {}),
      ...(before ? { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] } : {})
    },
    include: { author: { select: { id: true, name: true } }, quotedMessage: { select: { id: true, text: true, kind: true, createdAt: true, author: { select: { name: true } } } }, reactions: { include: { user: { select: { id: true, name: true } } } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1
  });
  const hasMore = messages.length > limit;
  const page = messages.slice(0, limit).reverse().map((message) => personalState?.clearedAt && message.quotedMessage && message.quotedMessage.createdAt <= personalState.clearedAt ? { ...message, quotedMessage: null } : message);
  if (canWorkOnConversation(req.user!, conversation)) void markBaileysMessagesRead(page.filter((message) => message.direction === MessageDirection.INBOUND).map((message) => message.externalId || "")).catch((error) => console.warn("WhatsApp read receipt failed", error));
  res.json({ messages: page, hasMore, nextBefore: hasMore && page.length ? page[0].id : null });
});

app.get("/api/me/starred-messages", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const stars = await prisma.messageStar.findMany({
    where: { userId: req.user!.id },
    include: { message: { include: {
      author: { select: { id: true, name: true } },
      mediaAsset: { select: { fileName: true, contentType: true, size: true } },
      conversation: { include: {
        customer: { select: { id: true, name: true, displayName: true, phone: true, avatarUrl: true, isBlocked: true, channelIdentifiers: true } },
        personalPreferences: { where: { userId: req.user!.id }, select: { isDeleted: true, clearedAt: true } }
      } }
    } } },
    orderBy: { createdAt: "desc" }, take: 200
  });
  const visible = [];
  for (const star of stars) {
    const { conversation, ...message } = star.message;
    const personalState = conversation.personalPreferences[0];
    if (personalState?.isDeleted || personalState?.clearedAt && message.createdAt <= personalState.clearedAt) continue;
    if (!await canReadConversationOrHistory(req.user!, conversation)) continue;
    const { personalPreferences: _personalPreferences, ...conversationData } = conversation;
    visible.push({ id: message.id, starredAt: star.createdAt, conversationId: conversation.id, conversation: conversationData, message });
  }
  res.json(visible);
});

app.put("/api/conversations/:id/messages/:messageId/star", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ starred: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "حالة تمييز الرسالة غير صالحة" });
  const message = await prisma.message.findFirst({
    where: { id: req.params.messageId, conversationId: req.params.id },
    include: { conversation: true }
  });
  if (!message || !await canReadConversationOrHistory(req.user!, message.conversation)) return res.status(404).json({ error: "الرسالة غير موجودة أو ليست ضمن صلاحياتك" });
  const personalState = await prisma.conversationPreference.findUnique({ where: { userId_conversationId: { userId: req.user!.id, conversationId: message.conversationId } }, select: { isDeleted: true, clearedAt: true } });
  if (personalState?.isDeleted || personalState?.clearedAt && message.createdAt <= personalState.clearedAt) return res.status(404).json({ error: "الرسالة غير موجودة في قائمتك الشخصية" });
  if (parsed.data.starred) {
    await prisma.messageStar.upsert({
      where: { userId_messageId: { userId: req.user!.id, messageId: message.id } },
      create: { userId: req.user!.id, messageId: message.id }, update: {}
    });
  } else {
    await prisma.messageStar.deleteMany({ where: { userId: req.user!.id, messageId: message.id } });
  }
  await audit(req.user!.id, parsed.data.starred ? "MESSAGE_STARRED" : "MESSAGE_UNSTARRED", message.conversationId, { messageId: message.id });
  res.json({ messageId: message.id, starred: parsed.data.starred });
});

app.post("/api/conversations/:id/whatsapp-presence", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ activity: z.enum(["composing", "recording", "paused"]) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "حالة الكتابة غير صالحة" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, select: { id: true, assignedAgentId: true, branchId: true, channel: true, externalConversationId: true } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "ليس لديك صلاحية العمل على هذه المحادثة" });
  if (conversation.channel !== Channel.WHATSAPP) return res.status(204).end();
  const sent = await sendBaileysPresence(conversation.externalConversationId, parsed.data.activity);
  if (sent) {
    const activity = parsed.data.activity === "paused" ? null : parsed.data.activity === "recording" ? "recording" : "typing";
    void emitConversationActivity(conversation, "whatsapp:agent-activity", { conversationId: conversation.id, activity, actorId: req.user!.id, actorName: req.user!.name }).catch((error) => console.warn("WhatsApp agent activity broadcast failed", error));
  }
  res.json({ sent });
});

app.post("/api/conversations/:id/messages/:messageId/played", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, select: { id: true, assignedAgentId: true, branchId: true, channel: true, externalConversationId: true } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "ليس لديك صلاحية العمل على هذه المحادثة" });
  if (conversation.channel !== Channel.WHATSAPP || await getWhatsAppMode() !== "BAILEYS") return res.status(204).end();
  const message = await prisma.message.findFirst({ where: { id: req.params.messageId, conversationId: conversation.id, direction: MessageDirection.INBOUND, kind: MessageKind.AUDIO }, select: { externalId: true } });
  if (!message) return res.status(404).json({ error: "الرسالة الصوتية غير موجودة" });
  await markBaileysMessagePlayed(message.externalId || "");
  res.status(204).end();
});

app.patch("/api/conversations/:id/customer", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = customerProfileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "بيانات ملف العميل غير صالحة" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, select: { id: true, customerId: true, assignedAgentId: true, branchId: true, channel: true, externalConversationId: true } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "لا تملك صلاحية تعديل بيانات هذا العميل" });
  const customer = await prisma.customer.update({ where: { id: conversation.customerId }, data: parsed.data });
  await audit(req.user!.id, "CUSTOMER_PROFILE_UPDATED", conversation.id, { customerId: customer.id });
  const payload = { conversationId: conversation.id, customer };
  await emitConversationEvent(conversation.id, conversation.channel, "customer:updated", payload);
  res.json(customer);
});

app.get("/api/contacts", agentGuard, async (req: express.Request, res: express.Response) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
  const contacts = await prisma.customer.findMany({
    where: q ? { OR: [
      { displayName: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } },
      { phone: { contains: q } }, { email: { contains: q, mode: "insensitive" } }
    ] } : {},
    select: { id: true, name: true, displayName: true, phone: true, email: true, avatarUrl: true },
    orderBy: [{ displayName: "asc" }, { name: "asc" }], take: 100
  });
  res.json(contacts);
});

app.get("/api/contacts/phone-search", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const rawPhone = typeof req.query.phone === "string" ? req.query.phone : "";
  let phone: string;
  try { phone = normalizePhoneNumber(rawPhone); }
  catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "أدخل رقمًا دوليًا صحيحًا" }); }
  const customers = await customersMatchingPhone(phone);
  const candidates = await conversationsMatchingPhone(phone, customers.map((customer) => customer.id));
  const personalPreferences = await prisma.conversationPreference.findMany({ where: { userId: req.user!.id, conversationId: { in: candidates.map((conversation) => conversation.id) } } });
  const personalPreferenceById = new Map(personalPreferences.map((preference) => [preference.conversationId, preference]));
  const conversations: any[] = [];
  for (const conversation of candidates) {
    const personalState = personalPreferenceById.get(conversation.id) || null;
    if (personalState?.isDeleted) continue;
    if (await canReadConversationOrHistory(req.user!, conversation)) {
      const messages = personalState?.clearedAt ? conversation.messages.filter((message) => message.createdAt > personalState.clearedAt!) : conversation.messages;
      conversations.push({ ...conversation, messages, personalState, readOnly: !canWorkOnConversation(req.user!, conversation) });
    }
  }
  res.json({ phone, customer: conversations[0]?.customer || customers[0] || null, conversations });
});

app.post("/api/contacts/whatsapp-conversation", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ phone: z.string().trim().min(1).max(64), displayName: z.string().trim().max(120).optional() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "أدخل رقم الهاتف واسمًا اختياريًا صالحين" });
  try {
    const result = await startWhatsAppConversation(req.user!, parsed.data.phone, parsed.data.displayName || "");
    return res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    if (error instanceof ContactConversationError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

app.post("/api/contacts/:id/whatsapp-conversation", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const customer = await prisma.customer.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, displayName: true, phone: true } });
  if (!customer) return res.status(404).json({ error: "جهة الاتصال غير موجودة" });
  if (!customer.phone) return res.status(409).json({ error: "أضف رقم واتساب دوليًا صالحًا لجهة الاتصال أولًا" });
  try {
    const result = await startWhatsAppConversation(req.user!, customer.phone, customer.displayName || customer.name || "", customer.id, "CONTACT");
    return res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    if (error instanceof ContactConversationError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

app.get("/api/customers", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
  const tagId = typeof req.query.tagId === "string" ? req.query.tagId : undefined;
  const favoriteOnly = req.query.favoritesOnly === "true";
  const pageValue = Number(req.query.page || 1);
  const page = Number.isInteger(pageValue) ? Math.max(1, Math.min(pageValue, 10_000)) : 1;
  const canSeeAll = req.user!.role === Role.ADMIN || req.user!.role === Role.SUPERVISOR && hasPermission(req.user!, "canViewAllConversations");
  const where: Prisma.CustomerWhereInput = {
    ...(q ? { OR: [
      { displayName: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } },
      { phone: { contains: q } }, { email: { contains: q, mode: "insensitive" } }
    ] } : {}),
    ...(tagId ? { tags: { some: { tagId } } } : {}),
    ...(favoriteOnly ? { favorites: { some: { userId: req.user!.id } } } : {}),
    ...(!canSeeAll ? { conversations: { some: { assignedAgentId: req.user!.id } } } : {})
  };
  const [customers, total] = await prisma.$transaction([
    prisma.customer.findMany({ where, include: { tags: { include: { tag: true } } }, orderBy: { updatedAt: "desc" }, skip: (page - 1) * 50, take: 50 }),
    prisma.customer.count({ where })
  ]);
  res.json({ customers, total, page, pageSize: 50 });
});

app.get("/api/customers/favorites", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const canSeeAll = req.user!.role === Role.ADMIN || req.user!.role === Role.SUPERVISOR && hasPermission(req.user!, "canViewAllConversations");
  const favorites = await prisma.customerFavorite.findMany({
    where: { userId: req.user!.id, ...(!canSeeAll ? { customer: { is: { conversations: { some: { assignedAgentId: req.user!.id } } } } } : {}) },
    select: { customerId: true }, orderBy: { createdAt: "desc" }
  });
  res.json({ ids: favorites.map((favorite) => favorite.customerId) });
});

app.put("/api/customers/:id/favorite", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ favorite: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "حالة المفضلة غير صالحة" });
  const canSeeAll = req.user!.role === Role.ADMIN || req.user!.role === Role.SUPERVISOR && hasPermission(req.user!, "canViewAllConversations");
  const customer = await prisma.customer.findFirst({
    where: { id: req.params.id, ...(!canSeeAll ? { conversations: { some: { assignedAgentId: req.user!.id } } } : {}) },
    select: { id: true }
  });
  if (!customer) return res.status(404).json({ error: "العميل غير موجود أو ليس ضمن محادثاتك" });
  if (parsed.data.favorite) {
    await prisma.customerFavorite.upsert({
      where: { userId_customerId: { userId: req.user!.id, customerId: customer.id } },
      create: { userId: req.user!.id, customerId: customer.id }, update: {}
    });
  } else {
    await prisma.customerFavorite.deleteMany({ where: { userId: req.user!.id, customerId: customer.id } });
  }
  await audit(req.user!.id, parsed.data.favorite ? "CUSTOMER_FAVORITED" : "CUSTOMER_UNFAVORITED", undefined, { customerId: customer.id });
  res.json({ customerId: customer.id, favorite: parsed.data.favorite });
});

app.patch("/api/customers/:id/flags", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ isVip: z.boolean().optional(), isBlocked: z.boolean().optional() }).strict().refine((value) => Object.keys(value).length > 0).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "حالة العميل غير صالحة" });
  const canSeeAll = req.user!.role === Role.ADMIN || req.user!.role === Role.SUPERVISOR && hasPermission(req.user!, "canViewAllConversations");
  const customer = await prisma.customer.findFirst({
    where: { id: req.params.id, ...(!canSeeAll ? { conversations: { some: { assignedAgentId: req.user!.id } } } : {}) },
    select: { id: true }
  });
  if (!customer) return res.status(404).json({ error: "العميل غير موجود أو ليس ضمن محادثاتك" });
  const updated = await prisma.customer.update({ where: { id: customer.id }, data: parsed.data });
  const conversations = await prisma.conversation.findMany({ where: { customerId: customer.id }, select: { id: true, channel: true } });
  await audit(req.user!.id, parsed.data.isBlocked === undefined ? "CUSTOMER_VIP_UPDATED" : "CUSTOMER_BLOCK_UPDATED", undefined, { customerId: customer.id, ...parsed.data });
  for (const conversation of conversations) await emitConversationEvent(conversation.id, conversation.channel, "customer:updated", { conversationId: conversation.id, customer: updated });
  res.json(updated);
});

app.delete("/api/customers/:id", systemAdminGuard, async (req: AuthedRequest, res: express.Response) => {
  const customer = await prisma.customer.findUnique({
    where: { id: req.params.id },
     include: { conversations: { select: { id: true, channel: true, assignedAgentId: true, messages: { select: { mediaAssetId: true } }, whatsappCallSessions: { select: { recording: { select: { mediaAssetId: true } } } } } } }
  });
  if (!customer) return res.status(404).json({ error: "العميل غير موجود" });
  const assetIds = [...new Set(customer.conversations.flatMap((conversation) => [
    ...conversation.messages.map((message) => message.mediaAssetId),
    ...conversation.whatsappCallSessions.map((session) => session.recording?.mediaAssetId)
  ]).filter((id): id is string => Boolean(id)))];
  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({ data: { actorId: req.user!.id, action: "CUSTOMER_PERMANENTLY_DELETED", details: { customerId: customer.id, conversationCount: customer.conversations.length } } });
    await tx.customer.delete({ where: { id: customer.id } });
    for (const assetId of assetIds) await tx.mediaAsset.deleteMany({ where: { id: assetId, messages: { none: {} }, products: { none: {} }, quickReplies: { none: {} } } });
  });
  for (const conversation of customer.conversations) {
    const event = { conversationId: conversation.id, customerId: customer.id };
    await emitConversationEvent(conversation.id, conversation.channel, "conversation:deleted", event, {
      extraRooms: conversation.assignedAgentId ? [`agent:${conversation.assignedAgentId}`] : []
    });
  }
  res.json({ customerId: customer.id, deleted: true, conversationsDeleted: customer.conversations.length });
});

app.get("/api/admin/customers/export.csv", permissionGuard("canManageTeam"), async (_req: express.Request, res: express.Response) => {
  const customers = await prisma.customer.findMany({ include: { tags: { include: { tag: true } } }, orderBy: { createdAt: "asc" } });
  const cell = (value: unknown) => {
    let text = String(value ?? "");
    if (/^[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = [["displayName", "phone", "email", "notes", "tags"], ...customers.map((customer) => [
    customer.displayName || customer.name || "", customer.phone || "", customer.email || "", customer.notes || "", customer.tags.map((item) => item.tag.name).join(" | ")
  ])];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''contacts.csv");
  res.send(`\uFEFF${rows.map((row) => row.map(cell).join(",")).join("\r\n")}`);
});

app.post("/api/admin/customers/import", permissionGuard("canManageTeam"), async (req: AuthedRequest, res: express.Response) => {
  const optionalText = (max: number) => z.preprocess((value) => typeof value === "string" && !value.trim() ? null : value, z.string().trim().max(max).nullable().optional());
  const importedCustomer = z.object({
    displayName: optionalText(120), phone: optionalText(32), email: z.preprocess((value) => typeof value === "string" && !value.trim() ? null : value, z.string().trim().email().max(254).nullable().optional()), notes: optionalText(4000)
  }).strict().refine((value) => Boolean(value.displayName || value.phone || value.email));
  const parsed = z.object({ customers: z.array(importedCustomer).min(1).max(1000) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "ملف الاستيراد غير صالح؛ الحد الأقصى 1000 جهة اتصال" });
  let created = 0;
  let updated = 0;
  await prisma.$transaction(async (tx) => {
    for (const row of parsed.data.customers) {
      const identity = [row.phone ? { phone: row.phone } : null, row.email ? { email: { equals: row.email, mode: "insensitive" as const } } : null].filter(Boolean) as Prisma.CustomerWhereInput[];
      const existing = identity.length ? await tx.customer.findFirst({ where: { OR: identity }, select: { id: true } }) : null;
      const contactFields = { ...(row.displayName !== undefined ? { displayName: row.displayName, ...(row.displayName ? { name: row.displayName } : {}) } : {}), ...(row.phone !== undefined ? { phone: row.phone } : {}), ...(row.email !== undefined ? { email: row.email } : {}), ...(row.notes !== undefined ? { notes: row.notes } : {}) };
      if (existing) { await tx.customer.update({ where: { id: existing.id }, data: contactFields }); updated++; }
      else { await tx.customer.create({ data: { ...contactFields, name: row.displayName || null } }); created++; }
    }
  });
  await audit(req.user!.id, "CUSTOMERS_IMPORTED", undefined, { created, updated });
  res.json({ created, updated });
});

app.get("/api/customers/:id", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const canSeeAll = req.user!.role === Role.ADMIN || req.user!.role === Role.SUPERVISOR && hasPermission(req.user!, "canViewAllConversations");
  const customer = await prisma.customer.findFirst({ where: { id: req.params.id, ...(!canSeeAll ? { conversations: { some: { assignedAgentId: req.user!.id } } } : {}) }, include: {
     tags: { include: { tag: true } }, orders: { where: canSeeAll ? {} : { conversation: { is: { assignedAgentId: req.user!.id } } }, orderBy: { createdAt: "desc" }, take: 50 },
    conversations: { where: canSeeAll ? {} : { assignedAgentId: req.user!.id }, select: { id: true, channel: true, status: true, subject: true, lastMessageAt: true }, orderBy: { lastMessageAt: "desc" }, take: 50 }
  } });
  if (!customer) return res.status(404).json({ error: "العميل غير موجود أو ليس ضمن محادثاتك" });
  res.json(customer);
});

app.patch("/api/customers/:id", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = customerProfileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "بيانات ملف العميل غير صالحة" });
  const canSeeAll = req.user!.role === Role.ADMIN || req.user!.role === Role.SUPERVISOR && hasPermission(req.user!, "canViewAllConversations");
  const existing = await prisma.customer.findFirst({ where: { id: req.params.id, ...(!canSeeAll ? { conversations: { some: { assignedAgentId: req.user!.id } } } : {}) }, select: { id: true } });
  if (!existing) return res.status(404).json({ error: "العميل غير موجود أو ليس ضمن محادثاتك" });
  const customer = await prisma.customer.update({ where: { id: existing.id }, data: parsed.data, include: { tags: { include: { tag: true } } } });
  await audit(req.user!.id, "CUSTOMER_PROFILE_UPDATED", undefined, { customerId: customer.id });
  const conversations = await prisma.conversation.findMany({ where: { customerId: customer.id, ...(!canSeeAll ? { assignedAgentId: req.user!.id } : {}) }, select: { id: true, channel: true } });
  for (const conversation of conversations) await emitConversationEvent(conversation.id, conversation.channel, "customer:updated", { conversationId: conversation.id, customerId: customer.id, customer });
  res.json(customer);
});

app.get("/api/customer-tags", agentGuard, async (_req: express.Request, res: express.Response) => {
  res.json(await prisma.customerTag.findMany({ orderBy: { name: "asc" } }));
});

app.get("/api/admin/customer-tags", permissionGuard("canManageCatalog"), async (_req: express.Request, res: express.Response) => {
  res.json(await prisma.customerTag.findMany({ include: { _count: { select: { customers: true } } }, orderBy: { name: "asc" } }));
});

app.post("/api/admin/customer-tags", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(40), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#2563eb") }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "أدخل اسمًا ولونًا صالحين للوسم" });
  try {
    const tag = await prisma.customerTag.create({ data: parsed.data });
    await audit(req.user!.id, "CUSTOMER_TAG_CREATED", undefined, { tagId: tag.id });
    res.status(201).json(tag);
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: "اسم الوسم مستخدم بالفعل" });
    throw error;
  }
});

app.patch("/api/admin/customer-tags/:id", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(40).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).strict().refine((value) => Object.keys(value).length > 0).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "راجع اسم الوسم ولونه" });
  try {
    const tag = await prisma.customerTag.update({ where: { id: req.params.id }, data: parsed.data });
    await audit(req.user!.id, "CUSTOMER_TAG_UPDATED", undefined, { tagId: tag.id });
    res.json(tag);
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: "اسم الوسم مستخدم بالفعل" });
    throw error;
  }
});

app.delete("/api/admin/customer-tags/:id", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  await prisma.customerTag.delete({ where: { id: req.params.id } });
  await audit(req.user!.id, "CUSTOMER_TAG_DELETED", undefined, { tagId: req.params.id });
  res.sendStatus(204);
});

app.put("/api/customers/:id/tags", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ tagIds: z.array(z.string().min(1)).max(30) }).strict().safeParse(req.body);
  if (!parsed.success || new Set(parsed.data?.tagIds || []).size !== parsed.data?.tagIds.length) return res.status(400).json({ error: "قائمة الوسوم غير صالحة" });
  const canSeeAll = req.user!.role === Role.ADMIN || req.user!.role === Role.SUPERVISOR && hasPermission(req.user!, "canViewAllConversations");
  const customer = await prisma.customer.findFirst({ where: { id: req.params.id, ...(!canSeeAll ? { conversations: { some: { assignedAgentId: req.user!.id } } } : {}) }, select: { id: true } });
  if (!customer) return res.status(404).json({ error: "العميل غير موجود أو ليس ضمن محادثاتك" });
  const validTags = await prisma.customerTag.count({ where: { id: { in: parsed.data.tagIds } } });
  if (validTags !== new Set(parsed.data.tagIds).size) return res.status(400).json({ error: "أحد الوسوم المحددة غير موجود" });
  await prisma.$transaction(async (tx) => {
    await tx.customerTagAssignment.deleteMany({ where: { customerId: customer.id } });
    if (parsed.data.tagIds.length) await tx.customerTagAssignment.createMany({ data: parsed.data.tagIds.map((tagId) => ({ customerId: customer.id, tagId })), skipDuplicates: true });
  });
  const tags = await prisma.customerTagAssignment.findMany({ where: { customerId: customer.id }, include: { tag: true } });
  await audit(req.user!.id, "CUSTOMER_TAGS_UPDATED", undefined, { customerId: customer.id, tagIds: parsed.data.tagIds });
  const conversations = await prisma.conversation.findMany({ where: { customerId: customer.id, ...(!canSeeAll ? { assignedAgentId: req.user!.id } : {}) }, select: { id: true, channel: true } });
  const payload = { customerId: customer.id, tags };
  for (const conversation of conversations) await emitConversationEvent(conversation.id, conversation.channel, "customer:tags-updated", payload);
  res.json(tags);
});

app.get("/api/directory", agentGuard, async (_req: express.Request, res: express.Response) => {
  res.json(await prisma.directoryCategory.findMany({ where: { isActive: true }, include: { entries: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }));
});

app.get("/api/admin/directory", permissionGuard("canManageCatalog"), async (_req: express.Request, res: express.Response) => {
  res.json(await prisma.directoryCategory.findMany({ include: { entries: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }));
});

app.post("/api/admin/directory/categories", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(80), sortOrder: z.number().int().min(0).max(10_000).default(0) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اسم القسم غير صالح" });
  try {
    const category = await prisma.directoryCategory.create({ data: parsed.data });
    await audit(req.user!.id, "DIRECTORY_CATEGORY_CREATED", undefined, { categoryId: category.id });
    res.status(201).json(category);
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: "اسم القسم موجود بالفعل" });
    throw error;
  }
});

app.patch("/api/admin/directory/categories/:id", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(80).optional(), sortOrder: z.number().int().min(0).max(10_000).optional(), isActive: z.boolean().optional() }).strict().refine((value) => Object.keys(value).length > 0).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "بيانات القسم غير صالحة" });
  try {
    const category = await prisma.directoryCategory.update({ where: { id: req.params.id }, data: parsed.data });
    await audit(req.user!.id, "DIRECTORY_CATEGORY_UPDATED", undefined, { categoryId: category.id });
    res.json(category);
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: "اسم القسم موجود بالفعل" });
    throw error;
  }
});

app.delete("/api/admin/directory/categories/:id", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const category = await prisma.directoryCategory.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, _count: { select: { entries: true } } } });
  if (!category) return res.status(404).json({ error: "القسم غير موجود" });
  await prisma.directoryCategory.delete({ where: { id: category.id } });
  await audit(req.user!.id, "DIRECTORY_CATEGORY_DELETED", undefined, { categoryId: category.id, name: category.name, entryCount: category._count.entries });
  res.sendStatus(204);
});

app.post("/api/admin/directory/entries", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
  const parsed = z.object({ categoryId: z.string().min(1), name: z.string().trim().min(1).max(120), phone: optionalText(32), whatsappNumber: optionalText(32), email: z.string().trim().email().max(254).nullable().optional(), description: optionalText(1000), sortOrder: z.number().int().min(0).max(10_000).default(0) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "راجع بيانات جهة الاتصال" });
  const category = await prisma.directoryCategory.findUnique({ where: { id: parsed.data.categoryId }, select: { id: true } });
  if (!category) return res.status(400).json({ error: "القسم المحدد غير موجود" });
  const entry = await prisma.directoryEntry.create({ data: parsed.data });
  await audit(req.user!.id, "DIRECTORY_ENTRY_CREATED", undefined, { entryId: entry.id, categoryId: entry.categoryId });
  res.status(201).json(entry);
});

app.patch("/api/admin/directory/entries/:id", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
  const parsed = z.object({ categoryId: z.string().min(1).optional(), name: z.string().trim().min(1).max(120).optional(), phone: optionalText(32), whatsappNumber: optionalText(32), email: z.string().trim().email().max(254).nullable().optional(), description: optionalText(1000), sortOrder: z.number().int().min(0).max(10_000).optional(), isActive: z.boolean().optional() }).strict().refine((value) => Object.keys(value).length > 0).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "راجع بيانات جهة الاتصال" });
  if (parsed.data.categoryId && !await prisma.directoryCategory.findUnique({ where: { id: parsed.data.categoryId }, select: { id: true } })) return res.status(400).json({ error: "القسم المحدد غير موجود" });
  const entry = await prisma.directoryEntry.update({ where: { id: req.params.id }, data: parsed.data });
  await audit(req.user!.id, "DIRECTORY_ENTRY_UPDATED", undefined, { entryId: entry.id, categoryId: entry.categoryId });
  res.json(entry);
});

async function applyCustomerTagsFromQuickReply(customerId: string, actorId: string, tagIds: string[]) {
  await prisma.customerTagAssignment.createMany({ data: tagIds.map((tagId) => ({ customerId, tagId })), skipDuplicates: true });
  const tags = await prisma.customerTagAssignment.findMany({ where: { customerId }, include: { tag: true } });
  await audit(actorId, "CUSTOMER_TAGS_UPDATED", undefined, { customerId, tagIds, source: "quick_reply" });
  const conversations = await prisma.conversation.findMany({ where: { customerId }, select: { id: true, channel: true } });
  const payload = { customerId, tags };
  for (const conversation of conversations) await emitConversationEvent(conversation.id, conversation.channel, "customer:tags-updated", payload);
}

app.post("/api/conversations/:id/reply", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ text: z.string().optional(), kind: z.nativeEnum(MessageKind).default(MessageKind.TEXT), mediaUrl: httpsUrl.optional(), mediaAssetId: z.string().optional(), applyTagIds: z.array(z.string().min(1)).max(30).optional(), latitude: z.number().optional(), longitude: z.number().optional(), quotedMessageId: z.string().min(1).optional(), clientMessageId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict().safeParse(req.body);
  if (!parsed.success || (!parsed.data.text && parsed.data.kind === MessageKind.TEXT)) return res.status(400).json({ error: "الرسالة غير صالحة" });
  const applyTagIds = parsed.data.applyTagIds || [];
  if (new Set(applyTagIds).size !== applyTagIds.length) return res.status(400).json({ error: "قائمة الوسوم غير صالحة" });
  if (applyTagIds.length && await prisma.customerTag.count({ where: { id: { in: applyTagIds } } }) !== applyTagIds.length) return res.status(400).json({ error: "أحد الوسوم المحددة غير موجود" });
  if (parsed.data.kind === MessageKind.POLL) return res.status(400).json({ error: "استخدم نموذج الاستطلاع لإرسال السؤال وخياراته" });
   const mediaKind = parsed.data.kind === MessageKind.IMAGE || parsed.data.kind === MessageKind.AUDIO || parsed.data.kind === MessageKind.VIDEO || parsed.data.kind === MessageKind.FILE || parsed.data.kind === MessageKind.STICKER;
  if (mediaKind && !parsed.data.mediaUrl && !parsed.data.mediaAssetId || parsed.data.kind === MessageKind.LOCATION && (parsed.data.latitude === undefined || parsed.data.longitude === undefined)) return res.status(400).json({ error: "يلزم إرفاق ملف أو رابط وسيط أو إحداثيات الموقع" });
  if (!mediaKind && (parsed.data.mediaAssetId || parsed.data.mediaUrl)) return res.status(400).json({ error: "نوع الملف لا يطابق نوع الرسالة" });
   return withConversationAssignmentLock(req.params.id, async () => {
    const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, include: { customer: { select: { isBlocked: true } } } });
   if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
   if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "ليس لديك صلاحية الرد على هذه المحادثة" });
   if (conversation.customer.isBlocked) return res.status(409).json({ error: "هذا العميل محظور داخل النظام؛ ألغِ الحظر قبل إرسال رسالة" });
  if (parsed.data.kind === MessageKind.STICKER && (conversation.channel === Channel.MESSENGER || conversation.channel === Channel.WHATSAPP && await getWhatsAppMode() !== "BAILEYS")) return res.status(409).json({ error: "إرسال الملصقات غير مدعوم في وضع القناة الحالي" });
  if (parsed.data.quotedMessageId && !await prisma.message.findFirst({ where: { id: parsed.data.quotedMessageId, conversationId: conversation.id }, select: { id: true } })) return res.status(400).json({ error: "الرسالة المقتبسة لا تنتمي إلى هذه المحادثة" });
   const { quotedMessageId, clientMessageId, ...replyInput } = parsed.data;
  const receivedAt = await lastInboundAt(conversation.id, conversation.lastInboundAt);
  if (!messengerWindowOpen(conversation.channel, receivedAt)) return res.status(409).json({ code: "META_WINDOW_EXPIRED", error: "انتهت نافذة الرد في Messenger. انتظر رسالة جديدة من العميل." });
  try {
     const asset = parsed.data.mediaAssetId ? await prisma.mediaAsset.findUnique({ where: { id: parsed.data.mediaAssetId } }) : null;
     if (parsed.data.mediaAssetId && !asset) return res.status(404).json({ error: "الملف المرفق غير موجود" });
     if (parsed.data.kind === MessageKind.STICKER && !asset) return res.status(400).json({ error: "ارفع ملصق WebP صالحًا أولًا" });
      if (asset && (parsed.data.kind === MessageKind.IMAGE && !asset.contentType.startsWith("image/") || parsed.data.kind === MessageKind.STICKER && asset.contentType !== "image/webp" || parsed.data.kind === MessageKind.AUDIO && !asset.contentType.startsWith("audio/") || parsed.data.kind === MessageKind.VIDEO && !asset.contentType.startsWith("video/") || parsed.data.kind === MessageKind.FILE && /^(?:image|audio|video)\//.test(asset.contentType))) return res.status(400).json({ error: "نوع الملف لا يطابق نوع الرسالة" });
    const mediaUrl = asset ? conversation.channel === Channel.WHATSAPP ? undefined : publicMediaUrl(asset.id) : parsed.data.mediaUrl;
    if (conversation.channel === Channel.WHATSAPP) {
      const message = await prisma.message.create({ data: {
        conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND,
        kind: parsed.data.kind, text: parsed.data.text, mediaUrl, mediaAssetId: asset?.id, deliveryStatus: "QUEUED", latitude: parsed.data.latitude,
        longitude: parsed.data.longitude, quotedMessageId
      }, include: { author: { select: { id: true, name: true } }, quotedMessage: { select: { id: true, text: true, kind: true } } } });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: message.createdAt, status: ConversationStatus.OPEN } });
      await audit(req.user!.id, "MESSAGE_QUEUED", conversation.id, { kind: parsed.data.kind });
      const queuedMessage = await queueWhatsAppMessage(message.id, conversation.id, req.user!.id, { channel: conversation.channel, recipient: conversation.externalCustomerId, ...replyInput, mediaUrl, mediaAssetId: asset?.id, mediaContentType: asset?.contentType }, { clientMessageId });
        let quickReplyTagsApplied = true;
        if (applyTagIds.length && queuedMessage?.deliveryStatus !== "FAILED") {
          try { await applyCustomerTagsFromQuickReply(conversation.customerId, req.user!.id, applyTagIds); }
          catch (error) { quickReplyTagsApplied = false; console.error("Could not apply quick-reply customer lists", error); }
        }
        return res.status(202).json({ ...(queuedMessage || message), ...(applyTagIds.length ? { quickReplyTagsApplied } : {}) });
    }
       const result: any = await sendToChannel({ channel: conversation.channel, recipient: channelRecipient(conversation.channel, conversation.externalConversationId, conversation.externalCustomerId), ...replyInput, mediaUrl, mediaContentType: asset?.contentType, mediaBuffer: conversation.channel === Channel.TELEGRAM && (parsed.data.kind === MessageKind.AUDIO || parsed.data.kind === MessageKind.STICKER) && asset ? asset.data : undefined });
    const providerId = kalemlyExternalMessageId(result);
    const message = await prisma.message.create({ data: {
      conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND,
      kind: parsed.data.kind, text: parsed.data.text, mediaUrl, mediaAssetId: asset?.id, deliveryStatus: "SENT", latitude: parsed.data.latitude,
      longitude: parsed.data.longitude, externalId: providerId ? `${conversation.channel}:${providerId}` : undefined, quotedMessageId
    }, include: { author: { select: { id: true, name: true } }, quotedMessage: { select: { id: true, text: true, kind: true } } } });
    await prisma.conversation.update({ where: { id: conversation.id }, data: {
      lastMessageAt: message.createdAt, lastAgentResponseAt: message.createdAt, firstResponseAt: conversation.firstResponseAt || message.createdAt, slaBreachedAt: null, status: ConversationStatus.OPEN
    } });
    await audit(req.user!.id, "MESSAGE_SENT", conversation.id, { kind: parsed.data.kind });
    await emitConversationEvent(conversation.id, conversation.channel, "message:new", { conversationId: conversation.id, message, ...(clientMessageId ? { clientMessageId } : {}) }, { extraRooms: [`agent:${req.user!.id}`] });
    let quickReplyTagsApplied = true;
    if (applyTagIds.length) {
      try { await applyCustomerTagsFromQuickReply(conversation.customerId, req.user!.id, applyTagIds); }
      catch (error) { quickReplyTagsApplied = false; console.error("Could not apply quick-reply customer lists", error); }
    }
    res.status(201).json({ ...message, ...(applyTagIds.length ? { quickReplyTagsApplied } : {}) });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "تعذر إرسال الرسالة للقناة" });
  }
   });
});

app.post("/api/conversations/:id/contact-card", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ contactId: z.string().min(1).max(100) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اختر جهة اتصال صالحة" });
  return withConversationAssignmentLock(req.params.id, async () => {
    const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, include: { customer: { select: { isBlocked: true } } } });
    if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
    if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "ليس لديك صلاحية الرد على هذه المحادثة" });
    if (conversation.customer.isBlocked) return res.status(409).json({ error: "هذا العميل محظور داخل النظام؛ ألغِ الحظر قبل إرسال رسالة" });
    if (conversation.channel !== Channel.WHATSAPP) return res.status(409).json({ error: "إرسال بطاقة جهة الاتصال متاح عبر WhatsApp فقط" });
    if (await getWhatsAppMode() !== "BAILEYS") return res.status(409).json({ error: "أرسل بطاقة جهة الاتصال بعد اتصال WhatsApp بوضع Baileys" });
    const contact = await prisma.customer.findUnique({ where: { id: parsed.data.contactId }, select: { id: true, name: true, displayName: true, phone: true } });
    if (!contact?.phone) return res.status(400).json({ error: "جهة الاتصال المحددة لا تحتوي على رقم هاتف" });
    let phone: string;
    try { phone = normalizePhoneNumber(contact.phone); }
    catch { return res.status(400).json({ error: "رقم هاتف جهة الاتصال غير صالح" }); }
    const name = (contact.displayName || contact.name || phone).trim().slice(0, 120);
    const message = await prisma.message.create({ data: {
      conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND,
      kind: MessageKind.TEXT, text: null, metadata: { contactCard: { name, phone } }, deliveryStatus: "QUEUED"
    }, include: { author: { select: { id: true, name: true } } } });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: message.createdAt, status: ConversationStatus.OPEN } });
    await audit(req.user!.id, "CONTACT_CARD_QUEUED", conversation.id, { messageId: message.id, contactId: contact.id });
    const queued = await queueWhatsAppMessage(message.id, conversation.id, req.user!.id, { channel: conversation.channel, recipient: conversation.externalCustomerId, contactCard: { name, phone } });
    return res.status(202).json(queued || message);
  });
});

app.post("/api/conversations/:id/poll", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ question: z.string().trim().min(1).max(300), options: z.array(z.string().trim().min(1).max(100)).min(2).max(10) }).strict().safeParse(req.body);
  if (!parsed.success || new Set(parsed.data?.options.map((option) => option.toLocaleLowerCase())).size !== parsed.data?.options.length) return res.status(400).json({ error: "اكتب سؤالًا واختر من خيارين إلى عشرة خيارات مختلفة" });
  return withConversationAssignmentLock(req.params.id, async () => {
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, include: { customer: { select: { isBlocked: true } } } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "لا تملك صلاحية الرد على هذه المحادثة" });
  if (conversation.customer.isBlocked) return res.status(409).json({ error: "هذا العميل محظور داخل النظام؛ ألغِ الحظر قبل إرسال رسالة" });
  if (conversation.channel === Channel.MESSENGER || conversation.channel === Channel.WHATSAPP && await getWhatsAppMode() !== "BAILEYS") return res.status(409).json({ error: "إنشاء الاستطلاعات متاح في Telegram ووضع Baileys لـ WhatsApp فقط" });
  const receivedAt = await lastInboundAt(conversation.id, conversation.lastInboundAt);
  if (!messengerWindowOpen(conversation.channel, receivedAt)) return res.status(409).json({ code: "META_WINDOW_EXPIRED", error: "انتهت نافذة الرد في Messenger" });
  const metadata = { pollOptions: parsed.data.options, pollAnonymous: true } as Prisma.InputJsonValue;
  if (conversation.channel === Channel.WHATSAPP) {
    const message = await prisma.message.create({ data: { conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.POLL, text: parsed.data.question, metadata, deliveryStatus: "QUEUED" }, include: { author: { select: { id: true, name: true } } } });
    const queued = await queueWhatsAppMessage(message.id, conversation.id, req.user!.id, { channel: conversation.channel, recipient: conversation.externalCustomerId, kind: MessageKind.POLL, text: parsed.data.question, pollOptions: parsed.data.options });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: message.createdAt, status: ConversationStatus.OPEN } });
    await audit(req.user!.id, "POLL_SENT", conversation.id, { messageId: message.id, optionCount: parsed.data.options.length });
    return res.status(202).json(queued || message);
  }
  try {
    const result: any = await sendToChannel({ channel: conversation.channel, recipient: channelRecipient(conversation.channel, conversation.externalConversationId, conversation.externalCustomerId), kind: MessageKind.POLL, text: parsed.data.question, pollOptions: parsed.data.options });
    const providerId = kalemlyExternalMessageId(result);
    const message = await prisma.message.create({ data: { conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.POLL, text: parsed.data.question, metadata, deliveryStatus: "SENT", externalId: providerId ? `${conversation.channel}:${providerId}` : undefined }, include: { author: { select: { id: true, name: true } } } });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: message.createdAt, lastAgentResponseAt: message.createdAt, firstResponseAt: conversation.firstResponseAt || message.createdAt, slaBreachedAt: null, status: ConversationStatus.OPEN } });
    await audit(req.user!.id, "POLL_SENT", conversation.id, { messageId: message.id, optionCount: parsed.data.options.length });
     await emitConversationEvent(conversation.id, conversation.channel, "message:new", { conversationId: conversation.id, message }, { extraRooms: [`agent:${req.user!.id}`] });
    res.status(201).json(message);
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : "تعذر إرسال الاستطلاع" }); }
  });
});

app.patch("/api/conversations/:id/messages/:messageId", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ text: z.string().trim().min(1).max(4000) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اكتب نصًا صالحًا للتعديل" });
  const message = await prisma.message.findFirst({ where: { id: req.params.messageId, conversationId: req.params.id }, include: { conversation: { include: { customer: { select: { isBlocked: true } } } } } });
  if (!message) return res.status(404).json({ error: "الرسالة غير موجودة" });
  if (!canWorkOnConversation(req.user!, message.conversation)) return res.status(403).json({ error: "لا تملك صلاحية تعديل هذه المحادثة" });
  if (message.conversation.customer.isBlocked) return res.status(409).json({ error: "لا يمكن تعديل رسائل عميل محظور داخل النظام" });
  if (message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata) && "contactCard" in message.metadata) return res.status(409).json({ error: "لا يمكن تعديل بطاقة جهة اتصال بعد إرسالها" });
  if (message.direction !== MessageDirection.OUTBOUND || message.authorId !== req.user!.id || message.kind !== MessageKind.TEXT) return res.status(409).json({ error: "يمكن تعديل الرسائل النصية التي أرسلتها أنت فقط" });
  if (message.deliveryStatus !== "SENT" || !message.externalId) return res.status(409).json({ error: "لا يمكن تعديل رسالة لم يؤكد مزود القناة إرسالها" });
  if (message.conversation.channel === Channel.MESSENGER) return res.status(409).json({ error: "لا يتيح Messenger تعديل الرسالة بعد إرسالها؛ لم نرسل بديلًا حتى لا نفقد الرسالة الأصلية." });
  if (message.conversation.channel === Channel.WHATSAPP && await getWhatsAppMode() !== "BAILEYS") return res.status(409).json({ error: "تعديل الرسائل غير متاح في وضع WhatsApp API الحالي" });
  try {
    await editProviderMessage({ channel: message.conversation.channel, recipient: channelRecipient(message.conversation.channel, message.conversation.externalConversationId, message.conversation.externalCustomerId), externalId: message.externalId, text: parsed.data.text, direction: "OUTBOUND" });
    const previous = message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata) ? message.metadata as Record<string, Prisma.JsonValue> : {};
    const updated = await prisma.message.update({ where: { id: message.id }, data: { text: parsed.data.text, metadata: { ...previous, editedAt: new Date().toISOString() } as Prisma.InputJsonValue }, include: { author: { select: { id: true, name: true } }, reactions: { include: { user: { select: { id: true, name: true } } } } } });
    await audit(req.user!.id, "MESSAGE_EDITED", message.conversationId, { messageId: message.id });
     await emitConversationEvent(message.conversationId, message.conversation.channel, "message:updated", { conversationId: message.conversationId, message: updated });
    res.json(updated);
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : "تعذر تعديل الرسالة لدى القناة" }); }
});

app.delete("/api/conversations/:id/messages/:messageId", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const message = await prisma.message.findFirst({ where: { id: req.params.messageId, conversationId: req.params.id }, include: { conversation: true } });
  if (!message) return res.status(404).json({ error: "الرسالة غير موجودة" });
  if (!canWorkOnConversation(req.user!, message.conversation)) return res.status(403).json({ error: "لا تملك صلاحية تعديل هذه المحادثة" });
  if (message.direction !== MessageDirection.OUTBOUND || message.authorId !== req.user!.id) return res.status(409).json({ error: "يمكن حذف الرسائل التي أرسلتها أنت فقط" });
  if (!message.externalId || !["SENT", "DELIVERED", "READ", "PLAYED"].includes(message.deliveryStatus || "")) return res.status(409).json({ error: "لا يمكن حذف رسالة لم يؤكد مزود القناة إرسالها" });
  try {
    await deleteProviderMessage({ channel: message.conversation.channel, recipient: channelRecipient(message.conversation.channel, message.conversation.externalConversationId, message.conversation.externalCustomerId), externalId: message.externalId });
    await prisma.$transaction(async (tx) => {
      await tx.auditLog.create({ data: { actorId: req.user!.id, conversationId: message.conversationId, action: "MESSAGE_DELETED", details: { messageId: message.id, providerDeleted: true } } });
      await tx.message.delete({ where: { id: message.id } });
      if (message.mediaAssetId) await tx.mediaAsset.deleteMany({ where: { id: message.mediaAssetId, messages: { none: {} }, products: { none: {} }, quickReplies: { none: {} } } });
    });
     await emitConversationEvent(message.conversationId, message.conversation.channel, "message:deleted", { conversationId: message.conversationId, messageId: message.id });
    res.json({ messageId: message.id, deleted: true, providerDeleted: true });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "تعذر حذف الرسالة لدى القناة" });
  }
});

app.post("/api/conversations/:id/messages/:messageId/forward", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ targetConversationId: z.string().min(1) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اختر محادثة مستهدفة" });
  return withConversationAssignmentLock(parsed.data.targetConversationId, async () => {
  const source = await prisma.message.findFirst({ where: { id: req.params.messageId, conversationId: req.params.id }, include: { conversation: true, mediaAsset: { select: { id: true, contentType: true } } } });
  const target = await prisma.conversation.findUnique({ where: { id: parsed.data.targetConversationId }, include: { customer: { select: { isBlocked: true } } } });
  if (!source || !target) return res.status(404).json({ error: "الرسالة أو المحادثة المستهدفة غير موجودة" });
  if (!canWorkOnConversation(req.user!, source.conversation) || !canWorkOnConversation(req.user!, target)) return res.status(403).json({ error: "لا تملك صلاحية تحويل هذه الرسالة بين المحادثتين" });
  if (target.customer.isBlocked) return res.status(409).json({ error: "لا يمكن إرسال رسالة إلى عميل محظور داخل النظام" });
  if (source.direction === MessageDirection.INTERNAL || source.kind === MessageKind.SYSTEM || source.kind === MessageKind.LOCATION && (source.latitude === null || source.longitude === null)) return res.status(409).json({ error: "لا يمكن تحويل هذا النوع من الرسائل" });
  const receivedAt = await lastInboundAt(target.id, target.lastInboundAt);
  if (!messengerWindowOpen(target.channel, receivedAt)) return res.status(409).json({ code: "META_WINDOW_EXPIRED", error: "انتهت نافذة الرد في المحادثة المستهدفة" });
  if (source.kind === MessageKind.STICKER && (target.channel === Channel.MESSENGER || target.channel === Channel.WHATSAPP && await getWhatsAppMode() !== "BAILEYS")) return res.status(409).json({ error: "ملصقات القناة المستهدفة غير مدعومة في وضعها الحالي" });
  const sourceMetadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata) ? source.metadata as Record<string, unknown> : {};
  const pollOptions = Array.isArray(sourceMetadata.pollOptions) ? sourceMetadata.pollOptions.filter((option): option is string => typeof option === "string") : undefined;
  if (source.kind === MessageKind.POLL && (!pollOptions || pollOptions.length < 2 || pollOptions.length > 10 || new Set(pollOptions.map((option) => option.toLocaleLowerCase())).size !== pollOptions.length || target.channel === Channel.MESSENGER || target.channel === Channel.WHATSAPP && await getWhatsAppMode() !== "BAILEYS")) return res.status(409).json({ error: "لا يمكن تحويل هذا الاستطلاع إلى القناة المستهدفة" });
   const hasMedia = [MessageKind.IMAGE, MessageKind.AUDIO, MessageKind.VIDEO, MessageKind.FILE, MessageKind.STICKER].some((kind) => kind === source.kind);
   try {
    let sourceAsset = source.mediaAsset;
    let sourceMediaBuffer: Uint8Array | undefined;
    if (hasMedia && !sourceAsset) {
      const media = await fetchInboundMedia(source.conversation.channel, sourceMetadata, source.mediaUrl || undefined);
      const contentType = media.contentType.split(";")[0].toLowerCase();
      if (!allowedMediaTypes.has(contentType) || !imageSignatureMatches(contentType, media.body)) return res.status(415).json({ error: "نوع المرفق غير مدعوم للتحويل" });
      const extension = contentType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "bin";
      const asset = await prisma.mediaAsset.create({ data: { fileName: safeFileName(source.kind === MessageKind.STICKER ? "sticker.webp" : `forwarded-${source.id.slice(0, 8)}.${extension}`), contentType, size: media.body.length, data: Uint8Array.from(media.body), createdById: req.user!.id }, select: { id: true, contentType: true } });
      await prisma.message.update({ where: { id: source.id }, data: { mediaAssetId: asset.id, mediaUrl: null } });
      sourceAsset = asset;
       if (target.channel === Channel.TELEGRAM && (source.kind === MessageKind.AUDIO || source.kind === MessageKind.STICKER)) sourceMediaBuffer = media.body;
    }
    if (hasMedia && !sourceAsset) return res.status(409).json({ error: "تعذر العثور على ملف المرفق لتحويله" });
    if (target.channel === Channel.TELEGRAM && (source.kind === MessageKind.AUDIO || source.kind === MessageKind.STICKER) && sourceAsset && !sourceMediaBuffer) {
      const mediaAsset = await prisma.mediaAsset.findUnique({ where: { id: sourceAsset.id }, select: { data: true } });
      if (!mediaAsset) return res.status(409).json({ error: source.kind === MessageKind.STICKER ? "تعذر العثور على الملصق لتحويله" : "تعذر العثور على التسجيل الصوتي لتحويله" });
      sourceMediaBuffer = mediaAsset.data;
    }
    if (source.kind === MessageKind.STICKER && sourceAsset?.contentType !== "image/webp") return res.status(409).json({ error: "الملصق غير محفوظ بصيغة WebP صالحة" });
    const mediaUrl = sourceAsset ? target.channel === Channel.WHATSAPP ? undefined : publicMediaUrl(sourceAsset.id) : undefined;
    const forwardedMetadata = { ...(source.kind === MessageKind.POLL && pollOptions ? { pollOptions } : {}), forwardedFrom: { messageId: source.id, conversationId: source.conversationId } };
    const data = { conversationId: target.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND, kind: source.kind, text: source.kind === MessageKind.STICKER ? null : source.text, mediaUrl, mediaAssetId: sourceAsset?.id, latitude: source.latitude, longitude: source.longitude, metadata: forwardedMetadata as Prisma.InputJsonValue };
    if (target.channel === Channel.WHATSAPP) {
      const queued = await prisma.message.create({ data: { ...data, deliveryStatus: "QUEUED" }, include: { author: { select: { id: true, name: true } } } });
      const queuedMessage = await queueWhatsAppMessage(queued.id, target.id, req.user!.id, { channel: target.channel, recipient: channelRecipient(target.channel, target.externalConversationId, target.externalCustomerId), text: queued.text || undefined, kind: queued.kind, mediaUrl, mediaAssetId: sourceAsset?.id, mediaContentType: sourceAsset?.contentType, latitude: source.latitude ?? undefined, longitude: source.longitude ?? undefined, pollOptions });
      await prisma.conversation.update({ where: { id: target.id }, data: { lastMessageAt: queued.createdAt, status: ConversationStatus.OPEN } });
      await audit(req.user!.id, "MESSAGE_FORWARDED", target.id, { sourceMessageId: source.id, sourceConversationId: source.conversationId });
      return res.status(202).json(queuedMessage || queued);
    }
    const result: any = await sendToChannel({ channel: target.channel, recipient: channelRecipient(target.channel, target.externalConversationId, target.externalCustomerId), text: source.kind === MessageKind.STICKER ? undefined : source.text || undefined, kind: source.kind, mediaUrl, mediaAssetId: sourceAsset?.id, mediaContentType: sourceAsset?.contentType, mediaBuffer: sourceMediaBuffer, latitude: source.latitude ?? undefined, longitude: source.longitude ?? undefined, pollOptions });
    const providerId = kalemlyExternalMessageId(result);
    const message = await prisma.message.create({ data: { ...data, deliveryStatus: "SENT", externalId: providerId ? `${target.channel}:${providerId}` : undefined }, include: { author: { select: { id: true, name: true } } } });
    await prisma.conversation.update({ where: { id: target.id }, data: { lastMessageAt: message.createdAt, lastAgentResponseAt: message.createdAt, firstResponseAt: target.firstResponseAt || message.createdAt, slaBreachedAt: null, status: ConversationStatus.OPEN } });
    await audit(req.user!.id, "MESSAGE_FORWARDED", target.id, { sourceMessageId: source.id, sourceConversationId: source.conversationId });
     await emitConversationEvent(target.id, target.channel, "message:new", { conversationId: target.id, message }, { extraRooms: [`agent:${req.user!.id}`] });
    res.status(201).json(message);
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : "تعذر تحويل الرسالة للقناة" }); }
  });
});

app.post("/api/conversations/:id/products", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.union([
    z.object({ productIds: z.array(z.string().min(1)).min(1).max(12) }),
    z.object({ productId: z.string().min(1) })
  ]).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اختر منتجًا من الكتالوج" });
  return withConversationAssignmentLock(req.params.id, async () => {
  const productIds = "productIds" in parsed.data ? [...new Set(parsed.data.productIds)] : [parsed.data.productId];
  const [conversation, products] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: req.params.id }, include: { customer: { select: { isBlocked: true } } } }),
    prisma.product.findMany({ where: { id: { in: productIds }, isAvailable: true } })
  ]);
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "ليس لديك صلاحية على هذه المحادثة" });
  if (conversation.customer.isBlocked) return res.status(409).json({ error: "لا يمكن إرسال منتجات إلى عميل محظور داخل النظام" });
  if (products.length !== productIds.length) return res.status(404).json({ error: "أحد المنتجات المحددة غير متوفر" });
  if (products.some((product) => !product.imageUrl && !product.imageAssetId)) return res.status(409).json({ error: "أضف صور المنتجات المحددة قبل إرسالها للعميل" });
  const receivedAt = await lastInboundAt(conversation.id, conversation.lastInboundAt);
  if (!messengerWindowOpen(conversation.channel, receivedAt)) return res.status(409).json({ code: "META_WINDOW_EXPIRED", error: "انتهت نافذة الرد في Messenger. انتظر رسالة جديدة من العميل." });
  const results: any[] = [];
  for (const product of productIds.map((id) => products.find((item) => item.id === id)!)) {
    const text = `${product.name}\nالسعر: ${product.price.toFixed(2)} جنيه${product.description ? `\n${product.description}` : ""}`;
    if (conversation.channel === Channel.WHATSAPP) {
      try {
        const textMessage = await prisma.message.create({ data: { conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.TEXT, text, productId: product.id, deliveryStatus: "QUEUED" } });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: textMessage.createdAt, status: ConversationStatus.OPEN } });
        const queuedText = await queueWhatsAppMessage(textMessage.id, conversation.id, req.user!.id, { channel: conversation.channel, recipient: conversation.externalCustomerId, text });
        const imageUrl = product.imageAssetId ? undefined : product.imageUrl!;
        const imageMessage = await prisma.message.create({ data: { conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.IMAGE, mediaUrl: imageUrl, mediaAssetId: product.imageAssetId, productId: product.id, deliveryStatus: "QUEUED" } });
         const queuedImage = await queueWhatsAppMessage(imageMessage.id, conversation.id, req.user!.id, { channel: conversation.channel, recipient: conversation.externalCustomerId, kind: MessageKind.IMAGE, mediaUrl: imageUrl, mediaAssetId: product.imageAssetId || undefined });
        const captionDelivery = queuedText?.deliveryStatus === "FAILED" ? "failed" : queuedText?.deliveryStatus === "SENT" ? "sent" : "queued";
        const imageDelivery = queuedImage?.deliveryStatus === "FAILED" ? "failed" : queuedImage?.deliveryStatus === "SENT" ? "sent" : "queued";
        results.push({ productId: product.id, name: product.name, textMessage: queuedText || textMessage, imageMessage: queuedImage || imageMessage, captionDelivery, imageDelivery });
      } catch (error) {
        results.push({ productId: product.id, name: product.name, captionDelivery: "failed", imageDelivery: "not-sent", error: error instanceof Error ? error.message : "تعذر إرسال المنتج للقناة" });
      }
      continue;
    }
    try {
       const textResult: any = await sendToChannel({ channel: conversation.channel, recipient: channelRecipient(conversation.channel, conversation.externalConversationId, conversation.externalCustomerId), text });
      const textProviderId = kalemlyExternalMessageId(textResult);
      const textMessage = await prisma.message.create({ data: { conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.TEXT, text, productId: product.id, deliveryStatus: "SENT", externalId: textProviderId ? `${conversation.channel}:${textProviderId}` : undefined } });
       await emitConversationEvent(conversation.id, conversation.channel, "message:new", { conversationId: conversation.id, message: textMessage }, { extraRooms: [`agent:${req.user!.id}`] });
       const imageUrl = product.imageAssetId ? publicMediaUrl(product.imageAssetId) : product.imageUrl!;
      let imageMessage: any;
      let imageError: string | undefined;
      try {
         const imageResult: any = await sendToChannel({ channel: conversation.channel, recipient: channelRecipient(conversation.channel, conversation.externalConversationId, conversation.externalCustomerId), kind: MessageKind.IMAGE, mediaUrl: imageUrl });
        const imageProviderId = kalemlyExternalMessageId(imageResult);
        imageMessage = await prisma.message.create({ data: { conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.IMAGE, mediaUrl: imageUrl, mediaAssetId: product.imageAssetId, productId: product.id, deliveryStatus: "SENT", externalId: imageProviderId ? `${conversation.channel}:${imageProviderId}` : undefined } });
         await emitConversationEvent(conversation.id, conversation.channel, "message:new", { conversationId: conversation.id, message: imageMessage }, { extraRooms: [`agent:${req.user!.id}`] });
      } catch (error) { imageError = error instanceof Error ? error.message : "تعذر إرسال الصورة"; }
      const lastMessage = imageMessage || textMessage;
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: lastMessage.createdAt, lastAgentResponseAt: lastMessage.createdAt, firstResponseAt: conversation.firstResponseAt || lastMessage.createdAt, slaBreachedAt: null, status: ConversationStatus.OPEN } });
      results.push({ productId: product.id, name: product.name, textMessage, imageMessage, captionDelivery: "sent", imageDelivery: imageMessage ? "sent" : "failed", ...(imageError ? { imageError } : {}) });
    } catch (error) {
      results.push({ productId: product.id, name: product.name, captionDelivery: "failed", imageDelivery: "not-sent", error: error instanceof Error ? error.message : "تعذر إرسال المنتج للقناة" });
    }
  }
  await audit(req.user!.id, "PRODUCT_SENT", conversation.id, { productIds, results: results.map(({ productId, captionDelivery, imageDelivery }) => ({ productId, captionDelivery, imageDelivery })) });
  if (results.every((result) => result.captionDelivery !== "sent" && result.captionDelivery !== "queued")) return res.status(502).json({ error: results[0]?.error || "تعذر إرسال المنتجات للقناة", items: results });
  res.status(conversation.channel === Channel.WHATSAPP && results.some((result) => result.captionDelivery === "queued" || result.imageDelivery === "queued") ? 202 : 201)
    .json({ items: results, ...(results.length === 1 ? results[0] : {}) });
  });
});

app.get("/api/products", agentGuard, async (_req: express.Request, res: express.Response) => {
  const products = await prisma.product.findMany({ where: { isAvailable: true }, orderBy: [{ category: "asc" }, { name: "asc" }] });
   res.json(products.map((product) => product.imageAssetId ? { ...product, imageUrl: publicMediaUrl(product.imageAssetId, 90 * 24 * 60 * 60) } : product));
});
app.get("/api/admin/products", permissionGuard("canManageCatalog"), async (_req: express.Request, res: express.Response) => {
  const products = await prisma.product.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] });
   res.json(products.map((product) => product.imageAssetId ? { ...product, imageUrl: publicMediaUrl(product.imageAssetId, 90 * 24 * 60 * 60) } : product));
});
app.post("/api/admin/products", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ name: z.string().min(2).max(120), sku: z.preprocess((value) => typeof value === "string" && !value.trim() ? null : value, z.string().trim().max(80).nullable().optional()), category: z.nativeEnum(ProductCategory), price: z.number().nonnegative(), imageUrl: httpsUrl.nullable().optional(), imageAssetId: z.string().nullable().optional(), description: z.string().max(800).nullable().optional(), isAvailable: z.boolean().default(true) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "راجع اسم المنتج وقسمه وسعره ورابط صورته" });
  const asset = parsed.data.imageAssetId ? await prisma.mediaAsset.findFirst({ where: { id: parsed.data.imageAssetId, contentType: { startsWith: "image/" } }, select: { id: true } }) : null;
  if (parsed.data.imageAssetId && !asset) return res.status(400).json({ error: "صورة المنتج غير موجودة أو ليست صورة" });
  let product;
   try { product = await prisma.product.create({ data: { ...parsed.data, imageUrl: asset ? publicMediaUrl(asset.id, 90 * 24 * 60 * 60) : parsed.data.imageUrl, imageAssetId: asset?.id, price: new Prisma.Decimal(parsed.data.price) } }); }
  catch (error) { if (isUniqueConstraintError(error)) return res.status(409).json({ error: "كود المنتج مستخدم بالفعل" }); throw error; }
  await audit(req.user!.id, "PRODUCT_CREATED", undefined, { productId: product.id });
  res.status(201).json(product);
});
app.patch("/api/admin/products/:id", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ name: z.string().min(2).max(120).optional(), sku: z.preprocess((value) => typeof value === "string" && !value.trim() ? null : value, z.string().trim().max(80).nullable().optional()), category: z.nativeEnum(ProductCategory).optional(), price: z.number().nonnegative().optional(), imageUrl: httpsUrl.nullable().optional(), imageAssetId: z.string().nullable().optional(), description: z.string().max(800).nullable().optional(), isAvailable: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "بيانات المنتج غير صالحة" });
  const { price, imageAssetId, ...fields } = parsed.data;
  const asset = imageAssetId ? await prisma.mediaAsset.findFirst({ where: { id: imageAssetId, contentType: { startsWith: "image/" } }, select: { id: true } }) : null;
  if (imageAssetId && !asset) return res.status(400).json({ error: "صورة المنتج غير موجودة أو ليست صورة" });
  const imageFields = imageAssetId !== undefined
     ? { imageAssetId: asset?.id || null, ...(asset ? { imageUrl: publicMediaUrl(asset.id, 90 * 24 * 60 * 60) } : {}) }
    : fields.imageUrl !== undefined ? { imageAssetId: null } : {};
  let product;
  try { product = await prisma.product.update({ where: { id: req.params.id }, data: { ...fields, ...imageFields, ...(price === undefined ? {} : { price: new Prisma.Decimal(price) }) } }); }
  catch (error) { if (isUniqueConstraintError(error)) return res.status(409).json({ error: "كود المنتج مستخدم بالفعل" }); throw error; }
  await audit(req.user!.id, "PRODUCT_UPDATED", undefined, { productId: product.id });
  res.json(product);
});

app.post("/api/conversations/:id/whisper", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ text: z.string().min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اكتب الملاحظة السرية" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, include: { assignedAgent: { select: { role: true } } } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  const assignedRole = conversation.assignedAgent?.role;
  if (!conversation.assignedAgentId || assignedRole !== Role.AGENT && assignedRole !== Role.BRANCH_USER) return res.status(409).json({ error: "أسند المحادثة لموظف قبل إرسال توجيه سري" });
  const note = await prisma.whisperNote.create({ data: { conversationId: conversation.id, authorId: req.user!.id, text: parsed.data.text } });
  await audit(req.user!.id, "WHISPER_SENT", conversation.id);
   await emitConversationEvent(conversation.id, conversation.channel, "whisper:new", note, { audience: "managers", extraRooms: [`agent:${conversation.assignedAgentId}`] });
  res.status(201).json(note);
});

app.get("/api/conversations/:id/private-note-recipients", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, select: { id: true, assignedAgentId: true, branchId: true, status: true, channel: true, externalConversationId: true } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!await canReadConversationOrHistory(req.user!, conversation)) return res.status(403).json({ error: "لا تملك صلاحية مراسلة زميل في هذه المحادثة" });
  const recipientFilters: Prisma.UserWhereInput[] = [{ role: Role.AGENT }];
  if (conversation.branchId) recipientFilters.push({ role: Role.BRANCH_USER, branchId: conversation.branchId });
  const recipients = await prisma.user.findMany({
    where: { id: { not: req.user!.id }, isActive: true, OR: recipientFilters },
    select: { id: true, name: true, presence: true, branch: { select: { name: true } } },
    orderBy: { name: "asc" }
  });
  res.json(recipients);
});

app.post("/api/conversations/:id/private-notes", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ recipientId: z.string().min(1).max(100), text: z.string().trim().min(1).max(4000) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اختر زميلًا واكتب رسالة سرية لا تتجاوز 4000 حرف" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, select: { id: true, assignedAgentId: true, branchId: true, status: true, channel: true, externalConversationId: true, customer: { select: { name: true, displayName: true } } } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!await canReadConversationOrHistory(req.user!, conversation) || !canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "لا تملك صلاحية مراسلة زميل في هذه المحادثة" });
  const recipient = await prisma.user.findUnique({ where: { id: parsed.data.recipientId }, select: { id: true, name: true, role: true, branchId: true, isActive: true } });
  if (!recipient || recipient.id === req.user!.id || !canReceivePrivateConversationNote(recipient, conversation)) return res.status(400).json({ error: "الزميل المحدد غير متاح لهذه المحادثة" });
  const note = await prisma.conversationPrivateNote.create({
    data: { conversationId: conversation.id, authorId: req.user!.id, recipientId: recipient.id, text: parsed.data.text },
    include: { author: { select: { id: true, name: true } }, recipient: { select: { id: true, name: true } } }
  });
  await audit(req.user!.id, "PRIVATE_CONVERSATION_NOTE_SENT", conversation.id, { noteId: note.id, recipientId: recipient.id });
  const event = { conversationId: conversation.id, recipientId: recipient.id, customerName: conversation.customer.displayName || conversation.customer.name || "عميل جديد", channel: conversation.channel, note };
   await emitConversationEvent(conversation.id, conversation.channel, "conversation-private-note:new", event, { audience: "managers", extraRooms: [`user:${req.user!.id}`, `user:${recipient.id}`] });
  const managers = await prisma.user.findMany({ where: { isActive: true, OR: [
    { role: Role.ADMIN },
    { role: Role.SUPERVISOR, canViewAllConversations: true },
    { role: Role.SUPERVISOR, canViewAllConversations: null }
  ] }, select: { id: true } });
  void sendPushNotification([...new Set([req.user!.id, recipient.id, ...managers.map((manager) => manager.id)])], {
    title: "رسالة سرية في محادثة",
    body: `${req.user!.name} أرسل رسالة سرية إلى ${recipient.name}.`,
    url: `/agent/workspace?conversation=${encodeURIComponent(conversation.id)}`,
    tag: `secret-note-${note.id}`
  }).catch((error) => console.warn("Secret note push notification failed", error));
  res.status(201).json(note);
});

app.post("/api/conversations/:id/notes", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ text: z.string().trim().min(1).max(4000) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اكتب ملاحظة داخلية لا تتجاوز 4000 حرف" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "لا تملك صلاحية إضافة ملاحظة لهذه المحادثة" });
  const note = await prisma.conversationNote.create({ data: { conversationId: conversation.id, authorId: req.user!.id, text: parsed.data.text }, include: { author: { select: { id: true, name: true } } } });
  await audit(req.user!.id, "CONVERSATION_NOTE_ADDED", conversation.id, { noteId: note.id });
   await emitConversationEvent(conversation.id, conversation.channel, "conversation-note:new", { conversationId: conversation.id, note });
  res.status(201).json(note);
});

app.patch("/api/conversations/:id/assignment", permissionGuard("canTransferConversations"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ agentId: z.string().nullable(), branchId: z.string().nullable().optional(), keepQueued: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اختر الموظف الجديد" });
  if (parsed.data.keepQueued && parsed.data.agentId) return res.status(400).json({ error: "لا يمكن إبقاء المحادثة في الطابور مع إسنادها لموظف" });
  const result = await withConversationAssignmentLock(req.params.id, async () => {
    const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, include: { assignedAgent: { select: { id: true, name: true } } } });
    if (!conversation) return { error: res.status(404).json({ error: "المحادثة غير موجودة" }) };
      if (!canWorkOnConversation(req.user!, conversation)) return { error: res.status(403).json({ error: "لا تملك صلاحية لتحويل هذه المحادثة" }) };
    let assignee: { id: string; role: Role; presence: Presence; branchId: string | null } | null = null;
    if (parsed.data.agentId) {
      assignee = await prisma.user.findFirst({ where: { id: parsed.data.agentId, role: { in: [Role.AGENT, Role.BRANCH_USER] }, isActive: true, ...await channelRecipientWhere(conversation.channel) }, select: { id: true, role: true, presence: true, branchId: true } });
      if (!assignee) return { error: res.status(400).json({ error: "الموظف المحدد غير متاح" }) };
      if (assignee.presence !== Presence.ONLINE) return { error: res.status(409).json({ error: "لا يمكن إسناد محادثة لموظف غير متصل" }) };
      if (!await isUserConnected(assignee.id)) return { error: res.status(409).json({ error: "الموظف المحدد غير متصل بالنظام حاليًا" }) };
      if (assignee.role === Role.BRANCH_USER && !assignee.branchId) return { error: res.status(409).json({ error: "اربط الموظف بفرع قبل إسناد المحادثة" }) };
    }
    const branchId = assignee?.role === Role.BRANCH_USER ? assignee.branchId : parsed.data.branchId !== undefined ? parsed.data.branchId : parsed.data.agentId ? null : conversation.branchId;
    if (parsed.data.branchId) return { error: res.status(409).json({ error: "توجيه المحادثات إلى فرع غير متاح" }) };
    const changed = await prisma.conversation.updateMany({
      where: { id: conversation.id, assignedAgentId: conversation.assignedAgentId, branchId: conversation.branchId },
      data: { assignedAgentId: parsed.data.agentId, branchId, routingDepartment: branchId ? Department.BRANCH : conversation.routingDepartment === Department.BRANCH ? null : conversation.routingDepartment, status: parsed.data.agentId ? ConversationStatus.OPEN : ConversationStatus.QUEUED, awaitingRouting: false }
    });
    if (!changed.count) return { error: res.status(409).json({ error: "تغيّر إسناد المحادثة. حدّث الصفحة وحاول مجددًا" }) };
    if (conversation.assignedAgentId !== parsed.data.agentId) {
      const pendingRequest = await prisma.conversationHandoffRequest.findUnique({ where: { conversationId: conversation.id } });
      if (pendingRequest?.status === ConversationHandoffStatus.PENDING) {
        const cancelled = await prisma.conversationHandoffRequest.updateMany({ where: { id: pendingRequest.id, status: ConversationHandoffStatus.PENDING }, data: { status: ConversationHandoffStatus.CANCELLED, resolvedAt: new Date() } });
        if (cancelled.count) {
          await audit(req.user!.id, "CONVERSATION_HANDOFF_CANCELLED", conversation.id, { from: pendingRequest.fromAgentId, to: pendingRequest.toAgentId, reason: "ADMIN_REASSIGNMENT" });
          io.to(`agent:${pendingRequest.toAgentId}`).emit("conversation:handoff-cancelled", { conversationId: conversation.id });
          await emitConversationEvent(conversation.id, conversation.channel, "handoff:updated", { conversationId: conversation.id, decision: "CANCELLED" }, { audience: "managers" });
        }
      }
    }
    const historyAgentIds = [...new Set([conversation.assignedAgentId, parsed.data.agentId].filter((id): id is string => Boolean(id)))];
    if (historyAgentIds.length) await prisma.conversationAssignment.createMany({ data: historyAgentIds.map((agentId) => ({ conversationId: conversation.id, agentId })), skipDuplicates: true });
    await audit(req.user!.id, "CONVERSATION_REASSIGNED", conversation.id, { from: conversation.assignedAgentId, to: parsed.data.agentId, by: req.user!.id, keepQueued: parsed.data.keepQueued || false });
    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id }, include: { customer: true, assignedAgent: { select: { id: true, name: true, presence: true } } } });
    if (conversation.branchId !== updated.branchId) await revokeConversationRoomAccess(updated.id, updated);
    return { conversation, updated, branchId };
  });
  if ("error" in result) return result.error;
  const { conversation, branchId } = result;
  let updated = result.updated;
  if (!parsed.data.agentId && !parsed.data.keepQueued) {
    await assignConversation(conversation.id, branchId ? Department.BRANCH : undefined);
    updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id }, include: { customer: true, assignedAgent: { select: { id: true, name: true, presence: true } } } });
  }
  if (updated.assignedAgentId) {
    const inbound = await prisma.message.findFirst({ where: { conversationId: updated.id, direction: MessageDirection.INBOUND }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    if (inbound) await scheduleUnansweredReassignment(updated.id, inbound.id, updated.assignedAgentId);
  }
  if (conversation.assignedAgentId && conversation.assignedAgentId !== updated.assignedAgentId) {
    const managerTitle = req.user!.role === Role.ADMIN ? "مدير النظام" : "المشرف";
    const body = updated.assignedAgent?.name ? `سحب ${managerTitle} (${req.user!.name}) المحادثة من متابعتك وأسندها إلى ${updated.assignedAgent.name}.` : `سحب ${managerTitle} (${req.user!.name}) المحادثة من متابعتك.`;
    const formerAgent = await loadSessionUser(conversation.assignedAgentId);
    if (formerAgent && canViewChannel(formerAgent, conversation.channel)) {
      io.to(`agent:${conversation.assignedAgentId}`).emit("conversation:unassigned", { ...updated, adminReassigned: true, managerName: req.user!.name });
      io.to(`agent:${conversation.assignedAgentId}`).emit("conversation:admin-reassigned", { conversationId: conversation.id, customerName: updated.customer?.displayName || updated.customer?.name || "عميل", managerName: req.user!.name, nextAgentName: updated.assignedAgent?.name || null, body });
      void sendPushNotification([conversation.assignedAgentId], { title: "تغيير إسناد محادثة", body, url: "/agent/workspace", tag: `admin-reassigned-${conversation.id}` }).catch((error) => console.warn("Admin reassignment push notification failed", error));
    }
  }
  if (parsed.data.agentId) io.to(`agent:${parsed.data.agentId}`).emit("conversation:assigned", updated);
   await emitConversationEvent(updated.id, updated.channel, "conversation:updated", updated);
  res.json(updated);
});

app.get("/api/agents/customer-care-colleagues", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  if (req.user!.role !== Role.AGENT) return res.status(403).json({ error: "التحويل متاح لحسابات الموظفين فقط" });
  const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
  const conversation = conversationId ? await prisma.conversation.findUnique({ where: { id: conversationId }, select: { assignedAgentId: true, channel: true } }) : null;
  if (!conversation || conversation.assignedAgentId !== req.user!.id) return res.status(404).json({ error: "المحادثة غير موجودة أو ليست مسندة إليك" });
  if (conversation.channel !== Channel.MESSENGER && req.user!.department !== Department.CUSTOMER_CARE) return res.status(403).json({ error: "التحويل متاح لموظفي خدمة العملاء لهذه القناة فقط" });
  if (!canReplyChannel(req.user!, conversation.channel) || !await isConnectedFullAgent(req.user!.id, conversation.channel)) return res.status(409).json({ error: "يلزم اتصال نشط وصلاحية كاملة بالقناة لتحويل المحادثة" });
  const colleagues = await prisma.user.findMany({
    where: { id: { not: req.user!.id }, role: Role.AGENT, ...(conversation.channel === Channel.MESSENGER ? {} : { department: Department.CUSTOMER_CARE }), isActive: true, presence: Presence.ONLINE, ...await channelRecipientWhere(conversation.channel) },
    select: { id: true, name: true, presence: true, department: true }, orderBy: { name: "asc" }
  });
  const connected = await connectedUserIds(colleagues.map((colleague) => colleague.id));
  res.json(colleagues.filter((colleague) => connected.has(colleague.id)));
});

app.get("/api/agents/handoff-requests", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  if (req.user!.role !== Role.AGENT) return res.status(403).json({ error: "طلبات التحويل متاحة لحسابات الموظفين فقط" });
  const requests = await prisma.conversationHandoffRequest.findMany({
    where: { toAgentId: req.user!.id, status: ConversationHandoffStatus.PENDING },
    include: { fromAgent: { select: { id: true, name: true } }, conversation: { include: { customer: { select: { name: true, displayName: true } } } } },
    orderBy: { createdAt: "desc" }
  });
  res.json(requests.filter((request) => canRespondToHandoff(req.user!, request, request.conversation.channel)));
});

app.post("/api/conversations/:id/handoff", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  if (req.user!.role !== Role.AGENT) return res.status(403).json({ error: "التحويل متاح لحسابات الموظفين فقط" });
  const parsed = z.object({ agentId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اختر موظفًا مؤهلًا" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "لا تملك صلاحية تحويل هذه المحادثة" });
  if (conversation.assignedAgentId !== req.user!.id) return res.status(403).json({ error: "يمكنك تحويل المحادثات المسندة إليك فقط" });
  if (conversation.channel !== Channel.MESSENGER && req.user!.department !== Department.CUSTOMER_CARE) return res.status(403).json({ error: "التحويل متاح لموظفي خدمة العملاء لهذه القناة فقط" });
  if (!await isConnectedFullAgent(req.user!.id, conversation.channel)) return res.status(409).json({ error: "يلزم اتصال نشط وصلاحية كاملة بالقناة لتحويل المحادثة" });
  if (conversation.status !== ConversationStatus.OPEN && conversation.status !== ConversationStatus.PENDING) return res.status(409).json({ error: "لا يمكن تحويل محادثة مغلقة أو منتهية" });
  const colleague = await prisma.user.findFirst({
    where: { id: { equals: parsed.data.agentId, not: req.user!.id }, role: Role.AGENT, ...(conversation.channel === Channel.MESSENGER ? {} : { department: Department.CUSTOMER_CARE }), isActive: true, presence: Presence.ONLINE, ...await channelRecipientWhere(conversation.channel) },
    select: { id: true, name: true }
  });
  if (!colleague || !await isUserConnected(colleague.id)) return res.status(409).json({ error: "الزميل المحدد لم يعد متصلًا أو مؤهلًا لهذه القناة" });
  const existing = await prisma.conversationHandoffRequest.findUnique({ where: { conversationId: conversation.id } });
  if (existing?.status === ConversationHandoffStatus.PENDING) return res.status(409).json({ error: "يوجد طلب تحويل بانتظار رد الزميل" });
  const handoffData = { fromAgentId: req.user!.id, toAgentId: colleague.id, status: ConversationHandoffStatus.PENDING, createdAt: new Date(), resolvedAt: null };
  let handoff;
  try {
    if (existing) {
      const changed = await prisma.conversationHandoffRequest.updateMany({ where: { id: existing.id, status: existing.status }, data: handoffData });
      if (!changed.count) return res.status(409).json({ error: "تغيّر طلب التحويل. حدّث الصفحة وحاول مجددًا" });
      handoff = await prisma.conversationHandoffRequest.findUniqueOrThrow({ where: { id: existing.id } });
    } else handoff = await prisma.conversationHandoffRequest.create({ data: { conversationId: conversation.id, ...handoffData } });
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: "يوجد طلب تحويل بانتظار رد الزميل" });
    throw error;
  }
  const request = await prisma.conversationHandoffRequest.findUniqueOrThrow({ where: { id: handoff.id }, include: { fromAgent: { select: { id: true, name: true } }, toAgent: { select: { id: true, name: true } }, conversation: { include: { customer: { select: { name: true, displayName: true } } } } } });
  await audit(req.user!.id, "CONVERSATION_HANDOFF_REQUESTED", conversation.id, { from: req.user!.id, to: colleague.id });
  io.to(`agent:${colleague.id}`).emit("conversation:handoff-requested", request);
   await emitConversationEvent(conversation.id, conversation.channel, "handoff:updated", { conversationId: conversation.id }, { audience: "managers" });
  const customerName = request.conversation.customer.displayName || request.conversation.customer.name || "عميل";
  void sendPushNotification([colleague.id], { title: "طلب استلام محادثة", body: `يريد ${req.user!.name} تحويل محادثة ${customerName} إليك. اقبل الطلب أو ارفضه من مساحة العمل.`, url: "/agent/workspace", tag: `handoff-${conversation.id}` }).catch((error) => console.warn("Handoff request push notification failed", error));
  res.status(202).json({ ...request, status: ConversationHandoffStatus.PENDING });
});

app.post("/api/conversations/:id/handoff-response", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ decision: z.enum(["ACCEPT", "DECLINE"]) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اختر قبول الطلب أو رفضه" });
  const request = await prisma.conversationHandoffRequest.findUnique({ where: { conversationId: req.params.id }, include: { fromAgent: { select: { id: true, name: true } }, conversation: { include: { customer: true } } } });
  if (!request || request.status !== ConversationHandoffStatus.PENDING) return res.status(409).json({ error: "طلب التحويل لم يعد متاحًا" });
  if (!canRespondToHandoff(req.user!, request, request.conversation.channel)) return res.status(403).json({ error: "طلب التحويل متاح للموظف المحدد فقط" });

  if (parsed.data.decision === "DECLINE") {
    const declined = await prisma.conversationHandoffRequest.updateMany({ where: { id: request.id, toAgentId: req.user!.id, status: ConversationHandoffStatus.PENDING }, data: { status: ConversationHandoffStatus.DECLINED, resolvedAt: new Date() } });
    if (!declined.count) return res.status(409).json({ error: "تمت معالجة طلب التحويل بالفعل" });
    await audit(req.user!.id, "CONVERSATION_HANDOFF_DECLINED", request.conversationId, { from: request.fromAgentId, to: request.toAgentId });
    const event = { conversationId: request.conversationId, decision: "DECLINED", agentName: req.user!.name };
    io.to(`agent:${request.fromAgentId}`).emit("conversation:handoff-declined", event);
   await emitConversationEvent(request.conversationId, request.conversation.channel, "handoff:updated", event, { audience: "managers" });
     void sendPushNotification([request.fromAgentId], { title: "رُفض طلب تحويل المحادثة", body: `رفض ${req.user!.name} استلام محادثة ${request.conversation.customer.displayName || request.conversation.customer.name || "العميل"}؛ بقيت لديك ويمكنك تحويلها لزميل آخر.`, url: "/agent/workspace", tag: `handoff-declined-${request.conversationId}` }).catch((error) => console.warn("Handoff decline push notification failed", error));
    return res.json({ status: ConversationHandoffStatus.DECLINED, conversationId: request.conversationId });
  }

  const eligibleRecipient = await prisma.user.findFirst({
    where: { id: req.user!.id, role: Role.AGENT, ...(request.conversation.channel === Channel.MESSENGER ? {} : { department: Department.CUSTOMER_CARE }), isActive: true, presence: Presence.ONLINE, ...await channelRecipientWhere(request.conversation.channel) },
    select: { id: true }
  });
  if (!eligibleRecipient || !await isUserConnected(req.user!.id)) return res.status(409).json({ error: "لم تعد متصلًا أو مؤهلًا لاستقبال محادثات هذه القناة" });

  let updated;
  try {
    updated = await withConversationAssignmentLock(request.conversationId, () => prisma.$transaction(async (transaction) => {
      const accepted = await transaction.conversationHandoffRequest.updateMany({ where: { id: request.id, toAgentId: req.user!.id, status: ConversationHandoffStatus.PENDING }, data: { status: ConversationHandoffStatus.ACCEPTED, resolvedAt: new Date() } });
      if (!accepted.count) throw new Error("HANDOFF_ALREADY_RESOLVED");
      const moved = await transaction.conversation.updateMany({ where: { id: request.conversationId, assignedAgentId: request.fromAgentId, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } }, data: { assignedAgentId: request.toAgentId, status: ConversationStatus.OPEN, awaitingRouting: false } });
      if (!moved.count) throw new Error("HANDOFF_CONVERSATION_CHANGED");
      await transaction.conversationAssignment.createMany({ data: [request.fromAgentId, request.toAgentId].map((agentId) => ({ conversationId: request.conversationId, agentId })), skipDuplicates: true });
      return transaction.conversation.findUniqueOrThrow({ where: { id: request.conversationId }, include: { customer: true, assignedAgent: { select: { id: true, name: true } } } });
    }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("HANDOFF_")) return res.status(409).json({ error: "تغيّر إسناد المحادثة. حدّث الصفحة وحاول مجددًا" });
    throw error;
  }
  await audit(req.user!.id, "CONVERSATION_HANDOFF_ACCEPTED", request.conversationId, { from: request.fromAgentId, to: request.toAgentId });
  const inbound = await prisma.message.findFirst({ where: { conversationId: request.conversationId, direction: MessageDirection.INBOUND }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
  if (inbound) await scheduleUnansweredReassignment(request.conversationId, inbound.id, request.toAgentId);
  io.to(`agent:${request.fromAgentId}`).emit("conversation:unassigned", updated);
  io.to(`agent:${request.toAgentId}`).emit("conversation:assigned", updated);
   await emitConversationEvent(updated.id, updated.channel, "conversation:updated", updated);
   await emitConversationEvent(updated.id, updated.channel, "handoff:updated", { conversationId: request.conversationId, decision: "ACCEPTED" }, { audience: "managers" });
  void sendPushNotification([request.fromAgentId], { title: "تم قبول طلب التحويل", body: `قبل ${req.user!.name} استلام المحادثة؛ لم تعد مسندة إليك.`, url: "/agent/workspace", tag: `handoff-accepted-${request.conversationId}` }).catch((error) => console.warn("Handoff acceptance push notification failed", error));
  res.json(updated);
});

app.patch("/api/conversations/:id/status", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ status: z.nativeEnum(ConversationStatus) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "الحالة غير صالحة" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, include: { customer: { select: { isBlocked: true } } } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "لا تملك صلاحية تعديل المحادثة" });
  if (terminalStatuses.includes(parsed.data.status)) {
    const pendingRequest = await prisma.conversationHandoffRequest.findUnique({ where: { conversationId: conversation.id } });
    if (pendingRequest?.status === ConversationHandoffStatus.PENDING) {
      const cancelled = await prisma.conversationHandoffRequest.updateMany({ where: { id: pendingRequest.id, status: ConversationHandoffStatus.PENDING }, data: { status: ConversationHandoffStatus.CANCELLED, resolvedAt: new Date() } });
      if (cancelled.count) {
        await audit(req.user!.id, "CONVERSATION_HANDOFF_CANCELLED", conversation.id, { from: pendingRequest.fromAgentId, to: pendingRequest.toAgentId, reason: "CONVERSATION_CLOSED" });
        io.to(`agent:${pendingRequest.toAgentId}`).emit("conversation:handoff-cancelled", { conversationId: conversation.id });
         await emitConversationEvent(conversation.id, conversation.channel, "handoff:updated", { conversationId: conversation.id, decision: "CANCELLED" }, { audience: "managers" });
      }
    }
  }
  const updated = await prisma.conversation.update({ where: { id: conversation.id }, data: { status: parsed.data.status, closedAt: terminalStatuses.includes(parsed.data.status) ? new Date() : null } });
  await audit(req.user!.id, parsed.data.status === ConversationStatus.CLOSED ? "CONVERSATION_CLOSED" : "CONVERSATION_STATUS_CHANGED", conversation.id, { status: parsed.data.status });
   await emitConversationEvent(conversation.id, conversation.channel, "conversation:updated", updated);
  let csatDelivery: "sent" | "already-requested" | "failed" | "not-requested" = "not-requested";
  if (parsed.data.status === ConversationStatus.RESOLVED && !conversation.customer.isBlocked) {
    const existingSurvey = await prisma.csatSurvey.findUnique({ where: { conversationId: conversation.id } });
    if (existingSurvey) csatDelivery = "already-requested";
    else {
      try {
        const receivedAt = await lastInboundAt(conversation.id, conversation.lastInboundAt);
         const result: any = await sendCsatPrompt(conversation.channel, channelRecipient(conversation.channel, conversation.externalConversationId, conversation.externalCustomerId), !messengerWindowOpen(conversation.channel, receivedAt));
        const providerId = kalemlyExternalMessageId(result);
        const survey = await prisma.csatSurvey.create({ data: { conversationId: conversation.id, agentId: conversation.assignedAgentId || (req.user!.role === Role.AGENT || req.user!.role === Role.BRANCH_USER ? req.user!.id : null) } });
        const message = await prisma.message.create({ data: { conversationId: conversation.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.TEXT,
          text: "شكرًا لاختيارك حلواني بندق. كيف تقيّم خدمتنا؟ أرسل رقمًا من 1 إلى 5، حيث 5 ممتاز و1 يحتاج إلى تحسين.",
          externalId: providerId ? `${conversation.channel}:${providerId}` : undefined, metadata: { automation: "csat-survey", surveyId: survey.id } } });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: message.createdAt } });
         await emitConversationEvent(conversation.id, conversation.channel, "message:new", { conversationId: conversation.id, message });
        csatDelivery = "sent";
      } catch (error) {
        console.error("CSAT survey delivery failed", error);
        await audit(req.user!.id, "CSAT_DELIVERY_FAILED", conversation.id, { reason: error instanceof Error ? error.message : "unknown" });
         await emitConversationEvent(conversation.id, conversation.channel, "csat:delivery-failed", { conversationId: conversation.id }, { audience: "managers" });
        csatDelivery = "failed";
      }
    }
  }
  res.json({ ...updated, csatDelivery });
});

app.get("/api/conversations/:id/messages/:messageId/media", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const message = await prisma.message.findFirst({ where: { id: req.params.messageId, conversationId: req.params.id }, include: { conversation: true } });
  if (!message) return res.status(404).json({ error: "الملف غير موجود" });
  if (!await canReadConversationOrHistory(req.user!, message.conversation)) return res.status(403).json({ error: "لا تملك صلاحية عرض هذا الملف" });
  const personalState = await prisma.conversationPreference.findUnique({ where: { userId_conversationId: { userId: req.user!.id, conversationId: message.conversationId } }, select: { isDeleted: true, clearedAt: true } });
  if (personalState?.isDeleted || personalState?.clearedAt && message.createdAt <= personalState.clearedAt) return res.status(404).json({ error: "الملف غير موجود في سجلّك الشخصي" });
  try {
    if (message.mediaAssetId) {
      const asset = await prisma.mediaAsset.findUnique({ where: { id: message.mediaAssetId }, select: { data: true, contentType: true, fileName: true, size: true } });
      if (!asset) return res.status(404).json({ error: "الملف غير موجود" });
      const disposition = message.kind === MessageKind.FILE ? "attachment" : "inline";
      return res.set({ "Content-Type": asset.contentType, "Content-Length": String(asset.size), "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" }).send(Buffer.from(asset.data));
    }
    const media = await fetchInboundMedia(message.conversation.channel, (message.metadata || {}) as unknown as Record<string, unknown>, message.mediaUrl || undefined);
    res.setHeader("Content-Type", media.contentType); res.setHeader("Cache-Control", "private, max-age=300"); res.setHeader("X-Content-Type-Options", "nosniff"); res.send(media.body);
  } catch { res.status(404).json({ error: "تعذر تحميل الملف من المنصة" }); }
});

app.put("/api/conversations/:id/messages/:messageId/reaction", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ emoji: z.string().trim().min(1).max(16) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اختر تفاعلًا صالحًا" });
  const message = await prisma.message.findFirst({ where: { id: req.params.messageId, conversationId: req.params.id }, include: { conversation: true } });
  if (!message) return res.status(404).json({ error: "الرسالة غير موجودة" });
  if (!canWorkOnConversation(req.user!, message.conversation)) return res.status(403).json({ error: "لا تملك صلاحية التفاعل مع هذه الرسالة" });
  let providerSynced = false;
  try {
    if (message.externalId) providerSynced = await reactToProviderMessage({ channel: message.conversation.channel, recipient: channelRecipient(message.conversation.channel, message.conversation.externalConversationId, message.conversation.externalCustomerId), externalId: message.externalId, direction: message.direction === MessageDirection.OUTBOUND ? "OUTBOUND" : "INBOUND", emoji: parsed.data.emoji });
  } catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : "تعذر مزامنة التفاعل مع القناة" }); }
  const reaction = await prisma.messageReaction.upsert({
    where: { messageId_userId: { messageId: message.id, userId: req.user!.id } },
    create: { messageId: message.id, userId: req.user!.id, emoji: parsed.data.emoji },
    update: { emoji: parsed.data.emoji }, include: { user: { select: { id: true, name: true } } }
  });
   await emitConversationEvent(message.conversationId, message.conversation.channel, "message:reaction", { conversationId: message.conversationId, messageId: message.id, reaction });
  res.json({ ...reaction, providerSynced });
});

app.delete("/api/conversations/:id/messages/:messageId/reaction", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const message = await prisma.message.findFirst({ where: { id: req.params.messageId, conversationId: req.params.id }, include: { conversation: true } });
  if (!message) return res.status(404).json({ error: "الرسالة غير موجودة" });
  if (!canWorkOnConversation(req.user!, message.conversation)) return res.status(403).json({ error: "لا تملك صلاحية تعديل التفاعل" });
  const existing = await prisma.messageReaction.findUnique({ where: { messageId_userId: { messageId: message.id, userId: req.user!.id } } });
  let providerSynced = false;
  try {
    if (existing && message.externalId) providerSynced = await reactToProviderMessage({ channel: message.conversation.channel, recipient: channelRecipient(message.conversation.channel, message.conversation.externalConversationId, message.conversation.externalCustomerId), externalId: message.externalId, direction: message.direction === MessageDirection.OUTBOUND ? "OUTBOUND" : "INBOUND", emoji: "" });
  } catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : "تعذر إزالة التفاعل من القناة" }); }
  await prisma.messageReaction.deleteMany({ where: { messageId: message.id, userId: req.user!.id } });
   await emitConversationEvent(message.conversationId, message.conversation.channel, "message:reaction-removed", { conversationId: message.conversationId, messageId: message.id, userId: req.user!.id });
  res.json({ providerSynced });
});

app.post("/api/conversations/:id/orders", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ product: z.string().optional(), size: z.string().optional(), filling: z.string().optional(), cakeMessage: z.string().optional(), deliveryAt: z.string().datetime().optional(), deliveryAddress: z.string().optional(), notes: z.string().optional(), price: z.number().nonnegative().optional(), deposit: z.number().nonnegative().default(0) }).superRefine((value, context) => {
    if (value.deposit > 0 && value.price === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["price"], message: "أدخل إجمالي السعر قبل العربون" });
    if (value.price !== undefined && value.deposit > value.price) context.addIssue({ code: z.ZodIssueCode.custom, path: ["deposit"], message: "العربون لا يمكن أن يتجاوز إجمالي السعر" });
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "تفاصيل الطلب غير صالحة" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "لا تملك صلاحية لهذا الطلب" });
  const { price, deposit, ...fields } = parsed.data;
  const order = await prisma.orderDetails.create({ data: { ...fields, ...(price === undefined ? {} : { price: new Prisma.Decimal(price) }), deposit: new Prisma.Decimal(deposit), deliveryAt: parsed.data.deliveryAt ? new Date(parsed.data.deliveryAt) : undefined, customerId: conversation.customerId, conversationId: conversation.id } });
  await audit(req.user!.id, "ORDER_CREATED", conversation.id, { orderId: order.id });
  res.status(201).json(order);
});

app.patch("/api/orders/:id/status", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ status: z.nativeEnum(OrderStatus) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "حالة الطلب غير صالحة" });
  const existing = await prisma.orderDetails.findUnique({ where: { id: req.params.id }, include: { conversation: { include: { customer: { select: { isBlocked: true } } } } } });
  if (!existing) return res.status(404).json({ error: "الطلب غير موجود" });
  if (existing.conversation && !canWorkOnConversation(req.user!, existing.conversation)) return res.status(403).json({ error: "لا تملك صلاحية تعديل هذا الطلب" });
  const order = await prisma.orderDetails.update({ where: { id: existing.id }, data: { status: parsed.data.status } });
  await audit(req.user!.id, "ORDER_STATUS_CHANGED", existing.conversationId || undefined, { orderId: order.id, status: order.status });
  let notificationDelivery: "sent" | "not-sent" | "not-applicable" = "not-applicable";
  if (existing.status !== order.status && existing.conversation?.customer.isBlocked) {
    notificationDelivery = "not-sent";
  } else if (existing.status !== order.status && existing.conversation) {
    const receivedAt = await lastInboundAt(existing.conversation.id, existing.conversation.lastInboundAt);
    if (messengerWindowOpen(existing.conversation.channel, receivedAt)) {
      const statusText: Record<OrderStatus, string> = {
        DRAFT: "تم استلام طلبك وهو قيد المراجعة.", CONFIRMED: "تم تأكيد طلبك من حلواني بندق.",
        PREPARING: "بدأنا تجهيز طلبك بكل عناية.", OUT_FOR_DELIVERY: "طلبك خرج للتوصيل إليك.",
        DELIVERED: "تم تسليم طلبك. شكرًا لاختيارك حلواني بندق.", CANCELLED: "تم إلغاء طلبك. تواصل معنا إذا احتجت إلى مساعدة.", COMPLETED: "تم تسليم طلبك. شكرًا لاختيارك حلواني بندق."
      };
      try {
        const text = `${statusText[order.status]}\nرقم الطلب: ${order.id}`;
         const result: any = await sendToChannel({ channel: existing.conversation.channel, recipient: channelRecipient(existing.conversation.channel, existing.conversation.externalConversationId, existing.conversation.externalCustomerId), text });
        const providerId = kalemlyExternalMessageId(result);
        const notification = await prisma.message.create({ data: {
          conversationId: existing.conversation.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.TEXT, text,
          externalId: providerId ? `${existing.conversation.channel}:${providerId}` : undefined, metadata: { automation: "order-status", orderId: order.id, status: order.status }
        } });
        await prisma.conversation.update({ where: { id: existing.conversation.id }, data: { lastMessageAt: notification.createdAt } });
         await emitConversationEvent(existing.conversation.id, existing.conversation.channel, "message:new", { conversationId: existing.conversation.id, message: notification });
        notificationDelivery = "sent";
      } catch (error) {
        notificationDelivery = "not-sent";
        console.error("Order status notification failed", error);
      }
    } else notificationDelivery = "not-sent";
  }
  res.json({ ...order, notificationDelivery });
});

app.patch("/api/agents/me/presence", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ presence: z.nativeEnum(Presence) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "الحالة غير صالحة" });
  const userId = req.user!.id;
  const previous = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { presence: true } });
  const presence = parsed.data.presence;
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { presence, lastSeenAt: new Date() } });
    if (presence === Presence.ONLINE && previous.presence !== Presence.ONLINE) await tx.agentSession.create({ data: { userId, startState: presence } });
    if (presence === Presence.OFFLINE && previous.presence !== Presence.OFFLINE) await tx.agentSession.updateMany({ where: { userId, endedAt: null }, data: { endedAt: new Date(), endState: presence } });
    await tx.auditLog.create({ data: { actorId: userId, action: "PRESENCE_CHANGED", details: { from: previous.presence, to: presence } } });
  });
  broadcastPresence(userId, presence, req.user!.department);
  if (presence === Presence.ONLINE) await dispatchQueued();
  if (presence === Presence.OFFLINE) await releaseAgentConversations(userId);
  res.json({ presence });
});

app.post("/api/agents/me/connection-ready", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  if (req.user!.role !== Role.AGENT && req.user!.role !== Role.BRANCH_USER) return res.status(403).json({ error: "هذه العملية متاحة لحسابات الموظفين فقط" });
  const parsed = z.object({ presence: z.nativeEnum(Presence) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "حالة الاتصال غير صالحة" });
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { isActive: true, presence: true } });
  if (!user?.isActive) return res.status(401).json({ error: "الحساب غير نشط" });
  if (parsed.data.presence === Presence.ONLINE && user.presence === Presence.OFFLINE) {
    const now = new Date();
    await prisma.$transaction([
      prisma.user.update({ where: { id: req.user!.id }, data: { presence: Presence.ONLINE, lastSeenAt: now } }),
      prisma.agentSession.create({ data: { userId: req.user!.id, startState: Presence.ONLINE } }),
      prisma.auditLog.create({ data: { actorId: req.user!.id, action: "AGENT_RECONNECTED" } })
    ]);
    broadcastPresence(req.user!.id, Presence.ONLINE, req.user!.department);
    await dispatchQueued();
    return res.json({ presence: Presence.ONLINE });
  }
  if (user.presence === Presence.ONLINE) {
    await prisma.user.update({ where: { id: req.user!.id }, data: { lastSeenAt: new Date() } });
    broadcastPresence(req.user!.id, Presence.ONLINE, req.user!.department);
    await dispatchQueued();
  }
  res.json({ presence: user.presence });
});

app.get("/api/canned-responses", agentGuard, async (_req: express.Request, res: express.Response) => res.json(await prisma.cannedResponse.findMany({ where: { isActive: true }, orderBy: { title: "asc" } })));
app.get("/api/admin/canned-responses", permissionGuard("canManageCatalog"), async (_req: express.Request, res: express.Response) => res.json(await prisma.cannedResponse.findMany({ orderBy: { title: "asc" } })));
app.post("/api/admin/canned-responses", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ shortcut: z.string().trim().min(2).max(40).regex(/^\/[\p{L}\p{N}_-]+$/u), title: z.string().trim().min(2).max(80), content: z.string().trim().min(1).max(2000), isActive: z.boolean().default(true) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "راجع الاختصار والعنوان ونص الرد" });
  try {
    const response = await prisma.cannedResponse.create({ data: parsed.data });
    await audit(req.user!.id, "CANNED_RESPONSE_CREATED", undefined, { responseId: response.id });
    io.emit("canned:updated");
    res.status(201).json(response);
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: "الاختصار مستخدم بالفعل" });
    throw error;
  }
});
app.patch("/api/admin/canned-responses/:id", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ shortcut: z.string().trim().min(2).max(40).regex(/^\/[\p{L}\p{N}_-]+$/u).optional(), title: z.string().trim().min(2).max(80).optional(), content: z.string().trim().min(1).max(2000).optional(), isActive: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "بيانات الرد الجاهز غير صالحة" });
  try {
    const response = await prisma.cannedResponse.update({ where: { id: req.params.id }, data: parsed.data });
    await audit(req.user!.id, "CANNED_RESPONSE_UPDATED", undefined, { responseId: response.id });
    io.emit("canned:updated");
    res.json(response);
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: "الاختصار مستخدم بالفعل" });
    throw error;
  }
});
app.delete("/api/admin/canned-responses/:id", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  await prisma.cannedResponse.delete({ where: { id: req.params.id } });
  await audit(req.user!.id, "CANNED_RESPONSE_DELETED", undefined, { responseId: req.params.id });
  io.emit("canned:updated");
  res.sendStatus(204);
});

app.post("/api/agent/quick-replies/media", agentGuard, express.raw({ type: () => true, limit: uploadLimitBytes }), async (req: AuthedRequest, res: express.Response) => {
  try { publicMediaUrl("configuration-check", 3600); }
  catch { return res.status(503).json({ error: "لم يتم إعداد رابط آمن لاستقبال الوسائط" }); }
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "اختر ملفًا صالحًا" });
  const contentType = String(req.header("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!allowedMediaTypes.has(contentType)) return res.status(415).json({ error: "نوع الملف غير مدعوم" });
  if (!imageSignatureMatches(contentType, req.body)) return res.status(415).json({ error: "محتوى الصورة لا يطابق نوع الملف" });
  let fileName: string;
  try { fileName = safeFileName(decodeURIComponent(req.header("x-file-name") || "quick-reply-attachment")); }
  catch { return res.status(400).json({ error: "اسم الملف غير صالح" }); }
  const asset = await prisma.mediaAsset.create({ data: { fileName, contentType, size: req.body.length, data: Uint8Array.from(req.body), createdById: req.user!.id }, select: { id: true, fileName: true, contentType: true, size: true } });
  res.status(201).json(asset);
});

async function deleteUnusedQuickReplyMedia(mediaAssetId: string, userId: string) {
  await prisma.mediaAsset.deleteMany({ where: { id: mediaAssetId, createdById: userId, messages: { none: {} }, products: { none: {} }, quickReplies: { none: {} } } });
}

app.delete("/api/agent/quick-replies/media/:id", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const removed = await prisma.mediaAsset.deleteMany({ where: { id: req.params.id, createdById: req.user!.id, messages: { none: {} }, products: { none: {} }, quickReplies: { none: {} } } });
  if (!removed.count) return res.status(404).json({ error: "الملف غير موجود أو مستخدم بالفعل" });
  res.sendStatus(204);
});

const quickReplyInclude = { mediaAsset: { select: { id: true, fileName: true, contentType: true, size: true } }, tags: { include: { tag: true } } } satisfies Prisma.AgentQuickReplyInclude;

app.get("/api/agent/quick-replies", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  res.json(await prisma.agentQuickReply.findMany({ where: { userId: req.user!.id }, include: quickReplyInclude, orderBy: { title: "asc" } }));
});
app.post("/api/agent/quick-replies", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ shortcut: z.string().trim().min(2).max(40).regex(/^\/[\p{L}\p{N}_-]+$/u), title: z.string().trim().min(2).max(80).optional(), content: z.string().trim().max(2000).default(""), mediaAssetId: z.string().min(1).nullable().optional(), tagIds: z.array(z.string().min(1)).max(30).default([]) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "راجع الاختصار ونص الرد السريع" });
  const { tagIds, mediaAssetId, ...replyData } = parsed.data;
  if (!replyData.content && !mediaAssetId) return res.status(400).json({ error: "اكتب نص الرسالة أو أرفق ملفًا" });
  if (new Set(tagIds).size !== tagIds.length || tagIds.length && await prisma.customerTag.count({ where: { id: { in: tagIds } } }) !== tagIds.length) return res.status(400).json({ error: "قوائم العميل المحددة غير صالحة" });
  if (mediaAssetId && !await prisma.mediaAsset.findFirst({ where: { id: mediaAssetId, createdById: req.user!.id }, select: { id: true } })) return res.status(400).json({ error: "المرفق غير صالح" });
  try {
    const reply = await prisma.agentQuickReply.create({ data: { ...replyData, title: replyData.title || parsed.data.shortcut.slice(1) || parsed.data.content.slice(0, 80), mediaAssetId: mediaAssetId || null, userId: req.user!.id, tags: { create: tagIds.map((tagId) => ({ tagId })) } }, include: quickReplyInclude });
    await audit(req.user!.id, "AGENT_QUICK_REPLY_CREATED", undefined, { replyId: reply.id });
    io.to(`user:${req.user!.id}`).emit("agent:quick-replies-updated");
    res.status(201).json(reply);
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: "الاختصار مستخدم في ردودك الشخصية بالفعل" });
    throw error;
  }
});
app.patch("/api/agent/quick-replies/:id", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ shortcut: z.string().trim().min(2).max(40).regex(/^\/[\p{L}\p{N}_-]+$/u).optional(), title: z.string().trim().min(2).max(80).optional(), content: z.string().trim().max(2000).optional(), mediaAssetId: z.string().min(1).nullable().optional(), tagIds: z.array(z.string().min(1)).max(30).optional() }).strict().refine((value) => Object.keys(value).length > 0).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "بيانات الرد السريع غير صالحة" });
  const { tagIds, mediaAssetId, ...replyData } = parsed.data;
  if (tagIds && (new Set(tagIds).size !== tagIds.length || await prisma.customerTag.count({ where: { id: { in: tagIds } } }) !== tagIds.length)) return res.status(400).json({ error: "قوائم العميل المحددة غير صالحة" });
  if (mediaAssetId && !await prisma.mediaAsset.findFirst({ where: { id: mediaAssetId, createdById: req.user!.id }, select: { id: true } })) return res.status(400).json({ error: "المرفق غير صالح" });
  const previous = await prisma.agentQuickReply.findFirst({ where: { id: req.params.id, userId: req.user!.id }, select: { id: true, mediaAssetId: true } });
  if (!previous) return res.status(404).json({ error: "الرد الشخصي غير موجود" });
  const effectiveMediaAssetId = mediaAssetId !== undefined ? mediaAssetId : previous.mediaAssetId;
  if (parsed.data.content !== undefined && !parsed.data.content && !effectiveMediaAssetId) return res.status(400).json({ error: "اكتب نص الرسالة أو أرفق ملفًا" });
  try {
    const reply = await prisma.$transaction(async (tx) => {
      if (tagIds) {
        await tx.agentQuickReplyTag.deleteMany({ where: { quickReplyId: previous.id } });
        if (tagIds.length) await tx.agentQuickReplyTag.createMany({ data: tagIds.map((tagId) => ({ quickReplyId: previous.id, tagId })) });
      }
      return tx.agentQuickReply.update({ where: { id: previous.id, userId: req.user!.id }, data: { ...replyData, ...(mediaAssetId !== undefined ? { mediaAssetId } : {}) }, include: quickReplyInclude });
    });
    if (previous.mediaAssetId && mediaAssetId !== undefined && previous.mediaAssetId !== mediaAssetId) await deleteUnusedQuickReplyMedia(previous.mediaAssetId, req.user!.id);
    await audit(req.user!.id, "AGENT_QUICK_REPLY_UPDATED", undefined, { replyId: reply.id });
    io.to(`user:${req.user!.id}`).emit("agent:quick-replies-updated");
    res.json(reply);
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: "الاختصار مستخدم في ردودك الشخصية بالفعل" });
    throw error;
  }
});
app.delete("/api/agent/quick-replies/:id", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const reply = await prisma.agentQuickReply.findFirst({ where: { id: req.params.id, userId: req.user!.id }, select: { id: true, mediaAssetId: true } });
  if (!reply) return res.status(404).json({ error: "الرد الشخصي غير موجود" });
  await prisma.agentQuickReply.delete({ where: { id: reply.id } });
  if (reply.mediaAssetId) await deleteUnusedQuickReplyMedia(reply.mediaAssetId, req.user!.id);
  await audit(req.user!.id, "AGENT_QUICK_REPLY_DELETED", undefined, { replyId: req.params.id });
  io.to(`user:${req.user!.id}`).emit("agent:quick-replies-updated");
  res.sendStatus(204);
});

app.get("/api/admin/auto-replies", permissionGuard("canManageCatalog"), async (_req: express.Request, res: express.Response) => res.json(await prisma.autoReplyRule.findMany({ orderBy: [{ isWelcome: "desc" }, { priority: "desc" }, { createdAt: "asc" }] })));
app.post("/api/admin/auto-replies", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(80), keywords: z.array(z.string().trim().min(1).max(80)).max(20), responseText: z.string().trim().min(1).max(2000), routingDepartment: z.nativeEnum(Department).nullable().optional(), isActive: z.boolean().default(true), isWelcome: z.boolean().default(false), priority: z.number().int().min(0).max(100).default(0) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "راجع اسم القاعدة والكلمات المفتاحية ونص الرد" });
  const rule = await prisma.autoReplyRule.create({ data: parsed.data });
  await audit(req.user!.id, "AUTO_REPLY_CREATED", undefined, { ruleId: rule.id });
  res.status(201).json(rule);
});
app.patch("/api/admin/auto-replies/:id", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(80).optional(), keywords: z.array(z.string().trim().min(1).max(80)).max(20).optional(), responseText: z.string().trim().min(1).max(2000).optional(), routingDepartment: z.nativeEnum(Department).nullable().optional(), isActive: z.boolean().optional(), priority: z.number().int().min(0).max(100).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "بيانات قاعدة الرد التلقائي غير صالحة" });
  const rule = await prisma.autoReplyRule.update({ where: { id: req.params.id }, data: parsed.data });
  await audit(req.user!.id, "AUTO_REPLY_UPDATED", undefined, { ruleId: rule.id });
  res.json(rule);
});
app.delete("/api/admin/auto-replies/:id", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const rule = await prisma.autoReplyRule.findUnique({ where: { id: req.params.id } });
  if (!rule) return res.sendStatus(404);
  if (rule.isWelcome) return res.status(409).json({ error: "رسالة الترحيب لا تُحذف؛ عدّلها أو أوقفها" });
  await prisma.autoReplyRule.delete({ where: { id: rule.id } });
  await audit(req.user!.id, "AUTO_REPLY_DELETED", undefined, { ruleId: rule.id });
  res.sendStatus(204);
});

const chatbotSettingsSchema = z.object({
  enabled: z.boolean(), welcomeText: z.string().trim().min(1).max(1000), agentHandoffGreeting: z.string().trim().min(1).max(1000), invalidChoiceText: z.string().trim().min(1).max(1000),
  option1Label: z.string().trim().min(1).max(100), option2Label: z.string().trim().min(1).max(100), option3Label: z.string().trim().min(1).max(100), option4Label: z.string().trim().min(1).max(100), option5Label: z.string().trim().min(1).max(100),
  option1ReplyText: z.string().trim().min(1).max(3000), option2ReplyText: z.string().trim().min(1).max(1000), option3ReplyText: z.string().trim().min(1).max(1000), option4ReplyText: z.string().trim().min(1).max(1000), option5ReplyText: z.string().trim().min(1).max(1000),
  businessHoursEnabled: z.boolean(), businessDays: z.array(z.enum(["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"])).min(1).max(7),
  businessStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), businessEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  offHoursReplyEnabled: z.boolean(), offHoursReplyText: z.string().trim().min(1).max(1000)
}).strict().refine((settings) => new Set(settings.businessDays).size === settings.businessDays.length, { message: "اختر كل يوم مرة واحدة فقط", path: ["businessDays"] });

app.get("/api/admin/chatbot-settings", permissionGuard("canManageCatalog"), async (_req: express.Request, res: express.Response) => {
  res.json(await getChatbotSettings());
});
app.put("/api/admin/chatbot-settings", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = chatbotSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "تحقق من إعدادات البوت ورسالة استلام الموظف" });
  const settings = await saveChatbotSettings(parsed.data);
  await audit(req.user!.id, "CHATBOT_SETTINGS_UPDATED", undefined, { enabled: settings.enabled });
  io.to("admins").emit("chatbot:settings-updated");
  res.json(settings);
});

const callRecordingSettingsSchema = z.object({ enabled: z.boolean(), aiProcessingEnabled: z.boolean() }).strict();
app.get("/api/admin/call-recordings/settings", permissionGuard("canManageTeam"), async (_req: express.Request, res: express.Response) => {
  const settings = await getCallRecordingSettings();
  res.json({ ...settings, aiProcessingEnabled: false, aiProcessingAvailable: false });
});
app.put("/api/admin/call-recordings/settings", permissionGuard("canManageTeam"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = callRecordingSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "إعداد التسجيل غير صالح" });
  const settings = await prisma.callRecordingSettings.upsert({ where: { id: "default" }, create: { id: "default", enabled: parsed.data.enabled, aiProcessingEnabled: false }, update: { enabled: parsed.data.enabled, aiProcessingEnabled: false } });
  await audit(req.user!.id, "CALL_RECORDING_SETTINGS_UPDATED", undefined, { enabled: settings.enabled, aiProcessingEnabled: false });
  res.json({ ...settings, aiProcessingEnabled: false });
});

app.get("/api/admin/call-recordings", permissionGuard("canViewReports"), async (req: express.Request, res: express.Response) => {
  const take = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const sessions = await prisma.whatsAppCallSession.findMany({
    where: { callLogHiddenAt: null },
    orderBy: { createdAt: "desc" }, take,
    select: {
       id: true, direction: true, status: true, recordingConsentAt: true, recordingDeletedAt: true, createdAt: true, endedAt: true,
      conversation: { select: { id: true, customer: { select: { name: true } } } },
      agent: { select: { name: true } },
       recording: { select: { id: true, durationSeconds: true, transcript: true, summary: true, reviewedAt: true, createdAt: true } }
    }
  });
  res.json(sessions);
});

app.delete("/api/admin/call-recordings/sessions/:id", permissionGuard("canManageTeam"), async (req: AuthedRequest, res: express.Response) => {
  const session = await prisma.whatsAppCallSession.findUnique({ where: { id: req.params.id }, select: { id: true, conversationId: true, callLogHiddenAt: true } });
  if (!session) return res.status(404).json({ error: "جلسة المكالمة غير موجودة" });
  if (!session.callLogHiddenAt) {
    await prisma.whatsAppCallSession.update({ where: { id: session.id }, data: { callLogHiddenAt: new Date() } });
    await audit(req.user!.id, "CALL_SESSION_HIDDEN_FROM_LOG", session.conversationId, { sessionId: session.id });
  }
  res.sendStatus(204);
});

app.patch("/api/admin/call-recordings/:id", permissionGuard("canViewReports"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ transcript: z.string().trim().max(30_000).nullable(), summary: z.string().trim().max(5_000).nullable() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "تحقق من نص التفريغ وملخص المكالمة" });
  const recording = await prisma.callRecording.findUnique({ where: { id: req.params.id }, select: { id: true, session: { select: { conversationId: true } } } });
  if (!recording) return res.status(404).json({ error: "التسجيل غير موجود" });
  const saved = await prisma.callRecording.update({ where: { id: recording.id }, data: { ...parsed.data, reviewedById: req.user!.id, reviewedAt: new Date() } });
  await audit(req.user!.id, "CALL_RECORDING_REVIEWED", recording.session.conversationId, { recordingId: recording.id });
  res.json({ id: saved.id, durationSeconds: saved.durationSeconds, transcript: saved.transcript, summary: saved.summary, reviewedAt: saved.reviewedAt });
});

app.delete("/api/admin/call-recordings/:id", permissionGuard("canManageTeam"), async (req: AuthedRequest, res: express.Response) => {
  const recording = await prisma.callRecording.findUnique({ where: { id: req.params.id }, select: { id: true, sessionId: true, mediaAssetId: true, session: { select: { conversationId: true } } } });
  if (!recording) return res.status(404).json({ error: "التسجيل غير موجود" });
  const deleted = await prisma.$transaction(async (tx) => {
    const result = await tx.callRecording.deleteMany({ where: { id: recording.id } });
    if (!result.count) return false;
    await tx.mediaAsset.delete({ where: { id: recording.mediaAssetId } });
    await tx.whatsAppCallSession.update({ where: { id: recording.sessionId }, data: { recordingDeletedAt: new Date() } });
    return true;
  });
  if (!deleted) return res.status(404).json({ error: "التسجيل غير موجود" });
  await audit(req.user!.id, "CALL_RECORDING_DELETED", recording.session.conversationId, { recordingId: recording.id });
  res.sendStatus(204);
});

app.get("/api/admin/call-recordings/:id/audio", permissionGuard("canViewReports"), async (req: AuthedRequest, res: express.Response) => {
  const recording = await prisma.callRecording.findUnique({ where: { id: req.params.id }, include: { mediaAsset: true, session: { select: { conversationId: true } } } });
  if (!recording) return res.status(404).json({ error: "التسجيل الصوتي غير موجود" });
  await audit(req.user!.id, "CALL_RECORDING_LISTENED", recording.session.conversationId, { recordingId: recording.id });
  res.set({
    "Content-Type": recording.mediaAsset.contentType,
    "Content-Length": String(recording.mediaAsset.size),
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(recording.mediaAsset.fileName)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff"
  }).send(Buffer.from(recording.mediaAsset.data));
});

app.get("/api/push/config", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const pushConfig = getPushConfig();
  const subscriptionCount = pushConfig.configured ? await prisma.pushSubscription.count({ where: { userId: req.user!.id } }) : 0;
  res.json({ ...pushConfig, subscribed: subscriptionCount > 0 });
});
app.post("/api/push/subscriptions", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  if (!getPushConfig().configured) return res.status(503).json({ error: "إشعارات المتصفح لم تُفعّل على الخادم بعد" });
  const parsed = z.object({ endpoint: httpsUrl, keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اشتراك الإشعارات غير صالح" });
  const subscription = await prisma.pushSubscription.upsert({
    where: { endpoint: parsed.data.endpoint },
    update: { userId: req.user!.id, p256dh: parsed.data.keys.p256dh, auth: parsed.data.keys.auth },
    create: { userId: req.user!.id, endpoint: parsed.data.endpoint, p256dh: parsed.data.keys.p256dh, auth: parsed.data.keys.auth }
  });
  res.status(201).json({ id: subscription.id, subscribed: true });
});
app.delete("/api/push/subscriptions", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ endpoint: httpsUrl }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اشتراك الإشعارات غير صالح" });
  await prisma.pushSubscription.deleteMany({ where: { userId: req.user!.id, endpoint: parsed.data.endpoint } });
  res.sendStatus(204);
});

app.get("/api/admin/integrations/kalemlywa", adminGuard, async (_req: express.Request, res: express.Response) => {
  const settings = await getKalemlySettings();
  const integration = await prisma.integrationSetting.findUnique({ where: { id: "kalemlywa" }, select: { whatsappCallReplyText: true } });
  const webhookSecret = config.kalemlyWebhookSecret || settings.appKey;
  res.json({ endpoint: settings.endpoint, authKeyConfigured: Boolean(settings.authKey), appKeyConfigured: Boolean(settings.appKey), qrCodePayload: settings.qrCodePayload, webhookAuthConfigured: Boolean(webhookSecret), webhookUrlToken: webhookSecret ? kalemlyWebhookUrlToken(webhookSecret) : "", whatsappMode: await getWhatsAppMode(), whatsappConnection: getBaileysWhatsAppState(), callReplyText: integration?.whatsappCallReplyText || defaultCallReply });
});

app.put("/api/admin/integrations/kalemlywa", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ authKey: z.string().max(2048).optional(), appKey: z.string().max(2048).optional(), qrCodePayload: z.string().max(12000).optional(), clearQrCode: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "تحقق من authkey وappkey وحمولة QR" });
  const settings = await saveKalemlySettings(parsed.data);
  await audit(req.user!.id, "KALEMLYWA_SETTINGS_UPDATED", undefined, { authKeyConfigured: Boolean(settings.authKey), appKeyConfigured: Boolean(settings.appKey), qrCodeUpdated: parsed.data.qrCodePayload !== undefined || Boolean(parsed.data.clearQrCode) });
  const webhookSecret = config.kalemlyWebhookSecret || settings.appKey;
  res.json({ endpoint: settings.endpoint, authKeyConfigured: Boolean(settings.authKey), appKeyConfigured: Boolean(settings.appKey), qrCodePayload: settings.qrCodePayload, webhookAuthConfigured: Boolean(webhookSecret), webhookUrlToken: webhookSecret ? kalemlyWebhookUrlToken(webhookSecret) : "", whatsappMode: await getWhatsAppMode(), whatsappConnection: getBaileysWhatsAppState(), callReplyText: await getWhatsAppCallReply() });
});

app.put("/api/admin/integrations/whatsapp/mode", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ mode: z.enum(["BAILEYS", "API"]) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اختر وضع اتصال واتساب صالحًا" });
  const result = await setWhatsAppMode(parsed.data.mode as WhatsAppMode);
  await audit(req.user!.id, "WHATSAPP_MODE_UPDATED", undefined, { mode: result.mode });
  res.json(result);
});

app.post("/api/admin/integrations/whatsapp/baileys/start", adminGuard, async (_req: AuthedRequest, res: express.Response) => {
  if (await getWhatsAppMode() !== "BAILEYS") return res.status(409).json({ error: "حوّل الوضع إلى المحرك الداخلي قبل بدء الاتصال" });
  res.json(await startBaileysWhatsApp());
});

app.post("/api/admin/integrations/whatsapp/baileys/restart", adminGuard, async (_req: AuthedRequest, res: express.Response) => {
  if (await getWhatsAppMode() !== "BAILEYS") return res.status(409).json({ error: "حوّل الوضع إلى المحرك الداخلي قبل إعادة الاتصال" });
  res.json(await restartBaileysWhatsApp());
});

app.post("/api/admin/integrations/whatsapp/baileys/logout", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  if (await getWhatsAppMode() !== "BAILEYS") return res.status(409).json({ error: "حوّل الوضع إلى المحرك الداخلي قبل حذف جلسته" });
  await audit(req.user!.id, "WHATSAPP_SESSION_LOGGED_OUT");
  res.json(await logoutBaileysWhatsApp());
});

app.put("/api/admin/integrations/whatsapp/call-reply", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ text: z.string().trim().min(10).max(1000) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اكتب ردًا تلقائيًا من 10 إلى 1000 حرف" });
  const text = await saveWhatsAppCallReply(parsed.data.text);
  await audit(req.user!.id, "WHATSAPP_CALL_REPLY_UPDATED");
  res.json({ text });
});

app.get("/api/conversations/:id/whatsapp-call/permission", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, include: { customer: { select: { phone: true, isBlocked: true } } } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (conversation.channel !== Channel.WHATSAPP) return res.status(409).json({ error: "الاتصال الصوتي متاح لمحادثات WhatsApp فقط" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "هذه المحادثة ليست ضمن صلاحياتك" });
  if (conversation.customer.isBlocked) return res.status(409).json({ error: "العميل محظور داخل النظام؛ ألغِ الحظر قبل الاتصال" });
  try {
    const [mode, recordingSettings] = await Promise.all([getWhatsAppMode(), getCallRecordingSettings()]);
     if (mode === "BAILEYS") return res.json({
      status: "browser_link", transport: "INTERNAL_WEB", expiration: null, canStartCall: true, canRequestPermission: false,
       recordingEnabled: recordingSettings.enabled, aiProcessingEnabled: false, iceServers: callIceServers(req.user!.id)
     });
     const permission = await getCloudCallPermission(conversation.customer.phone || conversation.externalCustomerId);
     res.json({ ...permission, transport: "WHATSAPP_CLOUD", recordingEnabled: recordingSettings.enabled, aiProcessingEnabled: false, iceServers: callIceServers(req.user!.id) });
  } catch (error) {
    res.status(error instanceof WhatsAppCloudApiError ? error.status || 502 : 503).json({ error: error instanceof Error ? error.message : "تعذر فحص صلاحية الاتصال" });
  }
});

app.post("/api/conversations/:id/whatsapp-call/permission-request", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({}).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "طلب الإذن غير صالح" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, include: { customer: { select: { phone: true, isBlocked: true } } } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (conversation.channel !== Channel.WHATSAPP) return res.status(409).json({ error: "طلب الإذن متاح لمحادثات WhatsApp فقط" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "هذه المحادثة ليست ضمن صلاحياتك" });
  if (conversation.customer.isBlocked) return res.status(409).json({ error: "العميل محظور داخل النظام؛ ألغِ الحظر قبل الاتصال" });
  if (await getWhatsAppMode() === "BAILEYS") return res.status(409).json({ error: "في وضع Baileys يُرسل رابط مكالمة متصفح بدل طلب إذن مكالمة WhatsApp أصلية" });
  try {
    const result = await requestCloudCallPermission(conversation.customer.phone || conversation.externalCustomerId);
    await audit(req.user!.id, "WHATSAPP_CALL_PERMISSION_REQUESTED", conversation.id, { phoneLastFour: normalizeCloudCallTarget(conversation.customer.phone || conversation.externalCustomerId).slice(-4) });
    res.json({ ok: true, messageId: result.messages?.[0]?.id || null });
  } catch (error) {
    const status = error instanceof WhatsAppCloudApiError ? error.status || 502 : 502;
    res.status(status).json({ error: error instanceof Error ? error.message : "تعذر إرسال طلب إذن الاتصال" });
  }
});

app.post("/api/conversations/:id/whatsapp-call", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ offerSdp: z.string().min(100).max(100_000), recordingConsent: z.boolean(), aiProcessingConsent: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success || !parsed.data.offerSdp.includes("m=audio")) return res.status(400).json({ error: "تعذر إنشاء عرض صوتي صالح للمكالمة" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, include: { customer: { select: { phone: true, isBlocked: true } } } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (conversation.channel !== Channel.WHATSAPP) return res.status(409).json({ error: "الاتصال الصوتي متاح لمحادثات WhatsApp فقط" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "هذه المحادثة ليست ضمن صلاحياتك" });
  if (conversation.customer.isBlocked) return res.status(409).json({ error: "العميل محظور داخل النظام؛ ألغِ الحظر قبل الاتصال" });
  const whatsappMode = await getWhatsAppMode();
  const recordingSettings = await getCallRecordingSettings();
  if (whatsappMode === "API" && recordingSettings.enabled && !parsed.data.recordingConsent) return res.status(400).json({ error: "سجّل موافقة العميل الصريحة على التسجيل قبل بدء المكالمة" });
  const activeStatuses = ["INITIATING", "RINGING", "CONNECTED"];
  const now = new Date();
  await prisma.whatsAppCallSession.updateMany({
    where: { agentId: req.user!.id, transport: "INTERNAL_WEB", status: "INITIATING", guestExpiresAt: { lte: now } },
    data: { status: "FAILED", guestTokenHash: null, lastError: "انتهت صلاحية رابط الاتصال.", endedAt: now }
  });
  const activeCall = await prisma.whatsAppCallSession.findFirst({ where: { agentId: req.user!.id, status: { in: activeStatuses }, createdAt: { gte: new Date(Date.now() - 4 * 60 * 60_000) } }, select: { id: true } });
  if (activeCall) return res.status(409).json({ error: "لديك مكالمة صوتية أخرى مفتوحة. أنهِها قبل بدء مكالمة جديدة." });
  if (whatsappMode === "BAILEYS") {
    const token = createWebCallToken();
    let joinUrl: string;
    try {
      const webOrigin = new URL(config.webOrigin);
      if (process.env.NODE_ENV === "production" && webOrigin.protocol !== "https:") throw new Error("WEB_ORIGIN must use HTTPS for browser calls");
      joinUrl = new URL(`/voice-call/${token}`, webOrigin).toString();
    } catch {
      return res.status(503).json({ error: "اضبط WEB_ORIGIN على عنوان HTTPS الصحيح لواجهة النظام قبل إرسال رابط المكالمة" });
    }
    const guestExpiresAt = new Date(Date.now() + 10 * 60_000);
    const session = await prisma.whatsAppCallSession.create({ data: {
      conversationId: conversation.id, agentId: req.user!.id, phoneNumber: conversation.customer.phone || conversation.externalCustomerId,
      transport: "INTERNAL_WEB", offerSdp: parsed.data.offerSdp, guestTokenHash: hashWebCallToken(token), guestExpiresAt, status: "INITIATING"
    } });
    try {
      const inviteText = `يرغب فريق حلواني بندق في التحدث معك صوتيًا. افتح الرابط خلال 10 دقائق للانضمام عبر المتصفح (هذه ليست مكالمة WhatsApp أصلية): ${joinUrl}`;
      const invite = await prisma.message.create({ data: {
        conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND,
        kind: MessageKind.TEXT, text: inviteText, deliveryStatus: "QUEUED"
      }, include: { author: { select: { id: true, name: true } } } });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: invite.createdAt, status: ConversationStatus.OPEN } });
      const delivered = await queueWhatsAppMessage(invite.id, conversation.id, req.user!.id, { channel: conversation.channel, recipient: conversation.externalCustomerId, text: inviteText });
      if (!delivered || delivered.deliveryStatus === "FAILED") throw new Error("تعذر إرسال رابط المكالمة عبر WhatsApp");
      await audit(req.user!.id, "INTERNAL_WEB_CALL_INVITE_SENT", conversation.id, { sessionId: session.id, expiresAt: guestExpiresAt.toISOString() });
      return res.status(201).json({
        sessionId: session.id, status: session.status, transport: session.transport, recordingEnabled: false,
        aiProcessingEnabled: false, iceServers: callIceServers(session.id), inviteExpiresAt: guestExpiresAt
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "تعذر إرسال رابط المكالمة";
      await prisma.whatsAppCallSession.update({ where: { id: session.id }, data: { status: "FAILED", guestTokenHash: null, lastError: message, endedAt: new Date() } });
      return res.status(502).json({ error: message });
    }
  }
  let phoneNumber: string;
  try { phoneNumber = normalizeCloudCallTarget(conversation.customer.phone || conversation.externalCustomerId); }
  catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "رقم WhatsApp للعميل غير صالح" }); }
  const session = await prisma.whatsAppCallSession.create({ data: {
    conversationId: conversation.id, agentId: req.user!.id, phoneNumber, status: "INITIATING",
    ...(recordingSettings.enabled ? { recordingConsentAt: new Date() } : {})
    } });
  try {
    const providerCallId = await startCloudCall({ phone: phoneNumber, offerSdp: parsed.data.offerSdp, callbackData: session.id });
    await prisma.whatsAppCallSession.updateMany({ where: { id: session.id, status: "INITIATING" }, data: { providerCallId } });
    await audit(req.user!.id, "WHATSAPP_CLOUD_CALL_STARTED", conversation.id, { sessionId: session.id, phoneLastFour: phoneNumber.slice(-4), recordingConsent: Boolean(session.recordingConsentAt) });
    res.json({ sessionId: session.id, status: "INITIATING", transport: "WHATSAPP_CLOUD", recordingEnabled: recordingSettings.enabled, aiProcessingEnabled: false, iceServers: callIceServers(session.id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "تعذر بدء المكالمة عبر WhatsApp";
    await prisma.whatsAppCallSession.update({ where: { id: session.id }, data: { status: "FAILED", lastError: message, endedAt: new Date() } });
    const status = error instanceof WhatsAppCloudApiError ? error.status || 502 : 502;
    await audit(req.user!.id, "WHATSAPP_CLOUD_CALL_FAILED", conversation.id, { sessionId: session.id, errorCode: error instanceof WhatsAppCloudApiError ? error.code || null : null });
    res.status(status).json({ error: message });
  }
});

app.get("/api/public/voice-calls/:token", async (req, res) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (!isWebCallToken(req.params.token)) return res.sendStatus(404);
  const guestTokenHash = hashWebCallToken(req.params.token);
  const session = await prisma.whatsAppCallSession.findFirst({ where: { guestTokenHash }, include: { conversation: { select: { customer: { select: { name: true, displayName: true } } } } } });
  if (!session || session.transport !== "INTERNAL_WEB") return res.sendStatus(404);
  if (session.status === "INITIATING" && (!session.guestExpiresAt || session.guestExpiresAt.getTime() <= Date.now())) {
    await prisma.whatsAppCallSession.updateMany({ where: { id: session.id, status: "INITIATING" }, data: { status: "FAILED", guestTokenHash: null, lastError: "انتهت صلاحية رابط الاتصال.", endedAt: new Date() } });
    io.to(`agent:${session.agentId}`).emit("whatsapp:cloud-call-updated", { sessionId: session.id, status: "FAILED" });
    return res.status(410).json({ error: "انتهت صلاحية رابط الاتصال. اطلب من الموظف إرسال رابط جديد." });
  }
  const terminal = ["REJECTED", "TERMINATED", "FAILED"].includes(session.status);
  const recordingSettings = terminal ? null : await getCallRecordingSettings();
  res.json({
    status: session.status,
    ...(session.status === "INITIATING" ? { offerSdp: session.offerSdp } : {}),
    customerName: session.conversation.customer.displayName || session.conversation.customer.name || "",
    recordingAvailable: Boolean(recordingSettings?.enabled),
    aiConsentAvailable: false,
    ...(terminal ? {} : { iceServers: callIceServers(session.id) })
  });
});

app.post("/api/public/voice-calls/:token/answer", async (req, res) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (!isWebCallToken(req.params.token)) return res.sendStatus(404);
  const parsed = z.object({ answerSdp: z.string().min(100).max(100_000), recordingConsent: z.boolean(), aiProcessingConsent: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success || !parsed.data.answerSdp.includes("m=audio") || !parsed.data.answerSdp.includes("a=candidate:")) return res.status(400).json({ error: "تعذر إنشاء إجابة صوتية صالحة" });
  const session = await prisma.whatsAppCallSession.findFirst({ where: { guestTokenHash: hashWebCallToken(req.params.token) } });
  if (!session || session.transport !== "INTERNAL_WEB") return res.sendStatus(404);
  if (session.status !== "INITIATING" || !session.guestExpiresAt || session.guestExpiresAt.getTime() <= Date.now()) return res.status(410).json({ error: "انتهت صلاحية الدعوة أو استُخدمت بالفعل" });
  const recordingSettings = await getCallRecordingSettings();
  const acceptedAt = new Date();
  const updated = await prisma.whatsAppCallSession.updateMany({
    where: { id: session.id, status: "INITIATING", sdpAnswer: null, guestExpiresAt: { gt: acceptedAt } },
    data: {
      sdpAnswer: parsed.data.answerSdp, status: "RINGING",
      ...(recordingSettings.enabled && parsed.data.recordingConsent ? { recordingConsentAt: acceptedAt } : {})
    }
  });
  if (updated.count !== 1) return res.status(409).json({ error: "انضم شخص آخر إلى هذه المكالمة أو انتهت الدعوة" });
  await audit(null, "INTERNAL_WEB_CALL_ACCEPTED", session.conversationId, { sessionId: session.id, recordingConsent: Boolean(recordingSettings.enabled && parsed.data.recordingConsent) });
  io.to(`agent:${session.agentId}`).emit("whatsapp:cloud-call-updated", { sessionId: session.id, status: "RINGING" });
  res.json({ ok: true });
});

app.post("/api/public/voice-calls/:token/decline", async (req, res) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (!isWebCallToken(req.params.token) || !z.object({}).strict().safeParse(req.body).success) return res.sendStatus(404);
  const session = await prisma.whatsAppCallSession.findFirst({ where: { guestTokenHash: hashWebCallToken(req.params.token) } });
  if (!session || session.transport !== "INTERNAL_WEB") return res.sendStatus(404);
  const result = await prisma.whatsAppCallSession.updateMany({ where: { id: session.id, status: "INITIATING" }, data: { status: "REJECTED", guestTokenHash: null, lastError: "رفض العميل الانضمام إلى مكالمة المتصفح.", endedAt: new Date() } });
  if (result.count) {
    await audit(null, "INTERNAL_WEB_CALL_DECLINED", session.conversationId, { sessionId: session.id });
    io.to(`agent:${session.agentId}`).emit("whatsapp:cloud-call-updated", { sessionId: session.id, status: "REJECTED" });
  }
  res.json({ ok: true });
});

app.post("/api/public/voice-calls/:token/terminate", async (req, res) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (!isWebCallToken(req.params.token) || !z.object({}).strict().safeParse(req.body).success) return res.sendStatus(404);
  const session = await prisma.whatsAppCallSession.findFirst({ where: { guestTokenHash: hashWebCallToken(req.params.token) } });
  if (!session || session.transport !== "INTERNAL_WEB") return res.sendStatus(404);
  const result = await prisma.whatsAppCallSession.updateMany({ where: { id: session.id, status: { in: ["INITIATING", "RINGING", "CONNECTED"] } }, data: { status: "TERMINATED", guestTokenHash: null, endedAt: new Date() } });
  if (result.count) {
    await audit(null, "INTERNAL_WEB_CALL_TERMINATED", session.conversationId, { sessionId: session.id, endedBy: "customer" });
    io.to(`agent:${session.agentId}`).emit("whatsapp:cloud-call-updated", { sessionId: session.id, status: "TERMINATED" });
  }
  res.json({ ok: true });
});

app.post("/api/whatsapp-calls/:id/recording", agentGuard, express.raw({ type: () => true, limit: uploadLimitBytes }), async (req: AuthedRequest, res: express.Response) => {
  const session = await prisma.whatsAppCallSession.findUnique({ where: { id: req.params.id }, select: { id: true, agentId: true, conversationId: true, recordingConsentAt: true, recordingDeletedAt: true, recording: { select: { id: true } } } });
  if (!session) return res.status(404).json({ error: "جلسة المكالمة غير موجودة" });
  if (session.agentId !== req.user!.id) return res.status(403).json({ error: "لا تملك صلاحية رفع تسجيل هذه المكالمة" });
  if (session.recordingDeletedAt) return res.status(409).json({ error: "حُذف تسجيل هذه المكالمة نهائيًا ولا يمكن رفعه مجددًا" });
  if (!session.recordingConsentAt) return res.status(409).json({ error: "لا يوجد إثبات موافقة على تسجيل هذه المكالمة" });
  if (session.recording) return res.status(409).json({ error: "تم حفظ تسجيل هذه المكالمة بالفعل" });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "التسجيل الصوتي فارغ" });
  const contentType = String(req.header("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!["audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg"].includes(contentType)) return res.status(415).json({ error: "صيغة التسجيل الصوتي غير مدعومة" });
  const durationSeconds = Number(req.header("x-duration-seconds"));
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 4 * 60 * 60) return res.status(400).json({ error: "مدة التسجيل غير صالحة" });
  const extension = contentType === "audio/mp4" ? "m4a" : contentType === "audio/ogg" ? "ogg" : contentType === "audio/mpeg" ? "mp3" : "webm";
  const asset = await prisma.mediaAsset.create({ data: {
    fileName: safeFileName(`whatsapp-call-${session.id}.${extension}`), contentType, size: req.body.length,
    data: Uint8Array.from(req.body), createdById: req.user!.id
  }, select: { id: true } });
  try {
     const recording = await prisma.callRecording.create({ data: { sessionId: session.id, mediaAssetId: asset.id, durationSeconds, aiProcessingStatus: "NOT_REQUESTED" } });
     await audit(req.user!.id, "CALL_RECORDING_SAVED", session.conversationId, { sessionId: session.id, durationSeconds });
     res.status(201).json({ id: recording.id, durationSeconds });
  } catch (error) {
    await prisma.mediaAsset.delete({ where: { id: asset.id } }).catch(() => {});
    throw error;
  }
});

app.get("/api/whatsapp-calls/:id", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  let session = await prisma.whatsAppCallSession.findUnique({ where: { id: req.params.id } });
  if (!session) return res.status(404).json({ error: "جلسة المكالمة غير موجودة" });
  if (session.agentId !== req.user!.id && req.user!.role !== Role.ADMIN && !(req.user!.role === Role.SUPERVISOR && hasPermission(req.user!, "canViewAllConversations"))) return res.status(403).json({ error: "لا تملك صلاحية متابعة هذه المكالمة" });
  if (session.transport === "INTERNAL_WEB" && session.status === "INITIATING" && (!session.guestExpiresAt || session.guestExpiresAt.getTime() <= Date.now())) {
    await prisma.whatsAppCallSession.updateMany({ where: { id: session.id, status: "INITIATING" }, data: { status: "FAILED", guestTokenHash: null, lastError: "انتهت صلاحية رابط الاتصال.", endedAt: new Date() } });
    session = { ...session, status: "FAILED", sdpAnswer: null, lastError: "انتهت صلاحية رابط الاتصال.", endedAt: new Date() };
  }
  if (session.transport === "WHATSAPP_CLOUD" && session.sdpAnswer && Date.now() - session.updatedAt.getTime() > 120_000) {
    await prisma.whatsAppCallSession.updateMany({ where: { id: session.id, sdpAnswer: session.sdpAnswer }, data: { sdpAnswer: null } });
    session = { ...session, sdpAnswer: null };
  }
   res.json({ id: session.id, transport: session.transport, status: session.status, sdpAnswer: session.sdpAnswer, recordingEnabled: Boolean(session.recordingConsentAt), aiProcessingEnabled: false, error: session.lastError, updatedAt: session.updatedAt });
});

app.post("/api/whatsapp-calls/:id/answer-applied", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const session = await prisma.whatsAppCallSession.findUnique({ where: { id: req.params.id } });
  if (!session) return res.status(404).json({ error: "جلسة المكالمة غير موجودة" });
  if (session.agentId !== req.user!.id) return res.status(403).json({ error: "لا تملك صلاحية متابعة هذه المكالمة" });
  await prisma.whatsAppCallSession.updateMany({ where: { id: session.id }, data: { sdpAnswer: null } });
  res.json({ ok: true });
});

app.post("/api/whatsapp-calls/:id/terminate", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const session = await prisma.whatsAppCallSession.findUnique({ where: { id: req.params.id } });
  if (!session) return res.status(404).json({ error: "جلسة المكالمة غير موجودة" });
  if (session.agentId !== req.user!.id && req.user!.role !== Role.ADMIN && !(req.user!.role === Role.SUPERVISOR && hasPermission(req.user!, "canViewAllConversations"))) return res.status(403).json({ error: "لا تملك صلاحية إنهاء هذه المكالمة" });
  if (["TERMINATED", "REJECTED", "FAILED"].includes(session.status)) return res.json({ ok: true });
  try {
    if (session.transport === "WHATSAPP_CLOUD" && session.providerCallId) await terminateCloudCall(session.providerCallId);
    await prisma.whatsAppCallSession.update({ where: { id: session.id }, data: { status: "TERMINATED", sdpAnswer: null, endedAt: new Date() } });
    await audit(req.user!.id, session.transport === "INTERNAL_WEB" ? "INTERNAL_WEB_CALL_TERMINATED" : "WHATSAPP_CLOUD_CALL_TERMINATED", session.conversationId, { sessionId: session.id, endedBy: "agent" });
    res.json({ ok: true });
  } catch (error) {
    res.status(error instanceof WhatsAppCloudApiError ? error.status || 502 : 502).json({ error: error instanceof Error ? error.message : "تعذر إنهاء المكالمة لدى WhatsApp" });
  }
});

app.post("/api/integrations/whatsapp/calls/reject", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ callId: z.string().min(1).max(256), callerJid: z.string().min(1).max(256), text: z.string().trim().max(1000).optional() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "بيانات المكالمة غير صالحة" });
  if (await getWhatsAppMode() !== "BAILEYS") return res.status(409).json({ error: "مكالمات WhatsApp الواردة تتطلب تفعيل المحرك الداخلي" });
  const pending = getPendingBaileysCall(parsed.data.callId, parsed.data.callerJid);
  if (!pending) return res.status(404).json({ error: "المكالمة لم تعد واردة أو انتهت بالفعل" });
  const conversation = pending.conversationId ? await prisma.conversation.findUnique({ where: { id: pending.conversationId } }) : null;
  if (conversation && !canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "ليس لديك صلاحية معالجة هذه المكالمة" });
  if (!conversation && req.user!.role !== Role.ADMIN && req.user!.role !== Role.SUPERVISOR) return res.status(403).json({ error: "هذه المكالمة غير مرتبطة بمحادثة مسندة إليك" });
  try {
    await rejectBaileysCall(pending.callId, pending.callerJid);
  } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : "تعذر رفض المكالمة" }); }
  const text = parsed.data.text?.trim() || await getWhatsAppCallReply();
  try {
    const result: any = await sendToChannel({ channel: Channel.WHATSAPP, recipient: pending.phoneNumber || pending.callerJid, text });
    if (conversation) {
      const externalId = kalemlyExternalMessageId(result);
      const message = await prisma.message.create({ data: { conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.TEXT, text, deliveryStatus: "SENT", externalId: externalId ? `WHATSAPP:${externalId}` : undefined }, include: { author: { select: { id: true, name: true } } } });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: message.createdAt, lastAgentResponseAt: message.createdAt, firstResponseAt: conversation.firstResponseAt || message.createdAt, slaBreachedAt: null, status: ConversationStatus.OPEN } });
      await audit(req.user!.id, "WHATSAPP_CALL_REJECTED_WITH_REPLY", conversation.id, { callId: pending.callId });
       await emitConversationEvent(conversation.id, conversation.channel, "message:new", { conversationId: conversation.id, message });
      res.json({ ok: true, message });
    } else {
      await audit(req.user!.id, "WHATSAPP_CALL_REJECTED_WITH_REPLY", undefined, { callId: pending.callId, phoneLastFour: pending.phoneNumber.replace(/\D/g, "").slice(-4) });
      res.json({ ok: true });
    }
  } catch (error) {
    await audit(req.user!.id, "WHATSAPP_CALL_REJECTED_REPLY_FAILED", conversation?.id, { callId: pending.callId });
    res.status(502).json({ error: error instanceof Error ? `رُفضت المكالمة لكن تعذر إرسال الرد التلقائي: ${error.message}` : "رُفضت المكالمة لكن تعذر إرسال الرد التلقائي" });
  }
});

app.post("/api/admin/integrations/kalemlywa/test", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ phone: z.string().min(8).max(32), message: z.string().min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "أدخل رقم واتساب مصريًا صحيحًا ورسالة قصيرة" });
  try {
    const result = await sendKalemlyTest(parsed.data.phone, parsed.data.message);
    await audit(req.user!.id, "KALEMLYWA_TEST_SENT", undefined, { phoneLastFour: parsed.data.phone.replace(/\D/g, "").slice(-4) });
    res.json({ ok: true, provider: safeProviderResponse(result) });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "تعذر إرسال رسالة الاختبار عبر KalemlyWA" });
  }
});

app.get("/api/admin/integrations/messenger", adminGuard, async (_req: express.Request, res: express.Response) => {
  const settings = await getMessengerSettings();
  res.json({ pageId: settings.pageId, pageTokenConfigured: Boolean(settings.pageAccessToken), appSecretConfigured: Boolean(settings.appSecret), verifyTokenConfigured: Boolean(settings.verifyToken) });
});

app.put("/api/admin/integrations/messenger", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ pageId: z.string().max(180).optional(), pageAccessToken: z.string().max(4096).optional(), appSecret: z.string().max(2048).optional(), verifyToken: z.string().max(512).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "تحقق من بيانات تطبيق Meta والصفحة" });
  const settings = await saveMessengerSettings(parsed.data);
  await audit(req.user!.id, "MESSENGER_SETTINGS_UPDATED", undefined, { pageIdConfigured: Boolean(settings.pageId), pageTokenConfigured: Boolean(settings.pageAccessToken), appSecretConfigured: Boolean(settings.appSecret), verifyTokenConfigured: Boolean(settings.verifyToken) });
  res.json({ pageId: settings.pageId, pageTokenConfigured: Boolean(settings.pageAccessToken), appSecretConfigured: Boolean(settings.appSecret), verifyTokenConfigured: Boolean(settings.verifyToken) });
});

app.post("/api/admin/integrations/messenger/test", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const settings = await getMessengerSettings();
  if (!settings.pageAccessToken) return res.status(400).json({ error: "احفظ رمز الوصول للصفحة أولًا" });
  try {
    const response = await fetch("https://graph.facebook.com/v21.0/me?fields=id,name", { headers: { Authorization: `Bearer ${settings.pageAccessToken}` }, signal: AbortSignal.timeout(15_000) });
    const result = await response.json() as { id?: string; name?: string; error?: { message?: string } };
    if (!response.ok) return res.status(502).json({ error: result.error?.message || "تعذر التحقق من رمز Meta" });
    if (settings.pageId && settings.pageId !== result.id) return res.status(409).json({ error: "معرّف الصفحة لا يطابق الرمز المحفوظ" });
    if (!settings.pageId && result.id) await saveMessengerSettings({ pageId: result.id });
    await audit(req.user!.id, "MESSENGER_CONNECTION_TESTED", undefined, { pageId: result.id });
    res.json({ ok: true, pageId: result.id, pageName: result.name });
  } catch {
    res.status(502).json({ error: "تعذر الاتصال بخدمة Meta؛ تحقق من الرمز وحاول مجددًا" });
  }
});

app.get("/api/admin/integrations/telegram", adminGuard, async (_req: express.Request, res: express.Response) => {
  const settings = await getTelegramSettings();
  res.json({ botUsername: settings.botUsername, botTokenConfigured: Boolean(settings.botToken), webhookSecretConfigured: Boolean(settings.webhookSecret) });
});

app.put("/api/admin/integrations/telegram", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ botUsername: z.string().max(100).optional(), botToken: z.string().max(512).optional(), webhookSecret: z.string().max(256).regex(/^[A-Za-z0-9_-]*$/).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "تحقق من اسم المستخدم والرمز السري لـ Telegram" });
  const settings = await saveTelegramSettings(parsed.data);
  await audit(req.user!.id, "TELEGRAM_SETTINGS_UPDATED", undefined, { botUsernameConfigured: Boolean(settings.botUsername), botTokenConfigured: Boolean(settings.botToken), webhookSecretConfigured: Boolean(settings.webhookSecret) });
  res.json({ botUsername: settings.botUsername, botTokenConfigured: Boolean(settings.botToken), webhookSecretConfigured: Boolean(settings.webhookSecret) });
});

app.post("/api/admin/integrations/telegram/test", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const settings = await getTelegramSettings();
  if (!settings.botToken) return res.status(400).json({ error: "احفظ رمز البوت أولًا" });
  try {
    const response = await fetch(`https://api.telegram.org/bot${settings.botToken}/getMe`, { signal: AbortSignal.timeout(15_000) });
    const result = await response.json() as { ok?: boolean; result?: { username?: string }; description?: string };
    if (!response.ok || !result.ok) return res.status(502).json({ error: result.description || "تعذر التحقق من رمز Telegram" });
    const botUsername = result.result?.username || "";
    if (botUsername && botUsername !== settings.botUsername) await saveTelegramSettings({ botUsername });
    await audit(req.user!.id, "TELEGRAM_CONNECTION_TESTED", undefined, { botUsername });
    res.json({ ok: true, botUsername });
  } catch {
    res.status(502).json({ error: "تعذر الاتصال بخدمة Telegram؛ تحقق من الرمز وحاول مجددًا" });
  }
});

app.post("/api/admin/integrations/telegram/webhook", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ url: httpsUrl }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "أدخل عنوان Webhook آمنًا يبدأ بـ HTTPS" });
  const settings = await getTelegramSettings();
  if (!settings.botToken || settings.webhookSecret.length < 16) return res.status(400).json({ error: "احفظ رمز البوت ورمز حماية Webhook بطول 16 حرفًا على الأقل أولًا" });
  try {
    const response = await fetch(`https://api.telegram.org/bot${settings.botToken}/setWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: parsed.data.url, secret_token: settings.webhookSecret, allowed_updates: ["message", "edited_message", "callback_query"] }),
      signal: AbortSignal.timeout(15_000)
    });
    const result = await response.json() as { ok?: boolean; description?: string };
    if (!response.ok || !result.ok) return res.status(502).json({ error: result.description || "تعذر تسجيل Webhook لدى Telegram" });
    await audit(req.user!.id, "TELEGRAM_WEBHOOK_CONFIGURED");
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "تعذر تسجيل Webhook لدى Telegram؛ تحقق من عنوان API وحاول مجددًا" });
  }
});

app.get("/api/admin/dashboard", permissionGuard("canViewReports"), async (_req: express.Request, res: express.Response) => {
  const today = startOfCairoDay();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [openChats, queue, slaBreached, agents, todayResponses, closedToday, recentAudit, allRatings, weeklyReplyCounts, weeklyConversationTouches, pendingHandoffs] = await Promise.all([
    prisma.conversation.count({ where: { status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } } }),
    prisma.conversation.count({ where: { status: ConversationStatus.QUEUED } }),
    prisma.conversation.count({ where: { slaBreachedAt: { not: null }, status: { not: ConversationStatus.CLOSED } } }),
    prisma.user.findMany({ where: { role: { in: [Role.AGENT, Role.BRANCH_USER] } }, select: { id: true, name: true, email: true, role: true, department: true, branchId: true, presence: true, isActive: true, sessions: { where: { startedAt: { gte: today } }, select: { startedAt: true, endedAt: true } } }, orderBy: { name: "asc" } }),
    prisma.conversation.findMany({ where: { firstResponseAt: { gte: today } }, select: { createdAt: true, firstResponseAt: true, assignedAgentId: true } }),
    prisma.conversation.count({ where: { status: { in: [ConversationStatus.CLOSED, ConversationStatus.RESOLVED] }, closedAt: { gte: today } } }),
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 12, include: { actor: { select: { name: true } } } }),
    prisma.csatSurvey.findMany({ where: { rating: { not: null } }, select: { rating: true } }),
    prisma.message.groupBy({ by: ["authorId"], where: { authorId: { not: null }, createdAt: { gte: weekAgo }, direction: MessageDirection.OUTBOUND }, _count: { _all: true } }),
    prisma.message.findMany({ where: { authorId: { not: null }, createdAt: { gte: weekAgo }, direction: MessageDirection.OUTBOUND }, distinct: ["authorId", "conversationId"], select: { authorId: true, conversationId: true } }),
    prisma.conversationHandoffRequest.findMany({ where: { status: ConversationHandoffStatus.PENDING }, include: { fromAgent: { select: { id: true, name: true } }, toAgent: { select: { id: true, name: true } }, conversation: { include: { customer: { select: { name: true, displayName: true } } } } }, orderBy: { createdAt: "desc" } })
  ]);
  const weeklyStats = weeklyAgentPerformance(agents.map((agent) => agent.id), weeklyReplyCounts.map((row) => ({ authorId: row.authorId, count: row._count._all })), weeklyConversationTouches);
  const durations = todayResponses.flatMap((row) => row.firstResponseAt ? [row.firstResponseAt.getTime() - row.createdAt.getTime()] : []);
  const employeeStats = await Promise.all(agents.map(async (agent) => {
    const [activeChats, slaBreachedChats, responses, ratings] = await Promise.all([
      prisma.conversation.count({ where: { assignedAgentId: agent.id, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } } }),
      prisma.conversation.count({ where: { assignedAgentId: agent.id, slaBreachedAt: { not: null }, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } } }),
      prisma.conversation.findMany({ where: { assignedAgentId: agent.id, firstResponseAt: { gte: today } }, select: { createdAt: true, firstResponseAt: true } }),
      prisma.csatSurvey.findMany({ where: { agentId: agent.id, rating: { not: null } }, select: { rating: true } })
    ]);
    const seconds = responses.flatMap((row) => row.firstResponseAt ? [(row.firstResponseAt.getTime() - row.createdAt.getTime()) / 1000] : []);
    const sessionMinutes = agent.sessions.reduce((sum, session) => sum + ((session.endedAt || new Date()).getTime() - session.startedAt.getTime()) / 60000, 0);
     const closedOrders = await prisma.orderDetails.count({ where: { status: { in: [OrderStatus.DELIVERED, OrderStatus.COMPLETED] }, updatedAt: { gte: today }, conversation: { is: { assignedAgentId: agent.id } } } });
    const validRatings = ratings.flatMap((row) => row.rating === null ? [] : [row.rating]);
    return { ...agent, ...weeklyStats[agent.id], activeChats, slaBreachedChats, avgResponseSeconds: seconds.length ? Math.round(seconds.reduce((a, b) => a + b, 0) / seconds.length) : null, avgCsat: validRatings.length ? Number((validRatings.reduce((a, b) => a + b, 0) / validRatings.length).toFixed(1)) : null, csatCount: validRatings.length, closedOrders, sessionMinutes: Math.round(sessionMinutes) };
  }));
  const ratings = allRatings.flatMap((row) => row.rating === null ? [] : [row.rating]);
  res.json({ kpis: { openChats, queue, slaBreached, avgResponseSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 1000) : null, closedToday, avgCsat: ratings.length ? Number((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)) : null, csatCount: ratings.length }, agents: employeeStats, recentAudit, pendingHandoffs });
});

app.get("/api/admin/messenger-permissions", permissionGuard("canManageTeam"), async (_req: express.Request, res: express.Response) => {
  res.json({ departments: await messengerDepartmentPolicies() });
});
app.put("/api/admin/messenger-permissions", permissionGuard("canManageTeam"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ departments: z.array(z.object({ department: z.nativeEnum(Department), mode: z.nativeEnum(MessengerAccessMode) }).strict()).length(messengerDepartments.length) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "حدد صلاحية Messenger لكل قسم مرة واحدة" });
  if (new Set(parsed.data.departments.map((item) => item.department)).size !== messengerDepartments.length) return res.status(400).json({ error: "حدد صلاحية Messenger لكل قسم مرة واحدة" });
  const departments = parsed.data.departments.map((item) => item.department);
  await prisma.$transaction(parsed.data.departments.map(({ department, mode }) => prisma.departmentMessengerPermission.upsert({
    where: { department }, create: { department, mode }, update: { mode }
  })));
  await audit(req.user!.id, "MESSENGER_DEPARTMENT_PERMISSIONS_UPDATED", undefined, { departments: parsed.data.departments });
  for (const channel of accessControlledChannels) {
    await refreshChannelAccessForDepartments(channel, departments);
    const activeConversations = await prisma.conversation.findMany({ where: { channel, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING, ConversationStatus.QUEUED] }, awaitingRouting: false }, select: { id: true } });
    for (const conversation of activeConversations) await assignConversation(conversation.id, undefined, { reassignIfIneligible: true });
    io.to("admins").emit("channel:permissions-updated", { channel });
  }
  res.json({ departments: await messengerDepartmentPolicies() });
});
app.get("/api/admin/channel-permissions/:channel", permissionGuard("canManageTeam"), async (req: express.Request, res: express.Response) => {
  const parsedChannel = z.enum(configurableChannels).safeParse(req.params.channel);
  if (!parsedChannel.success) return res.status(404).json({ error: "القناة غير مدعومة" });
  res.json({ departments: await channelDepartmentPolicies(parsedChannel.data) });
});
app.put("/api/admin/channel-permissions/:channel", permissionGuard("canManageTeam"), async (req: AuthedRequest, res: express.Response) => {
  const parsedChannel = z.enum(configurableChannels).safeParse(req.params.channel);
  if (!parsedChannel.success) return res.status(404).json({ error: "القناة غير مدعومة" });
  const channel = parsedChannel.data;
  const parsed = z.object({ departments: z.array(z.object({ department: z.nativeEnum(Department), mode: z.nativeEnum(MessengerAccessMode) }).strict()).length(messengerDepartments.length) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: `حدد صلاحية ${channel} لكل قسم مرة واحدة` });
  if (new Set(parsed.data.departments.map((item) => item.department)).size !== messengerDepartments.length) return res.status(400).json({ error: `حدد صلاحية ${channel} لكل قسم مرة واحدة` });
  const departments = parsed.data.departments.map((item) => item.department);
  await prisma.$transaction(parsed.data.departments.map(({ department, mode }) => prisma.departmentChannelPermission.upsert({
    where: { department_channel: { department, channel } }, create: { department, channel, mode }, update: { mode }
  })));
  await audit(req.user!.id, `${channel}_DEPARTMENT_PERMISSIONS_UPDATED`, undefined, { departments: parsed.data.departments });
  await refreshChannelAccessForDepartments(channel, departments);
  const activeConversations = await prisma.conversation.findMany({ where: { channel, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING, ConversationStatus.QUEUED] }, awaitingRouting: false }, select: { id: true } });
  for (const conversation of activeConversations) await assignConversation(conversation.id, undefined, { reassignIfIneligible: true });
  io.to("admins").emit("channel:permissions-updated", { channel });
  res.json({ departments: await channelDepartmentPolicies(channel) });
});
app.get("/api/admin/agents", adminGuard, async (_req: express.Request, res: express.Response) => {
  const [agents, whatsappPolicies, messengerPolicies, telegramPolicies] = await Promise.all([
    prisma.user.findMany({ where: { role: { in: [Role.AGENT, Role.BRANCH_USER] } }, select: { id: true, name: true, role: true, department: true, presence: true, isActive: true, canReceiveWhatsApp: true, canReceiveMessenger: true, canReceiveTelegram: true, whatsappAccess: true, messengerAccess: true, telegramAccess: true }, orderBy: { name: "asc" } }),
    channelDepartmentPolicies(Channel.WHATSAPP), messengerDepartmentPolicies(), channelDepartmentPolicies(Channel.TELEGRAM)
  ]);
  const connected = await connectedUserIds(agents.map((agent) => agent.id));
  const modes = [whatsappPolicies, messengerPolicies, telegramPolicies].map((policies) => Object.fromEntries(policies.map((item) => [item.department, item.mode])));
  res.json(agents.map((agent) => {
    const [whatsappModes, messengerModes, telegramModes] = modes;
    const principal = {
      ...agent,
      departmentWhatsAppAccess: agent.department ? whatsappModes[agent.department] : MessengerAccessMode.DISABLED,
      departmentMessengerAccess: agent.department ? messengerModes[agent.department] : MessengerAccessMode.DISABLED,
      departmentTelegramAccess: agent.department ? telegramModes[agent.department] : MessengerAccessMode.DISABLED
    };
    return {
      ...agent,
      isConnected: connected.has(agent.id),
      canReceiveWhatsApp: effectiveChannelAccess(principal, Channel.WHATSAPP) === MessengerAccessMode.FULL,
      canReceiveMessenger: effectiveMessengerAccess(principal) === MessengerAccessMode.FULL,
      canReceiveTelegram: effectiveChannelAccess(principal, Channel.TELEGRAM) === MessengerAccessMode.FULL
    };
  }));
});
app.get("/api/admin/team", permissionGuard("canManageTeam"), async (_req: express.Request, res: express.Response) => {
  const members = await prisma.user.findMany({ where: { role: { not: Role.ADMIN } }, select: staffSelect, orderBy: { name: "asc" } });
  const connected = await connectedUserIds(members.map((member) => member.id));
  res.json(members.map((member) => ({ ...member, isConnected: connected.has(member.id) })));
});
app.post("/api/admin/agents", permissionGuard("canManageTeam"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({
    name: z.string().trim().min(2).max(100), email: z.string().trim().email().max(254), username: usernameSchema.optional(), password: z.string().min(10).max(128),
    role: z.nativeEnum(Role).default(Role.AGENT), department: z.nativeEnum(Department).nullable().optional(), branchId: z.string().nullable().optional(), messengerAccess: z.nativeEnum(MessengerAccessMode).nullable().optional(), ...permissionFields, ...channelPermissionFields
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "راجع بيانات الموظف" });
  const { password, email, name, username: suppliedUsername, role, department, branchId, ...permissions } = parsed.data;
  if (role === Role.BRANCH_USER || department === Department.BRANCH || branchId) return res.status(400).json({ error: "إدارة حسابات الفروع غير متاحة" });
  const normalizedEmail = email.toLowerCase();
  const emailUsername = normalizedEmail.split("@")[0].replace(/[^a-z0-9._-]/g, "_").slice(0, 32);
  const username = suppliedUsername || (emailUsername.length >= 3 ? emailUsername : `user_${emailUsername || "member"}`.slice(0, 32));
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: "اكتب اسم مستخدم صالحًا من 3 إلى 32 حرفًا" });
  if (role === Role.ADMIN && req.user!.role !== Role.ADMIN) return res.status(403).json({ error: "إنشاء مدير نظام يتطلب صلاحية مدير النظام" });
  try {
    const user = await prisma.user.create({
      data: { email: normalizedEmail, username, name, role, department: department ?? null, branchId: null, passwordHash: await bcrypt.hash(password, 12), ...permissions } as Prisma.UserUncheckedCreateInput,
      select: staffSelect
    });
    await audit(req.user!.id, "TEAM_MEMBER_CREATED", undefined, { userId: user.id, role: user.role });
    io.to("admins").emit("team:updated", user);
    res.status(201).json(user);
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: "البريد الإلكتروني أو اسم المستخدم مستخدم بالفعل" });
    console.error("Team member creation failed", error);
    res.status(500).json({ error: "تعذر إنشاء الحساب الآن. راجع البيانات وحاول مجددًا." });
  }
});
app.patch("/api/admin/agents/:id", permissionGuard("canManageTeam"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({
    name: z.string().trim().min(2).max(100).optional(), email: z.string().trim().email().max(254).optional(), username: usernameSchema.optional(),
    isActive: z.boolean().optional(), password: z.string().min(10).max(128).optional(), role: z.nativeEnum(Role).optional(),
    department: z.nativeEnum(Department).nullable().optional(), branchId: z.string().nullable().optional(), messengerAccess: z.nativeEnum(MessengerAccessMode).nullable().optional(), ...permissionFields, ...channelPermissionFields
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "بيانات التعديل غير صالحة" });
  if (!Object.keys(parsed.data).length) return res.status(400).json({ error: "لا توجد تغييرات لحفظها" });
   const previous = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, role: true, department: true, branchId: true, canViewAllConversations: true, canTransferConversations: true, canManageCatalog: true, canViewReports: true, canManageTeam: true, canReceiveWhatsApp: true, canReceiveMessenger: true, canReceiveTelegram: true, whatsappAccess: true, messengerAccess: true, telegramAccess: true } });
  if (!previous) return res.status(404).json({ error: "حساب الموظف غير موجود" });
  if (previous.role === Role.ADMIN) return res.status(403).json({ error: "حساب مدير النظام محمي من التعديل عبر إدارة الفريق" });
  const role = parsed.data.role ?? previous.role;
  if (role === Role.ADMIN && req.user!.role !== Role.ADMIN) return res.status(403).json({ error: "تعيين مدير نظام يتطلب صلاحية مدير النظام" });
  if (parsed.data.role === Role.BRANCH_USER || parsed.data.department === Department.BRANCH || parsed.data.branchId) return res.status(400).json({ error: "إدارة حسابات الفروع غير متاحة" });
  const branchId = parsed.data.branchId === undefined ? previous.branchId : parsed.data.branchId;
  const department = parsed.data.department === undefined ? previous.department : parsed.data.department;
  const policyChanged = parsed.data.role !== undefined && parsed.data.role !== previous.role ||
    parsed.data.department !== undefined && parsed.data.department !== previous.department ||
    parsed.data.branchId !== undefined && parsed.data.branchId !== previous.branchId ||
    (Object.keys(permissionFields) as Array<keyof typeof permissionFields>).some((key) => {
      const requested = parsed.data[key];
      if (requested === undefined) return false;
      const defaultValue = previous.role === Role.ADMIN || previous.role === Role.SUPERVISOR;
      return (previous[key] ?? defaultValue) !== requested;
    });
  const channelPolicyChanged = (Object.keys(channelPermissionFields) as Array<keyof typeof channelPermissionFields>).some((key) => {
    const requested = parsed.data[key];
    return requested !== undefined && previous[key] !== requested;
  });
  const messengerPolicyChanged = parsed.data.messengerAccess !== undefined && previous.messengerAccess !== parsed.data.messengerAccess;
  const revokeSessions = Boolean(parsed.data.password || parsed.data.isActive === false || policyChanged || channelPolicyChanged || messengerPolicyChanged);
  const data: Prisma.UserUncheckedUpdateInput = {
    ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
    ...(parsed.data.email === undefined ? {} : { email: parsed.data.email.toLowerCase() }),
    ...(parsed.data.username === undefined ? {} : { username: parsed.data.username }),
    ...(parsed.data.role === undefined ? {} : { role }),
    ...(parsed.data.department === undefined ? role === Role.BRANCH_USER && previous.role !== Role.BRANCH_USER ? { department: Department.BRANCH } : {} : { department: parsed.data.department }),
    ...(parsed.data.branchId === undefined && !(role !== Role.BRANCH_USER && previous.role === Role.BRANCH_USER) ? {} : { branchId: role === Role.BRANCH_USER || department === Department.BRANCH ? branchId : null }),
    ...(parsed.data.isActive === undefined ? {} : { isActive: parsed.data.isActive }),
    ...((parsed.data.isActive === false || role !== Role.AGENT && role !== Role.BRANCH_USER || parsed.data.isActive === true) ? { presence: Presence.OFFLINE } : {}),
    ...(parsed.data.password ? { passwordHash: await bcrypt.hash(parsed.data.password, 12) } : {}),
    ...Object.fromEntries([...Object.keys(permissionFields), ...Object.keys(channelPermissionFields), "messengerAccess"].filter((key) => parsed.data[key as keyof typeof parsed.data] !== undefined).map((key) => [key, parsed.data[key as keyof typeof parsed.data]])),
    ...(revokeSessions ? { authVersion: { increment: 1 }, ...(role === Role.AGENT || role === Role.BRANCH_USER ? { presence: Presence.OFFLINE } : {}) } : {})
  };
  try {
    const user = await prisma.user.update({ where: { id: previous.id }, data, select: staffSelect });
    if (parsed.data.isActive === false || revokeSessions && (previous.role === Role.AGENT || previous.role === Role.BRANCH_USER) || previous.role !== role || previous.branchId !== null && role !== Role.BRANCH_USER || previous.department !== user.department) {
      await prisma.agentSession.updateMany({ where: { userId: user.id, endedAt: null }, data: { endedAt: new Date(), endState: Presence.OFFLINE } });
      await releaseAgentConversations(user.id);
    }
    if (revokeSessions) io.in(`user:${user.id}`).disconnectSockets(true);
    io.to("admins").emit("team:updated", user);
    if (!user.isActive || user.presence === Presence.OFFLINE) io.to("admins").emit("presence:updated", { userId: user.id, presence: Presence.OFFLINE });
    await audit(req.user!.id, "TEAM_MEMBER_UPDATED", undefined, { userId: user.id, changes: Object.keys(parsed.data) });
    res.json(user);
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: "البريد الإلكتروني أو اسم المستخدم مستخدم بالفعل" });
    console.error("Team member update failed", error);
    res.status(500).json({ error: "تعذر حفظ التعديلات الآن. حاول مجددًا." });
  }
});

app.get("/api/admin/audit", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const logs = await prisma.auditLog.findMany({ take: 100, orderBy: { createdAt: "desc" }, include: { actor: { select: { name: true } }, conversation: { select: { id: true, channel: true } } } });
  res.json(logs);
});

app.get("/webhooks/meta", async (req, res) => {
  const settings = await getMessengerSettings();
  const verifyTokens = [settings.verifyToken, cloudCallWebhookVerifyToken()].filter(Boolean);
  if (!verifyTokens.length) return res.status(503).send("Meta verify token is not configured");
  const supplied = String(req.query["hub.verify_token"] || "");
  const valid = req.query["hub.mode"] === "subscribe" && verifyTokens.some((token) => secretMatches(token, supplied));
  if (valid) return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

function verifyMetaSignature(req: express.Request, appSecret: string) {
  if (!appSecret) return process.env.NODE_ENV !== "production";
  const signature = req.header("x-hub-signature-256");
  if (!signature || !Buffer.isBuffer((req as any).rawBody)) return false;
  const expected = `sha256=${crypto.createHmac("sha256", appSecret).update((req as any).rawBody).digest("hex")}`;
  const actualBytes = Buffer.from(signature); const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

app.post("/webhooks/meta", async (req, res) => {
  const settings = await getMessengerSettings();
  const secret = req.body?.object === "whatsapp_business_account" ? cloudCallWebhookSecret() || settings.appSecret : settings.appSecret;
  if (!verifyMetaSignature(req, secret)) return res.sendStatus(401);
  if (req.body.object === "page") {
    res.sendStatus(200);
    try { for (const message of parseMetaWebhook(req.body)) await ingestMessage(message); }
    catch (error) { console.error("Meta webhook ingestion failed", error); }
    return;
  }
  if (req.body.object === "whatsapp_business_account") {
    try {
      const updates = await processCloudCallWebhooks(req.body);
      res.sendStatus(200);
      for (const update of updates) io.to(`agent:${update.agentId}`).emit("whatsapp:cloud-call-updated", { sessionId: update.sessionId, status: update.status });
    } catch (error) {
      console.error("WhatsApp Cloud Calling webhook processing failed", error);
      res.sendStatus(500);
    }
    return;
  }
  res.sendStatus(404);
});

function secretMatches(expected: string, supplied: string) {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

function kalemlyWebhookUrlToken(secret: string) {
  return crypto.createHmac("sha256", secret).update("bondoq/kalemlywa/webhook-url/v1").digest("hex");
}

function kalemlyWebhookCredentials(req: express.Request) {
  const authorization = req.header("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const payloads = [req.body, req.body?.data, req.body?.payload].filter((value) => value && typeof value === "object");
  return [
    req.header("x-kalemly-webhook-secret"),
    req.header("x-webhook-secret"),
    req.header("x-api-key"),
    req.header("apikey"),
    req.header("api-key"),
    req.header("x-app-key"),
    req.header("appkey"),
    bearer,
    typeof req.query.token === "string" ? req.query.token : undefined,
    ...payloads.flatMap((payload) => [payload.appkey, payload.app_key, payload.apiKey, payload.api_key, payload.apikey, payload["api-key"]])
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

app.post("/webhooks/kalemlywa", async (req, res) => {
  const settings = await getKalemlySettings();
  const expected = [config.kalemlyWebhookSecret, settings.appKey].filter((value): value is string => Boolean(value));
  if (!expected.length) return res.status(503).json({ error: "KalemlyWA webhook credentials are not configured" });
  const supplied = kalemlyWebhookCredentials(req);
  if (!expected.some((credential) => supplied.some((value) => secretMatches(credential, value) || secretMatches(kalemlyWebhookUrlToken(credential), value)))) return res.sendStatus(401);
  if (await getWhatsAppMode() !== "API") return res.status(202).json({ ignored: true, reason: "BAILEYS mode is active" });
  try {
    for (const message of parseKalemlyWebhook(req.body)) await ingestMessage(message);
    for (const update of parseKalemlyPresenceUpdates(req.body)) await publishWhatsAppCustomerPresence(update);
    res.sendStatus(200);
  } catch (error) {
    console.error("KalemlyWA webhook ingestion failed", error);
    res.status(500).json({ error: "تعذر حفظ رسالة واتساب الواردة" });
  }
});

app.post("/webhooks/telegram", async (req, res) => {
  const settings = await getTelegramSettings();
  if (!settings.webhookSecret && process.env.NODE_ENV === "production") return res.status(503).json({ error: "Telegram webhook secret is not configured" });
  if (settings.webhookSecret && !secretMatches(settings.webhookSecret, req.header("x-telegram-bot-api-secret-token") || "")) return res.sendStatus(401);
  res.sendStatus(200);
  if (req.body.callback_query?.id) void answerTelegramCallback(String(req.body.callback_query.id)).catch((error) => console.warn("Telegram callback acknowledgement failed", error));
  try {
    for (const message of parseTelegramWebhook(req.body)) {
      if (message.isEdit) await updateEditedInboundMessage(message);
      else await ingestMessage(message);
    }
  }
  catch (error) { console.error("Telegram webhook ingestion failed", error); }
});

const kalemlyWorker = startKalemlyWaWorker();
kalemlyWorker.on("failed", (job, error) => console.error("KalemlyWA outbound delivery failed", job?.id, error));
void initializeWhatsAppEngine().catch((error) => console.error("Could not initialize WhatsApp engine", error));
const callRecordingAiQueue = new Queue("call-recording-ai", { connection: redis });
void (async () => {
  try {
    await prisma.callRecordingSettings.updateMany({ where: { aiProcessingEnabled: true }, data: { aiProcessingEnabled: false } });
    await prisma.callRecording.updateMany({ where: { aiProcessingStatus: { in: ["PENDING", "PROCESSING"] } }, data: { aiProcessingStatus: "NOT_REQUESTED", aiProcessingError: null } });
    await callRecordingAiQueue.obliterate({ force: true });
  } catch (error) {
    console.error("Could not disable call recording AI processing", error);
  } finally {
    await callRecordingAiQueue.close().catch((error) => console.error("Could not close retired call recording AI queue", error));
  }
})();
new Worker("conversation-reassignment", async (job) => {
  const { conversationId, messageId, assignedAgentId } = job.data as { conversationId: string; messageId: string; assignedAgentId: string };
  await assignConversation(conversationId, undefined, { forceReassign: true, expectedUnanswered: { messageId, assignedAgentId } });
}, { connection: redis });
void (async () => {
  const activeConversations = await prisma.conversation.findMany({ where: { channel: { in: accessControlledChannels }, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING, ConversationStatus.QUEUED] }, awaitingRouting: false }, select: { id: true, channel: true } });
  for (const conversation of activeConversations) await assignConversation(conversation.id, undefined, { reassignIfIneligible: true });
})().catch((error) => console.error("Could not align active channel assignments with access policies", error));
new Worker("conversation-sla", async (job) => {
  const { conversationId, messageId } = job.data as { conversationId: string; messageId: string };
  const [conversation, inboundMessage] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: conversationId }, include: { customer: { select: { name: true, phone: true } } } }),
    prisma.message.findFirst({ where: { id: messageId, conversationId, direction: MessageDirection.INBOUND }, select: { createdAt: true } })
  ]);
  if (!conversation || !inboundMessage || terminalStatuses.includes(conversation.status) || conversation.lastInboundAt?.getTime() !== inboundMessage.createdAt.getTime() || conversation.lastAgentResponseAt && conversation.lastAgentResponseAt >= inboundMessage.createdAt) return;
  const updated = await prisma.conversation.update({ where: { id: conversationId }, data: { slaBreachedAt: new Date() } });
  await audit(null, "SLA_BREACHED", conversationId, { assignedAgentId: conversation.assignedAgentId, thresholdMinutes: config.slaResponseMinutes });
  await emitConversationEvent(conversation.id, conversation.channel, "sla:breached", { conversation: updated, assignedAgentId: conversation.assignedAgentId }, { audience: "managers" });
  const viewerWhere = await channelViewerWhere(conversation.channel);
  const managerScope = { OR: [{ role: Role.ADMIN }, { role: Role.SUPERVISOR, canViewAllConversations: true }, { role: Role.SUPERVISOR, canViewAllConversations: null }] };
  const [recipients, assignedViewer] = await Promise.all([
    prisma.user.findMany({ where: { isActive: true, AND: [managerScope, { OR: [{ role: Role.ADMIN }, viewerWhere] }] }, select: { id: true } }),
    conversation.assignedAgentId ? prisma.user.findFirst({ where: { id: conversation.assignedAgentId, isActive: true, OR: [{ role: Role.ADMIN }, viewerWhere] }, select: { id: true } }) : Promise.resolve(null)
  ]);
  if (assignedViewer) io.to(`agent:${assignedViewer.id}`).emit("sla:breached", updated);
  const customerLabel = conversation.customer.name || conversation.customer.phone || "عميل";
  void sendPushNotification(recipients.map((recipient) => recipient.id), { title: "تنبيه مهلة الرد", body: `لم يصل رد للعميل ${customerLabel} خلال ${config.slaResponseMinutes} دقائق.`, url: `/admin/dashboard?conversation=${encodeURIComponent(conversationId)}`, tag: `sla-${conversationId}` }).catch((error) => console.warn("SLA push notification failed", error));
  if (assignedViewer) void sendPushNotification([assignedViewer.id], { title: "تنبيه مهلة الرد", body: `لم يصل رد للعميل ${customerLabel} خلال ${config.slaResponseMinutes} دقائق.`, url: `/agent/workspace?conversation=${encodeURIComponent(conversationId)}`, tag: `sla-${conversationId}` }).catch((error) => console.warn("Agent SLA push notification failed", error));
}, { connection: redis });

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: "حدث خطأ داخلي" });
});

server.listen(config.port, () => console.info(`Bondoq API listening on :${config.port}`));
