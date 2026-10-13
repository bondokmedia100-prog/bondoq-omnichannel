import crypto from "node:crypto";
import http from "node:http";
import cors from "cors";
import express from "express";
import bcrypt from "bcryptjs";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { z } from "zod";
import { Channel, ConversationStatus, Department, MessageDirection, MessageKind, OrderStatus, Presence, Prisma, ProductCategory, Role } from "@prisma/client";
import { config } from "./config";
import { adminGuard, agentGuard, authenticate, AuthedRequest, signToken } from "./auth";
import { prisma } from "./prisma";
import { initRealtime, io } from "./realtime";
import { assignConversation, dispatchQueued } from "./routing";
import { answerTelegramCallback, fetchInboundMedia, parseKalemlyWebhook, parseMetaWebhook, parseTelegramWebhook, sendCsatPrompt, sendToChannel } from "./providers";
import { ingestMessage } from "./ingestion";
import { getKalemlySettings, safeProviderResponse, saveKalemlySettings, sendKalemlyTest, startKalemlyWaWorker, kalemlyExternalMessageId } from "./KalemlyWaService";
import { startOfCairoDay } from "./cairoTime";

const app = express();
const server = http.createServer(app);
initRealtime(server);
app.use(cors({ origin: config.webOrigin, credentials: true }));
app.use(express.json({ limit: "15mb", verify: (req: any, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));

const audit = (actorId: string | null, action: string, conversationId?: string, details: Prisma.InputJsonValue = {}) =>
  prisma.auditLog.create({ data: { actorId, action, conversationId, details } });
const MESSENGER_WINDOW_MS = 24 * 60 * 60 * 1000;
const terminalStatuses: ConversationStatus[] = [ConversationStatus.CLOSED, ConversationStatus.RESOLVED];
const httpsUrl = z.string().url().refine((value) => value.startsWith("https://"), "استخدم رابط HTTPS آمنًا");
const isMessenger = (channel: Channel) => channel === Channel.MESSENGER;
async function lastInboundAt(conversationId: string, stored?: Date | null) {
  if (stored) return stored;
  const latest = await prisma.message.findFirst({ where: { conversationId, direction: MessageDirection.INBOUND }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  return latest?.createdAt || null;
}
function messengerWindowOpen(channel: Channel, inboundAt: Date | null) {
  return !isMessenger(channel) || Boolean(inboundAt && Date.now() - inboundAt.getTime() < MESSENGER_WINDOW_MS);
}

app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "bondoq-api" }));

app.post("/api/auth/login", async (req, res) => {
  const parsed = z.object({ identifier: z.string().min(1), password: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "أدخل البريد أو اسم المستخدم وكلمة المرور" });
  const { identifier, password } = parsed.data;
  const user = await prisma.user.findFirst({ where: { OR: [{ email: identifier.toLowerCase() }, { username: identifier.toLowerCase() }] } });
  if (!user || !user.isActive || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });
  if (user.role === Role.AGENT && user.presence === Presence.OFFLINE) {
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { presence: Presence.ONLINE, lastSeenAt: new Date() } }),
      prisma.agentSession.create({ data: { userId: user.id, startState: Presence.ONLINE } }),
      prisma.auditLog.create({ data: { actorId: user.id, action: "AGENT_LOGIN" } })
    ]);
  }
  if (user.role === Role.AGENT) await dispatchQueued();
  const token = signToken({ id: user.id, role: user.role, name: user.name, authVersion: user.authVersion });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, department: user.department } });
});

app.post("/api/auth/logout", authenticate, async (req: AuthedRequest, res) => {
  const isAgent = req.user!.role === Role.AGENT;
  await prisma.user.update({ where: { id: req.user!.id }, data: { authVersion: { increment: 1 }, ...(isAgent ? { presence: Presence.OFFLINE, lastSeenAt: new Date() } : {}) } });
  await prisma.auditLog.create({ data: { actorId: req.user!.id, action: isAgent ? "AGENT_LOGOUT" : "USER_LOGOUT" } });
  if (isAgent) {
    await prisma.agentSession.updateMany({ where: { userId: req.user!.id, endedAt: null }, data: { endedAt: new Date(), endState: Presence.OFFLINE } });
    io.to("admins").emit("presence:updated", { userId: req.user!.id, presence: Presence.OFFLINE });
  }
  io.in(`user:${req.user!.id}`).disconnectSockets(true);
  res.sendStatus(204);
});

