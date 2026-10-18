import { Channel, Department, MessengerAccessMode, Prisma, Role } from "@prisma/client";
import { prisma } from "./prisma";

export const messengerDepartments = Object.values(Department);

export const defaultMessengerDepartmentModes: Record<Department, MessengerAccessMode> = {
  [Department.WORK_FROM_HOME]: MessengerAccessMode.FULL,
  [Department.CUSTOMER_CARE]: MessengerAccessMode.READ_ONLY,
  [Department.CAKES]: MessengerAccessMode.DISABLED,
  [Department.DELIVERY]: MessengerAccessMode.DISABLED,
  [Department.QUALITY]: MessengerAccessMode.DISABLED,
  [Department.HEADQUARTERS]: MessengerAccessMode.DISABLED,
  [Department.BRANCH]: MessengerAccessMode.DISABLED,
  [Department.ADMINISTRATION]: MessengerAccessMode.DISABLED
};

export const defaultChannelDepartmentModes: Record<Channel, Record<Department, MessengerAccessMode>> = {
  WHATSAPP: defaultMessengerDepartmentModes,
  MESSENGER: defaultMessengerDepartmentModes,
  TELEGRAM: defaultMessengerDepartmentModes
};

export type MessengerPrincipal = {
  role: Role;
  department: Department | null;
  whatsappAccess?: MessengerAccessMode | null;
  messengerAccess: MessengerAccessMode | null;
  telegramAccess?: MessengerAccessMode | null;
  canReceiveWhatsApp?: boolean;
  canReceiveMessenger?: boolean;
  canReceiveTelegram?: boolean;
  departmentWhatsAppAccess?: MessengerAccessMode;
  departmentMessengerAccess?: MessengerAccessMode;
  departmentTelegramAccess?: MessengerAccessMode;
};

export function effectiveMessengerAccess(user: MessengerPrincipal): MessengerAccessMode {
  if (user.messengerAccess) return user.messengerAccess;
  const inherited = user.departmentMessengerAccess ?? (user.department ? defaultMessengerDepartmentModes[user.department] : MessengerAccessMode.DISABLED);
  return inherited === MessengerAccessMode.FULL && user.canReceiveMessenger === false ? MessengerAccessMode.READ_ONLY : inherited;
}

export function canViewMessenger(user: MessengerPrincipal) {
  return user.role === Role.ADMIN || effectiveMessengerAccess(user) !== MessengerAccessMode.DISABLED;
}

export function canReplyMessenger(user: MessengerPrincipal) {
  return user.role === Role.ADMIN || effectiveMessengerAccess(user) === MessengerAccessMode.FULL;
}

export function effectiveChannelAccess(user: MessengerPrincipal, channel: Channel): MessengerAccessMode {
  if (channel === Channel.MESSENGER) return effectiveMessengerAccess(user);
  const override = channel === Channel.WHATSAPP ? user.whatsappAccess : user.telegramAccess;
  if (override) return override;
  const inherited = channel === Channel.WHATSAPP
    ? user.departmentWhatsAppAccess ?? (user.department ? defaultChannelDepartmentModes[channel][user.department] : MessengerAccessMode.DISABLED)
    : user.departmentTelegramAccess ?? (user.department ? defaultChannelDepartmentModes[channel][user.department] : MessengerAccessMode.DISABLED);
  const canReceive = channel === Channel.WHATSAPP ? user.canReceiveWhatsApp : user.canReceiveTelegram;
  return inherited === MessengerAccessMode.FULL && canReceive === false ? MessengerAccessMode.READ_ONLY : inherited;
}

export function canViewChannel(user: MessengerPrincipal, channel: Channel) {
  return user.role === Role.ADMIN || effectiveChannelAccess(user, channel) !== MessengerAccessMode.DISABLED;
}

export function canReplyChannel(user: MessengerPrincipal, channel: Channel) {
  return user.role === Role.ADMIN || effectiveChannelAccess(user, channel) === MessengerAccessMode.FULL;
}

export async function getDepartmentMessengerMode(department: Department | null) {
  if (!department) return MessengerAccessMode.DISABLED;
  const stored = await prisma.departmentMessengerPermission.findUnique({ where: { department }, select: { mode: true } });
  return stored?.mode ?? defaultMessengerDepartmentModes[department];
}

export async function getDepartmentMessengerModes() {
  const stored = await prisma.departmentMessengerPermission.findMany({ select: { department: true, mode: true } });
  const modes = { ...defaultMessengerDepartmentModes };
  for (const item of stored) modes[item.department] = item.mode;
  return modes;
}

export async function getDepartmentChannelModes(channel: Channel) {
  const stored = await prisma.departmentChannelPermission.findMany({ where: { channel }, select: { department: true, mode: true } });
  const modes = channel === Channel.MESSENGER
    ? { ...defaultMessengerDepartmentModes }
    : await getDepartmentMessengerModes();
  for (const item of stored) modes[item.department] = item.mode;
  return modes;
}

export async function channelDepartmentPolicies(channel: Channel) {
  const modes = await getDepartmentChannelModes(channel);
  return messengerDepartments.map((department) => ({ department, mode: modes[department] }));
}

export async function messengerAssignmentWhere(): Promise<Prisma.UserWhereInput> {
  return channelAssignmentWhere(Channel.MESSENGER);
}

export async function channelAssignmentWhere(channel: Channel): Promise<Prisma.UserWhereInput> {
  const modes = channel === Channel.MESSENGER ? await getDepartmentMessengerModes() : await getDepartmentChannelModes(channel);
  const receivingDepartments = messengerDepartments.filter((department) => modes[department] === MessengerAccessMode.FULL);
  const accessField = channel === Channel.WHATSAPP ? "whatsappAccess" : channel === Channel.TELEGRAM ? "telegramAccess" : "messengerAccess";
  const receiveField = channel === Channel.WHATSAPP ? "canReceiveWhatsApp" : channel === Channel.TELEGRAM ? "canReceiveTelegram" : "canReceiveMessenger";
  return {
    OR: [
      { [accessField]: MessengerAccessMode.FULL },
      ...(receivingDepartments.length ? [{ [accessField]: null, [receiveField]: true, department: { in: receivingDepartments } }] : [])
    ]
  };
}

export async function messengerViewerWhere(): Promise<Prisma.UserWhereInput> {
  return channelViewerWhere(Channel.MESSENGER);
}

export async function channelViewerWhere(channel: Channel): Promise<Prisma.UserWhereInput> {
  const modes = channel === Channel.MESSENGER ? await getDepartmentMessengerModes() : await getDepartmentChannelModes(channel);
  const visibleDepartments = messengerDepartments.filter((department) => modes[department] !== MessengerAccessMode.DISABLED);
  const accessField = channel === Channel.WHATSAPP ? "whatsappAccess" : channel === Channel.TELEGRAM ? "telegramAccess" : "messengerAccess";
  return {
    OR: [
      { [accessField]: { in: [MessengerAccessMode.FULL, MessengerAccessMode.READ_ONLY] } },
      ...(visibleDepartments.length ? [{ [accessField]: null, department: { in: visibleDepartments } }] : [])
    ]
  };
}

export async function messengerDepartmentPolicies() {
  const modes = await getDepartmentMessengerModes();
  return messengerDepartments.map((department) => ({ department, mode: modes[department] }));
}
