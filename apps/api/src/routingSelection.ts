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

export function chooseRoundRobinAgent<T extends { id: string }>(agents: T[], roundRobinTurn: number): T | undefined {
  if (!agents.length) return undefined;
  const index = ((roundRobinTurn % agents.length) + agents.length) % agents.length;
  return agents[index];
}
