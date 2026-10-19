type ReceivingChannel = "WHATSAPP" | "MESSENGER" | "TELEGRAM";

export type ChannelEligibility = {
  canReceiveWhatsApp?: boolean | null;
  canReceiveMessenger?: boolean | null;
  canReceiveTelegram?: boolean | null;
};

const channelPermission: Record<ReceivingChannel, keyof ChannelEligibility> = {
  WHATSAPP: "canReceiveWhatsApp",
  MESSENGER: "canReceiveMessenger",
  TELEGRAM: "canReceiveTelegram"
};

export function channelEligibilityWhere(channel: ReceivingChannel) {
  return { [channelPermission[channel]]: true };
}

export function canReceiveChannel(agent: ChannelEligibility, channel: ReceivingChannel) {
  return agent[channelPermission[channel]] === true;
}

export function isEligibleForAutomaticAssignment(agent: {
  isActive: boolean;
  presence: string;
  connected: boolean;
  fullAccess: boolean;
}) {
  return agent.isActive && agent.presence === "ONLINE" && agent.connected && agent.fullAccess;
}

export function chooseRoundRobinAgent<T extends { id: string }>(agents: T[], roundRobinTurn: number): T | undefined {
  if (!agents.length) return undefined;
  const index = ((roundRobinTurn % agents.length) + agents.length) % agents.length;
  return agents[index];
}

export function shouldReassignUnansweredConversation(conversation: {
  status: string;
  assignedAgentId: string | null;
  lastInboundAt: Date | null;
  lastAgentResponseAt: Date | null;
}, expected: { assignedAgentId: string; inboundAt: Date }) {
  const active = ["OPEN", "PENDING", "QUEUED"].includes(conversation.status);
  return active && conversation.assignedAgentId === expected.assignedAgentId
    && conversation.lastInboundAt?.getTime() === expected.inboundAt.getTime()
    && (!conversation.lastAgentResponseAt || conversation.lastAgentResponseAt < expected.inboundAt);
}