app.get("/api/auth/me", authenticate, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { id: true, name: true, email: true, role: true, department: true, presence: true } });
  if (!user) return res.status(401).json({ error: "الحساب غير موجود" });
  res.json(user);
});

app.get("/api/conversations", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const isAdmin = req.user!.role !== Role.AGENT;
  const channel = typeof req.query.channel === "string" ? req.query.channel : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const conversations = await prisma.conversation.findMany({
    where: { ...(isAdmin ? {} : { assignedAgentId: req.user!.id }), ...(channel && channel !== "ALL" ? { channel: channel as Channel } : {}), ...(status && status !== "ALL" ? { status: status as ConversationStatus } : {}) },
    include: { customer: true, assignedAgent: { select: { id: true, name: true, presence: true } }, messages: { orderBy: { createdAt: "desc" }, take: 1 } }, orderBy: { lastMessageAt: "desc" }, take: 100
  });
  res.json(conversations);
});

app.get("/api/conversations/:id", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  let conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, include: {
    customer: { include: { orders: { orderBy: { createdAt: "desc" }, take: 10 } } }, assignedAgent: { select: { id: true, name: true } },
    messages: { include: { author: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" }, take: 200 }, whisperNotes: { include: { author: { select: { name: true } } }, orderBy: { createdAt: "asc" } }
  } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (req.user!.role === Role.AGENT && conversation.assignedAgentId !== req.user!.id) return res.status(403).json({ error: "هذه المحادثة ليست ضمن محادثاتك" });
  if (!conversation.lastInboundAt) {
    const receivedAt = await lastInboundAt(conversation.id);
    if (receivedAt) conversation = { ...conversation, lastInboundAt: receivedAt };
  }
  await prisma.conversation.update({ where: { id: conversation.id }, data: { unreadCount: 0 } });
  await audit(req.user!.id, "CONVERSATION_OPENED", conversation.id);
  res.json(conversation);
});

app.post("/api/conversations/:id/reply", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ text: z.string().optional(), kind: z.nativeEnum(MessageKind).default(MessageKind.TEXT), mediaUrl: z.string().url().optional(), latitude: z.number().optional(), longitude: z.number().optional() }).safeParse(req.body);
  if (!parsed.success || (!parsed.data.text && parsed.data.kind === MessageKind.TEXT)) return res.status(400).json({ error: "الرسالة غير صالحة" });
  const mediaKind = parsed.data.kind === MessageKind.IMAGE || parsed.data.kind === MessageKind.AUDIO || parsed.data.kind === MessageKind.FILE;
  if (mediaKind && !parsed.data.mediaUrl || parsed.data.kind === MessageKind.LOCATION && (parsed.data.latitude === undefined || parsed.data.longitude === undefined)) return res.status(400).json({ error: "يلزم إرفاق رابط الوسيط أو إحداثيات الموقع" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (req.user!.role === Role.AGENT && conversation.assignedAgentId !== req.user!.id) return res.status(403).json({ error: "ليس لديك صلاحية الرد على هذه المحادثة" });
  const receivedAt = await lastInboundAt(conversation.id, conversation.lastInboundAt);
  if (!messengerWindowOpen(conversation.channel, receivedAt)) return res.status(409).json({ code: "META_WINDOW_EXPIRED", error: "انتهت نافذة الرد في Messenger. انتظر رسالة جديدة من العميل." });
  try {
    const result: any = await sendToChannel({ channel: conversation.channel, recipient: conversation.externalCustomerId, ...parsed.data });
    const providerId = kalemlyExternalMessageId(result);
    const message = await prisma.message.create({ data: {
      conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND,
      kind: parsed.data.kind, text: parsed.data.text, mediaUrl: parsed.data.mediaUrl, latitude: parsed.data.latitude,
      longitude: parsed.data.longitude, externalId: providerId ? `${conversation.channel}:${providerId}` : undefined
    } });
    await prisma.conversation.update({ where: { id: conversation.id }, data: {
      lastMessageAt: message.createdAt, lastAgentResponseAt: message.createdAt, firstResponseAt: conversation.firstResponseAt || message.createdAt, slaBreachedAt: null, status: ConversationStatus.OPEN
    } });
    await audit(req.user!.id, "MESSAGE_SENT", conversation.id, { kind: parsed.data.kind });
    io.to(`conversation:${conversation.id}`).to("admins").emit("message:new", { conversationId: conversation.id, message });
    res.status(201).json(message);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "تعذر إرسال الرسالة للقناة" });
  }
});

