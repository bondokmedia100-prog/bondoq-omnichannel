import type { Channel, Prisma } from "@prisma/client";

export function normalizeSearchDigits(value: string) {
  return value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/\D/g, "");
}

export function messageContentSearchWhere(query: string): Prisma.MessageWhereInput {
  const term = query.trim();
  return {
    OR: [
      { text: { contains: term, mode: "insensitive" } },
      { transcription: { contains: term, mode: "insensitive" } }
    ]
  };
}

export function accessibleConversationSearchScope(
  agentId: string,
  branchId: string | null | undefined,
  viewOnlyChannels: Channel[] = []
): Prisma.ConversationWhereInput {
  return {
    ...(branchId !== undefined ? { branchId } : {}),
    OR: [
      { assignedAgentId: agentId },
      ...(viewOnlyChannels.length ? [{ channel: { in: viewOnlyChannels } }] : []),
      { assignmentHistory: { some: { agentId } } },
      { messages: { some: { authorId: agentId } } },
      { internalNotes: { some: { authorId: agentId } } },
      { whatsappCallSessions: { some: { agentId } } }
    ]
  };
}
