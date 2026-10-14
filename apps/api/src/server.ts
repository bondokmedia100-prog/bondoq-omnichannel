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
import { adminGuard, agentGuard, authenticate, AuthedRequest, canReadConversation, canWorkOnConversation, hasPermission, permissionGuard, signToken } from "./auth";
import { prisma } from "./prisma";
import { initRealtime, io } from "./realtime";
import { assignConversation, dispatchQueued, releaseAgentConversations } from "./routing";
import { answerTelegramCallback, fetchInboundMedia, parseKalemlyWebhook, parseMetaWebhook, parseTelegramWebhook, sendCsatPrompt, sendToChannel } from "./providers";
import { ingestMessage } from "./ingestion";
import { getKalemlySettings, safeProviderResponse, saveKalemlySettings, sendKalemlyTest, startKalemlyWaWorker, kalemlyExternalMessageId } from "./KalemlyWaService";
import { startOfCairoDay } from "./cairoTime";
import { getMessengerSettings, getTelegramSettings, saveMessengerSettings, saveTelegramSettings } from "./ChannelIntegrationService";
import { allowedMediaTypes, publicMediaUrl, safeFileName, uploadLimitBytes, verifyPublicMediaUrl } from "./mediaStorage";
import { getPushConfig, sendPushNotification } from "./pushNotifications";

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
const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,32}$/, "اسم المستخدم من 3 إلى 32 حرفًا، ويقبل الحروف الإنجليزية والأرقام والنقطة والشرطة");
const permissionFields = { canViewAllConversations: z.boolean().nullable().optional(), canTransferConversations: z.boolean().nullable().optional(), canManageCatalog: z.boolean().nullable().optional(), canViewReports: z.boolean().nullable().optional(), canManageTeam: z.boolean().nullable().optional() };
const staffSelect = { id: true, email: true, username: true, name: true, role: true, department: true, branchId: true, branch: { select: { id: true, name: true } }, presence: true, isActive: true, canViewAllConversations: true, canTransferConversations: true, canManageCatalog: true, canViewReports: true, canManageTeam: true } as const;
const defaultBranches = Array.from({ length: 8 }, (_, index) => ({ id: `branch-${index + 1}`, name: `الفرع ${index + 1}` }));
async function ensureBranches() {
  await Promise.all(defaultBranches.map((branch) => prisma.branch.upsert({ where: { id: branch.id }, update: {}, create: branch })));
}
const isMessenger = (channel: Channel) => channel === Channel.MESSENGER;
const isUniqueConstraintError = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
async function lastInboundAt(conversationId: string, stored?: Date | null) {
  if (stored) return stored;
  const latest = await prisma.message.findFirst({ where: { conversationId, direction: MessageDirection.INBOUND }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  return latest?.createdAt || null;
}
function messengerWindowOpen(channel: Channel, inboundAt: Date | null) {
  return !isMessenger(channel) || Boolean(inboundAt && Date.now() - inboundAt.getTime() < MESSENGER_WINDOW_MS);
}

app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "bondoq-api" }));

app.post("/api/media", agentGuard, express.raw({ type: () => true, limit: uploadLimitBytes }), async (req: AuthedRequest, res: express.Response) => {
  try { publicMediaUrl("configuration-check", 0); }
  catch { return res.status(503).json({ error: "لم يتم إعداد API_PUBLIC_URL صالح وآمن لاستقبال الوسائط" }); }
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "اختر ملفًا صالحًا" });
  const contentType = String(req.header("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!allowedMediaTypes.has(contentType)) return res.status(415).json({ error: "نوع الملف غير مدعوم" });
  let fileName: string;
  try { fileName = safeFileName(decodeURIComponent(req.header("x-file-name") || "attachment")); }
  catch { return res.status(400).json({ error: "اسم الملف غير صالح" }); }
  const asset = await prisma.mediaAsset.create({ data: {
    fileName, contentType, size: req.body.length, data: Uint8Array.from(req.body), createdById: req.user!.id
  }, select: { id: true, fileName: true, contentType: true, size: true } });
  res.status(201).json({ ...asset, url: publicMediaUrl(asset.id, 0) });
});

