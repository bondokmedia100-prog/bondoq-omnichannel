export type AgentReplyCount = {
  authorId: string | null;
  count: number;
};

export type AgentConversationTouch = {
  authorId: string | null;
  conversationId: string;
};

export function weeklyAgentPerformance(agentIds: string[], replyCounts: AgentReplyCount[], touchedConversations: AgentConversationTouch[]) {
  const stats = new Map<string, { weeklyReplies: number; conversations: Set<string> }>();
  for (const id of agentIds) stats.set(id, { weeklyReplies: 0, conversations: new Set<string>() });
  for (const row of replyCounts) {
    if (row.authorId && stats.has(row.authorId)) stats.get(row.authorId)!.weeklyReplies = row.count;
  }
  for (const row of touchedConversations) {
    if (row.authorId) stats.get(row.authorId)?.conversations.add(row.conversationId);
  }
  return Object.fromEntries([...stats].map(([id, agent]) => [id, {
    weeklyReplies: agent.weeklyReplies,
    weeklyConversations: agent.conversations.size
  }]));
}
