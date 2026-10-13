import { ConversationStatus, MessageDirection, MessageKind, Prisma } from "@prisma/client";
import type { NormalizedInbound } from "./providers";
import { prisma } from "./prisma";
import { assignConversation, scheduleSla } from "./routing";
import { io } from "./realtime";
import { sendRoutingMenu } from "./providers";
import { kalemlyExternalMessageId } from "./KalemlyWaService";
import { transcribeAudioMessage } from "./transcription";

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
  const routeChoice = conversation.awaitingRouting ? inbound.routingDepartment : undefined;
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

  if (isNewConversation) {
    try {
      const result: any = await sendRoutingMenu(inbound.channel, inbound.externalCustomerId);
      const providerId = kalemlyExternalMessageId(result);
      const menuMessage = await prisma.message.create({ data: {
        conversationId: conversation.id, direction: MessageDirection.OUTBOUND, kind: MessageKind.TEXT,
        text: "أهلًا بك في حلواني بندق. اختر كيف نقدر نساعدك:",
        externalId: providerId ? `${inbound.channel}:${providerId}` : undefined,
        metadata: { automation: "pre-routing-menu" }
      } });
      conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: menuMessage.createdAt } });
    } catch (error) {
      console.error("Pre-routing menu send failed; assigning conversation to the default queue", error);
      conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { awaitingRouting: false } });
      conversation = await assignConversation(conversation.id);
      await scheduleSla(conversation.id, message.id);
    }
  } else if (conversation.awaitingRouting || !conversation.assignedAgentId) {
    conversation = await assignConversation(conversation.id, routeChoice);
  }

  if (!isNewConversation || routeChoice) await scheduleSla(conversation.id, message.id);
  const payload = { conversation, message, customer };
  if (io) {
    const targets = io.to("admins").to(`conversation:${conversation.id}`);
    if (conversation.assignedAgentId) targets.to(`agent:${conversation.assignedAgentId}`).emit("message:new", payload);
    else targets.emit("message:new", payload);
  }
  if (message.kind === MessageKind.AUDIO) void transcribeAudioMessage(message.id).catch((error) => console.error("Voice note transcription failed", error));
  return { conversationId: conversation.id, messageId: message.id };
}
