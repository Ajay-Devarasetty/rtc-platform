import "dotenv/config";
import { WebSocketServer, WebSocket } from "ws";
import Fastify from "fastify";
import cors from "@fastify/cors";
import type {
  ClientMessage,
  ServerMessage,
  TokenClaims,
  TokenRequest,
  TokenResponse,
} from "@rtc/protocol";
import { verifyToken, issueToken } from "./auth.js";
import { verifyAppCredentials, seedDemoApp } from "./apps.js";
import { getPlatformConfig } from "./config.js";
import { closeDb, getPool, runMigrations } from "./db.js";
import { loadSignalingEnv } from "./env.js";
import { handleClientMessage } from "./handlers.js";
import { getIceConfig } from "./ice.js";
import { MessageRelay } from "./relay.js";
import { rateLimit } from "./rate-limit.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerCustomerRoutes } from './routes/customers.js';
import { registerEventRoutes } from "./routes/events.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerRecordingRoutes } from "./routes/recordings.js";
import { registerRecordingUploadRoutes } from "./routes/recording-upload.js";
import { registerQualityRoutes } from "./routes/quality.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerMediaSessionRoutes } from "./routes/media-sessions.js";
import { registerLeadRoutes } from "./routes/leads.js";
import { registerDemoTokenRoutes } from "./routes/demo-token.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerPushSettingsRoutes } from "./routes/push-settings.js";
import { registerConsoleRoutes } from "./routes/console.js";
import { registerPortalRoutes } from "./routes/portal.js";
import { endMediaSessionsForUser, leaveMediaSession } from "./media-sessions.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { endActiveCallsForUser, endCallSession } from "./metering.js";
import { clearUserCalls, expireRingingCalls, findUserCall } from "./call-state.js";
import { tenantKey, scopedRooms, scopedRoles } from "./tenant-scope.js";
import { registerMediaAuthorizeRoutes } from "./routes/media-authorize.js";
import { ProjectTaskQueue } from "./task-queue.js";
import { registerPushRoutes } from "./routes/push.js";
import { sendCallPush } from "./push.js";
import { startMessagePushWorker, removeChatSubscription } from './chat-notifications.js';
import { registerAccountSecurityRoutes } from "./routes/account-security.js";
import { registerDiagnosticsRoutes } from "./routes/diagnostics.js";
import { dispatchEvent } from "./webhooks.js";
import { setRecordingsDir, ensureRecordingsDir } from "./recordings.js";
import { MemoryRoomRoleStore } from "./room-roles.js";
import { registerCloudRecordingRoutes } from "./routes/cloud-recording.js";
import { registerCdnStreamRoutes } from "./routes/cdn-stream.js";
import { MemoryPresenceStore, MemoryRoomStore } from "./store/memory.js";
import {
  createRedisClient,
  RedisPresenceStore,
  RedisRoomStore,
} from "./store/redis.js";
import type { PresenceStore, RoomStore } from "./store/types.js";

const env = loadSignalingEnv();
setRecordingsDir(env.recordingsDir);
await ensureRecordingsDir();

if (env.databaseUrl) {
  await runMigrations();
  await seedDemoApp();
  console.log("PostgreSQL app registry enabled");
} else {
  console.log("No DATABASE_URL — using env demo credentials only");
}

const app = Fastify({ logger: true });
await app.register(cors, { origin: true, methods:['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'] });
await registerAdminRoutes(app);
await app.register(async scope=>registerCustomerRoutes(scope,env.jwtSecret));
await registerWebhookRoutes(app);
await registerEventRoutes(app);
await registerRecordingRoutes(app);
await registerQualityRoutes(app);
await registerBillingRoutes(app);
await registerMediaSessionRoutes(app);
await registerLeadRoutes(app);
await registerDemoTokenRoutes(app, { jwtSecret: env.jwtSecret });
await registerAuthRoutes(app, env.jwtSecret);
await registerPortalRoutes(app, env.jwtSecret);
await app.register(async (scope) => registerConsoleRoutes(scope, env.jwtSecret));
await app.register(async (scope) => registerPushSettingsRoutes(scope, env.jwtSecret));
await registerPushRoutes(app, env.jwtSecret);
await registerAccountSecurityRoutes(app, env.jwtSecret);
await registerDiagnosticsRoutes(app, env.jwtSecret);