app.post("/api/conversations/:id/products", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ productId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اختر منتجًا من الكتالوج" });
  const [conversation, product] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: req.params.id } }),
    prisma.product.findFirst({ where: { id: parsed.data.productId, isAvailable: true } })
  ]);
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (req.user!.role === Role.AGENT && conversation.assignedAgentId !== req.user!.id) return res.status(403).json({ error: "ليس لديك صلاحية على هذه المحادثة" });
  if (!product) return res.status(404).json({ error: "المنتج غير متوفر" });
  if (!product.imageUrl) return res.status(409).json({ error: "أضف رابط صورة المنتج قبل إرساله للعميل" });
  const receivedAt = await lastInboundAt(conversation.id, conversation.lastInboundAt);
  if (!messengerWindowOpen(conversation.channel, receivedAt)) return res.status(409).json({ code: "META_WINDOW_EXPIRED", error: "انتهت نافذة الرد في Messenger. انتظر رسالة جديدة من العميل." });
  const text = `${product.name}\nالسعر: ${product.price.toFixed(2)} جنيه${product.description ? `\n${product.description}` : ""}`;
  try {
    const result: any = await sendToChannel({ channel: conversation.channel, recipient: conversation.externalCustomerId, kind: MessageKind.IMAGE, mediaUrl: product.imageUrl, text });
    const providerId = kalemlyExternalMessageId(result);
    const message = await prisma.message.create({ data: { conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.IMAGE, text, mediaUrl: product.imageUrl, productId: product.id, externalId: providerId ? `${conversation.channel}:${providerId}` : undefined } });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: message.createdAt, lastAgentResponseAt: message.createdAt, firstResponseAt: conversation.firstResponseAt || message.createdAt, slaBreachedAt: null, status: ConversationStatus.OPEN } });
    await audit(req.user!.id, "PRODUCT_SENT", conversation.id, { productId: product.id });
    io.to(`conversation:${conversation.id}`).to("admins").emit("message:new", { conversationId: conversation.id, message });
    res.status(201).json({ ...message, captionDelivery: result?.captionDelivery || "sent" });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : "تعذر إرسال المنتج للقناة" }); }
});

app.get("/api/products", agentGuard, async (_req: express.Request, res: express.Response) => res.json(await prisma.product.findMany({ where: { isAvailable: true }, orderBy: [{ category: "asc" }, { name: "asc" }] })));
app.get("/api/admin/products", adminGuard, async (_req: express.Request, res: express.Response) => res.json(await prisma.product.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] })));
app.post("/api/admin/products", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ name: z.string().min(2).max(120), category: z.nativeEnum(ProductCategory), price: z.number().nonnegative(), imageUrl: httpsUrl.nullable().optional(), description: z.string().max(800).nullable().optional(), isAvailable: z.boolean().default(true) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "راجع اسم المنتج وقسمه وسعره ورابط صورته" });
  const product = await prisma.product.create({ data: { ...parsed.data, price: new Prisma.Decimal(parsed.data.price) } });
  await audit(req.user!.id, "PRODUCT_CREATED", undefined, { productId: product.id });
  res.status(201).json(product);
});
app.patch("/api/admin/products/:id", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ name: z.string().min(2).max(120).optional(), category: z.nativeEnum(ProductCategory).optional(), price: z.number().nonnegative().optional(), imageUrl: httpsUrl.nullable().optional(), description: z.string().max(800).nullable().optional(), isAvailable: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "بيانات المنتج غير صالحة" });
  const { price, ...fields } = parsed.data;
  const product = await prisma.product.update({ where: { id: req.params.id }, data: { ...fields, ...(price === undefined ? {} : { price: new Prisma.Decimal(price) }) } });
  await audit(req.user!.id, "PRODUCT_UPDATED", undefined, { productId: product.id });
  res.json(product);
});

