import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { TokenClaims } from "@rtc/protocol";

export interface AuthenticatedRequest extends FastifyRequest {
  rtcClaims: TokenClaims;
  rtcRoomId?: string;
}

function peerIdFromRequest(req: FastifyRequest): string | undefined {
  const body = req.body as { peerId?: string } | undefined;
  const query = req.query as { peerId?: string } | undefined;
  return body?.peerId?.trim() || query?.peerId?.trim();
}

export function createAuthHook(jwtSecret: string, signalingUrl = process.env.SIGNALING_URL || "http://127.0.0.1:4000") {
  return async function authHook(req: FastifyRequest, reply: FastifyReply) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Missing bearer token" });
    }

    try {
      const claims = jwt.verify(header.slice(7), jwtSecret, { algorithms: ["HS256"] }) as TokenClaims;
      if (typeof claims.appId !== "string" || !claims.appId || typeof claims.userId !== "string" || !claims.userId) {
        return reply.status(401).send({ error: "Invalid token subject" });
      }
      const params = req.params as { roomId?: string };
      if (params.roomId) {
        if (claims.roomId && claims.roomId !== params.roomId) {
          return reply.status(403).send({ error: "Token is not valid for this room" });
        }
        (req as AuthenticatedRequest).rtcRoomId = params.roomId;
        params.roomId = `${Buffer.from(claims.appId).toString("base64url")}.${Buffer.from(params.roomId).toString("base64url")}`;
      }
      const peerId = peerIdFromRequest(req);
      if (peerId && peerId !== claims.userId) {
        return reply.status(403).send({ error: "peerId does not match token subject" });
      }
      const roomId = (req as AuthenticatedRequest).rtcRoomId;
      if (roomId) {
        const path = req.url.split("?")[0];
        let action = "read";
        if (path.endsWith("/produce")) {
          const kind = (req.body as { kind?: string })?.kind;
          if (kind !== "audio" && kind !== "video") return reply.status(400).send({ error: "Invalid media kind" });
          action = kind;
        } else if (path.endsWith("/recording/start")) action = "recording-start";
        else if (path.endsWith("/recording/stop")) action = "recording-stop";
        else if (path.endsWith("/cdn-stream/start")) action = "cdn-start";
        else if (path.endsWith("/cdn-stream/stop")) action = "cdn-stop";
        try {
          const response = await fetch(`${signalingUrl.replace(/\/$/, "")}/v1/media/authorize`, {
            method: "POST", headers: { Authorization: header, "Content-Type": "application/json" },
            body: JSON.stringify({ roomId, action }), signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) {
            return reply.status(response.status === 401 ? 401 : response.status === 403 ? 403 : 503).send({ error: "Media authorization denied or unavailable" });
          }
          const result = await response.json() as { allowed?: boolean };
          if (result.allowed !== true) return reply.status(403).send({ error: "Media authorization denied" });
        } catch {
          return reply.status(503).send({ error: "Media authorization unavailable" });
        }
      }
      (req as AuthenticatedRequest).rtcClaims = claims;
    } catch {
      return reply.status(401).send({ error: "Invalid or expired token" });
    }
  };
}
