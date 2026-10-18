import { Department, MessengerAccessMode, Prisma, Role } from "@prisma/client";
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

export type MessengerPrincipal = {
  role: Role;
  department: Department | null;
  messengerAccess: MessengerAccessMode | null;
  canReceiveMessenger?: boolean;
  departmentMessengerAccess?: MessengerAccessMode;
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

export async function messengerAssignmentWhere(): Promise<Prisma.UserWhereInput> {
  const modes = await getDepartmentMessengerModes();
  const receivingDepartments = messengerDepartments.filter((department) => modes[department] === MessengerAccessMode.FULL);
  return {
    OR: [
      { messengerAccess: MessengerAccessMode.FULL },
      ...(receivingDepartments.length ? [{ messengerAccess: null, canReceiveMessenger: true, department: { in: receivingDepartments } }] : [])
    ]
  };
}

export async function messengerViewerWhere(): Promise<Prisma.UserWhereInput> {
  const modes = await getDepartmentMessengerModes();
  const visibleDepartments = messengerDepartments.filter((department) => modes[department] !== MessengerAccessMode.DISABLED);
  return {
    OR: [
      { messengerAccess: { in: [MessengerAccessMode.FULL, MessengerAccessMode.READ_ONLY] } },
      ...(visibleDepartments.length ? [{ messengerAccess: null, department: { in: visibleDepartments } }] : [])
    ]
  };
}

export async function messengerDepartmentPolicies() {
  const modes = await getDepartmentMessengerModes();
  return messengerDepartments.map((department) => ({ department, mode: modes[department] }));
}