app.post("/api/conversations/:id/whisper", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ text: z.string().min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اكتب الملاحظة السرية" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, include: { assignedAgent: { select: { role: true } } } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!conversation.assignedAgentId || conversation.assignedAgent?.role !== Role.AGENT) return res.status(409).json({ error: "أسند المحادثة لموظف قبل إرسال توجيه سري" });
  const note = await prisma.whisperNote.create({ data: { conversationId: conversation.id, authorId: req.user!.id, text: parsed.data.text } });
  await audit(req.user!.id, "WHISPER_SENT", conversation.id);
  io.to(`agent:${conversation.assignedAgentId}`).to(`conversation:${conversation.id}`).emit("whisper:new", note);
  res.status(201).json(note);
});

app.patch("/api/conversations/:id/assignment", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ agentId: z.string().nullable() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اختر الموظف الجديد" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (parsed.data.agentId) {
    const assignee = await prisma.user.findFirst({ where: { id: parsed.data.agentId, role: { in: [Role.AGENT, Role.ADMIN, Role.SUPERVISOR] }, isActive: true } });
    if (!assignee) return res.status(400).json({ error: "الموظف المحدد غير متاح" });
  }
  const updated = await prisma.conversation.update({ where: { id: conversation.id }, data: { assignedAgentId: parsed.data.agentId, status: parsed.data.agentId ? ConversationStatus.OPEN : ConversationStatus.QUEUED } });
  await audit(req.user!.id, "CONVERSATION_REASSIGNED", conversation.id, { from: conversation.assignedAgentId, to: parsed.data.agentId });
  if (parsed.data.agentId) io.to(`agent:${parsed.data.agentId}`).emit("conversation:assigned", updated);
  io.to("admins").emit("conversation:updated", updated);
  res.json(updated);
});

app.patch("/api/conversations/:id/status", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ status: z.nativeEnum(ConversationStatus) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "الحالة غير صالحة" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (req.user!.role === Role.AGENT && conversation.assignedAgentId !== req.user!.id) return res.status(403).json({ error: "لا تملك صلاحية تعديل المحادثة" });
  const updated = await prisma.conversation.update({ where: { id: conversation.id }, data: { status: parsed.data.status, closedAt: terminalStatuses.includes(parsed.data.status) ? new Date() : null } });
  await audit(req.user!.id, parsed.data.status === ConversationStatus.CLOSED ? "CONVERSATION_CLOSED" : "CONVERSATION_STATUS_CHANGED", conversation.id, { status: parsed.data.status });
  io.to("admins").emit("conversation:updated", updated);
  let csatDelivery: "sent" | "already-requested" | "failed" | "not-requested" = "not-requested";
  if (parsed.data.status === ConversationStatus.RESOLVED) {
    const existingSurvey = await prisma.csatSurvey.findUnique({ where: { conversationId: conversation.id } });
    if (existingSurvey) csatDelivery = "already-requested";
    else {
      try {
        const receivedAt = await lastInboundAt(conversation.id, conversation.lastInboundAt);
        const result: any = await sendCsatPrompt(conversation.channel, conversation.externalCustomerId, !messengerWindowOpen(conversation.channel, receivedAt));
        const providerId = kalemlyExternalMessageId(result);
        const survey = await prisma.csatSurvey.create({ data: { conversationId: conversation.id, agentId: conversation.assignedAgentId || (req.user!.role === Role.AGENT ? req.user!.id : null) } });
        const message = await prisma.message.create({ data: { conversationId: conversation.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.TEXT,
          text: "شكرًا لاختيارك حلواني بندق. كيف تقيّم خدمتنا؟ أرسل رقمًا من 1 إلى 5، حيث 5 ممتاز و1 يحتاج إلى تحسين.",
          externalId: providerId ? `${conversation.channel}:${providerId}` : undefined, metadata: { automation: "csat-survey", surveyId: survey.id } } });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: message.createdAt } });
        io.to(`conversation:${conversation.id}`).to("admins").emit("message:new", { conversationId: conversation.id, message });
        csatDelivery = "sent";
      } catch (error) {
        console.error("CSAT survey delivery failed", error);
        await audit(req.user!.id, "CSAT_DELIVERY_FAILED", conversation.id, { reason: error instanceof Error ? error.message : "unknown" });
        io.to("admins").emit("csat:delivery-failed", { conversationId: conversation.id });
        csatDelivery = "failed";
      }
    }
  }
  res.json({ ...updated, csatDelivery });
});

