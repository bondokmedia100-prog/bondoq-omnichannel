import { ConversationBotState, ConversationStatus, Department, MessageDirection, MessageKind, Prisma, Role } from "@prisma/client";
import type { NormalizedInbound } from "./providers";
import { prisma } from "./prisma";
import { assignConversation, scheduleSla, scheduleUnansweredReassignment, withInboundConversationLock } from "./routing";
import { emitConversationEvent, io } from "./realtime";
import { channelRecipient, fetchInboundMedia, sendRoutingMenu, sendToChannel } from "./providers";
import { kalemlyExternalMessageId } from "./KalemlyWaService";
import { transcribeAudioMessage } from "./transcription";
import { buildRoutingMenuText, decideBotAction, findMatchingAutoReply, formatAgentHandoffGreeting, shouldStartBotFlow, type BotState } from "./autoReplies";
import { getChatbotSettings } from "./chatbotSettings";
import { sendPushNotification } from "./pushNotifications";
import { detectImageContentType, safeFileName } from "./mediaStorage";
import { isWebmContainer } from "./webpSticker";
import { isWithinBusinessHours } from "./businessHours";
import { startOfCairoDay } from "./cairoTime";
import { normalizePhoneNumber, phoneNumbersMatch } from "./egyptianPhoneFormatter";
import { channelViewerWhere } from "./messengerAccess";

export async function ingestMessage(inbound: NormalizedInbound) {
  let lockKey = inbound.externalConversationId;
  if (inbound.channel === "WHATSAPP" && inbound.customerPhone) {
    try { lockKey = normalizePhoneNumber(inbound.customerPhone); } catch {}
  }
  return withInboundConversationLock(inbound.channel, lockKey, () => ingestMessageLocked(inbound));
}

async function findWhatsAppConversationByPhone(phone: string) {
  const suffixes = [...new Set([phone.slice(-8), phone.slice(-6), phone.slice(-4)])];
  const candidates = await prisma.conversation.findMany({
    where: { channel: "WHATSAPP", OR: suffixes.flatMap((suffix) => [
      { externalCustomerId: { contains: suffix } }, { externalConversationId: { contains: suffix } },
      { customer: { is: { phone: { contains: suffix } } } }
    ]) },
    include: { customer: { select: { phone: true } } },
    orderBy: { lastMessageAt: "desc" }
  });
  return candidates.find((conversation) => [conversation.externalCustomerId, conversation.externalConversationId, conversation.customer.phone]
    .some((candidate) => phoneNumbersMatch(candidate || "", phone))) || null;
}

