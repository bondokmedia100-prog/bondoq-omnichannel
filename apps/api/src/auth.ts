import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";
import { config } from "./config";
import { prisma } from "./prisma";

export type SessionUser = { id: string; role: Role; name: string; authVersion: number };
export type AuthedRequest = Request & { user?: SessionUser };

export function signToken(user: SessionUser) {
  return jwt.sign(user, config.jwtSecret, { expiresIn: "12h", issuer: "bondoq-support" });
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
  const user = await prisma.user.findFirst({ where: { id: claims.id, isActive: true }, select: { id: true, role: true, name: true, authVersion: true } });
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

export const adminGuard: RequestHandler[] = [authenticate as RequestHandler, allowRoles(Role.ADMIN, Role.SUPERVISOR) as RequestHandler];
export const agentGuard: RequestHandler[] = [authenticate as RequestHandler, allowRoles(Role.AGENT, Role.ADMIN, Role.SUPERVISOR) as RequestHandler];
