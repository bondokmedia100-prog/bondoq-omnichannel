import { ConversationBotState, ConversationStatus, Department, MessageDirection, MessageKind, Prisma, Role } from "@prisma/client";
import type { NormalizedInbound } from "./providers";
import { prisma } from "./prisma";
import { assignConversation, scheduleSla, withInboundConversationLock } from "./routing";
import { io } from "./realtime";
import { channelRecipient, fetchInboundMedia, sendRoutingMenu, sendToChannel } from "./providers";
import { kalemlyExternalMessageId } from "./KalemlyWaService";
import { transcribeAudioMessage } from "./transcription";
import { buildBranchReplyText, buildRoutingMenuText, decideBotAction, findMatchingAutoReply, type BotState } from "./autoReplies";
import { getChatbotSettings } from "./chatbotSettings";
import { sendPushNotification } from "./pushNotifications";
import { detectImageContentType, publicMediaUrl, safeFileName } from "./mediaStorage";

export async function ingestMessage(inbound: NormalizedInbound) {
  return withInboundConversationLock(inbound.channel, inbound.externalConversationId, () => ingestMessageLocked(inbound));
}

async function ingestMessageLocked(inbound: NormalizedInbound) {
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
    const declaredType = cachedMedia?.contentType || String(metadata.mediaMimeType || "application/octet-stream");
    const contentType = inbound.kind === MessageKind.IMAGE && cachedMedia
      ? detectImageContentType(cachedMedia.body) || declaredType.split(";")[0].toLowerCase()
      : declaredType.split(";")[0].toLowerCase();
    const extension = contentType.split(";")[0].split("/")[1]?.replace(/[^a-zA-Z0-9.+-]/g, "") || "bin";
    const fileName = inbound.mediaFileName || (inbound.kind === MessageKind.AUDIO
      ? `${metadata.voiceNote === true ? "voice-note" : "audio"}.${extension}`
      : inbound.kind === MessageKind.IMAGE ? `image.${extension}` : inbound.kind === MessageKind.VIDEO ? `video.${extension}` : `attachment.${extension}`);
    message = await prisma.$transaction(async (tx) => {
      const asset = cachedMedia ? await tx.mediaAsset.create({ data: {
        fileName: safeFileName(fileName), contentType, size: cachedMedia.body.length, data: Uint8Array.from(cachedMedia.body)
      }, select: { id: true } }) : null;
      let mediaUrl = inbound.mediaUrl;
      if (asset) {
        try { mediaUrl = publicMediaUrl(asset.id, 0); }
        catch (error) { console.warn("Public media URL unavailable; protected media route will be used", error); }
      }
      return tx.message.create({ data: {
        conversationId: conversation.id, direction: MessageDirection.INBOUND, kind: inbound.kind || MessageKind.TEXT,
        text: inbound.text, mediaUrl, mediaAssetId: asset?.id, latitude: inbound.latitude, longitude: inbound.longitude,
        externalId: storedExternalId, metadata: metadata as Prisma.InputJsonValue
      } });
    });
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
  const chatbotSettings = await getChatbotSettings();
  const starting = !isRatingReply && (isNewConversation || isTerminal);
  const currentBotState: BotState = conversation.awaitingRouting ? "BOT_MENU" : conversation.botState;
  const decision = decideBotAction({ enabled: chatbotSettings.enabled, state: currentBotState, starting, text: inbound.text, settings: chatbotSettings });
  const serviceChoice = decision.action === "BRANCHES" || decision.action === "HANDOFF" ? decision.choice : undefined;
  const autoRules = decision.action === "NONE" && !conversation.assignedAgentId && !conversation.serviceTag && inbound.text
    ? await prisma.autoReplyRule.findMany({ where: { isActive: true, isWelcome: false }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] })
    : [];
  const autoReply = findMatchingAutoReply(autoRules, inbound.text);
  const routeDepartment = (decision.action === "HANDOFF" ? serviceChoice?.routingDepartment : undefined) as Department | undefined
    || (autoReply?.routingDepartment as Department | null | undefined)
    || inbound.routingDepartment;
  const shouldPreserveResolved = isRatingReply && (conversation.status === ConversationStatus.RESOLVED || conversation.status === ConversationStatus.CLOSED);
  const previousAssignedAgentId = conversation.assignedAgentId;
  const awaitingMenu = decision.nextState === "BOT_MENU";
  const needsAssignment = decision.action === "HANDOFF" || decision.action === "BYPASS";
  conversation = await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: message.createdAt, lastInboundAt: message.createdAt, unreadCount: { increment: 1 },
      status: awaitingMenu || needsAssignment ? ConversationStatus.QUEUED : shouldPreserveResolved ? conversation.status : isTerminal ? ConversationStatus.OPEN : conversation.status,
      closedAt: awaitingMenu || needsAssignment ? null : shouldPreserveResolved ? conversation.closedAt : isTerminal ? null : conversation.closedAt,
      assignedAgentId: awaitingMenu || needsAssignment ? null : conversation.assignedAgentId,
      awaitingRouting: awaitingMenu,
      botState: decision.nextState === "BOT_MENU" ? ConversationBotState.BOT_MENU : ConversationBotState.ASSIGNED_TO_AGENT,
      routingDepartment: awaitingMenu || decision.action === "BYPASS" ? null : routeDepartment || conversation.routingDepartment,
      serviceTag: decision.action === "HANDOFF" ? serviceChoice?.label : decision.action === "BYPASS" ? "تواصل مباشر" : awaitingMenu ? null : conversation.serviceTag,
      isComplaint: decision.action === "HANDOFF" ? Boolean(serviceChoice?.isComplaint) : awaitingMenu || decision.action === "BYPASS" ? false : inbound.isComplaint ?? conversation.isComplaint,
      ...(decision.action === "MENU" || decision.action === "BYPASS" ? { firstResponseAt: null, lastAgentResponseAt: null, slaBreachedAt: null } : {})
    }
  });
  if (awaitingMenu && previousAssignedAgentId) {
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

  async function sendBotReply(text: string, automation: string, details: Record<string, unknown> = {}) {
    const result: any = await sendToChannel({ channel: inbound.channel, recipient: channelRecipient(inbound.channel, inbound.externalConversationId, inbound.externalCustomerId), text });
    const providerId = kalemlyExternalMessageId(result);
    const reply = await prisma.message.create({ data: {
      conversationId: conversation.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.TEXT, text,
      externalId: providerId ? `${inbound.channel}:${providerId}` : undefined,
      metadata: { automation, ...details } as Prisma.InputJsonValue
    } });
    conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: reply.createdAt } });
    io?.to(`conversation:${conversation.id}`).to("admins").emit("message:new", { conversationId: conversation.id, message: reply });
    if (conversation.assignedAgentId) io?.to(`agent:${conversation.assignedAgentId}`).emit("message:new", { conversationId: conversation.id, message: reply });
  }

  if (decision.action === "MENU") {
    try {
      const menuText = buildRoutingMenuText(chatbotSettings);
      const labels = [chatbotSettings.option1Label, chatbotSettings.option2Label, chatbotSettings.option3Label, chatbotSettings.option4Label, chatbotSettings.option5Label];
      const recipient = channelRecipient(inbound.channel, inbound.externalConversationId, inbound.externalCustomerId);
      const result: any = await sendRoutingMenu(inbound.channel, recipient, menuText, labels);
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
      conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { awaitingRouting: false, botState: ConversationBotState.ASSIGNED_TO_AGENT, serviceTag: "تواصل مباشر" } });
      conversation = await assignConversation(conversation.id);
    }
  } else if (decision.action === "BRANCHES") {
    try {
      await sendBotReply(buildBranchReplyText(chatbotSettings), "branch-information", { service: serviceChoice?.label || chatbotSettings.option1Label });
    } catch (error) { console.error("Branch information reply failed", error); }
  } else if (decision.action === "INVALID") {
    try {
      await sendBotReply(chatbotSettings.invalidChoiceText, "invalid-menu-choice");
    } catch (error) { console.error("Invalid menu reply failed", error); }
  } else if (decision.action === "HANDOFF" && serviceChoice) {
    conversation = await assignConversation(conversation.id, routeDepartment, { reassignIfIneligible: true });
    try {
      const replyText = [chatbotSettings.option1ReplyText, chatbotSettings.option2ReplyText, chatbotSettings.option3ReplyText, chatbotSettings.option4ReplyText, chatbotSettings.option5ReplyText][serviceChoice.number - 1];
      await sendBotReply(replyText, "agent-handoff", { service: serviceChoice.label, serviceNumber: serviceChoice.number });
    } catch (error) { console.error("Agent handoff acknowledgement failed", error); }
  } else if (decision.action === "BYPASS") {
    conversation = await assignConversation(conversation.id);
  } else if (autoReply) {
    try { await sendBotReply(autoReply.responseText, "auto-reply", { ruleId: autoReply.id }); }
    catch (error) { console.error("Automatic reply delivery failed", error); }
  }

  if (decision.action === "NONE" && !autoReply && !conversation.awaitingRouting && !conversation.assignedAgentId) {
    conversation = await assignConversation(conversation.id, routeDepartment);
  }

  if (io && conversation.assignedAgentId && conversation.assignedAgentId !== previousAssignedAgentId) {
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
  if (conversation.assignedAgentId) await scheduleSla(conversation.id, message.id);
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