app.get("/api/conversations/:id/messages/:messageId/media", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const message = await prisma.message.findFirst({ where: { id: req.params.messageId, conversationId: req.params.id }, include: { conversation: true } });
  if (!message) return res.status(404).json({ error: "الملف غير موجود" });
  if (req.user!.role === Role.AGENT && message.conversation.assignedAgentId !== req.user!.id) return res.status(403).json({ error: "لا تملك صلاحية عرض هذا الملف" });
  try {
    const media = await fetchInboundMedia(message.conversation.channel, (message.metadata || {}) as unknown as Record<string, unknown>, message.mediaUrl || undefined);
    res.setHeader("Content-Type", media.contentType); res.setHeader("Cache-Control", "private, max-age=300"); res.send(media.body);
  } catch { res.status(404).json({ error: "تعذر تحميل الملف من المنصة" }); }
});

app.post("/api/conversations/:id/orders", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ product: z.string().optional(), size: z.string().optional(), filling: z.string().optional(), cakeMessage: z.string().optional(), deliveryAt: z.string().datetime().optional(), deliveryAddress: z.string().optional(), notes: z.string().optional(), price: z.number().nonnegative().optional(), referenceImageMessageId: z.string().nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "تفاصيل الطلب غير صالحة" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (req.user!.role === Role.AGENT && conversation.assignedAgentId !== req.user!.id) return res.status(403).json({ error: "لا تملك صلاحية لهذا الطلب" });
  if (parsed.data.referenceImageMessageId) {
    const reference = await prisma.message.findFirst({ where: { id: parsed.data.referenceImageMessageId, conversationId: conversation.id, direction: MessageDirection.INBOUND, kind: MessageKind.IMAGE }, select: { id: true } });
    if (!reference) return res.status(400).json({ error: "صورة المرجع يجب أن تكون صورة واردة من محادثة العميل نفسها" });
  }
  const { price, ...fields } = parsed.data;
  const order = await prisma.orderDetails.create({ data: { ...fields, ...(price === undefined ? {} : { price: new Prisma.Decimal(price) }), deliveryAt: parsed.data.deliveryAt ? new Date(parsed.data.deliveryAt) : undefined, customerId: conversation.customerId, conversationId: conversation.id } });
  await audit(req.user!.id, "ORDER_CREATED", conversation.id, { orderId: order.id });
  res.status(201).json(order);
});

