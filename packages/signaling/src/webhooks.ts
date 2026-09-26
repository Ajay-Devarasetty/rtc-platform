import { createHmac, randomBytes } from "crypto";
import { getPool } from "./db.js";
import { recordEvent } from "./events.js";

export interface WebhookRecord {
  id: string;
  appId: string;
  url: string;
  eventTypes: string[];
  active: boolean;
  createdAt: string;
}

const MAX_DELIVERY_ATTEMPTS = 3;

function generateSecret() {
  return `whsec_${randomBytes(16).toString("hex")}`;
}

export async function createWebhook(appId: string, url: string, eventTypes: string[]) {
  const db = getPool();
  if (!db) throw new Error("Database not configured");

  const secret = generateSecret();
  const result = await db.query(
    `INSERT INTO webhooks (app_id, url, secret, event_types)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [appId, url, secret, eventTypes]
  );

  return {
    id: result.rows[0].id as string,
    appId,
    url,
    secret,
    eventTypes,
    createdAt: result.rows[0].created_at as string,
    note: "Store the secret securely. It is shown only once.",
  };
}

export async function listWebhooks(appId: string): Promise<WebhookRecord[]> {
  const db = getPool();
  if (!db) throw new Error("Database not configured");

  const result = await db.query(
    `SELECT id, app_id, url, event_types, active, created_at
     FROM webhooks WHERE app_id = $1 ORDER BY created_at DESC`,
    [appId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    appId: row.app_id,
    url: row.url,
    eventTypes: row.event_types,
    active: row.active,
    createdAt: row.created_at,
  }));
}

export async function deleteWebhook(appId: string, id: string): Promise<boolean> {
  const db = getPool();
  if (!db) throw new Error("Database not configured");

  const result = await db.query(`DELETE FROM webhooks WHERE id = $1 AND app_id = $2`, [id, appId]);
  return (result.rowCount ?? 0) > 0;
}

export interface WebhookDelivery {
  id: number;
  webhookId: string;
  eventId: number | null;
  eventType: string | null;
  statusCode: number | null;
  success: boolean;
  error: string | null;
  attempt: number;
  createdAt: string;
}

export async function listWebhookDeliveries(
  appId: string,
  opts: { webhookId?: string; limit?: number } = {}
): Promise<WebhookDelivery[]> {
  const db = getPool();
  if (!db) throw new Error("Database not configured");

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [appId];
  let query = `
    SELECT wd.id, wd.webhook_id, wd.event_id, e.type AS event_type,
           wd.status_code, wd.success, wd.error, wd.attempt, wd.created_at
    FROM webhook_deliveries wd
    JOIN webhooks w ON w.id = wd.webhook_id
    LEFT JOIN events e ON e.id = wd.event_id
    WHERE w.app_id = $1`;

  if (opts.webhookId) {
    params.push(opts.webhookId);
    query += ` AND wd.webhook_id = $${params.length}`;
  }
  params.push(limit);
  query += ` ORDER BY wd.created_at DESC LIMIT $${params.length}`;

  const result = await db.query(query, params);
  return result.rows.map((row) => ({
    id: row.id,
    webhookId: row.webhook_id,
    eventId: row.event_id,
    eventType: row.event_type,
    statusCode: row.status_code,
    success: row.success,
    error: row.error,
    attempt: row.attempt,
    createdAt: row.created_at,
  }));
}

export async function updateWebhook(
  appId: string,
  id: string,
  updates: { active?: boolean; url?: string; eventTypes?: string[] }
) {
  const db = getPool();
  if (!db) throw new Error("Database not configured");

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.active !== undefined) {
    sets.push(`active = $${idx++}`);
    params.push(updates.active);
  }
  if (updates.url) {
    sets.push(`url = $${idx++}`);
    params.push(updates.url);
  }
  if (updates.eventTypes) {
    sets.push(`event_types = $${idx++}`);
    params.push(updates.eventTypes);
  }
  if (!sets.length) return null;

    params.push(id, appId);
    const result = await db.query(
      `UPDATE webhooks SET ${sets.join(", ")} WHERE id = $${idx} AND app_id = $${idx + 1}
     RETURNING id, app_id, url, event_types, active, created_at`,
      params
    );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    appId: row.app_id,
    url: row.url,
    eventTypes: row.event_types,
    active: row.active,
    createdAt: row.created_at,
  } satisfies WebhookRecord;
}

async function getActiveWebhooksForEvent(appId: string, type: string) {
  const db = getPool();
  if (!db) return [];

  const result = await db.query(
    `SELECT id, url, secret FROM webhooks WHERE app_id = $1 AND active = TRUE AND $2 = ANY(event_types)`,
    [appId, type]
  );
  return result.rows as Array<{ id: string; url: string; secret: string }>;
}

function signPayload(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function logDelivery(
  webhookId: string,
  eventId: number | null,
  success: boolean,
  statusCode: number | null,
  error: string | null,
  attempt: number
) {
  const db = getPool();
  if (!db) return;
  await db.query(
    `INSERT INTO webhook_deliveries (webhook_id, event_id, status_code, success, error, attempt)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [webhookId, eventId, statusCode, success, error, attempt]
  );
}

async function deliverWithRetry(
  webhook: { id: string; url: string; secret: string },
  body: string,
  eventId: number | null
) {
  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
    try {
      const signature = signPayload(webhook.secret, body);
      const res = await fetch(webhook.url, {
        signal: AbortSignal.timeout(5000),
        redirect: "error",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-RTC-Signature": signature,
        },
        body,
      });
      await logDelivery(webhook.id, eventId, res.ok, res.status, res.ok ? null : `HTTP ${res.status}`, attempt);
      if (res.ok) return;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown delivery error";
      await logDelivery(webhook.id, eventId, false, null, message, attempt);
    }
    if (attempt < MAX_DELIVERY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
}

/**
 * Persists the event and fires any matching webhooks. No-ops when no DB is
 * configured (in-memory/demo mode), matching the rest of the app-registry.
 */
export async function dispatchEvent(appId: string, type: string, payload: Record<string, unknown>) {
  const event = await recordEvent(appId, type, payload);

  const webhooks = await getActiveWebhooksForEvent(appId, type);
  if (!webhooks.length) return;

  const body = JSON.stringify({
    type,
    appId,
    data: payload,
    eventId: event?.id ?? null,
    createdAt: new Date().toISOString(),
  });

  for (const webhook of webhooks) {
    void deliverWithRetry(webhook, body, event?.id ?? null).catch(() => console.error("Webhook delivery logging failed"));
  }
}
