import { tenantKey } from "./tenant-scope.js";
import { randomUUID } from "crypto";
import { issueToken } from "./auth.js";

export interface CdnStreamSession {
  id: string;
  roomId: string;
  appId: string;
  streamKey: string;
  rtmpPushUrl: string;
  hlsPlaybackUrl: string;
  startedBy: string;
  startedAt: string;
  endedAt: string | null;
  status: "active" | "stopped";
  mode: "webrtc_bridge" | "rtmp_push";
}

const sessions = new Map<string, CdnStreamSession>();
const activeByRoom = new Map<string, string>();

function rtmpIngestBase() {
  return (process.env.RTMP_INGEST_URL || "rtmp://rtmp-ingest/live").replace(/\/$/, "");
}

function hlsPublicBase() {
  const base = process.env.HLS_PUBLIC_URL || "http://localhost:8081/hls";
  return base.replace(/\/$/, "");
}

export async function startCdnStream(
  appId: string,
  roomId: string,
  startedBy: string,
  jwtSecret?: string
): Promise<CdnStreamSession> {
  if (activeByRoom.has(tenantKey(appId, roomId))) {
    throw new Error("CDN stream already active for this room");
  }

  const id = randomUUID();
  const streamKey = `${roomId}-${id.slice(0, 8)}`;
  const rtmpPushUrl = `${rtmpIngestBase()}/${streamKey}`;
  const hlsPlaybackUrl = `${hlsPublicBase()}/${streamKey}/index.m3u8`;

  const session: CdnStreamSession = {
    id,
    roomId,
    appId,
    streamKey,
    rtmpPushUrl,
    hlsPlaybackUrl,
    startedBy,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "active",
    mode: "rtmp_push",
  };

  sessions.set(id, session);
  activeByRoom.set(tenantKey(appId, roomId), id);

  try {
    const sfuUrl = process.env.SFU_URL?.replace(/\/$/, "");
    if (sfuUrl) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (jwtSecret) {
        headers.Authorization = `Bearer ${issueToken({ appId, userId: startedBy, roomId }, jwtSecret)}`;
      }
      const res = await fetch(`${sfuUrl}/v1/rooms/${encodeURIComponent(roomId)}/cdn-stream/start`, {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers,
        body: JSON.stringify({ streamKey, sessionId: id, rtmpPushUrl }),
      });
      if (!res.ok) {
        activeByRoom.delete(tenantKey(appId, roomId));
        sessions.delete(id);
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `SFU CDN stream start failed (${res.status})`);
      }
      const body = (await res.json()) as { session?: { mode?: CdnStreamSession["mode"] } };
      if (body.session?.mode) session.mode = body.session.mode;
    }

  } catch (error) {
    activeByRoom.delete(tenantKey(appId, roomId));
    sessions.delete(id);
    throw error;
  }
  return session;
}

export async function stopCdnStream(
  roomId: string,
  jwtSecret?: string,
  appId?: string,
  userId?: string
): Promise<CdnStreamSession> {
  if (!appId) throw new Error("appId is required");
  const sessionId = activeByRoom.get(tenantKey(appId, roomId));
  if (!sessionId) throw new Error("No active CDN stream for this room");
  const session = sessions.get(sessionId);
  if (!session) throw new Error("CDN stream session not found");

  const sfuUrl = process.env.SFU_URL?.replace(/\/$/, "");
  if (sfuUrl) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (jwtSecret && appId && userId) {
      headers.Authorization = `Bearer ${issueToken({ appId, userId, roomId }, jwtSecret)}`;
    }
    const res = await fetch(`${sfuUrl}/v1/rooms/${encodeURIComponent(roomId)}/cdn-stream/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers,
    });
  }

  session.endedAt = new Date().toISOString();
  session.status = "stopped";
  activeByRoom.delete(tenantKey(appId, roomId));
  return session;
}

export function getActiveCdnStream(roomId: string, appId: string) {
  const id = activeByRoom.get(tenantKey(appId, roomId));
  return id ? sessions.get(id) ?? null : null;
}

export function listCdnStreams(appId: string) {
  return [...sessions.values()].filter((s) => s.appId === appId);
}

/** Test helper */
export function resetCdnStreams() {
  sessions.clear();
  activeByRoom.clear();
}