app.patch("/api/orders/:id/status", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ status: z.nativeEnum(OrderStatus) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "حالة الطلب غير صالحة" });
  const existing = await prisma.orderDetails.findUnique({ where: { id: req.params.id }, include: { conversation: true } });
  if (!existing) return res.status(404).json({ error: "الطلب غير موجود" });
  if (req.user!.role === Role.AGENT && existing.conversation?.assignedAgentId !== req.user!.id) return res.status(403).json({ error: "لا تملك صلاحية تعديل هذا الطلب" });
  const order = await prisma.orderDetails.update({ where: { id: existing.id }, data: { status: parsed.data.status } });
  await audit(req.user!.id, "ORDER_STATUS_CHANGED", existing.conversationId || undefined, { orderId: order.id, status: order.status });
  let notificationDelivery: "sent" | "not-sent" | "not-applicable" = "not-applicable";
  if (existing.status !== order.status && existing.conversation) {
    const receivedAt = await lastInboundAt(existing.conversation.id, existing.conversation.lastInboundAt);
    if (messengerWindowOpen(existing.conversation.channel, receivedAt)) {
      const statusText: Record<OrderStatus, string> = {
        DRAFT: "تم استلام طلبك وهو قيد المراجعة.", CONFIRMED: "تم تأكيد طلبك من حلواني بندق.",
        PREPARING: "بدأنا تجهيز طلبك بكل عناية.", OUT_FOR_DELIVERY: "طلبك خرج للتوصيل إليك.",
        DELIVERED: "تم تسليم طلبك. شكرًا لاختيارك حلواني بندق.", CANCELLED: "تم إلغاء طلبك. تواصل معنا إذا احتجت إلى مساعدة.", COMPLETED: "تم تسليم طلبك. شكرًا لاختيارك حلواني بندق."
      };
      try {
        const text = `${statusText[order.status]}\nرقم الطلب: ${order.id}`;
        const result: any = await sendToChannel({ channel: existing.conversation.channel, recipient: existing.conversation.externalCustomerId, text });
        const providerId = kalemlyExternalMessageId(result);
        const notification = await prisma.message.create({ data: {
          conversationId: existing.conversation.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.TEXT, text,
          externalId: providerId ? `${existing.conversation.channel}:${providerId}` : undefined, metadata: { automation: "order-status", orderId: order.id, status: order.status }
        } });
        await prisma.conversation.update({ where: { id: existing.conversation.id }, data: { lastMessageAt: notification.createdAt } });
        io.to(`conversation:${existing.conversation.id}`).to("admins").emit("message:new", { conversationId: existing.conversation.id, message: notification });
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
  io.to("admins").emit("presence:updated", { userId, presence });
  if (presence === Presence.ONLINE) await dispatchQueued();
  res.json({ presence });
});

app.get("/api/canned-responses", agentGuard, async (_req: express.Request, res: express.Response) => res.json(await prisma.cannedResponse.findMany({ where: { isActive: true }, orderBy: { title: "asc" } })));

app.get("/api/admin/integrations/kalemlywa", adminGuard, async (_req: express.Request, res: express.Response) => {
  const settings = await getKalemlySettings();
  res.json({ endpoint: settings.endpoint, instanceId: settings.instanceId, apiKeyConfigured: Boolean(settings.apiKey), qrCodePayload: settings.qrCodePayload, webhookSecretConfigured: Boolean(config.kalemlyWebhookSecret) });
});

app.put("/api/admin/integrations/kalemlywa", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ apiKey: z.string().max(2048).optional(), instanceId: z.string().max(180).optional(), qrCodePayload: z.string().max(12000).optional(), clearQrCode: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "تحقق من مفتاح API ومعرّف الجهاز وحمولة QR" });
  const settings = await saveKalemlySettings(parsed.data);
  await audit(req.user!.id, "KALEMLYWA_SETTINGS_UPDATED", undefined, { apiKeyConfigured: Boolean(settings.apiKey), instanceIdConfigured: Boolean(settings.instanceId), qrCodeUpdated: parsed.data.qrCodePayload !== undefined || Boolean(parsed.data.clearQrCode) });
  res.json({ endpoint: settings.endpoint, instanceId: settings.instanceId, apiKeyConfigured: Boolean(settings.apiKey), qrCodePayload: settings.qrCodePayload, webhookSecretConfigured: Boolean(config.kalemlyWebhookSecret) });
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

