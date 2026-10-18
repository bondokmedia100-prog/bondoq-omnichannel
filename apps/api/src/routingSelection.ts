export const receivingChannels = ["WHATSAPP", "MESSENGER", "TELEGRAM"] as const;
export type ReceivingChannel = typeof receivingChannels[number];
export const channelAccessLevels = ["FULL", "READ_ONLY", "EXCLUDED"] as const;
export type ChannelAccessLevel = typeof channelAccessLevels[number];

export type ChannelEligibility = {
  department?: string | null;
  channelAccess?: Partial<Record<ReceivingChannel, ChannelAccessLevel>>;
  whatsappAccess?: ChannelAccessLevel | null;
  messengerAccess?: ChannelAccessLevel | null;
  telegramAccess?: ChannelAccessLevel | null;
  canReceiveWhatsApp?: boolean | null;
  canReceiveMessenger?: boolean | null;
  canReceiveTelegram?: boolean | null;
};

const channelOverrideField: Record<ReceivingChannel, keyof ChannelEligibility> = {
  WHATSAPP: "whatsappAccess",
  MESSENGER: "messengerAccess",
  TELEGRAM: "telegramAccess"
};
const legacyChannelField: Record<ReceivingChannel, keyof ChannelEligibility> = {
  WHATSAPP: "canReceiveWhatsApp",
  MESSENGER: "canReceiveMessenger",
  TELEGRAM: "canReceiveTelegram"
};

export function defaultDepartmentChannelAccess(department: string | null | undefined, channel: ReceivingChannel): ChannelAccessLevel {
  return department === "CUSTOMER_CARE" && channel === "MESSENGER" ? "READ_ONLY" : "FULL";
}

export function effectiveChannelAccess(agent: ChannelEligibility, channel: ReceivingChannel, departmentAccess?: ChannelAccessLevel): ChannelAccessLevel {
  const resolved = agent.channelAccess?.[channel];
  if (resolved) return resolved;
  const override = agent[channelOverrideField[channel]] as ChannelAccessLevel | null | undefined;
  if (override) return override;
  if (agent[legacyChannelField[channel]] === false) return "EXCLUDED";
  return departmentAccess || defaultDepartmentChannelAccess(agent.department, channel);
}

export function canReceiveChannel(agent: ChannelEligibility, channel: ReceivingChannel, departmentAccess?: ChannelAccessLevel) {
  return effectiveChannelAccess(agent, channel, departmentAccess) === "FULL";
}

export function canReadChannel(agent: ChannelEligibility, channel: ReceivingChannel, departmentAccess?: ChannelAccessLevel) {
  return effectiveChannelAccess(agent, channel, departmentAccess) !== "EXCLUDED";
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
