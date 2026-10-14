import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { Department, Role } from "@prisma/client";
import { config } from "./config";
import { prisma } from "./prisma";

export type PermissionName = "canViewAllConversations" | "canTransferConversations" | "canManageCatalog" | "canViewReports" | "canManageTeam";
export type SessionUser = {
  id: string;
  role: Role;
  name: string;
  authVersion: number;
  department: Department | null;
  branchId: string | null;
  canViewAllConversations: boolean | null;
  canTransferConversations: boolean | null;
  canManageCatalog: boolean | null;
  canViewReports: boolean | null;
  canManageTeam: boolean | null;
};
export type AuthedRequest = Request & { user?: SessionUser };

export function signToken(user: Pick<SessionUser, "id" | "role" | "name" | "authVersion">) {
  return jwt.sign(user, config.jwtSecret, { issuer: "bondoq-support" });
}

export async function authenticate(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "يلزم تسجيل الدخول" });
  let claims: SessionUser;
  try {
    claims = jwt.verify(token, config.jwtSecret, { issuer: "bondoq-support" }) as SessionUser;
  } catch {
    return res.status(401).json({ error: "جلسة الدخول غير صالحة أو انتهت" });
  }
  const user = await prisma.user.findFirst({ where: { id: claims.id, isActive: true }, select: {
    id: true, role: true, name: true, authVersion: true, department: true, branchId: true,
    canViewAllConversations: true, canTransferConversations: true, canManageCatalog: true, canViewReports: true, canManageTeam: true
  } });
  if (!user || user.authVersion !== claims.authVersion) return res.status(401).json({ error: "الجلسة منتهية أو تم إبطالها" });
  req.user = user;
  next();
}

export function allowRoles(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: "لا تملك صلاحية لهذا الإجراء" });
    next();
  };
}

export function hasPermission(user: SessionUser | undefined, permission: PermissionName) {
  if (!user) return false;
  if (user.role === Role.ADMIN) return true;
  const override = user[permission];
  if (override !== null && override !== undefined) return override;
  return user.role === Role.SUPERVISOR;
}

export function permissionGuard(permission: PermissionName): RequestHandler[] {
  return [authenticate as RequestHandler, ((req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!hasPermission(req.user, permission)) return res.status(403).json({ error: "لا تملك صلاحية لهذا الإجراء" });
    next();
  }) as RequestHandler];
}

export function canReadConversation(user: SessionUser, conversation: { assignedAgentId: string | null; branchId?: string | null }) {
  if (user.role === Role.ADMIN) return true;
  if (user.role === Role.SUPERVISOR && hasPermission(user, "canViewAllConversations")) return true;
  return conversation.assignedAgentId === user.id;
}

export function canWorkOnConversation(user: SessionUser, conversation: { assignedAgentId: string | null; branchId?: string | null }) {
  if (user.role === Role.ADMIN) return true;
  if (user.role === Role.SUPERVISOR && hasPermission(user, "canViewAllConversations")) return true;
  return conversation.assignedAgentId === user.id;
}

export const adminGuard: RequestHandler[] = [authenticate as RequestHandler, allowRoles(Role.ADMIN, Role.SUPERVISOR) as RequestHandler];
export const agentGuard: RequestHandler[] = [authenticate as RequestHandler, allowRoles(Role.AGENT, Role.BRANCH_USER, Role.ADMIN, Role.SUPERVISOR) as RequestHandler];
