import { getPool } from "./db.js";

/** Chat is relayed regardless; this bounds what reaches the database. */
export const MAX_MESSAGE_LENGTH = 4000;

export interface StoredMessage {
  id: string;
  roomId: string;
  fromUserId: string;
  text: string;
  clientMsgId: string | null;
  sentAt: string;
}

export interface MessagePage {
  messages: StoredMessage[];
  /** Pass as `before` to fetch the next (older) page. Null when the room is exhausted. */
  nextCursor: string | null;
}

export async function saveMessage(
  appId: string,
  roomId: string,
  fromUserId: string,
  text: string,
  clientMsgId?: string | null
) {
  const db = getPool();
  if (!db) return;

  await db.query(
    `WITH saved AS (INSERT INTO messages (app_id, room_id, from_user_id, text, client_msg_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (app_id, room_id, client_msg_id) WHERE client_msg_id IS NOT NULL DO NOTHING RETURNING id)
     INSERT INTO message_push_jobs (app_id,message_id,user_id,installation_id)
     SELECT $1,saved.id,s.user_id,d.installation_id FROM saved
       JOIN chat_push_subscriptions s ON s.app_id=$1 AND s.room_id=$2 AND s.user_id<>$3
       JOIN push_devices d ON d.app_id=s.app_id AND d.user_id=s.user_id AND d.push_type='alert' AND d.updated_at>NOW()-INTERVAL '90 days'
     ON CONFLICT (app_id,message_id,installation_id) DO NOTHING`,
    [appId, roomId, fromUserId, text, clientMsgId ?? null]
  );
}

function mapRow(row: Record<string, any>): StoredMessage {
  return {
    id: String(row.id),
    roomId: row.room_id,
    fromUserId: row.from_user_id,
    text: row.text,
    clientMsgId: row.client_msg_id,
    sentAt: row.sent_at,
  };
}

/**
 * Newest-first, keyset-paginated on the primary key. Offset pagination would
 * skip or repeat messages as new ones arrive mid-scroll.
 */
export async function listMessages(
  appId: string,
  roomId: string,
  opts: { before?: string; limit?: number } = {}
): Promise<MessagePage> {
  const db = getPool();
  if (!db) throw new Error("Database not configured");

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [appId, roomId];
  let query = `SELECT id, room_id, from_user_id, text, client_msg_id, sent_at
               FROM messages WHERE app_id = $1 AND room_id = $2`;

  if (opts.before) {
    params.push(opts.before);
    query += ` AND id < $${params.length}`;
  }
  // Fetch one extra row to detect whether another page exists.
  params.push(limit + 1);
  query += ` ORDER BY id DESC LIMIT $${params.length}`;

  const result = await db.query(query, params);
  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  const messages = rows.map(mapRow);

  return {
    messages,
    nextCursor: hasMore && messages.length ? messages[messages.length - 1].id : null,
  };
}

export async function countMessages(appId: string, roomId: string): Promise<number> {
  const db = getPool();
  if (!db) throw new Error("Database not configured");

  const result = await db.query(
    `SELECT COUNT(*)::int AS total FROM messages WHERE app_id = $1 AND room_id = $2`,
    [appId, roomId]
  );
  return result.rows[0]?.total ?? 0;
}
