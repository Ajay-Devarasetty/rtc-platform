import type { FastifyInstance } from "fastify";
import type { RoomStore } from "../store/types.js";
import type { RoomRoleStore } from "../room-roles.js";
import { canModerate, canPublish } from "../room-roles.js";
import { requireRoomUser } from "../room-access.js";
import { scopedRoles } from "../tenant-scope.js";
import { checkAppFeature } from "../plan-features.js";

export async function registerMediaAuthorizeRoutes(app: FastifyInstance, deps: { jwtSecret: string; rooms: RoomStore; roomRoles: RoomRoleStore }) {
  app.post<{ Body: { roomId?: string; action?: string } }>("/v1/media/authorize", async (req, reply) => {
    const { roomId, action } = req.body || {};
    const actions = ["read", "audio", "video", "recording-start", "recording-stop", "cdn-start", "cdn-stop"];
    if (typeof roomId !== "string" || !roomId || !action || !actions.includes(action)) {
      return reply.status(400).send({ error: "Valid roomId and media action required" });
    }
    const claims = await requireRoomUser(req, reply, deps.jwtSecret, deps.rooms, roomId);
    if (!claims) return;
    const role = scopedRoles(deps.roomRoles, claims.appId).get(roomId, claims.userId);
    if ((action.startsWith("recording-") || action.startsWith("cdn-")) && !canModerate(role)) {
      return reply.status(403).send({ error: "Only the room host can manage recording or streaming" });
    }
    if ((action === "audio" || action === "video") && !canPublish(role)) {
      return reply.status(403).send({ error: "Publishing is not allowed for this room role" });
    }
    // A downgrade must not prevent the host from stopping an existing job.
    if (!action.endsWith("-stop")) {
      const feature = action === "recording-start" ? "recording" : action === "cdn-start" ? "groupVideo" : action === "video" ? "video" : "voice";
      const result = await checkAppFeature(claims.appId, feature);
      if (!result.allowed) return reply.status(403).send({ error: result.message });
    }
    return { allowed: true };
  });
}
