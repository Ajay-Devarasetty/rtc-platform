import type { FastifyInstance } from "fastify";
import { getPool } from "../db.js";
import { requireUser } from "../user-auth.js";
import { rateLimit } from "../rate-limit.js";

export async function registerPushRoutes(app: FastifyInstance, jwtSecret: string) {
  app.post<{ Body: { installationId?: string; token?: string } }>("/v1/push/devices", async (req, reply) => {
    const claims = requireUser(req, reply, jwtSecret);
    if (!claims) return;
    if (claims.userId === "__portal__") return reply.status(403).send({ error: "RTC user token required" });
    if (!rateLimit(`push:${claims.appId}:${claims.userId}`, 30, 60000)) return reply.status(429).send({ error: "Too many registrations" });
    const { installationId, token } = req.body || {};
    if (typeof installationId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(installationId) || typeof token !== "string" || token.length < 20 || token.length > 4096) return reply.status(400).send({ error: "Valid installationId and FCM token required" });
    const db = getPool(); if (!db) return reply.status(503).send({ error: "Database unavailable" });
    // A stable installation ID follows the active signed-in user on shared devices.
    await db.query(`INSERT INTO push_devices (app_id, installation_id, user_id, token) VALUES ($1,$2,$3,$4)
      ON CONFLICT (app_id, installation_id) DO UPDATE SET user_id = EXCLUDED.user_id, token = EXCLUDED.token, updated_at = NOW()`, [claims.appId, installationId, claims.userId, token]);
    return { ok: true };
  });
  app.delete<{ Params: { installationId: string } }>("/v1/push/devices/:installationId", async (req, reply) => {
    const claims = requireUser(req, reply, jwtSecret); if (!claims) return;
    const db = getPool(); if (!db) return reply.status(503).send({ error: "Database unavailable" });
    await db.query(`DELETE FROM push_devices WHERE app_id = $1 AND user_id = $2 AND installation_id = $3`, [claims.appId, claims.userId, req.params.installationId]);
    return { ok: true };
  });
}