app.get("/api/admin/dashboard", adminGuard, async (_req: express.Request, res: express.Response) => {
  const today = startOfCairoDay();
  const [openChats, queue, slaBreached, agents, todayResponses, closedToday, recentAudit, allRatings] = await Promise.all([
    prisma.conversation.count({ where: { status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } } }),
    prisma.conversation.count({ where: { status: ConversationStatus.QUEUED } }),
    prisma.conversation.count({ where: { slaBreachedAt: { not: null }, status: { not: ConversationStatus.CLOSED } } }),
    prisma.user.findMany({ where: { role: Role.AGENT }, select: { id: true, name: true, email: true, department: true, presence: true, isActive: true, sessions: { where: { startedAt: { gte: today } }, select: { startedAt: true, endedAt: true } } }, orderBy: { name: "asc" } }),
    prisma.conversation.findMany({ where: { firstResponseAt: { gte: today } }, select: { createdAt: true, firstResponseAt: true, assignedAgentId: true } }),
    prisma.conversation.count({ where: { status: { in: [ConversationStatus.CLOSED, ConversationStatus.RESOLVED] }, closedAt: { gte: today } } }),
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 12, include: { actor: { select: { name: true } } } }),
    prisma.csatSurvey.findMany({ where: { rating: { not: null } }, select: { rating: true } })
  ]);
  const durations = todayResponses.flatMap((row) => row.firstResponseAt ? [row.firstResponseAt.getTime() - row.createdAt.getTime()] : []);
  const employeeStats = await Promise.all(agents.map(async (agent) => {
    const [activeChats, responses, ratings] = await Promise.all([
      prisma.conversation.count({ where: { assignedAgentId: agent.id, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } } }),
      prisma.conversation.findMany({ where: { assignedAgentId: agent.id, firstResponseAt: { gte: today } }, select: { createdAt: true, firstResponseAt: true } }),
      prisma.csatSurvey.findMany({ where: { agentId: agent.id, rating: { not: null } }, select: { rating: true } })
    ]);
    const seconds = responses.flatMap((row) => row.firstResponseAt ? [(row.firstResponseAt.getTime() - row.createdAt.getTime()) / 1000] : []);
    const sessionMinutes = agent.sessions.reduce((sum, session) => sum + ((session.endedAt || new Date()).getTime() - session.startedAt.getTime()) / 60000, 0);
     const closedOrders = await prisma.orderDetails.count({ where: { status: { in: [OrderStatus.DELIVERED, OrderStatus.COMPLETED] }, updatedAt: { gte: today }, conversation: { is: { assignedAgentId: agent.id } } } });
    const validRatings = ratings.flatMap((row) => row.rating === null ? [] : [row.rating]);
    return { ...agent, activeChats, avgResponseSeconds: seconds.length ? Math.round(seconds.reduce((a, b) => a + b, 0) / seconds.length) : null, avgCsat: validRatings.length ? Number((validRatings.reduce((a, b) => a + b, 0) / validRatings.length).toFixed(1)) : null, csatCount: validRatings.length, closedOrders, sessionMinutes: Math.round(sessionMinutes) };
  }));
  const ratings = allRatings.flatMap((row) => row.rating === null ? [] : [row.rating]);
  res.json({ kpis: { openChats, queue, slaBreached, avgResponseSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 1000) : null, closedToday, avgCsat: ratings.length ? Number((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)) : null, csatCount: ratings.length }, agents: employeeStats, recentAudit });
});

app.get("/api/admin/agents", adminGuard, async (_req: express.Request, res: express.Response) => res.json(await prisma.user.findMany({ where: { role: Role.AGENT }, select: { id: true, email: true, username: true, name: true, department: true, presence: true, isActive: true }, orderBy: { name: "asc" } })));
app.post("/api/admin/agents", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(10), department: z.nativeEnum(Department) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "راجع الاسم والبريد وكلمة المرور والقسم" });
  const username = parsed.data.email.split("@")[0].toLowerCase();
  try {
    const user = await prisma.user.create({ data: { ...parsed.data, email: parsed.data.email.toLowerCase(), username, role: Role.AGENT, passwordHash: await bcrypt.hash(parsed.data.password, 12) }, select: { id: true, name: true, email: true, username: true, role: true, department: true } });
    await audit(req.user!.id, "AGENT_CREATED", undefined, { agentId: user.id });
    res.status(201).json(user);
  } catch { res.status(409).json({ error: "البريد أو اسم المستخدم مستخدم بالفعل" }); }
});
app.patch("/api/admin/agents/:id", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ isActive: z.boolean().optional(), password: z.string().min(10).optional(), department: z.nativeEnum(Department).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "بيانات التعديل غير صالحة" });
  const data: Prisma.UserUpdateInput = {
    ...(parsed.data.isActive === undefined ? {} : { isActive: parsed.data.isActive, ...(parsed.data.isActive ? {} : { presence: Presence.OFFLINE, authVersion: { increment: 1 } }) }),
    ...(parsed.data.department === undefined ? {} : { department: parsed.data.department }),
    ...(parsed.data.password ? { passwordHash: await bcrypt.hash(parsed.data.password, 12), authVersion: { increment: 1 } } : {})
  };
  const user = await prisma.user.update({ where: { id: req.params.id }, data, select: { id: true, name: true, email: true, department: true, isActive: true } });
  if (parsed.data.isActive === false) {
    await prisma.agentSession.updateMany({ where: { userId: user.id, endedAt: null }, data: { endedAt: new Date(), endState: Presence.OFFLINE } });
    await prisma.conversation.updateMany({ where: { assignedAgentId: user.id, status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } }, data: { assignedAgentId: null, status: ConversationStatus.QUEUED } });
    await dispatchQueued();
    io.in(`agent:${user.id}`).disconnectSockets(true);
    io.to("admins").emit("presence:updated", { userId: user.id, presence: Presence.OFFLINE });
  }
  await audit(req.user!.id, "AGENT_UPDATED", undefined, { agentId: user.id, changes: Object.keys(parsed.data) });
  res.json(user);
});

