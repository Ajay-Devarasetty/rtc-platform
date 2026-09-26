import type { FastifyInstance } from "fastify";
import { getPool } from "../db.js";
import { requirePortalUser } from "../portal-auth.js";
import { listWebhookDeliveries } from "../webhooks.js";
import { getMediaStats } from "../media-sessions.js";
import { pushCredentials } from "../push.js";
import { emailConfigured } from "../account-security.js";
import { rateLimit } from "../rate-limit.js";

export async function registerDiagnosticsRoutes(app: FastifyInstance, secret: string) {
  app.get<{ Querystring: { callId?: string } }>("/v1/portal/diagnostics", async (req, reply) => {
    const claims = await requirePortalUser(req, reply, secret); if (!claims) return;
    if (!rateLimit(`diagnostics:${claims.appId}`, 60, 60000)) return reply.status(429).send({ error: "Too many requests" });
    const callId = req.query.callId?.trim() || null;
    if (callId && callId.length > 128) return reply.status(400).send({ error: "Call ID too long" });
    const db = getPool(); if (!db) return reply.status(503).send({ error: "Database unavailable" });
    const args = [claims.appId, callId];
    const [calls, events, quality, pushes, deliveries, groupUsage, account] = await Promise.all([
      db.query(`SELECT call_id, room_id, caller_user_id, callee_user_id, started_at, ended_at, duration_ms, end_reason FROM call_sessions WHERE app_id=$1 AND ($2::text IS NULL OR call_id=$2) ORDER BY started_at DESC LIMIT 50`, args),
      db.query(`SELECT id, type, room_id, user_id, created_at FROM events WHERE app_id=$1 AND ($2::text IS NULL OR payload->>'callId'=$2) ORDER BY created_at DESC LIMIT 50`, args),
      db.query(`SELECT call_id, user_id, quality_score, quality_label, rtt_ms, packet_loss_pct, created_at FROM call_quality_reports WHERE app_id=$1 AND ($2::text IS NULL OR call_id=$2) ORDER BY created_at DESC LIMIT 50`, args),
      db.query(`SELECT call_id, success, status_code, created_at FROM push_deliveries WHERE app_id=$1 AND ($2::text IS NULL OR call_id=$2) ORDER BY created_at DESC LIMIT 50`, args),
      listWebhookDeliveries(claims.appId, { limit: 50 }), getMediaStats(claims.appId),
      db.query(`SELECT email_verified_at FROM customer_accounts WHERE app_id=$1`, [claims.appId]),
    ]);
    const pushStatus = await pushCredentials(claims.appId).then(config => config ? "configured" : "not_configured").catch(() => "configuration_error");
    reply.header("Cache-Control", "no-store");
    return { calls: calls.rows, events: events.rows, quality: quality.rows, pushes: pushes.rows, deliveries, groupUsage,
      configuration: { androidPush: pushStatus, emailDelivery: emailConfigured(), emailVerified: Boolean(account.rows[0]?.email_verified_at) } };
  });
}
