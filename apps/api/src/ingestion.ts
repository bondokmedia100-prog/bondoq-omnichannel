import { ConversationStatus, Department, MessageDirection, MessageKind, Prisma, Role } from "@prisma/client";
import type { NormalizedInbound } from "./providers";
import { prisma } from "./prisma";
import { assignConversation, scheduleSla } from "./routing";
import { io } from "./realtime";
import { sendRoutingMenu, sendToChannel } from "./providers";
import { kalemlyExternalMessageId } from "./KalemlyWaService";
import { transcribeAudioMessage } from "./transcription";
import { findMatchingAutoReply } from "./autoReplies";
import { sendPushNotification } from "./pushNotifications";

export async function ingestMessage(inbound: NormalizedInbound) {
  const customer = await prisma.customer.upsert({
    where: { id: `external_${inbound.channel.toLowerCase()}_${inbound.externalCustomerId}` },
    update: {
      ...(inbound.customerName ? { name: inbound.customerName } : {}),
      ...(inbound.profilePictureUrl ? { avatarUrl: inbound.profilePictureUrl } : {}),
      ...(inbound.customerPhone ? { phone: inbound.customerPhone } : {}),
      ...(inbound.latitude === undefined ? {} : { lastLatitude: inbound.latitude }),
      ...(inbound.longitude === undefined ? {} : { lastLongitude: inbound.longitude }),
      channelIdentifiers: { [inbound.channel.toLowerCase()]: inbound.externalCustomerId }
    },
    create: {
      id: `external_${inbound.channel.toLowerCase()}_${inbound.externalCustomerId}`,
      name: inbound.customerName,
      phone: inbound.customerPhone || (inbound.channel === "WHATSAPP" ? inbound.externalCustomerId : null),
      avatarUrl: inbound.profilePictureUrl,
      lastLatitude: inbound.latitude,
      lastLongitude: inbound.longitude,
      channelIdentifiers: { [inbound.channel.toLowerCase()]: inbound.externalCustomerId }
    }
  });
  let conversation = await prisma.conversation.findUnique({ where: { channel_externalConversationId: { channel: inbound.channel, externalConversationId: inbound.externalConversationId } } });
  const isNewConversation = !conversation;
  if (isNewConversation) {
    conversation = await prisma.conversation.create({ data: {
      customerId: customer.id, channel: inbound.channel, externalConversationId: inbound.externalConversationId,
      externalCustomerId: inbound.externalCustomerId, status: ConversationStatus.QUEUED, awaitingRouting: true
    } });
  }
  if (!conversation) throw new Error("Conversation could not be created");
  let message;
  try {
    message = await prisma.message.create({ data: {
      conversationId: conversation.id, direction: MessageDirection.INBOUND, kind: inbound.kind || MessageKind.TEXT,
      text: inbound.text, mediaUrl: inbound.mediaUrl, latitude: inbound.latitude, longitude: inbound.longitude,
      externalId: `${inbound.channel}:${inbound.externalId}`, metadata: (inbound.metadata || {}) as Prisma.InputJsonValue
    } });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return { duplicate: true, conversationId: conversation.id };
    throw error;
  }
  const pendingSurvey = await prisma.csatSurvey.findUnique({ where: { conversationId: conversation.id } });
  const autoRules = inbound.text ? await prisma.autoReplyRule.findMany({ where: { isActive: true, isWelcome: false }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] }) : [];
  const autoReply = inbound.routingDepartment ? undefined : findMatchingAutoReply(autoRules, inbound.text);
  const routeChoice = conversation.awaitingRouting ? inbound.routingDepartment || autoReply?.routingDepartment || (autoReply ? Department.HEADQUARTERS : undefined) : undefined;
  const ratingText = (inbound.text || "").trim()
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
  const customerRating = /^(?:[1-5]|[1-5]\s*(?:نجوم|star(?:s)?))$/i.test(ratingText)
    ? Number(ratingText.match(/[1-5]/)?.[0]) : undefined;
  const isRatingReply = Boolean(pendingSurvey && pendingSurvey.rating === null && customerRating);
  let nextAwaitingRouting = conversation.awaitingRouting;
  if (routeChoice) nextAwaitingRouting = false;
  else if (conversation.awaitingRouting && !isNewConversation) nextAwaitingRouting = false;
  const shouldPreserveResolved = isRatingReply && (conversation.status === ConversationStatus.RESOLVED || conversation.status === ConversationStatus.CLOSED);
  conversation = await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: message.createdAt, lastInboundAt: message.createdAt, unreadCount: { increment: 1 },
      status: shouldPreserveResolved ? conversation.status : conversation.status === ConversationStatus.CLOSED || conversation.status === ConversationStatus.RESOLVED ? ConversationStatus.OPEN : conversation.status,
      closedAt: shouldPreserveResolved ? conversation.closedAt : conversation.status === ConversationStatus.CLOSED || conversation.status === ConversationStatus.RESOLVED ? null : conversation.closedAt,
      awaitingRouting: nextAwaitingRouting,
      ...(routeChoice ? { routingDepartment: routeChoice, isComplaint: Boolean(inbound.isComplaint) } : {}),
      ...(!routeChoice && conversation.awaitingRouting && !isNewConversation ? { routingDepartment: null, isComplaint: false } : {})
    }
  });

  if (isRatingReply && pendingSurvey && customerRating) {
    const survey = await prisma.csatSurvey.update({ where: { id: pendingSurvey.id }, data: { rating: customerRating, ratedAt: message.createdAt } });
    await prisma.auditLog.create({ data: { conversationId: conversation.id, action: "CSAT_RECEIVED", details: { rating: customerRating, agentId: survey.agentId } } });
    if (io) {
      io.to("admins").emit(customerRating < 3 ? "csat:low" : "csat:received", { conversationId: conversation.id, rating: customerRating, customer, agentId: survey.agentId });
      io.to(`conversation:${conversation.id}`).emit("message:new", { conversationId: conversation.id, message, customer });
    }
    return { conversationId: conversation.id, messageId: message.id, csatRating: customerRating };
  }

  const initiallyAssignedAgentId = conversation.assignedAgentId;
  const payload = { conversation, message, customer };
  if (io) {
    const targets = io.to("admins").to(`conversation:${conversation.id}`);
    if (conversation.assignedAgentId) targets.to(`agent:${conversation.assignedAgentId}`).emit("message:new", payload);
    else targets.emit("message:new", payload);
  }

  if (autoReply) {
    try {
      const result: any = await sendToChannel({ channel: inbound.channel, recipient: inbound.externalCustomerId, text: autoReply.responseText });
      const providerId = kalemlyExternalMessageId(result);
      const reply = await prisma.message.create({ data: {
        conversationId: conversation.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.TEXT, text: autoReply.responseText,
        externalId: providerId ? `${inbound.channel}:${providerId}` : undefined,
        metadata: { automation: "auto-reply", ruleId: autoReply.id }
      } });
      conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: reply.createdAt } });
      io?.to(`conversation:${conversation.id}`).to("admins").emit("message:new", { conversationId: conversation.id, message: reply });
      if (conversation.assignedAgentId) io?.to(`agent:${conversation.assignedAgentId}`).emit("message:new", { conversationId: conversation.id, message: reply });
    } catch (error) {
      console.error("Automatic reply delivery failed", error);
    }
  }

  if (isNewConversation && !autoReply) {
    try {
      const welcomeRule = await prisma.autoReplyRule.findFirst({ where: { isWelcome: true }, orderBy: { priority: "desc" } });
      if (welcomeRule && !welcomeRule.isActive) {
        conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { awaitingRouting: false } });
        conversation = await assignConversation(conversation.id);
      } else {
      const result: any = await sendRoutingMenu(inbound.channel, inbound.externalCustomerId, welcomeRule?.responseText);
      const providerId = kalemlyExternalMessageId(result);
      const menuMessage = await prisma.message.create({ data: {
        conversationId: conversation.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.TEXT,
        text: `${welcomeRule?.responseText || "أهلًا بك في حلواني بندق."}\nاكتب رقم الخدمة التي تحتاجها:\n1- طلب دليفري سريع\n2- حجز تورتة مناسبات\n3- المنيو والفروع\n4- شكوى أو مقترح`,
        externalId: providerId ? `${inbound.channel}:${providerId}` : undefined,
        metadata: { automation: "pre-routing-menu" }
      } });
      conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: menuMessage.createdAt } });
      }
    } catch (error) {
      console.error("Pre-routing menu send failed; assigning conversation to the default queue", error);
      conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { awaitingRouting: false } });
      conversation = await assignConversation(conversation.id);
      await scheduleSla(conversation.id, message.id);
    }
  } else if (conversation.awaitingRouting || !conversation.assignedAgentId) {
    if (routeChoice) conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { awaitingRouting: false, routingDepartment: routeChoice } });
    conversation = await assignConversation(conversation.id, routeChoice as Department | undefined);
  }

  if (io && conversation.assignedAgentId && conversation.assignedAgentId !== initiallyAssignedAgentId) {
    io.to(`agent:${conversation.assignedAgentId}`).emit("message:new", payload);
  }
  const admins = await prisma.user.findMany({ where: {
    isActive: true,
    OR: [
      { role: Role.ADMIN },
      { role: Role.SUPERVISOR, canViewAllConversations: true },
      { role: Role.SUPERVISOR, canViewAllConversations: null }
    ]
  }, select: { id: true } });
  const preview = inbound.text?.trim() || (inbound.kind === MessageKind.IMAGE ? "صورة مرفقة" : inbound.kind === MessageKind.AUDIO ? "رسالة صوتية" : inbound.kind === MessageKind.FILE ? "ملف مرفق" : "رسالة واردة");
  const tag = `inbound-${conversation.id}`;
  void sendPushNotification(admins.map((admin) => admin.id), { title: customer.name || customer.phone || "رسالة واردة", body: preview.slice(0, 160), url: `/admin/dashboard?conversation=${encodeURIComponent(conversation.id)}`, tag }).catch((error) => console.warn("Admin push notification failed", error));
  if (conversation.assignedAgentId) void sendPushNotification([conversation.assignedAgentId], { title: customer.name || customer.phone || "رسالة واردة", body: preview.slice(0, 160), url: `/agent/workspace?conversation=${encodeURIComponent(conversation.id)}`, tag }).catch((error) => console.warn("Agent push notification failed", error));
  await scheduleSla(conversation.id, message.id);
  if (message.kind === MessageKind.AUDIO) void transcribeAudioMessage(message.id).catch((error) => console.error("Voice note transcription failed", error));
  return { conversationId: conversation.id, messageId: message.id };
}