let rooms: RoomStore = new MemoryRoomStore();
const roomRoles = new MemoryRoomRoleStore();
let presence: PresenceStore = new MemoryPresenceStore();
let redisPub = env.redisUrl ? createRedisClient(env.redisUrl) : null;
let redisSub = env.redisUrl ? createRedisClient(env.redisUrl) : null;

if (redisPub && redisSub) {
  rooms = new RedisRoomStore(redisPub);
  presence = new RedisPresenceStore(redisPub);
  console.log(`Redis enabled (${env.instanceId})`);
} else {
  console.log("Running in single-node mode (set REDIS_URL for scale)");
}

// Registered here rather than with the other routes so it binds the final
// room store, after Redis has had its chance to replace the in-memory one.
await registerMessageRoutes(app, { jwtSecret: env.jwtSecret, rooms });
await registerMediaAuthorizeRoutes(app, { jwtSecret: env.jwtSecret, rooms, roomRoles });
await registerCloudRecordingRoutes(app, {
  jwtSecret: env.jwtSecret,
  recordingsDir: env.recordingsDir,
  rooms,
  roomRoles,
});
await registerCdnStreamRoutes(app, {
  jwtSecret: env.jwtSecret,
  rooms,
  roomRoles,
});

async function checkRedis() {
  if (!redisPub) return true;
  try {
    const pong = await redisPub.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

async function checkDatabase() {
  const pool = getPool();
  if (!pool) return true;
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

app.get("/health", async () => ({
  ok: true,
  service: "rtc-signaling",
  instanceId: env.instanceId,
  uptime: process.uptime(),
}));

app.get("/ready", async (_req, reply) => {
  const checks = {
    redis: await checkRedis(),
    database: await checkDatabase(),
  };
  const ready = Object.values(checks).every(Boolean);
  const payload = {
    ok: ready,
    service: "rtc-signaling",
    instanceId: env.instanceId,
    ready,
    checks,
  };
  if (!ready) return reply.status(503).send(payload);
  return payload;
});

function userIdFromAuthHeader(req: { headers: { authorization?: string } }) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  try {
    return verifyToken(header.slice(7), env.jwtSecret).userId;
  } catch {
    return undefined;
  }
}

app.get<{ Querystring: { appId?: string } }>("/v1/config", async (req) =>
  getPlatformConfig(req.query.appId, userIdFromAuthHeader(req))
);
app.get("/v1/ice", async (req) => getIceConfig({ userId: userIdFromAuthHeader(req) }));

app.post<{ Body: TokenRequest }>("/v1/token", async (req, reply) => {
  const ip = req.ip;
  if (!rateLimit(`token:${ip}`, 30, 60_000)) {
    return reply.status(429).send({ error: "Too many token requests" });
  }

  const { appId, appSecret, userId, roomId, role } = req.body || {};
  if (typeof appId !== "string" || typeof appSecret !== "string" || typeof userId !== "string" || !appId || !appSecret || !userId || userId === "__portal__") {
    return reply.status(400).send({ error: "appId, appSecret, and userId are required" });
  }

  const valid = await verifyAppCredentials(appId, appSecret);
  if (!valid) {
    return reply.status(401).send({ error: "Invalid app credentials" });
  }

  const token = issueToken({ appId, userId, roomId, role }, env.jwtSecret);
  const response: TokenResponse = { token, expiresIn: 3600 };
  return response;
});

const userNotifier = {
  sendToUser: async (_appId: string, _userId: string, _message: ServerMessage) => false,
};

await registerRecordingUploadRoutes(app, {
  env,
  dispatch: dispatchSafely,
  sendToUser: (appId, userId, message) => userNotifier.sendToUser(appId, userId, message),
});

await app.ready();
const wss = new WebSocketServer({ server: app.server, path: "/ws" });

const sockets = new Map<string, WebSocket>();
const projectTasks = new ProjectTaskQueue();

function send(ws: WebSocket, message: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

const relay = new MessageRelay(
  env.instanceId,
  sockets,
  presence,
  redisPub,
  redisSub,
  send
);
await relay.start();
const stopMessagePushWorker=startMessagePushWorker(async(appId,userId)=>Boolean(await presence.getInstance(tenantKey(appId,userId))),()=>app.log.error('Message push queue failed'));

userNotifier.sendToUser = (appId, userId, message) => relay.sendToUser(tenantKey(appId, userId), message);

function dispatchSafely(appId: string, type: string, payload: Record<string, unknown>) {
  if (type === "call.ringing") void sendCallPush(appId, payload).catch(() => app.log.error("Call push failed; check FCM configuration and push delivery records"));
  void dispatchEvent(appId, type, payload).catch((err) => app.log.error({ err }, "Event dispatch failed"));
}

const ringingTimer = setInterval(() => {
  for (const call of expireRingingCalls()) {
    for (const userId of [call.callerUserId, call.calleeUserId]) {
      void relay.sendToUser(tenantKey(call.appId, userId), {
        type: "call_end",
        payload: { callId: call.callId, roomId: call.roomId, fromUserId: userId === call.callerUserId ? call.calleeUserId : call.callerUserId, toUserId: userId, reason: "no_answer" },
      }).catch((err) => app.log.error({ err }, "Call timeout delivery failed"));
    }
    dispatchSafely(call.appId, "call.failed", { ...call, reason: "no_answer" });
  }
}, 1000);
ringingTimer.unref();

async function forceLeaveRoom(
  appId: string,
  roomId: string,
  targetUserId: string,
  reason: string
) {
  const appRooms = scopedRooms(rooms, appId);
  await removeChatSubscription(appId,roomId,targetUserId);
  await appRooms.leave(roomId, targetUserId);
  scopedRoles(roomRoles, appId).remove(roomId, targetUserId);
  await leaveMediaSession(appId, roomId, targetUserId, reason);
  await closeUserCall(appId, targetUserId, reason, roomId);

  await relay.sendToUser(tenantKey(appId, targetUserId), {
    type: "user_kicked",
    payload: { roomId, reason },
  });

  const members = await appRooms.getMembers(roomId);
  for (const memberId of members) {
    await relay.sendToUser(tenantKey(appId, memberId), {
      type: "user_left",
      payload: { roomId, userId: targetUserId },
    });
  }
  dispatchSafely(appId, "user.left", { roomId, userId: targetUserId, reason });
}

async function closeUserCall(appId: string, userId: string, reason: string, roomId?: string) {
  const call = findUserCall(appId, userId);
  if (!call || (roomId && call.roomId !== roomId)) return;
  await endCallSession(appId, call.callId, reason);
  clearUserCalls(appId, userId);
  const peer = call.callerUserId === userId ? call.calleeUserId : call.callerUserId;
  await relay.sendToUser(tenantKey(appId, peer), { type: "call_end", payload: { callId: call.callId, roomId: call.roomId, fromUserId: userId, toUserId: peer, reason } });
  dispatchSafely(appId, "call.ended", { callId: call.callId, roomId: call.roomId, fromUserId: userId, toUserId: peer, reason });
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const token = url.searchParams.get("token");

  if (!token) {
    ws.close(4001, "Missing token");
    return;
  }

  let claims: TokenClaims;
  try {
    claims = verifyToken(token, env.jwtSecret);
  } catch {
    ws.close(4002, "Invalid token");
    return;
  }

  const { userId } = claims;
  const socketKey = tenantKey(claims.appId, userId);
  const appRooms = scopedRooms(rooms, claims.appId);
  const appRoles = scopedRoles(roomRoles, claims.appId);
  void projectTasks.run(claims.appId, async () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const previous = sockets.get(socketKey);
    sockets.set(socketKey, ws);
    previous?.close(4000, "Replaced by a new connection");
    await presence.setOnline(socketKey, env.instanceId);

    send(ws, {
      type: "connected",
      payload: { userId, appId: claims.appId, instanceId: env.instanceId },
    });

    const pendingCall = findUserCall(claims.appId, userId);
    if (pendingCall?.phase === "ringing" && pendingCall.calleeUserId === userId && pendingCall.ringingExpiresAt > Date.now() && (!claims.roomId || claims.roomId === pendingCall.roomId)) {
      send(ws, { type: "call_invite", payload: { callId: pendingCall.callId, roomId: pendingCall.roomId, fromUserId: pendingCall.callerUserId, toUserId: userId, callType: pendingCall.callType } });
    }
  }).catch((err) => { app.log.error({ err }, "Connection setup failed"); ws.close(1011, "Connection setup failed"); });

  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as ClientMessage;
      void projectTasks.run(claims.appId, async () => {
        if (sockets.get(socketKey) !== ws) return;
        await handleClientMessage({
          message,
          claims,
          ws,
          rooms: appRooms,
          roomRoles: appRoles,
          send,
          sendToUser: (targetUserId, serverMessage) =>
            relay.sendToUser(tenantKey(claims.appId, targetUserId), serverMessage),
          dispatch: (type, payload) => dispatchSafely(claims.appId, type, payload),
          forceLeaveRoom: (roomId, targetUserId, reason) =>
            forceLeaveRoom(claims.appId, roomId, targetUserId, reason),
        });
      }).catch((err) => {
        app.log.error({ err }, "Signaling message failed");
        send(ws, { type: "error", payload: { message: "Unable to process message", code: "message_failed" }, requestId: message?.requestId });
      });
    } catch {
      send(ws, { type: "error", payload: { message: "Invalid message format" } });
    }
  });

  ws.on("close", () => {
    void projectTasks.run(claims.appId, async () => {
      if (sockets.get(socketKey) !== ws) return;
      sockets.delete(socketKey);
      await presence.setOffline(socketKey);
      // Close group media and any in-progress call before dropping room
      // membership, so a lost socket can't leave a session open indefinitely.
      await endMediaSessionsForUser(claims.appId, userId);
      await closeUserCall(claims.appId, userId, "disconnected");
      await endActiveCallsForUser(claims.appId, userId);
      clearUserCalls(claims.appId, userId);
      const leftRooms = await appRooms.leaveAll(userId);
      for (const roomId of leftRooms) {
        appRoles.remove(roomId, userId);
        const members = await appRooms.getMembers(roomId);
        for (const memberId of members) {
          await relay.sendToUser(tenantKey(claims.appId, memberId), {
            type: "user_left",
            payload: { roomId, userId },
          });
        }
        dispatchSafely(claims.appId, "user.left", { roomId, userId });
      }
    }).catch((err) => app.log.error({ err }, "Disconnect cleanup failed"));
  });
});

await app.listen({ port: env.port, host: "0.0.0.0" });
console.log(`RTC signaling server on http://localhost:${env.port}`);
console.log(`WebSocket: ws://localhost:${env.port}/ws?token=...`);

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(ringingTimer);
  await stopMessagePushWorker();
  console.log(`Shutting down (${signal})...`);

  for (const ws of sockets.values()) {
    ws.close(1001, "Server shutting down");
  }
  sockets.clear();

  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await relay.stop();
  if (redisPub) await redisPub.quit();
  if (redisSub) await redisSub.quit();
  await closeDb();
  await app.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
