import type { FastifyRequest, FastifyReply } from "fastify";
import { requireUser } from "./user-auth.js";
import { getPool } from "./db.js";

export async function portalVersion(appId: string): Promise<number | null> {
  const db = getPool(); if (!db) return null;
  const result = await db.query(`SELECT portal_version FROM apps WHERE app_id = $1 AND active = TRUE`, [appId]);
  return result.rows[0]?.portal_version ?? null;
}

export async function requirePortalUser(req: FastifyRequest, reply: FastifyReply, secret: string) {
  const claims = requireUser(req, reply, secret) as (ReturnType<typeof requireUser> & { sessionVersion?: number });
  if (!claims) return null;
  if (claims.userId !== "__portal__") { reply.status(403).send({ error: "Portal token required" }); return null; }
  const current = await portalVersion(claims.appId);
  if (current === null || current !== (claims.sessionVersion ?? 0)) {
    reply.status(401).send({ error: "Session expired. Please sign in again." }); return null;
  }
  return claims;
}
