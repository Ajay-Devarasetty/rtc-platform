import type { FastifyRequest, FastifyReply } from "fastify";
import type { RoomStore } from "./store/types.js";
import { requireUser } from "./user-auth.js";
import { scopedRooms } from "./tenant-scope.js";

export async function requireRoomUser(req: FastifyRequest, reply: FastifyReply, secret: string, rooms: RoomStore, roomId: string) {
  const claims = requireUser(req, reply, secret);
  if (!claims) return null;
  if ((claims.roomId && claims.roomId !== roomId) || !(await scopedRooms(rooms, claims.appId).isMember(roomId, claims.userId))) {
    reply.status(403).send({ error: "Room access denied" });
    return null;
  }
  return claims;
}
