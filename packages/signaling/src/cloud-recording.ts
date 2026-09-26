import { tenantKey } from "./tenant-scope.js";
import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { issueToken } from "./auth.js";

export interface CloudRecordingSession {
  id: string;
  roomId: string;
  appId: string;
  startedBy: string;
  startedAt: string;
  endedAt: string | null;
  status: "recording" | "completed" | "failed";
  filePath: string | null;
}

const sessions = new Map<string, CloudRecordingSession>();
const activeByRoom = new Map<string, string>();

export async function startCloudRecording(
  appId: string,
  roomId: string,
  startedBy: string,
  recordingsDir: string,
  jwtSecret?: string
): Promise<CloudRecordingSession> {
  if (activeByRoom.has(tenantKey(appId, roomId))) {
    throw new Error("Cloud recording already active for this room");
  }
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const session: CloudRecordingSession = {
    id,
    roomId,
    appId,
    startedBy,
    startedAt,
    endedAt: null,
    status: "recording",
    filePath: null,
  };
  sessions.set(id, session);
  activeByRoom.set(tenantKey(appId, roomId), id);

  try {
    const sfuUrl = process.env.SFU_URL?.replace(/\/$/, "");
    if (!sfuUrl) throw new Error("SFU_URL is required for cloud recording");
    await mkdir(recordingsDir, { recursive: true });
    if (sfuUrl) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (jwtSecret) {
        headers.Authorization = `Bearer ${issueToken({ appId, userId: startedBy, roomId }, jwtSecret)}`;
      }
      const res = await fetch(`${sfuUrl}/v1/rooms/${encodeURIComponent(roomId)}/recording/start`, {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers,
        body: JSON.stringify({ sessionId: id }),
      });
      if (!res.ok) {
        activeByRoom.delete(tenantKey(appId, roomId));
        sessions.delete(id);
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `SFU recording start failed (${res.status})`);
      }
    }

  } catch (error) {
    activeByRoom.delete(tenantKey(appId, roomId));
    sessions.delete(id);
    throw error;
  }
  return session;
}

export async function stopCloudRecording(
  roomId: string,
  recordingsDir: string,
  jwtSecret?: string,
  appId?: string,
  userId?: string
): Promise<CloudRecordingSession> {
  if (!appId) throw new Error("appId is required");
  const sessionId = activeByRoom.get(tenantKey(appId, roomId));
  if (!sessionId) throw new Error("No active cloud recording for this room");
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Recording session not found");

  const sfuUrl = process.env.SFU_URL?.replace(/\/$/, "");
  let filePath: string | null = null;
  if (sfuUrl) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (jwtSecret && appId && userId) {
      headers.Authorization = `Bearer ${issueToken({ appId, userId, roomId }, jwtSecret)}`;
    }
    const res = await fetch(`${sfuUrl}/v1/rooms/${encodeURIComponent(roomId)}/recording/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers,
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) throw new Error(`SFU recording stop failed (${res.status})`);
    if (res.ok) {
      const body = (await res.json()) as { filePath?: string; dataBase64?: string };
      if (body.filePath) {
        filePath = body.filePath;
      } else if (body.dataBase64) {
        filePath = path.join(recordingsDir, `cloud-${sessionId}.webm`);
        await writeFile(filePath, Buffer.from(body.dataBase64, "base64"));
      }
    }
  }

  session.endedAt = new Date().toISOString();
  session.status = "completed";
  session.filePath = filePath;
  activeByRoom.delete(tenantKey(appId, roomId));
  return session;
}

export function getActiveCloudRecording(roomId: string, appId: string) {
  const id = activeByRoom.get(tenantKey(appId, roomId));
  return id ? sessions.get(id) ?? null : null;
}

export function listCloudRecordings(appId: string) {
  return [...sessions.values()].filter((s) => s.appId === appId);
}

/** Test helper */
export function resetCloudRecordings() {
  sessions.clear();
  activeByRoom.clear();
}
