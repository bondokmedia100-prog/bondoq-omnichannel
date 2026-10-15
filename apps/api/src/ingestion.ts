import { ConversationStatus, Department, MessageDirection, MessageKind, Prisma, Role } from "@prisma/client";
import type { NormalizedInbound } from "./providers";
import { prisma } from "./prisma";
import { assignConversation, scheduleSla } from "./routing";
import { io } from "./realtime";
import { channelRecipient, fetchInboundMedia, sendRoutingMenu, sendToChannel } from "./providers";
import { kalemlyExternalMessageId } from "./KalemlyWaService";
import { transcribeAudioMessage } from "./transcription";
import { AUTO_REPLY_HANDOFF_TEXT, AUTO_REPLY_RESTART_MS, buildRoutingMenuText, getServiceChoice, findMatchingAutoReply } from "./autoReplies";
import { sendPushNotification } from "./pushNotifications";
import { safeFileName } from "./mediaStorage";

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
  let isNewConversation = !conversation;
  if (!conversation) {
    try {
      conversation = await prisma.conversation.create({ data: {
        customerId: customer.id, channel: inbound.channel, externalConversationId: inbound.externalConversationId,
        externalCustomerId: inbound.externalCustomerId, status: ConversationStatus.QUEUED, awaitingRouting: true
      } });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      conversation = await prisma.conversation.findUnique({ where: { channel_externalConversationId: { channel: inbound.channel, externalConversationId: inbound.externalConversationId } } });
      isNewConversation = false;
    }
  }
  if (!conversation) throw new Error("Conversation could not be created");
  const storedExternalId = `${inbound.channel}:${inbound.externalId}`;
  const existingMessage = await prisma.message.findUnique({ where: { externalId: storedExternalId }, select: { id: true, conversationId: true } });
  if (existingMessage) return { duplicate: true, conversationId: existingMessage.conversationId };
  const metadata = (inbound.metadata || {}) as Record<string, unknown>;
  let cachedMedia: { body: Buffer; contentType: string } | undefined = inbound.mediaBuffer
    ? { body: inbound.mediaBuffer, contentType: inbound.mediaContentType || String(metadata.mediaMimeType || "application/octet-stream") }
    : undefined;
  if (!cachedMedia && metadata.provider === "kalemlywa" && typeof metadata.mediaId === "string" && metadata.mediaId) {
    try {
      cachedMedia = await fetchInboundMedia(inbound.channel, metadata, inbound.mediaUrl);
    } catch (error) {
      console.warn("KalemlyWA inbound media cache failed", error instanceof Error ? error.message : error);
    }
  }
  let message;
  try {
    const contentType = cachedMedia?.contentType || String(metadata.mediaMimeType || "application/octet-stream");
    const extension = contentType.split(";")[0].split("/")[1]?.replace(/[^a-zA-Z0-9.+-]/g, "") || "bin";
    const fileName = inbound.mediaFileName || (inbound.kind === MessageKind.AUDIO
      ? `${metadata.voiceNote === true ? "voice-note" : "audio"}.${extension}`
      : inbound.kind === MessageKind.IMAGE ? `image.${extension}` : inbound.kind === MessageKind.VIDEO ? `video.${extension}` : `attachment.${extension}`);
    message = await prisma.message.create({ data: {
      conversation: { connect: { id: conversation.id } }, direction: MessageDirection.INBOUND, kind: inbound.kind || MessageKind.TEXT,
      text: inbound.text, mediaUrl: cachedMedia ? undefined : inbound.mediaUrl, latitude: inbound.latitude, longitude: inbound.longitude,
      externalId: storedExternalId, metadata: metadata as Prisma.InputJsonValue,
      ...(cachedMedia ? { mediaAsset: { create: {
        fileName: safeFileName(fileName), contentType, size: cachedMedia.body.length, data: Uint8Array.from(cachedMedia.body)
      } } } : {})
    } });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return { duplicate: true, conversationId: conversation.id };
    throw error;
  }
  const pendingSurvey = await prisma.csatSurvey.findUnique({ where: { conversationId: conversation.id } });
  const ratingText = (inbound.text || "").trim()
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
  const customerRating = /^(?:[1-5]|[1-5]\s*(?:نجوم|star(?:s)?))$/i.test(ratingText)
    ? Number(ratingText.match(/[1-5]/)?.[0]) : undefined;
  const isRatingReply = Boolean(pendingSurvey && pendingSurvey.rating === null && customerRating);
  const isTerminal = conversation.status === ConversationStatus.CLOSED || conversation.status === ConversationStatus.RESOLVED;
  const isIdle = Date.now() - conversation.lastMessageAt.getTime() >= AUTO_REPLY_RESTART_MS;
  const restartAutomation = !isRatingReply && (isNewConversation || isTerminal || isIdle);
  const awaitingChoice = !restartAutomation && conversation.awaitingRouting;
  const serviceChoice = awaitingChoice
    ? getServiceChoice(inbound.text) || getServiceChoice(inbound.routingDepartment)
    : undefined;
  const directHandoff = awaitingChoice && !serviceChoice;
  const autoRules = !restartAutomation && !awaitingChoice && !conversation.assignedAgentId && !conversation.serviceTag && inbound.text
    ? await prisma.autoReplyRule.findMany({ where: { isActive: true, isWelcome: false }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] })
    : [];
  const autoReply = findMatchingAutoReply(autoRules, inbound.text);
  const routeDepartment = serviceChoice?.routingDepartment as Department | undefined
    || (autoReply?.routingDepartment as Department | null | undefined)
    || inbound.routingDepartment;
  const shouldPreserveResolved = isRatingReply && (conversation.status === ConversationStatus.RESOLVED || conversation.status === ConversationStatus.CLOSED);
  const previousAssignedAgentId = conversation.assignedAgentId;
  const initiallyAssignedAgentId = restartAutomation ? null : conversation.assignedAgentId;
  conversation = await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: message.createdAt, lastInboundAt: message.createdAt, unreadCount: { increment: 1 },
      status: restartAutomation ? ConversationStatus.QUEUED : shouldPreserveResolved ? conversation.status : isTerminal ? ConversationStatus.OPEN : conversation.status,
      closedAt: restartAutomation ? null : shouldPreserveResolved ? conversation.closedAt : isTerminal ? null : conversation.closedAt,
      assignedAgentId: restartAutomation ? null : conversation.assignedAgentId,
      awaitingRouting: restartAutomation ? true : awaitingChoice ? false : conversation.awaitingRouting,
      routingDepartment: restartAutomation ? null : routeDepartment || (directHandoff ? null : conversation.routingDepartment),
      serviceTag: restartAutomation ? null : serviceChoice?.label || (directHandoff ? "تواصل مباشر" : conversation.serviceTag),
      isComplaint: restartAutomation ? false : serviceChoice?.isComplaint ?? (directHandoff ? false : inbound.isComplaint ?? conversation.isComplaint),
      ...(restartAutomation ? { firstResponseAt: null, lastAgentResponseAt: null, slaBreachedAt: null } : {})
    }
  });
  if (restartAutomation && previousAssignedAgentId) {
    io?.to(`agent:${previousAssignedAgentId}`).emit("conversation:unassigned", conversation);
  }

  if (isRatingReply && pendingSurvey && customerRating) {
    const survey = await prisma.csatSurvey.update({ where: { id: pendingSurvey.id }, data: { rating: customerRating, ratedAt: message.createdAt } });
    await prisma.auditLog.create({ data: { conversationId: conversation.id, action: "CSAT_RECEIVED", details: { rating: customerRating, agentId: survey.agentId } } });
    if (io) {
      io.to("admins").emit(customerRating < 3 ? "csat:low" : "csat:received", { conversationId: conversation.id, rating: customerRating, customer, agentId: survey.agentId });
      io.to(`conversation:${conversation.id}`).emit("message:new", { conversationId: conversation.id, message, customer });
    }
    return { conversationId: conversation.id, messageId: message.id, csatRating: customerRating };
  }

  const payload = { conversation, message, customer };
  if (io) {
    const targets = io.to("admins").to(`conversation:${conversation.id}`);
    if (conversation.assignedAgentId) targets.to(`agent:${conversation.assignedAgentId}`).emit("message:new", payload);
    else targets.emit("message:new", payload);
  }

  if (restartAutomation) {
    conversation = await assignConversation(conversation.id, undefined, { allowAwaitingRouting: true });
    try {
      const welcomeRule = await prisma.autoReplyRule.findFirst({
        where: { isActive: true, isWelcome: true },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
        select: { responseText: true }
      });
      const menuText = buildRoutingMenuText(welcomeRule?.responseText);
      const recipient = channelRecipient(inbound.channel, inbound.externalConversationId, inbound.externalCustomerId);
      const result: any = await sendRoutingMenu(inbound.channel, recipient, menuText);
      const providerId = kalemlyExternalMessageId(result);
      const menuMessage = await prisma.message.create({ data: {
        conversationId: conversation.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.TEXT, text: menuText,
        externalId: providerId ? `${inbound.channel}:${providerId}` : undefined,
        metadata: { automation: "service-menu" }
      } });
      conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: menuMessage.createdAt } });
      io?.to(`conversation:${conversation.id}`).to("admins").emit("message:new", { conversationId: conversation.id, message: menuMessage });
    } catch (error) {
      console.error("Service menu delivery failed; assigning conversation to the default queue", error);
      conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { awaitingRouting: false, serviceTag: "تواصل مباشر" } });
      conversation = await assignConversation(conversation.id);
    }
  } else if (serviceChoice || directHandoff) {
    conversation = await assignConversation(conversation.id, routeDepartment, { reassignIfIneligible: Boolean(serviceChoice) });
    try {
      const result: any = await sendToChannel({ channel: inbound.channel, recipient: channelRecipient(inbound.channel, inbound.externalConversationId, inbound.externalCustomerId), text: AUTO_REPLY_HANDOFF_TEXT });
      const providerId = kalemlyExternalMessageId(result);
      const handoffMessage = await prisma.message.create({ data: {
        conversationId: conversation.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.TEXT, text: AUTO_REPLY_HANDOFF_TEXT,
        externalId: providerId ? `${inbound.channel}:${providerId}` : undefined,
        metadata: { automation: "agent-handoff", service: serviceChoice?.label || "تواصل مباشر" }
      } });
      conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: handoffMessage.createdAt } });
      io?.to(`conversation:${conversation.id}`).to("admins").emit("message:new", { conversationId: conversation.id, message: handoffMessage });
      if (conversation.assignedAgentId) io?.to(`agent:${conversation.assignedAgentId}`).emit("message:new", { conversationId: conversation.id, message: handoffMessage });
    } catch (error) {
      console.error("Agent handoff acknowledgement failed", error);
    }
  } else if (autoReply) {
    try {
      const result: any = await sendToChannel({ channel: inbound.channel, recipient: channelRecipient(inbound.channel, inbound.externalConversationId, inbound.externalCustomerId), text: autoReply.responseText });
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

  if (!restartAutomation && !serviceChoice && !directHandoff && !autoReply && !conversation.awaitingRouting && !conversation.assignedAgentId) {
    conversation = await assignConversation(conversation.id, routeDepartment);
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
  const preview = inbound.text?.trim() || (inbound.kind === MessageKind.IMAGE ? "صورة مرفقة" : inbound.kind === MessageKind.STICKER ? "ملصق" : inbound.kind === MessageKind.AUDIO ? "رسالة صوتية" : inbound.kind === MessageKind.VIDEO ? "مقطع فيديو" : inbound.kind === MessageKind.FILE ? "ملف مرفق" : "رسالة واردة");
  const tag = `inbound-${conversation.id}`;
  void sendPushNotification(admins.map((admin) => admin.id), { title: customer.name || customer.phone || "رسالة واردة", body: preview.slice(0, 160), url: `/admin/dashboard?conversation=${encodeURIComponent(conversation.id)}`, tag }).catch((error) => console.warn("Admin push notification failed", error));
  if (conversation.assignedAgentId) void sendPushNotification([conversation.assignedAgentId], { title: customer.name || customer.phone || "رسالة واردة", body: preview.slice(0, 160), url: `/agent/workspace?conversation=${encodeURIComponent(conversation.id)}`, tag }).catch((error) => console.warn("Agent push notification failed", error));
  await scheduleSla(conversation.id, message.id);
  if (message.kind === MessageKind.AUDIO) void transcribeAudioMessage(message.id).catch((error) => console.error("Voice note transcription failed", error));
  return { conversationId: conversation.id, messageId: message.id };
}

export async function updateEditedInboundMessage(inbound: NormalizedInbound) {
  if (!inbound.isEdit) return false;
  const externalId = `${inbound.channel}:${inbound.externalId}`;
  const existing = await prisma.message.findUnique({ where: { externalId }, select: { id: true, conversationId: true, direction: true, metadata: true } });
  if (!existing || existing.direction !== "INBOUND") return false;
  const previous = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
    ? existing.metadata as Record<string, Prisma.JsonValue> : {};
  const message = await prisma.message.update({ where: { id: existing.id }, data: {
    text: inbound.text || null,
    metadata: { ...previous, editedAt: new Date().toISOString() } as Prisma.InputJsonValue
  }, include: { author: { select: { id: true, name: true } }, reactions: { include: { user: { select: { id: true, name: true } } } } } });
  io.to(`conversation:${existing.conversationId}`).to("admins").emit("message:updated", { conversationId: existing.conversationId, message });
  return true;
}
