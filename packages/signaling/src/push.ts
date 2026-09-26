import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { getPool } from "./db.js";
import { findUserCall } from "./call-state.js";

interface ServiceAccount { project_id: string; client_email: string; private_key: string }
const accessTokens = new Map<string, { token: string; expires: number }>();

export async function pushCredentials(appId: string): Promise<ServiceAccount | null> {
  const file = process.env.FCM_CONFIG_FILE;
  if (!file) return null;
  const projects = JSON.parse(await readFile(file, "utf8")) as Record<string, ServiceAccount>;
  const credentials = Object.hasOwn(projects, appId) ? projects[appId] : null;
  if (!credentials) return null;
  if (!/^[a-z][a-z0-9-]{4,62}$/.test(credentials.project_id) || typeof credentials.client_email !== "string" || typeof credentials.private_key !== "string") {
    throw new Error("Invalid FCM project configuration");
  }
  return credentials;
}

async function accessToken(credentials: ServiceAccount) {
  const key = createHash("sha256").update(JSON.stringify(credentials)).digest("hex");
  const cached = accessTokens.get(key);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const assertion = jwt.sign({ scope: "https://www.googleapis.com/auth/firebase.messaging" }, credentials.private_key, {
    algorithm: "RS256", issuer: credentials.client_email, audience: "https://oauth2.googleapis.com/token", expiresIn: 3600,
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(5000),
  });
  const result = await response.json() as { access_token?: string; expires_in?: number };
  if (!response.ok || !result.access_token) throw new Error("FCM authorization failed");
  accessTokens.set(key, { token: result.access_token, expires: Date.now() + Math.min(result.expires_in || 3600, 3600) * 1000 });
  return result.access_token;
}

export async function sendCallPush(appId: string, payload: Record<string, unknown>) {
  const db = getPool();
  if (!db || typeof payload.toUserId !== "string" || typeof payload.callId !== "string") return;
  const credentials = await pushCredentials(appId);
  if (!credentials) return;
  const devices = await db.query(`SELECT installation_id, token FROM push_devices WHERE app_id = $1 AND user_id = $2 AND updated_at > NOW() - INTERVAL '90 days' ORDER BY updated_at DESC LIMIT 10`, [appId, payload.toUserId]);
  if (!devices.rowCount) return;
  const bearer = await accessToken(credentials);
  await Promise.all(devices.rows.map(async (device) => {
    const call = findUserCall(appId, payload.toUserId as string);
    if (!call || call.callId !== payload.callId || call.phase !== "ringing" || call.ringingExpiresAt <= Date.now()) return;
    const ttl = Math.max(1, Math.floor((call.ringingExpiresAt - Date.now()) / 1000));
    let status: number | null = null;
    let success = false;
    try {
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${credentials.project_id}/messages:send`, {
        method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { token: device.token, android: { priority: "HIGH", ttl: `${ttl}s` }, data: {
          type: "rtc_call_invite", callId: call.callId, roomId: call.roomId,
          fromUserId: call.callerUserId, callType: call.callType, expiresAt: String(call.ringingExpiresAt),
        } } }), signal: AbortSignal.timeout(5000),
      });
      status = response.status; success = response.ok;
      const result = await response.json() as { error?: { details?: Array<{ errorCode?: string }> } };
      if (result.error?.details?.some(detail => detail.errorCode === "UNREGISTERED")) {
        await db.query(`DELETE FROM push_devices WHERE app_id = $1 AND installation_id = $2 AND token = $3`, [appId, device.installation_id, device.token]);
      }
    } catch { /* Persist only status, never device tokens or credentials. */ }
    await db.query(`INSERT INTO push_deliveries (app_id, call_id, installation_id, success, status_code) VALUES ($1,$2,$3,$4,$5)`, [appId, call.callId, device.installation_id, success, status]);
  }));
}
