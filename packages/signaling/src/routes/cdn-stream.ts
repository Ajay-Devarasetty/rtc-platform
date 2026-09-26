import { scopedRooms, scopedRoles } from "../tenant-scope.js";
import type { FastifyInstance } from "fastify";
import {
  getActiveCdnStream,
  listCdnStreams,
  startCdnStream,
  stopCdnStream,
} from "../cdn-stream.js";
import { canModerate } from "../room-roles.js";
import type { RoomRoleStore } from "../room-roles.js";
import type { RoomStore } from "../store/types.js";
import { requireRoomUser } from "../room-access.js";
import { checkAppFeature } from "../plan-features.js";
import { requireAdmin } from "./admin.js";

export async function registerCdnStreamRoutes(
  app: FastifyInstance,
  deps: {
    jwtSecret: string;
    rooms: RoomStore;
    roomRoles: RoomRoleStore;
  }
) {
  app.post<{ Params: { roomId: string } }>(
    "/v1/rooms/:roomId/cdn-stream/start",
    async (req, reply) => {
      const claims = await requireRoomUser(req, reply, deps.jwtSecret, deps.rooms, req.params.roomId);
      if (!claims) return;
      const roomId = req.params.roomId;
      if (claims.roomId && claims.roomId !== roomId) {
        return reply.status(403).send({ error: "Token is not valid for this room" });
      }
      if (!(await scopedRooms(deps.rooms, claims.appId).isMember(roomId, claims.userId))) {
        return reply.status(403).send({ error: "Join the room first" });
      }
      if (!canModerate(scopedRoles(deps.roomRoles, claims.appId).get(roomId, claims.userId))) {
        return reply.status(403).send({ error: "Only the room host can start CDN streaming" });
      }
      try {
        const feature = await checkAppFeature(claims.appId, "groupVideo");
        if (!feature.allowed) return reply.status(403).send({ error: feature.message });
        const session = await startCdnStream(
          claims.appId,
          roomId,
          claims.userId,
          deps.jwtSecret
        );
        return { session };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to start CDN stream";
        return reply.status(400).send({ error: message });
      }
    }
  );

  app.post<{ Params: { roomId: string } }>(
    "/v1/rooms/:roomId/cdn-stream/stop",
    async (req, reply) => {
      const claims = await requireRoomUser(req, reply, deps.jwtSecret, deps.rooms, req.params.roomId);
      if (!claims) return;
      const roomId = req.params.roomId;
      if (!canModerate(scopedRoles(deps.roomRoles, claims.appId).get(roomId, claims.userId))) {
        return reply.status(403).send({ error: "Only the room host can stop CDN streaming" });
      }
      try {
        const session = await stopCdnStream(
          roomId,
          deps.jwtSecret,
          claims.appId,
          claims.userId
        );
        return { session };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to stop CDN stream";
        return reply.status(400).send({ error: message });
      }
    }
  );

  app.get<{ Params: { roomId: string } }>("/v1/rooms/:roomId/cdn-stream", async (req, reply) => {
    const claims = await requireRoomUser(req, reply, deps.jwtSecret, deps.rooms, req.params.roomId);
    if (!claims) return;
    const session = getActiveCdnStream(req.params.roomId, claims.appId);
    return { active: session };
  });

  app.get<{ Params: { appId: string } }>(
    "/v1/admin/apps/:appId/cdn-streams",
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      return { sessions: listCdnStreams(req.params.appId) };
    }
  );
}