app.get("/api/admin/audit", adminGuard, async (req, res) => {
  const logs = await prisma.auditLog.findMany({ take: 100, orderBy: { createdAt: "desc" }, include: { actor: { select: { name: true } }, conversation: { select: { id: true, channel: true } } } });
  res.json(logs);
});

app.get("/webhooks/meta", (req, res) => {
  const valid = req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === config.metaVerifyToken;
  if (valid) return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

function verifyMetaSignature(req: express.Request) {
  if (!config.metaAppSecret) return process.env.NODE_ENV !== "production";
  const signature = req.header("x-hub-signature-256");
  if (!signature || !Buffer.isBuffer((req as any).rawBody)) return false;
  const expected = `sha256=${crypto.createHmac("sha256", config.metaAppSecret).update((req as any).rawBody).digest("hex")}`;
  const actualBytes = Buffer.from(signature); const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

app.post("/webhooks/meta", async (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(401);
  if (req.body.object !== "page") return res.sendStatus(404);
  res.sendStatus(200);
  try { for (const message of parseMetaWebhook(req.body)) await ingestMessage(message); }
  catch (error) { console.error("Meta webhook ingestion failed", error); }
});

function secretMatches(expected: string, supplied: string) {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

app.post("/webhooks/kalemlywa", async (req, res) => {
  const expected = config.kalemlyWebhookSecret;
  if (!expected) return res.status(503).json({ error: "KalemlyWA webhook secret is not configured" });
  const supplied = req.header("x-kalemly-webhook-secret") || req.header("x-webhook-secret") || "";
  if (!secretMatches(expected, supplied)) return res.sendStatus(401);
  try {
    for (const message of parseKalemlyWebhook(req.body)) await ingestMessage(message);
    res.sendStatus(200);
  } catch (error) {
    console.error("KalemlyWA webhook ingestion failed", error);
    res.status(500).json({ error: "تعذر حفظ رسالة واتساب الواردة" });
  }
});

app.post("/webhooks/telegram", async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.header("x-telegram-bot-api-secret-token") !== secret) return res.sendStatus(401);
  res.sendStatus(200);
  if (req.body.callback_query?.id) void answerTelegramCallback(String(req.body.callback_query.id)).catch((error) => console.warn("Telegram callback acknowledgement failed", error));
  try { for (const message of parseTelegramWebhook(req.body)) await ingestMessage(message); }
  catch (error) { console.error("Telegram webhook ingestion failed", error); }
});

const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const kalemlyWorker = startKalemlyWaWorker();
kalemlyWorker.on("failed", (job, error) => console.error("KalemlyWA outbound delivery failed", job?.id, error));
new Worker("conversation-sla", async (job) => {
  const { conversationId, messageId } = job.data as { conversationId: string; messageId: string };
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } } });
  const latestMessage = conversation?.messages[0];
  if (!conversation || !latestMessage || terminalStatuses.includes(conversation.status) || latestMessage.id !== messageId || conversation.lastAgentResponseAt && conversation.lastAgentResponseAt > latestMessage.createdAt) return;
  const updated = await prisma.conversation.update({ where: { id: conversationId }, data: { slaBreachedAt: new Date() } });
  await audit(null, "SLA_BREACHED", conversationId, { assignedAgentId: conversation.assignedAgentId, thresholdMinutes: 3 });
  io.to("admins").emit("sla:breached", { conversation: updated, assignedAgentId: conversation.assignedAgentId });
  if (conversation.assignedAgentId) io.to(`agent:${conversation.assignedAgentId}`).emit("sla:breached", updated);
}, { connection: redis });

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: "حدث خطأ داخلي" });
});

server.listen(config.port, () => console.info(`Bondoq API listening on :${config.port}`));