async function ingestMessageLocked(inbound: NormalizedInbound) {
  const metadata = (inbound.metadata || {}) as Record<string, unknown>;
  const historySync = inbound.isHistorySync === true || metadata.historySync === true;
  const direction = historySync && inbound.direction === "OUTBOUND" ? MessageDirection.OUTBOUND : MessageDirection.INBOUND;
  const timestampValue = inbound.messageTimestamp?.getTime() || Number(metadata.messageTimestamp) * 1000;
  const messageAt = Number.isFinite(timestampValue) && timestampValue > 0 ? new Date(timestampValue) : new Date();
  const timestampValid = Number.isFinite(messageAt.getTime()) && messageAt.getTime() <= Date.now() + 5 * 60_000;
  const createdAt = historySync && timestampValid ? messageAt : new Date();
  const isWhatsAppGroup = metadata.isWhatsAppGroup === true && inbound.channel === "WHATSAPP";
  const groupSubject = isWhatsAppGroup ? String(metadata.groupSubject || inbound.customerName || "مجموعة WhatsApp") : undefined;
  let conversation = await prisma.conversation.findUnique({ where: { channel_externalConversationId: { channel: inbound.channel, externalConversationId: inbound.externalConversationId } } });
  if (!conversation && inbound.channel === "WHATSAPP") {
    const identityJids = [...new Set([metadata.remoteJid, metadata.alternateJid].filter((value): value is string => typeof value === "string" && value.length > 0))];
    if (identityJids.length) conversation = await prisma.conversation.findFirst({
      where: { channel: "WHATSAPP", OR: [{ externalConversationId: { in: identityJids } }, { externalCustomerId: { in: identityJids } }] },
      orderBy: { lastMessageAt: "desc" }
    });
  }
  if (!conversation && inbound.channel === "WHATSAPP" && inbound.customerPhone) {
    try { conversation = await findWhatsAppConversationByPhone(normalizePhoneNumber(inbound.customerPhone)); } catch {}
  }
  const customerId = `external_${inbound.channel.toLowerCase()}_${inbound.externalCustomerId}`;
  const existingCustomer = await prisma.customer.findUnique({ where: { id: conversation?.customerId || customerId }, select: { channelIdentifiers: true } });
  const previousIdentifiers = existingCustomer?.channelIdentifiers && typeof existingCustomer.channelIdentifiers === "object" && !Array.isArray(existingCustomer.channelIdentifiers)
    ? existingCustomer.channelIdentifiers as Prisma.InputJsonObject : {};
  const channelIdentifiers: Prisma.InputJsonObject = {
    ...previousIdentifiers,
    ...(isWhatsAppGroup ? { whatsapp: inbound.externalCustomerId, whatsappGroup: true } : { [inbound.channel.toLowerCase()]: inbound.externalCustomerId }),
    ...(inbound.customerUsername ? { telegramUsername: inbound.customerUsername.replace(/^@/, "") } : {})
  };
  const customerUpdate = {
    ...(inbound.customerName ? { name: inbound.customerName } : {}),
    ...(isWhatsAppGroup ? { displayName: groupSubject } : {}),
    ...(inbound.profilePictureUrl ? { avatarUrl: inbound.profilePictureUrl } : {}),
    ...(isWhatsAppGroup ? { phone: null } : inbound.customerPhone ? { phone: inbound.customerPhone } : {}),
    ...(inbound.latitude === undefined ? {} : { lastLatitude: inbound.latitude }),
    ...(inbound.longitude === undefined ? {} : { lastLongitude: inbound.longitude }),
    channelIdentifiers
  };
  const customer = conversation
    ? await prisma.customer.update({ where: { id: conversation.customerId }, data: customerUpdate })
    : await prisma.customer.upsert({
      where: { id: customerId },
      update: customerUpdate,
      create: {
        id: customerId,
        name: groupSubject || inbound.customerName,
        ...(isWhatsAppGroup ? { displayName: groupSubject } : {}),
        phone: inbound.customerPhone || (inbound.channel === "WHATSAPP" && !isWhatsAppGroup ? inbound.externalCustomerId : null),
        avatarUrl: inbound.profilePictureUrl,
        lastLatitude: inbound.latitude,
        lastLongitude: inbound.longitude,
        channelIdentifiers
      }
    });
  if (!conversation) {
    try {
      conversation = await prisma.conversation.create({ data: {
        customerId: customer.id, channel: inbound.channel, externalConversationId: inbound.externalConversationId,
        externalCustomerId: inbound.externalCustomerId, ...(groupSubject ? { subject: groupSubject } : {}),
        status: historySync ? ConversationStatus.CLOSED : ConversationStatus.QUEUED,
        awaitingRouting: !historySync && !isWhatsAppGroup,
        ...(historySync ? { createdAt, lastMessageAt: createdAt } : {})
      } });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      conversation = await prisma.conversation.findUnique({ where: { channel_externalConversationId: { channel: inbound.channel, externalConversationId: inbound.externalConversationId } } });
    }
  }
  if (!conversation) throw new Error("Conversation could not be created");
  const conversationId = conversation.id;
  const storedExternalId = `${inbound.channel}:${inbound.externalId}`;
  const existingMessage = await prisma.message.findUnique({ where: { externalId: storedExternalId }, select: { id: true, conversationId: true } });
  if (existingMessage) return { duplicate: true, conversationId: existingMessage.conversationId };
  if (historySync && inbound.channel === "WHATSAPP" && metadata.provider === "baileys") {
    const baileysId = inbound.externalId.slice(inbound.externalId.lastIndexOf(":") + 1);
    if (baileysId) {
      const sameProviderMessage = await prisma.message.findFirst({
        where: { conversationId, direction, externalId: { startsWith: "WHATSAPP:baileys:", endsWith: `:${baileysId}` } },
        select: { id: true }
      });
      if (sameProviderMessage) return { duplicate: true, conversationId, messageId: sameProviderMessage.id };
    }
  }
  const previousInboundAt = historySync ? null : conversation.lastInboundAt || (await prisma.message.findFirst({
    where: { conversationId, direction: MessageDirection.INBOUND }, orderBy: { createdAt: "desc" }, select: { createdAt: true }
  }))?.createdAt || null;
  let cachedMedia: { body: Buffer; contentType: string } | undefined = inbound.mediaBuffer
    ? { body: inbound.mediaBuffer, contentType: inbound.mediaContentType || String(metadata.mediaMimeType || "application/octet-stream") }
    : undefined;
  const hasMedia = inbound.kind === MessageKind.IMAGE || inbound.kind === MessageKind.AUDIO || inbound.kind === MessageKind.VIDEO || inbound.kind === MessageKind.FILE || inbound.kind === MessageKind.STICKER;
  if (!cachedMedia && hasMedia && !historySync) {
    try {
      cachedMedia = await fetchInboundMedia(inbound.channel, metadata, inbound.mediaUrl);
    } catch (error) {
      console.warn("Inbound media cache failed", error instanceof Error ? error.message : error);
    }
  }
  let message;
  try {
    const declaredType = cachedMedia?.contentType || String(metadata.mediaMimeType || "application/octet-stream");
    const stickerVideo = inbound.kind === MessageKind.STICKER && metadata.telegramStickerIsVideo === true && cachedMedia?.contentType === "video/webm" && isWebmContainer(cachedMedia.body);
    const stickerImageType = inbound.kind === MessageKind.STICKER && cachedMedia ? detectImageContentType(cachedMedia.body) : undefined;
    const contentType = inbound.kind === MessageKind.IMAGE && cachedMedia
      ? detectImageContentType(cachedMedia.body) || declaredType.split(";")[0].toLowerCase()
      : inbound.kind === MessageKind.STICKER && cachedMedia
        ? stickerImageType || (stickerVideo ? "video/webm" : declaredType.split(";")[0].toLowerCase())
        : declaredType.split(";")[0].toLowerCase();
    const extension = contentType.split(";")[0].split("/")[1]?.replace(/[^a-zA-Z0-9.+-]/g, "") || "bin";
    const fileName = inbound.mediaFileName || (inbound.kind === MessageKind.AUDIO
      ? `${metadata.voiceNote === true ? "voice-note" : "audio"}.${extension}`
      : inbound.kind === MessageKind.IMAGE ? `image.${extension}` : inbound.kind === MessageKind.VIDEO ? `video.${extension}` : `attachment.${extension}`);
    message = await prisma.$transaction(async (tx) => {
      const mediaToCache = cachedMedia && (inbound.kind !== MessageKind.IMAGE && inbound.kind !== MessageKind.STICKER || Boolean(detectImageContentType(cachedMedia.body) || stickerVideo))
        ? cachedMedia : undefined;
      const asset = mediaToCache ? await tx.mediaAsset.create({ data: {
        fileName: safeFileName(fileName), contentType, size: mediaToCache.body.length, data: Uint8Array.from(mediaToCache.body)
      }, select: { id: true } }) : null;
      return tx.message.create({ data: {
        conversationId, direction, kind: inbound.kind || MessageKind.TEXT,
        text: inbound.text, mediaUrl: asset ? null : inbound.mediaUrl, mediaAssetId: asset?.id, latitude: inbound.latitude, longitude: inbound.longitude,
        externalId: storedExternalId, metadata: metadata as Prisma.InputJsonValue,
        ...(historySync ? { createdAt } : {})
      } });
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return { duplicate: true, conversationId: conversation.id };
    throw error;
  }
  if (historySync) {
    const update: Prisma.ConversationUpdateInput = {};
    if (createdAt > conversation.lastMessageAt) update.lastMessageAt = createdAt;
    if (createdAt < conversation.createdAt) update.createdAt = createdAt;
    if (direction === MessageDirection.INBOUND && (!conversation.lastInboundAt || createdAt > conversation.lastInboundAt)) update.lastInboundAt = createdAt;
    if (groupSubject) update.subject = groupSubject;
    if (Object.keys(update).length) await prisma.conversation.update({ where: { id: conversationId }, data: update });
    return { conversationId, messageId: message.id, historySync: true };
  }
  if (customer.isBlocked) {
    const previousAssignedAgentId = conversation.assignedAgentId;
    conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: {
      lastMessageAt: message.createdAt, lastInboundAt: message.createdAt, unreadCount: { increment: 1 },
      assignedAgentId: null, status: ConversationStatus.CLOSED, closedAt: new Date(), awaitingRouting: false,
      botState: ConversationBotState.ASSIGNED_TO_AGENT
    } });
    await prisma.auditLog.create({ data: { action: "BLOCKED_CUSTOMER_MESSAGE_IGNORED", conversationId: conversation.id, details: { customerId: customer.id, messageId: message.id } } });
    if (previousAssignedAgentId) io?.to(`agent:${previousAssignedAgentId}`).emit("conversation:unassigned", conversation);
    await emitConversationEvent(conversation.id, conversation.channel, "conversation:updated", conversation);
    await emitConversationEvent(conversation.id, conversation.channel, "message:new", { conversation, message, customer });
    return { conversationId: conversation.id, messageId: message.id, blocked: true };
  }
  const pendingSurvey = isWhatsAppGroup ? null : await prisma.csatSurvey.findUnique({ where: { conversationId: conversation.id } });
  const ratingText = (inbound.text || "").trim()
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
  const customerRating = /^(?:[1-5]|[1-5]\s*(?:نجوم|star(?:s)?))$/i.test(ratingText)
    ? Number(ratingText.match(/[1-5]/)?.[0]) : undefined;
  const isRatingReply = Boolean(pendingSurvey && pendingSurvey.rating === null && customerRating);
  const isTerminal = conversation.status === ConversationStatus.CLOSED || conversation.status === ConversationStatus.RESOLVED;
  const priorAgentOutreach = !isWhatsAppGroup ? await prisma.message.findFirst({ where: {
    conversationId: conversation.id, direction: MessageDirection.OUTBOUND, authorId: { not: null },
    createdAt: { ...(previousInboundAt ? { gt: previousInboundAt } : {}), lte: message.createdAt },
    OR: [{ deliveryStatus: { not: "FAILED" } }, { deliveryStatus: null }],
    NOT: { metadata: { path: ["automation"], equals: "agent-handoff-greeting" } }
  }, select: { id: true } }) : null;
  const agentRepliedSinceLastInbound = Boolean(conversation.lastAgentResponseAt && conversation.lastAgentResponseAt <= message.createdAt
    && (!previousInboundAt || conversation.lastAgentResponseAt > previousInboundAt));
  const manuallyInitiated = !isWhatsAppGroup && (conversation.serviceTag === "تواصل مباشر" || agentRepliedSinceLastInbound || Boolean(priorAgentOutreach));
  const chatbotSettings = await getChatbotSettings();
  const outsideBusinessHours = !isWhatsAppGroup && !manuallyInitiated && chatbotSettings.businessHoursEnabled && !isWithinBusinessHours(chatbotSettings, message.createdAt);
  const priorOffHoursReply = outsideBusinessHours && chatbotSettings.offHoursReplyEnabled ? await prisma.message.findFirst({ where: {
    conversationId: conversation.id, direction: MessageDirection.OUTBOUND, createdAt: { gte: startOfCairoDay(message.createdAt) },
    metadata: { path: ["automation"], equals: "off-hours-reply" }
  }, select: { id: true } }) : null;
  const shouldSendOffHoursReply = outsideBusinessHours && chatbotSettings.offHoursReplyEnabled && !priorOffHoursReply;
  const currentBotState: BotState = conversation.awaitingRouting ? "BOT_MENU" : conversation.botState;
  const starting = !isWhatsAppGroup && !isRatingReply && shouldStartBotFlow(previousInboundAt, isTerminal, message.createdAt, manuallyInitiated);
  const decision = isWhatsAppGroup || manuallyInitiated
    ? { action: "NONE" as const, nextState: "ASSIGNED_TO_AGENT" as const }
    : decideBotAction({ enabled: chatbotSettings.enabled, state: currentBotState, starting, text: inbound.text, settings: chatbotSettings });
  const serviceChoice = decision.action === "HANDOFF" ? decision.choice : undefined;
  const autoRules = !isWhatsAppGroup && !manuallyInitiated && decision.action === "NONE" && !conversation.assignedAgentId && !conversation.serviceTag && inbound.text
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
      assignedAgentId: awaitingMenu || needsAssignment ? null : undefined,
      awaitingRouting: awaitingMenu,
      botState: decision.nextState === "BOT_MENU" ? ConversationBotState.BOT_MENU : ConversationBotState.ASSIGNED_TO_AGENT,
      ...(groupSubject ? { subject: groupSubject } : {}),
      routingDepartment: awaitingMenu || decision.action === "BYPASS" ? null : routeDepartment || conversation.routingDepartment,
      serviceTag: decision.action === "HANDOFF" ? serviceChoice?.label : decision.action === "BYPASS" ? "تواصل مباشر" : awaitingMenu ? null : conversation.serviceTag,
      isComplaint: decision.action === "HANDOFF" ? Boolean(serviceChoice?.isComplaint) : awaitingMenu || decision.action === "BYPASS" ? false : inbound.isComplaint ?? conversation.isComplaint,
      ...(decision.action === "MENU" || decision.action === "BYPASS" ? { firstResponseAt: null, lastAgentResponseAt: null, slaBreachedAt: null } : {})
    }
  });
  await prisma.conversationPreference.updateMany({ where: { conversationId: conversation.id, isDeleted: true }, data: { isDeleted: false } });
  if (awaitingMenu && previousAssignedAgentId) {
    io?.to(`agent:${previousAssignedAgentId}`).emit("conversation:unassigned", conversation);
  }

  if (isRatingReply && pendingSurvey && customerRating) {
    const survey = await prisma.csatSurvey.update({ where: { id: pendingSurvey.id }, data: { rating: customerRating, ratedAt: message.createdAt } });
    await prisma.auditLog.create({ data: { conversationId: conversation.id, action: "CSAT_RECEIVED", details: { rating: customerRating, agentId: survey.agentId } } });
    if (io) {
      await emitConversationEvent(conversation.id, conversation.channel, customerRating < 3 ? "csat:low" : "csat:received", { conversationId: conversation.id, rating: customerRating, customer, agentId: survey.agentId }, { audience: "managers" });
      await emitConversationEvent(conversation.id, conversation.channel, "message:new", { conversationId: conversation.id, message, customer });
    }
    return { conversationId: conversation.id, messageId: message.id, csatRating: customerRating };
  }

  const payload = { conversation, message, customer };
  await emitConversationEvent(conversation.id, conversation.channel, "message:new", payload, {
    extraRooms: conversation.assignedAgentId ? [`agent:${conversation.assignedAgentId}`] : []
  });

  async function sendBotReply(text: string, automation: string, details: Record<string, unknown> = {}) {
    const result: any = await sendToChannel({ channel: inbound.channel, recipient: channelRecipient(inbound.channel, inbound.externalConversationId, inbound.externalCustomerId), text });
    const providerId = kalemlyExternalMessageId(result);
    const reply = await prisma.message.create({ data: {
      conversationId, direction: MessageDirection.OUTBOUND, kind: MessageKind.TEXT, text,
      externalId: providerId ? `${inbound.channel}:${providerId}` : undefined,
      metadata: { automation, ...details } as Prisma.InputJsonValue
    } });
    conversation = await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: reply.createdAt } });
    await emitConversationEvent(conversationId, conversation.channel, "message:new", { conversationId, message: reply }, {
      extraRooms: conversation.assignedAgentId ? [`agent:${conversation.assignedAgentId}`] : []
    });
  }

  if (outsideBusinessHours) {
    if (shouldSendOffHoursReply) {
      try { await sendBotReply(chatbotSettings.offHoursReplyText, "off-hours-reply"); }
      catch (error) { console.error("Out-of-hours reply failed", error); }
    }
    if (!conversation.assignedAgentId) {
      conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { awaitingRouting: false, botState: ConversationBotState.ASSIGNED_TO_AGENT, status: ConversationStatus.QUEUED } });
      conversation = await assignConversation(conversation.id, routeDepartment);
    }
  } else if (decision.action === "MENU") {
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
      await emitConversationEvent(conversation.id, conversation.channel, "message:new", { conversationId: conversation.id, message: menuMessage });
    } catch (error) {
      console.error("Service menu delivery failed; assigning conversation to the default queue", error);
      conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { awaitingRouting: false, botState: ConversationBotState.ASSIGNED_TO_AGENT, serviceTag: "تواصل مباشر" } });
      conversation = await assignConversation(conversation.id);
    }
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
    try {
      const assignedAgent = conversation.assignedAgentId
        ? await prisma.user.findUnique({ where: { id: conversation.assignedAgentId }, select: { name: true } })
        : null;
      const greeting = formatAgentHandoffGreeting(
        chatbotSettings.agentHandoffGreeting,
        customer.displayName || customer.name,
        assignedAgent?.name
      );
      await sendBotReply(greeting, "agent-handoff-greeting", {
        service: serviceChoice.label,
        serviceNumber: serviceChoice.number,
        agentId: conversation.assignedAgentId
      });
    } catch (error) { console.error("Agent handoff greeting failed", error); }
  } else if (decision.action === "BYPASS") {
    conversation = await assignConversation(conversation.id);
  } else if (autoReply) {
    try { await sendBotReply(autoReply.responseText, "auto-reply", { ruleId: autoReply.id }); }
    catch (error) { console.error("Automatic reply delivery failed", error); }
  }

  if (decision.action === "NONE" && !autoReply && !conversation.awaitingRouting) {
    conversation = await assignConversation(conversation.id, routeDepartment, { reassignIfIneligible: true });
  }

  const viewerWhere = await channelViewerWhere(conversation.channel);
  const assignedViewer = conversation.assignedAgentId ? await prisma.user.findFirst({
    where: { id: conversation.assignedAgentId, isActive: true, OR: [{ role: Role.ADMIN }, viewerWhere] }, select: { id: true }
  }) : null;
  if (io && assignedViewer && conversation.assignedAgentId !== previousAssignedAgentId) {
    io.to(`agent:${conversation.assignedAgentId}`).emit("message:new", payload);
  }
  const adminScope = { OR: [
    { role: Role.ADMIN },
    { role: Role.SUPERVISOR, canViewAllConversations: true },
    { role: Role.SUPERVISOR, canViewAllConversations: null }
  ] };
  const admins = await prisma.user.findMany({ where: {
    isActive: true,
    AND: [adminScope, { OR: [{ role: Role.ADMIN }, viewerWhere] }]
  }, select: { id: true } });
  const mutedPreferences = await prisma.conversationPreference.findMany({ where: { conversationId: conversation.id, isMuted: true }, select: { userId: true } });
  const mutedUserIds = new Set(mutedPreferences.map((preference) => preference.userId));
  const preview = inbound.text?.trim() || (inbound.kind === MessageKind.IMAGE ? "صورة مرفقة" : inbound.kind === MessageKind.STICKER ? "ملصق" : inbound.kind === MessageKind.AUDIO ? "رسالة صوتية" : inbound.kind === MessageKind.VIDEO ? "مقطع فيديو" : inbound.kind === MessageKind.FILE ? "ملف مرفق" : "رسالة واردة");
  const tag = `inbound-${conversation.id}`;
  const unmutedAdmins = admins.filter((admin) => !mutedUserIds.has(admin.id));
  if (unmutedAdmins.length) void sendPushNotification(unmutedAdmins.map((admin) => admin.id), { title: customer.name || customer.phone || "رسالة واردة", body: preview.slice(0, 160), url: `/admin/dashboard?conversation=${encodeURIComponent(conversation.id)}`, tag }).catch((error) => console.warn("Admin push notification failed", error));
  if (assignedViewer && !mutedUserIds.has(assignedViewer.id)) void sendPushNotification([assignedViewer.id], { title: customer.name || customer.phone || "رسالة واردة", body: preview.slice(0, 160), url: `/agent/workspace?conversation=${encodeURIComponent(conversation.id)}`, tag }).catch((error) => console.warn("Agent push notification failed", error));
  if (conversation.assignedAgentId) {
    await scheduleSla(conversation.id, message.id);
    await scheduleUnansweredReassignment(conversation.id, message.id, conversation.assignedAgentId);
  }
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
  await emitConversationEvent(existing.conversationId, inbound.channel, "message:updated", { conversationId: existing.conversationId, message });
  return true;
}
