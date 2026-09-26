import { scopedRooms, scopedRoles } from "../tenant-scope.js";
import type { FastifyInstance } from "fastify";
import {
  getActiveCloudRecording,
  listCloudRecordings,
  startCloudRecording,
  stopCloudRecording,
} from "../cloud-recording.js";
import { canModerate } from "../room-roles.js";
import type { RoomRoleStore } from "../room-roles.js";
import type { RoomStore } from "../store/types.js";
import { requireRoomUser } from "../room-access.js";
import { checkAppFeature } from "../plan-features.js";
import { requireAdmin } from "./admin.js";

export async function registerCloudRecordingRoutes(
  app: FastifyInstance,
  deps: {
    jwtSecret: string;
    recordingsDir: string;
    rooms: RoomStore;
    roomRoles: RoomRoleStore;
  }
) {
  app.post<{ Params: { roomId: string } }>(
    "/v1/rooms/:roomId/cloud-recording/start",
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
        return reply.status(403).send({ error: "Only the room host can start cloud recording" });
      }
      try {
        const feature = await checkAppFeature(claims.appId, "recording");
        if (!feature.allowed) return reply.status(403).send({ error: feature.message });
        const session = await startCloudRecording(
          claims.appId,
          roomId,
          claims.userId,
          deps.recordingsDir,
          deps.jwtSecret
        );
        return { session };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to start cloud recording";
        return reply.status(400).send({ error: message });
      }
    }
  );

  app.post<{ Params: { roomId: string } }>(
    "/v1/rooms/:roomId/cloud-recording/stop",
    async (req, reply) => {
      const claims = await requireRoomUser(req, reply, deps.jwtSecret, deps.rooms, req.params.roomId);
      if (!claims) return;
      const roomId = req.params.roomId;
      if (!canModerate(scopedRoles(deps.roomRoles, claims.appId).get(roomId, claims.userId))) {
        return reply.status(403).send({ error: "Only the room host can stop cloud recording" });
      }
      try {
        const session = await stopCloudRecording(
          roomId,
          deps.recordingsDir,
          deps.jwtSecret,
          claims.appId,
          claims.userId
        );
        return { session };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to stop cloud recording";
        return reply.status(400).send({ error: message });
      }
    }
  );

  app.get<{ Params: { roomId: string } }>(
    "/v1/rooms/:roomId/cloud-recording",
    async (req, reply) => {
      const claims = await requireRoomUser(req, reply, deps.jwtSecret, deps.rooms, req.params.roomId);
      if (!claims) return;
      const session = getActiveCloudRecording(req.params.roomId, claims.appId);
      return { active: session };
    }
  );

  app.get<{ Params: { appId: string } }>(
    "/v1/admin/apps/:appId/cloud-recordings",
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      return { sessions: listCloudRecordings(req.params.appId) };
    }
  );
}