app.get("/public-media/:id", async (req, res) => {
  if (!verifyPublicMediaUrl(req.params.id, req.query.expires, req.query.signature)) return res.sendStatus(403);
  const asset = await prisma.mediaAsset.findUnique({ where: { id: req.params.id }, select: { data: true, contentType: true, fileName: true, size: true } });
  if (!asset) return res.sendStatus(404);
  res.set({
    "Content-Type": asset.contentType,
    "Content-Length": String(asset.size),
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`,
    "Cache-Control": "public, max-age=3600",
    "X-Content-Type-Options": "nosniff"
  }).send(asset.data);
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
    io.to("admins").emit("presence:updated", { userId: req.user!.id, presence: Presence.OFFLINE });
    await releaseAgentConversations(req.user!.id);
  }
  io.in(`user:${req.user!.id}`).disconnectSockets(true);
  res.sendStatus(204);
});

app.get("/api/auth/me", authenticate, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { id: true, username: true, name: true, email: true, role: true, department: true, branchId: true, branch: { select: { name: true } }, presence: true, canViewAllConversations: true, canTransferConversations: true, canManageCatalog: true, canViewReports: true, canManageTeam: true } });
  if (!user) return res.status(401).json({ error: "الحساب غير موجود" });
  res.json(user);
});

app.patch("/api/auth/me", authenticate, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ username: usernameSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "اسم المستخدم غير صالح" });
  try {
    const user = await prisma.user.update({ where: { id: req.user!.id }, data: { username: parsed.data.username }, select: { id: true, username: true, name: true, email: true, role: true, department: true, presence: true } });
    await audit(user.id, "USERNAME_UPDATED");
    res.json(user);
  } catch (error) {
    if (isUniqueConstraintError(error)) return res.status(409).json({ error: "اسم المستخدم مستخدم بالفعل" });
    throw error;
  }
});

app.get("/api/conversations", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const actor = req.user!;
  const scope = hasPermission(actor, "canViewAllConversations") ? {} : { assignedAgentId: actor.id };
  const channel = typeof req.query.channel === "string" ? req.query.channel : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const conversations = await prisma.conversation.findMany({
    where: { ...scope, ...(channel && channel !== "ALL" ? { channel: channel as Channel } : {}), ...(status && status !== "ALL" ? { status: status as ConversationStatus } : {}) },
    include: { customer: true, assignedAgent: { select: { id: true, name: true, presence: true } }, messages: { orderBy: { createdAt: "desc" }, take: 1 } }, orderBy: { lastMessageAt: "desc" }, take: 100
  });
  res.json(conversations);
});

app.get("/api/conversations/:id", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  let conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, include: {
    customer: { include: { orders: { orderBy: { createdAt: "desc" }, take: 10 } } }, assignedAgent: { select: { id: true, name: true } },
    messages: { include: { author: { select: { id: true, name: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 200 }, whisperNotes: { include: { author: { select: { name: true } } }, orderBy: { createdAt: "asc" } }
  } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canReadConversation(req.user!, conversation)) return res.status(403).json({ error: "هذه المحادثة ليست ضمن محادثاتك" });
  if (!conversation.lastInboundAt) {
    const receivedAt = await lastInboundAt(conversation.id);
    if (receivedAt) conversation = { ...conversation, lastInboundAt: receivedAt };
  }
  await prisma.conversation.update({ where: { id: conversation.id }, data: { unreadCount: 0 } });
  await audit(req.user!.id, "CONVERSATION_OPENED", conversation.id);
  conversation.messages.reverse();
  res.json(conversation);
});

app.post("/api/conversations/:id/reply", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ text: z.string().optional(), kind: z.nativeEnum(MessageKind).default(MessageKind.TEXT), mediaUrl: z.string().url().optional(), mediaAssetId: z.string().optional(), latitude: z.number().optional(), longitude: z.number().optional() }).safeParse(req.body);
  if (!parsed.success || (!parsed.data.text && parsed.data.kind === MessageKind.TEXT)) return res.status(400).json({ error: "الرسالة غير صالحة" });
  const mediaKind = parsed.data.kind === MessageKind.IMAGE || parsed.data.kind === MessageKind.AUDIO || parsed.data.kind === MessageKind.FILE;
  if (mediaKind && !parsed.data.mediaUrl && !parsed.data.mediaAssetId || parsed.data.kind === MessageKind.LOCATION && (parsed.data.latitude === undefined || parsed.data.longitude === undefined)) return res.status(400).json({ error: "يلزم إرفاق ملف أو رابط وسيط أو إحداثيات الموقع" });
  if (!mediaKind && (parsed.data.mediaAssetId || parsed.data.mediaUrl)) return res.status(400).json({ error: "نوع الملف لا يطابق نوع الرسالة" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "ليس لديك صلاحية الرد على هذه المحادثة" });
  const receivedAt = await lastInboundAt(conversation.id, conversation.lastInboundAt);
  if (!messengerWindowOpen(conversation.channel, receivedAt)) return res.status(409).json({ code: "META_WINDOW_EXPIRED", error: "انتهت نافذة الرد في Messenger. انتظر رسالة جديدة من العميل." });
  try {
    const asset = parsed.data.mediaAssetId ? await prisma.mediaAsset.findUnique({ where: { id: parsed.data.mediaAssetId } }) : null;
    if (parsed.data.mediaAssetId && !asset) return res.status(404).json({ error: "الملف المرفق غير موجود" });
    if (asset && (parsed.data.kind === MessageKind.IMAGE && !asset.contentType.startsWith("image/") || parsed.data.kind === MessageKind.AUDIO && !asset.contentType.startsWith("audio/") || parsed.data.kind === MessageKind.FILE && (asset.contentType.startsWith("image/") || asset.contentType.startsWith("audio/")))) return res.status(400).json({ error: "نوع الملف لا يطابق نوع الرسالة" });
    const mediaUrl = asset ? publicMediaUrl(asset.id) : parsed.data.mediaUrl;
    const result: any = await sendToChannel({ channel: conversation.channel, recipient: conversation.externalCustomerId, ...parsed.data, mediaUrl, mediaContentType: asset?.contentType });
    const providerId = kalemlyExternalMessageId(result);
    const message = await prisma.message.create({ data: {
      conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND,
      kind: parsed.data.kind, text: parsed.data.text, mediaUrl, mediaAssetId: asset?.id, deliveryStatus: "SENT", latitude: parsed.data.latitude,
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
  const parsed = z.union([
    z.object({ productIds: z.array(z.string().min(1)).min(1).max(12) }),
    z.object({ productId: z.string().min(1) })
  ]).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اختر منتجًا من الكتالوج" });
  const productIds = "productIds" in parsed.data ? [...new Set(parsed.data.productIds)] : [parsed.data.productId];
  const [conversation, products] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: req.params.id } }),
    prisma.product.findMany({ where: { id: { in: productIds }, isAvailable: true } })
  ]);
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "ليس لديك صلاحية على هذه المحادثة" });
  if (products.length !== productIds.length) return res.status(404).json({ error: "أحد المنتجات المحددة غير متوفر" });
  if (products.some((product) => !product.imageUrl && !product.imageAssetId)) return res.status(409).json({ error: "أضف صور المنتجات المحددة قبل إرسالها للعميل" });
  const receivedAt = await lastInboundAt(conversation.id, conversation.lastInboundAt);
  if (!messengerWindowOpen(conversation.channel, receivedAt)) return res.status(409).json({ code: "META_WINDOW_EXPIRED", error: "انتهت نافذة الرد في Messenger. انتظر رسالة جديدة من العميل." });
  const results: any[] = [];
  for (const product of productIds.map((id) => products.find((item) => item.id === id)!)) {
    const text = `${product.name}\nالسعر: ${product.price.toFixed(2)} جنيه${product.description ? `\n${product.description}` : ""}`;
    try {
      const textResult: any = await sendToChannel({ channel: conversation.channel, recipient: conversation.externalCustomerId, text });
      const textProviderId = kalemlyExternalMessageId(textResult);
      const textMessage = await prisma.message.create({ data: { conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.TEXT, text, productId: product.id, deliveryStatus: "SENT", externalId: textProviderId ? `${conversation.channel}:${textProviderId}` : undefined } });
      io.to(`conversation:${conversation.id}`).to("admins").emit("message:new", { conversationId: conversation.id, message: textMessage });
      const imageUrl = product.imageAssetId ? publicMediaUrl(product.imageAssetId) : product.imageUrl!;
      let imageMessage: any;
      let imageError: string | undefined;
      try {
        const imageResult: any = await sendToChannel({ channel: conversation.channel, recipient: conversation.externalCustomerId, kind: MessageKind.IMAGE, mediaUrl: imageUrl });
        const imageProviderId = kalemlyExternalMessageId(imageResult);
        imageMessage = await prisma.message.create({ data: { conversationId: conversation.id, authorId: req.user!.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.IMAGE, mediaUrl: imageUrl, mediaAssetId: product.imageAssetId, productId: product.id, deliveryStatus: "SENT", externalId: imageProviderId ? `${conversation.channel}:${imageProviderId}` : undefined } });
        io.to(`conversation:${conversation.id}`).to("admins").emit("message:new", { conversationId: conversation.id, message: imageMessage });
      } catch (error) { imageError = error instanceof Error ? error.message : "تعذر إرسال الصورة"; }
      const lastMessage = imageMessage || textMessage;
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: lastMessage.createdAt, lastAgentResponseAt: lastMessage.createdAt, firstResponseAt: conversation.firstResponseAt || lastMessage.createdAt, slaBreachedAt: null, status: ConversationStatus.OPEN } });
      results.push({ productId: product.id, name: product.name, textMessage, imageMessage, captionDelivery: "sent", imageDelivery: imageMessage ? "sent" : "failed", ...(imageError ? { imageError } : {}) });
    } catch (error) {
      results.push({ productId: product.id, name: product.name, captionDelivery: "failed", imageDelivery: "not-sent", error: error instanceof Error ? error.message : "تعذر إرسال المنتج للقناة" });
    }
  }
  await audit(req.user!.id, "PRODUCT_SENT", conversation.id, { productIds, results: results.map(({ productId, captionDelivery, imageDelivery }) => ({ productId, captionDelivery, imageDelivery })) });
  if (results.every((result) => result.captionDelivery !== "sent")) return res.status(502).json({ error: results[0]?.error || "تعذر إرسال المنتجات للقناة", items: results });
  res.status(201).json({ items: results, ...(results.length === 1 ? results[0] : {}) });
});

app.get("/api/products", agentGuard, async (_req: express.Request, res: express.Response) => {
  const products = await prisma.product.findMany({ where: { isAvailable: true }, orderBy: [{ category: "asc" }, { name: "asc" }] });
  res.json(products.map((product) => product.imageAssetId ? { ...product, imageUrl: publicMediaUrl(product.imageAssetId, 0) } : product));
});
app.get("/api/branches", agentGuard, async (_req: express.Request, res: express.Response) => {
  await ensureBranches();
  res.json(await prisma.branch.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { id: "asc" } }));
});
app.get("/api/admin/products", permissionGuard("canManageCatalog"), async (_req: express.Request, res: express.Response) => {
  const products = await prisma.product.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] });
  res.json(products.map((product) => product.imageAssetId ? { ...product, imageUrl: publicMediaUrl(product.imageAssetId, 0) } : product));
});
app.post("/api/admin/products", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ name: z.string().min(2).max(120), category: z.nativeEnum(ProductCategory), price: z.number().nonnegative(), imageUrl: httpsUrl.nullable().optional(), imageAssetId: z.string().nullable().optional(), description: z.string().max(800).nullable().optional(), isAvailable: z.boolean().default(true) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "راجع اسم المنتج وقسمه وسعره ورابط صورته" });
  const asset = parsed.data.imageAssetId ? await prisma.mediaAsset.findFirst({ where: { id: parsed.data.imageAssetId, contentType: { startsWith: "image/" } }, select: { id: true } }) : null;
  if (parsed.data.imageAssetId && !asset) return res.status(400).json({ error: "صورة المنتج غير موجودة أو ليست صورة" });
  const product = await prisma.product.create({ data: { ...parsed.data, imageUrl: asset ? publicMediaUrl(asset.id, 0) : parsed.data.imageUrl, imageAssetId: asset?.id, price: new Prisma.Decimal(parsed.data.price) } });
  await audit(req.user!.id, "PRODUCT_CREATED", undefined, { productId: product.id });
  res.status(201).json(product);
});
app.patch("/api/admin/products/:id", permissionGuard("canManageCatalog"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ name: z.string().min(2).max(120).optional(), category: z.nativeEnum(ProductCategory).optional(), price: z.number().nonnegative().optional(), imageUrl: httpsUrl.nullable().optional(), imageAssetId: z.string().nullable().optional(), description: z.string().max(800).nullable().optional(), isAvailable: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "بيانات المنتج غير صالحة" });
  const { price, imageAssetId, ...fields } = parsed.data;
  const asset = imageAssetId ? await prisma.mediaAsset.findFirst({ where: { id: imageAssetId, contentType: { startsWith: "image/" } }, select: { id: true } }) : null;
  if (imageAssetId && !asset) return res.status(400).json({ error: "صورة المنتج غير موجودة أو ليست صورة" });
  const imageFields = imageAssetId !== undefined
    ? { imageAssetId: asset?.id || null, ...(asset ? { imageUrl: publicMediaUrl(asset.id, 0) } : {}) }
    : fields.imageUrl !== undefined ? { imageAssetId: null } : {};
  const product = await prisma.product.update({ where: { id: req.params.id }, data: { ...fields, ...imageFields, ...(price === undefined ? {} : { price: new Prisma.Decimal(price) }) } });
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
  io.to(`agent:${conversation.assignedAgentId}`).to(`conversation:${conversation.id}`).emit("whisper:new", note);
  res.status(201).json(note);
});

app.patch("/api/conversations/:id/assignment", permissionGuard("canTransferConversations"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ agentId: z.string().nullable(), branchId: z.string().nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اختر الموظف الجديد" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canReadConversation(req.user!, conversation)) return res.status(403).json({ error: "لا تملك صلاحية لتحويل هذه المحادثة" });
  if (parsed.data.agentId) {
    const assignee = await prisma.user.findFirst({ where: { id: parsed.data.agentId, role: { in: [Role.AGENT, Role.BRANCH_USER] }, isActive: true }, select: { id: true, role: true, presence: true, branchId: true } });
    if (!assignee) return res.status(400).json({ error: "الموظف المحدد غير متاح" });
    if (assignee.presence !== Presence.ONLINE) return res.status(409).json({ error: "لا يمكن إسناد محادثة لموظف غير متصل" });
    if (assignee.role === Role.BRANCH_USER && !assignee.branchId) return res.status(409).json({ error: "اربط الموظف بفرع قبل إسناد المحادثة" });
  }
  const target = parsed.data.agentId ? await prisma.user.findUniqueOrThrow({ where: { id: parsed.data.agentId }, select: { role: true, branchId: true } }) : null;
  const branchId = target?.role === Role.BRANCH_USER ? target.branchId : parsed.data.branchId !== undefined ? parsed.data.branchId : parsed.data.agentId ? null : conversation.branchId;
  if (branchId) {
    await ensureBranches();
    const branch = await prisma.branch.findFirst({ where: { id: branchId, isActive: true }, select: { id: true } });
    if (!branch) return res.status(400).json({ error: "الفرع المحدد غير موجود أو متوقف" });
  }
  const updated = await prisma.conversation.update({ where: { id: conversation.id }, data: { assignedAgentId: parsed.data.agentId, branchId, routingDepartment: branchId ? Department.BRANCH : conversation.routingDepartment === Department.BRANCH ? null : conversation.routingDepartment, status: parsed.data.agentId ? ConversationStatus.OPEN : ConversationStatus.QUEUED, awaitingRouting: false } });
  await audit(req.user!.id, "CONVERSATION_REASSIGNED", conversation.id, { from: conversation.assignedAgentId, to: parsed.data.agentId });
  if (conversation.assignedAgentId && conversation.assignedAgentId !== parsed.data.agentId) io.to(`agent:${conversation.assignedAgentId}`).emit("conversation:unassigned", updated);
  if (parsed.data.agentId) io.to(`agent:${parsed.data.agentId}`).emit("conversation:assigned", updated);
  else await assignConversation(conversation.id, branchId ? Department.BRANCH : undefined);
  io.to("admins").emit("conversation:updated", updated);
  res.json(updated);
});

app.patch("/api/conversations/:id/status", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ status: z.nativeEnum(ConversationStatus) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "الحالة غير صالحة" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "لا تملك صلاحية تعديل المحادثة" });
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
        const survey = await prisma.csatSurvey.create({ data: { conversationId: conversation.id, agentId: conversation.assignedAgentId || (req.user!.role === Role.AGENT || req.user!.role === Role.BRANCH_USER ? req.user!.id : null) } });
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
  if (!canReadConversation(req.user!, message.conversation)) return res.status(403).json({ error: "لا تملك صلاحية عرض هذا الملف" });
  try {
    if (message.mediaAssetId) {
      const asset = await prisma.mediaAsset.findUnique({ where: { id: message.mediaAssetId }, select: { data: true, contentType: true, fileName: true, size: true } });
      if (!asset) return res.status(404).json({ error: "الملف غير موجود" });
      return res.set({ "Content-Type": asset.contentType, "Content-Length": String(asset.size), "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" }).send(asset.data);
    }
    const media = await fetchInboundMedia(message.conversation.channel, (message.metadata || {}) as unknown as Record<string, unknown>, message.mediaUrl || undefined);
    res.setHeader("Content-Type", media.contentType); res.setHeader("Cache-Control", "private, max-age=300"); res.setHeader("X-Content-Type-Options", "nosniff"); res.send(media.body);
  } catch { res.status(404).json({ error: "تعذر تحميل الملف من المنصة" }); }
});

app.post("/api/conversations/:id/orders", agentGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ product: z.string().optional(), size: z.string().optional(), filling: z.string().optional(), cakeMessage: z.string().optional(), deliveryAt: z.string().datetime().optional(), deliveryAddress: z.string().optional(), notes: z.string().optional(), price: z.number().nonnegative().optional(), referenceImageMessageId: z.string().nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "تفاصيل الطلب غير صالحة" });
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: "المحادثة غير موجودة" });
  if (!canWorkOnConversation(req.user!, conversation)) return res.status(403).json({ error: "لا تملك صلاحية لهذا الطلب" });
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
  if (existing.conversation && !canWorkOnConversation(req.user!, existing.conversation)) return res.status(403).json({ error: "لا تملك صلاحية تعديل هذا الطلب" });
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
  if (presence === Presence.OFFLINE) await releaseAgentConversations(userId);
  res.json({ presence });
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
  const webhookSecret = config.kalemlyWebhookSecret || settings.appKey;
  res.json({ endpoint: settings.endpoint, authKeyConfigured: Boolean(settings.authKey), appKeyConfigured: Boolean(settings.appKey), qrCodePayload: settings.qrCodePayload, webhookAuthConfigured: Boolean(webhookSecret), webhookUrlToken: webhookSecret ? kalemlyWebhookUrlToken(webhookSecret) : "" });
});

app.put("/api/admin/integrations/kalemlywa", adminGuard, async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({ authKey: z.string().max(2048).optional(), appKey: z.string().max(2048).optional(), qrCodePayload: z.string().max(12000).optional(), clearQrCode: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "تحقق من authkey وappkey وحمولة QR" });
  const settings = await saveKalemlySettings(parsed.data);
  await audit(req.user!.id, "KALEMLYWA_SETTINGS_UPDATED", undefined, { authKeyConfigured: Boolean(settings.authKey), appKeyConfigured: Boolean(settings.appKey), qrCodeUpdated: parsed.data.qrCodePayload !== undefined || Boolean(parsed.data.clearQrCode) });
  const webhookSecret = config.kalemlyWebhookSecret || settings.appKey;
  res.json({ endpoint: settings.endpoint, authKeyConfigured: Boolean(settings.authKey), appKeyConfigured: Boolean(settings.appKey), qrCodePayload: settings.qrCodePayload, webhookAuthConfigured: Boolean(webhookSecret), webhookUrlToken: webhookSecret ? kalemlyWebhookUrlToken(webhookSecret) : "" });
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
      body: JSON.stringify({ url: parsed.data.url, secret_token: settings.webhookSecret, allowed_updates: ["message", "callback_query"] }),
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
  const [openChats, queue, slaBreached, agents, todayResponses, closedToday, recentAudit, allRatings] = await Promise.all([
    prisma.conversation.count({ where: { status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] } } }),
    prisma.conversation.count({ where: { status: ConversationStatus.QUEUED } }),
    prisma.conversation.count({ where: { slaBreachedAt: { not: null }, status: { not: ConversationStatus.CLOSED } } }),
    prisma.user.findMany({ where: { role: { in: [Role.AGENT, Role.BRANCH_USER] } }, select: { id: true, name: true, email: true, role: true, department: true, branchId: true, presence: true, isActive: true, sessions: { where: { startedAt: { gte: today } }, select: { startedAt: true, endedAt: true } } }, orderBy: { name: "asc" } }),
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

app.get("/api/admin/branches", permissionGuard("canManageTeam"), async (_req: express.Request, res: express.Response) => {
  await ensureBranches();
  res.json(await prisma.branch.findMany({ where: { isActive: true }, orderBy: { id: "asc" } }));
});
app.patch("/api/admin/branches/:id", permissionGuard("canManageTeam"), async (req: AuthedRequest, res: express.Response) => {
  await ensureBranches();
  const parsed = z.object({ name: z.string().trim().min(2).max(80) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "اكتب اسمًا للفرع من حرفين إلى 80 حرفًا" });
  if (!defaultBranches.some((branch) => branch.id === req.params.id)) return res.status(404).json({ error: "الفرع غير موجود" });
  const branch = await prisma.branch.update({ where: { id: req.params.id }, data: parsed.data });
  await audit(req.user!.id, "BRANCH_RENAMED", undefined, { branchId: branch.id, name: branch.name });
  res.json(branch);
});

app.get("/api/admin/agents", adminGuard, async (_req: express.Request, res: express.Response) => res.json(await prisma.user.findMany({ where: { role: { in: [Role.AGENT, Role.BRANCH_USER] } }, select: { id: true, name: true, role: true, department: true, branchId: true, branch: { select: { id: true, name: true } }, presence: true, isActive: true }, orderBy: { name: "asc" } })));
app.get("/api/admin/team", permissionGuard("canManageTeam"), async (_req: express.Request, res: express.Response) => res.json(await prisma.user.findMany({ where: { role: { not: Role.ADMIN } }, select: staffSelect, orderBy: { name: "asc" } })));
app.post("/api/admin/agents", permissionGuard("canManageTeam"), async (req: AuthedRequest, res: express.Response) => {
  const parsed = z.object({
    name: z.string().trim().min(2).max(100), email: z.string().trim().email().max(254), username: usernameSchema.optional(), password: z.string().min(10).max(128),
    role: z.nativeEnum(Role).default(Role.AGENT), department: z.nativeEnum(Department).nullable().optional(), branchId: z.string().nullable().optional(), ...permissionFields
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "راجع بيانات الموظف" });
  const { password, email, name, username: suppliedUsername, role, department, branchId, ...permissions } = parsed.data;
  const normalizedEmail = email.toLowerCase();
  const emailUsername = normalizedEmail.split("@")[0].replace(/[^a-z0-9._-]/g, "_").slice(0, 32);
  const username = suppliedUsername || (emailUsername.length >= 3 ? emailUsername : `user_${emailUsername || "member"}`.slice(0, 32));
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: "اكتب اسم مستخدم صالحًا من 3 إلى 32 حرفًا" });
  if (role === Role.ADMIN && req.user!.role !== Role.ADMIN) return res.status(403).json({ error: "إنشاء مدير نظام يتطلب صلاحية مدير النظام" });
  const assignedBranchId = branchId || null;
  if ((role === Role.BRANCH_USER || department === Department.BRANCH) && !assignedBranchId) return res.status(400).json({ error: "اختر الفرع لمستخدم الفرع" });
  if (assignedBranchId) {
    await ensureBranches();
    if (!await prisma.branch.findFirst({ where: { id: assignedBranchId, isActive: true }, select: { id: true } })) return res.status(400).json({ error: "الفرع المحدد غير موجود" });
  }
  try {
    const user = await prisma.user.create({
      data: { email: normalizedEmail, username, name, role, department: department ?? (role === Role.BRANCH_USER ? Department.BRANCH : null), branchId: role === Role.BRANCH_USER || department === Department.BRANCH ? assignedBranchId : null, passwordHash: await bcrypt.hash(password, 12), ...permissions } as Prisma.UserUncheckedCreateInput,
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
    department: z.nativeEnum(Department).nullable().optional(), branchId: z.string().nullable().optional(), ...permissionFields
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "بيانات التعديل غير صالحة" });
  if (!Object.keys(parsed.data).length) return res.status(400).json({ error: "لا توجد تغييرات لحفظها" });
  const previous = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, role: true, department: true, branchId: true, canViewAllConversations: true, canTransferConversations: true, canManageCatalog: true, canViewReports: true, canManageTeam: true } });
  if (!previous) return res.status(404).json({ error: "حساب الموظف غير موجود" });
  if (previous.role === Role.ADMIN) return res.status(403).json({ error: "حساب مدير النظام محمي من التعديل عبر إدارة الفريق" });
  const role = parsed.data.role ?? previous.role;
  if (role === Role.ADMIN && req.user!.role !== Role.ADMIN) return res.status(403).json({ error: "تعيين مدير نظام يتطلب صلاحية مدير النظام" });
  const branchId = parsed.data.branchId === undefined ? previous.branchId : parsed.data.branchId;
  const department = parsed.data.department === undefined ? previous.department : parsed.data.department;
  if ((role === Role.BRANCH_USER || department === Department.BRANCH) && !branchId) return res.status(400).json({ error: "اختر الفرع لمستخدم الفرع" });
  if (branchId) {
    await ensureBranches();
    if (!await prisma.branch.findFirst({ where: { id: branchId, isActive: true }, select: { id: true } })) return res.status(400).json({ error: "الفرع المحدد غير موجود" });
  }
  const policyChanged = parsed.data.role !== undefined && parsed.data.role !== previous.role ||
    parsed.data.department !== undefined && parsed.data.department !== previous.department ||
    parsed.data.branchId !== undefined && parsed.data.branchId !== previous.branchId ||
    (Object.keys(permissionFields) as Array<keyof typeof permissionFields>).some((key) => {
      const requested = parsed.data[key];
      if (requested === undefined) return false;
      const defaultValue = previous.role === Role.ADMIN || previous.role === Role.SUPERVISOR;
      return (previous[key] ?? defaultValue) !== requested;
    });
  const revokeSessions = Boolean(parsed.data.password || parsed.data.isActive === false || policyChanged);
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
    ...Object.fromEntries(Object.keys(permissionFields).filter((key) => parsed.data[key as keyof typeof parsed.data] !== undefined).map((key) => [key, parsed.data[key as keyof typeof parsed.data]])),
    ...(revokeSessions ? { authVersion: { increment: 1 }, ...(role === Role.AGENT || role === Role.BRANCH_USER ? { presence: Presence.OFFLINE } : {}) } : {})
  };
  try {
    const user = await prisma.user.update({ where: { id: previous.id }, data, select: staffSelect });
    if (parsed.data.isActive === false || revokeSessions && (previous.role === Role.AGENT || previous.role === Role.BRANCH_USER) || previous.role !== role || previous.branchId !== user.branchId || previous.department !== user.department) {
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
  if (!settings.verifyToken) return res.status(503).send("Meta verify token is not configured");
  const valid = req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === settings.verifyToken;
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
  if (!verifyMetaSignature(req, settings.appSecret)) return res.sendStatus(401);
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
  try {
    for (const message of parseKalemlyWebhook(req.body)) await ingestMessage(message);
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
  try { for (const message of parseTelegramWebhook(req.body)) await ingestMessage(message); }
  catch (error) { console.error("Telegram webhook ingestion failed", error); }
});

const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const kalemlyWorker = startKalemlyWaWorker();
kalemlyWorker.on("failed", (job, error) => console.error("KalemlyWA outbound delivery failed", job?.id, error));
new Worker("conversation-sla", async (job) => {
  const { conversationId, messageId } = job.data as { conversationId: string; messageId: string };
  const [conversation, inboundMessage] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: conversationId }, include: { customer: { select: { name: true, phone: true } } } }),
    prisma.message.findFirst({ where: { id: messageId, conversationId, direction: MessageDirection.INBOUND }, select: { createdAt: true } })
  ]);
  if (!conversation || !inboundMessage || terminalStatuses.includes(conversation.status) || conversation.lastInboundAt?.getTime() !== inboundMessage.createdAt.getTime() || conversation.lastAgentResponseAt && conversation.lastAgentResponseAt >= inboundMessage.createdAt) return;
  const updated = await prisma.conversation.update({ where: { id: conversationId }, data: { slaBreachedAt: new Date() } });
  await audit(null, "SLA_BREACHED", conversationId, { assignedAgentId: conversation.assignedAgentId, thresholdMinutes: config.slaResponseMinutes });
  io.to("admins").emit("sla:breached", { conversation: updated, assignedAgentId: conversation.assignedAgentId });
  if (conversation.assignedAgentId) io.to(`agent:${conversation.assignedAgentId}`).emit("sla:breached", updated);
  const recipients = await prisma.user.findMany({ where: { isActive: true, OR: [{ role: Role.ADMIN }, { role: Role.SUPERVISOR, canViewAllConversations: true }, { role: Role.SUPERVISOR, canViewAllConversations: null }] }, select: { id: true } });
  const customerLabel = conversation.customer.name || conversation.customer.phone || "عميل";
  void sendPushNotification(recipients.map((recipient) => recipient.id), { title: "تنبيه مهلة الرد", body: `لم يصل رد للعميل ${customerLabel} خلال ${config.slaResponseMinutes} دقائق.`, url: `/admin/dashboard?conversation=${encodeURIComponent(conversationId)}`, tag: `sla-${conversationId}` }).catch((error) => console.warn("SLA push notification failed", error));
  if (conversation.assignedAgentId) void sendPushNotification([conversation.assignedAgentId], { title: "تنبيه مهلة الرد", body: `لم يصل رد للعميل ${customerLabel} خلال ${config.slaResponseMinutes} دقائق.`, url: `/agent/workspace?conversation=${encodeURIComponent(conversationId)}`, tag: `sla-${conversationId}` }).catch((error) => console.warn("Agent SLA push notification failed", error));
}, { connection: redis });

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: "حدث خطأ داخلي" });
});

server.listen(config.port, () => console.info(`Bondoq API listening on :${config.port}`));
