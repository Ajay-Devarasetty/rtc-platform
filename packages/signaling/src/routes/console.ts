import type { FastifyInstance } from "fastify";
import { getPool } from "../db.js";
import { requirePortalUser } from "../portal-auth.js";
import { issueToken, verifyToken } from "../auth.js";
import { rateLimit } from "../rate-limit.js";
import { listWebhooks } from "../webhooks.js";

export function reportPeriod(from: unknown, to: unknown) {
  if (typeof from !== "string" || typeof to !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || new Date(start).toISOString().slice(0, 10) !== from || new Date(end).toISOString().slice(0, 10) !== to || end < start || end - start > 92 * 86400000) return null;
  return { from: new Date(start).toISOString(), to: new Date(end + 86400000).toISOString() };
}

export async function registerConsoleRoutes(app: FastifyInstance, secret: string) {
  // All console queries use the authenticated project, never an app ID supplied by the browser.
  app.addHook("onSend", async (_req, reply, payload) => { reply.header("Cache-Control", "no-store"); return payload; });

  app.get("/v1/portal/project", async (req, reply) => {
    const claims = await requirePortalUser(req, reply, secret); if (!claims) return;
    const db = getPool(); if (!db) return reply.code(503).send({ error: "Database unavailable" });
    const [project, webhooks] = await Promise.all([
      db.query("SELECT app_id, name, active, created_at FROM apps WHERE app_id=$1", [claims.appId]),
      listWebhooks(claims.appId),
    ]);
    return { project: project.rows[0], webhooks };
  });

  app.patch<{ Body: { name?: unknown } }>("/v1/portal/project", async (req, reply) => {
    const claims = await requirePortalUser(req, reply, secret); if (!claims) return;
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 100) return reply.code(400).send({ error: "Enter a project name of 1–100 characters" });
    const db = getPool(); if (!db) return reply.code(503).send({ error: "Database unavailable" });
    await db.query("UPDATE apps SET name=$1 WHERE app_id=$2", [name, claims.appId]);
    return { name };
  });

  app.get<{ Querystring: { from?: string; to?: string } }>("/v1/portal/reports", async (req, reply) => {
    const claims = await requirePortalUser(req, reply, secret); if (!claims) return;
    if (!rateLimit(`console-reports:${claims.appId}`, 30, 60000)) return reply.code(429).send({ error: "Too many report requests. Try again shortly." });
    const period = reportPeriod(req.query.from, req.query.to);
    if (!period) return reply.code(400).send({ error: "Use valid dates, in order, spanning at most 93 days" });
    const db = getPool(); if (!db) return reply.code(503).send({ error: "Database unavailable" });
    const args = [claims.appId, period.from, period.to];
    const [daily, calls, media, rooms, recordings, devices] = await Promise.all([
      db.query(`WITH days AS (SELECT generate_series(($2::timestamptz AT TIME ZONE 'UTC'), ($3::timestamptz AT TIME ZONE 'UTC') - interval '1 day', interval '1 day') AT TIME ZONE 'UTC' AS day),
        message_counts AS (SELECT (sent_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS messages FROM messages WHERE app_id=$1 AND sent_at >= $2 AND sent_at < $3 GROUP BY 1),
        activity AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(DISTINCT user_id)::int AS users, count(DISTINCT room_id)::int AS rooms FROM events WHERE app_id=$1 AND created_at >= $2 AND created_at < $3 AND user_id IS NOT NULL AND user_id <> '__portal__' GROUP BY 1)
        SELECT to_char(days.day AT TIME ZONE 'UTC','YYYY-MM-DD') AS date, COALESCE(message_counts.messages,0) AS messages, COALESCE(activity.users,0) AS users, COALESCE(activity.rooms,0) AS rooms,
          COALESCE((SELECT sum(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE(c.ended_at,NOW()),days.day + interval '24 hours',NOW()) - GREATEST(c.started_at,days.day)))))/60 FROM call_sessions c WHERE c.app_id=$1 AND c.started_at < days.day + interval '24 hours' AND COALESCE(c.ended_at,NOW()) > days.day),0)::float8 AS minutes
        FROM days LEFT JOIN message_counts ON message_counts.day=(days.day AT TIME ZONE 'UTC')::date LEFT JOIN activity ON activity.day=(days.day AT TIME ZONE 'UTC')::date ORDER BY days.day`, args),
      db.query(`SELECT call_id, room_id, caller_user_id, callee_user_id, started_at, ended_at, end_reason FROM call_sessions WHERE app_id=$1 AND started_at < $3 AND COALESCE(ended_at,NOW()) >= $2 ORDER BY started_at DESC LIMIT 200`, args),
      db.query(`SELECT room_id, user_id, kind, joined_at, left_at, end_reason FROM media_sessions WHERE app_id=$1 AND joined_at < $3 AND COALESCE(left_at,NOW()) >= $2 ORDER BY joined_at DESC LIMIT 200`, args),
      db.query(`SELECT room_id, count(*)::int AS messages, count(DISTINCT from_user_id)::int AS senders, max(sent_at) AS last_message_at FROM messages WHERE app_id=$1 AND sent_at >= $2 AND sent_at < $3 GROUP BY room_id ORDER BY messages DESC LIMIT 200`, args),
      db.query(`SELECT id, call_id, room_id, duration_ms, size_bytes, mime_type, created_at FROM recordings WHERE app_id=$1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at DESC LIMIT 200`, args),
      db.query(`SELECT installation_id, user_id, updated_at FROM push_devices WHERE app_id=$1 AND updated_at >= $2 AND updated_at < $3 ORDER BY updated_at DESC LIMIT 200`, args),
    ]);
    return { daily: daily.rows, calls: calls.rows, media: media.rows, rooms: rooms.rows, recordings: recordings.rows, devices: devices.rows, recordLimit: 200, timezone: "UTC" };
  });

  app.post<{ Body: { userId?: unknown; roomId?: unknown } }>("/v1/portal/test-token", async (req, reply) => {
    const claims = await requirePortalUser(req, reply, secret); if (!claims) return;
    if (!rateLimit(`console-token:${claims.appId}`, 20, 60000)) return reply.code(429).send({ error: "Too many requests" });
    const { userId, roomId } = req.body || {};
    if (typeof userId !== "string" || !userId.trim() || userId.length > 128 || userId.trim().startsWith("__") || typeof roomId !== "string" || !roomId.trim() || roomId.length > 128) return reply.code(400).send({ error: "Enter a user ID and room ID of 1–128 characters. Reserved user IDs are not allowed." });
    return { token: issueToken({ appId: claims.appId, userId: userId.trim(), roomId: roomId.trim(), role: "publisher" }, secret, 900), expiresIn: 900 };
  });

  app.post<{ Body: { token?: unknown } }>("/v1/portal/verify-test-token", async (req, reply) => {
    const claims = await requirePortalUser(req, reply, secret); if (!claims) return;
    if (!rateLimit(`console-verify:${claims.appId}`, 30, 60000)) return reply.code(429).send({ error: "Too many requests" });
    if (typeof req.body?.token !== "string" || req.body.token.length > 4096) return reply.code(400).send({ error: "Invalid token" });
    try {
      const verified = verifyToken(req.body.token, secret);
      if (verified.appId !== claims.appId || verified.userId === "__portal__") return reply.code(400).send({ error: "Use an RTC user token for this project" });
      return { valid: true, claims: verified };
    } catch { return reply.code(400).send({ error: "Token is invalid or expired" }); }
  });
}
