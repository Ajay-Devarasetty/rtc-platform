import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { SfuManager } from "./sfu.js";
import { loadSfuEnv } from "./env.js";
import { createAuthHook, type AuthenticatedRequest } from "./auth.js";
import { CloudRecordingManager } from "./cloud-recording.js";
import { CdnStreamManager } from "./cdn-streaming.js";

const env = loadSfuEnv();
const sfu = new SfuManager(env.announcedIp);
const cloudRecording = new CloudRecordingManager(sfu, process.env.RECORDINGS_DIR || "./data/recordings");
const cdnStreaming = new CdnStreamManager(sfu, process.env.CDN_WORK_DIR || "./data/cdn-streams");
const requireAuth = createAuthHook(env.jwtSecret);

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.addHook("preHandler", async (req, reply) => {
  if (req.url === "/health" || req.url === "/ready") return;
  await requireAuth(req, reply);
});

app.get("/health", async () => ({
  ok: true,
  service: "rtc-media-sfu",
  uptime: process.uptime(),
}));

app.get("/ready", async (_req, reply) => {
  if (!sfu.isReady()) {
    return reply.status(503).send({ ok: false, service: "rtc-media-sfu", ready: false });
  }
  return { ok: true, service: "rtc-media-sfu", ready: true };
});

app.post<{ Params: { roomId: string }; Body: { peerId?: string } }>(
  "/v1/rooms/:roomId/join",
  async (req, reply) => {
    const peerId = req.body?.peerId?.trim();
    if (!peerId) return reply.status(400).send({ error: "peerId is required" });

    const room = await sfu.getOrCreateRoom(req.params.roomId);
    return {
      roomId: (req as AuthenticatedRequest).rtcRoomId,
      peerId,
      rtpCapabilities: room.router.rtpCapabilities,
    };
  }
);

app.post<{
  Params: { roomId: string };
  Body: { peerId?: string };
}>("/v1/rooms/:roomId/transports", async (req, reply) => {
  const peerId = req.body?.peerId?.trim();
  if (!peerId) return reply.status(400).send({ error: "peerId is required" });

  const transport = await sfu.createTransport(req.params.roomId, peerId);
  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
});

app.post<{
  Params: { roomId: string; transportId: string };
  Body: { peerId?: string; dtlsParameters?: unknown };
}>("/v1/rooms/:roomId/transports/:transportId/connect", async (req, reply) => {
  const peerId = req.body?.peerId?.trim();
  if (!peerId || !req.body?.dtlsParameters) {
    return reply.status(400).send({ error: "peerId and dtlsParameters are required" });
  }
  const transport = sfu.getTransport(req.params.roomId, peerId, req.params.transportId);
  if (!transport) return reply.status(404).send({ error: "Transport not found" });
  await transport.connect({ dtlsParameters: req.body.dtlsParameters as never });
  return { connected: true };
});

app.post<{
  Params: { roomId: string; transportId: string };
  Body: { peerId?: string; kind?: string; rtpParameters?: unknown };
}>("/v1/rooms/:roomId/transports/:transportId/produce", async (req, reply) => {
  const peerId = req.body?.peerId?.trim();
  const kind = req.body?.kind;
  if (!peerId || (kind !== "audio" && kind !== "video") || !req.body?.rtpParameters) {
    return reply.status(400).send({ error: "peerId, kind=audio|video, rtpParameters required" });
  }
  const producer = await sfu.produce(
    req.params.roomId,
    peerId,
    req.params.transportId,
    kind,
    req.body.rtpParameters as never
  );
  return { producerId: producer.id };
});

app.get<{ Params: { roomId: string }; Querystring: { peerId?: string } }>(
  "/v1/rooms/:roomId/producers",
  async (req) => ({
    producers: sfu.listProducers(req.params.roomId, req.query.peerId),
  })
);

app.post<{
  Params: { roomId: string; transportId: string };
  Body: {
    peerId?: string;
    producerId?: string;
    rtpCapabilities?: unknown;
  };
}>("/v1/rooms/:roomId/transports/:transportId/consume", async (req, reply) => {
  const peerId = req.body?.peerId?.trim();
  const producerId = req.body?.producerId?.trim();
  if (!peerId || !producerId || !req.body?.rtpCapabilities) {
    return reply.status(400).send({ error: "peerId, producerId, rtpCapabilities required" });
  }
  const consumer = await sfu.consume(
    req.params.roomId,
    peerId,
    req.params.transportId,
    producerId,
    req.body.rtpCapabilities as never
  );
  return {
    consumerId: consumer.id,
    producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
  };
});

app.post<{ Params: { roomId: string }; Body: { sessionId?: string } }>(
  "/v1/rooms/:roomId/recording/start",
  async (req, reply) => {
    try {
      const session = await cloudRecording.start(req.params.roomId, req.body?.sessionId);
      return { ok: true, session };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start recording";
      return reply.status(400).send({ error: message });
    }
  }
);

app.post<{ Params: { roomId: string }; Body: { sessionId?: string } }>(
  "/v1/rooms/:roomId/recording/stop",
  async (req, reply) => {
    try {
      const result = await cloudRecording.stop(req.params.roomId);
      return { ok: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stop recording";
      return reply.status(400).send({ error: message });
    }
  }
);

app.post<{ Params: { roomId: string }; Body: { streamKey: string; sessionId: string; rtmpPushUrl: string } }>(
  "/v1/rooms/:roomId/cdn-stream/start",
  async (req, reply) => {
    const { streamKey, sessionId, rtmpPushUrl } = req.body || {};
    if (!streamKey || !sessionId || !rtmpPushUrl) {
      return reply.status(400).send({ error: "streamKey, sessionId, and rtmpPushUrl are required" });
    }
    try {
      const session = await cdnStreaming.start(
        req.params.roomId,
        streamKey,
        rtmpPushUrl,
        sessionId
      );
      return { ok: true, session };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start CDN stream";
      return reply.status(400).send({ error: message });
    }
  }
);

app.post<{ Params: { roomId: string } }>(
  "/v1/rooms/:roomId/cdn-stream/stop",
  async (req, reply) => {
    try {
      const session = await cdnStreaming.stop(req.params.roomId);
      return { ok: true, session };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stop CDN stream";
      return reply.status(400).send({ error: message });
    }
  }
);

app.get<{ Params: { roomId: string } }>("/v1/rooms/:roomId/cdn-stream", async (req) => ({
  active: cdnStreaming.getSession(req.params.roomId),
}));

await sfu.start();
await app.listen({ port: env.port, host: "0.0.0.0" });
console.log(`RTC media SFU on http://localhost:${env.port}`);

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down (${signal})...`);
  await sfu.stop();
  await app.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
