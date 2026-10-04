import { scopedRooms, scopedRoles } from "../tenant-scope.js";
import type { FastifyInstance } from "fastify";
import { listMessages } from "../messages.js";
import type { RoomStore } from "../store/types.js";
import { requireUser } from "../user-auth.js";
import { getPool } from '../db.js';
import { removeChatSubscription } from '../chat-notifications.js';
import { rateLimit } from '../rate-limit.js';

interface MessageRouteDeps {
  jwtSecret: string;
  rooms: RoomStore;
}

export async function registerMessageRoutes(app: FastifyInstance, deps: MessageRouteDeps) {
  app.put<{Params:{roomId:string}}>('/v1/rooms/:roomId/notifications',async(req,reply)=>{
    const claims=requireUser(req,reply,deps.jwtSecret);if(!claims)return;
    const roomId=req.params.roomId;
    if(claims.userId.startsWith('__') || (claims.roomId && claims.roomId!==roomId))return reply.code(403).send({error:'User token for this room required'});
    if(!roomId || roomId.length>255)return reply.code(400).send({error:'Valid roomId required'});
    if(!rateLimit(`chat-subscribe:${claims.appId}:${claims.userId}`,60,60000))return reply.code(429).send({error:'Too many subscriptions'});
    if(!await scopedRooms(deps.rooms,claims.appId).isMember(roomId,claims.userId))return reply.code(403).send({error:'Join the room before subscribing'});
    const db=getPool();if(!db)return reply.code(503).send({error:'Database unavailable'});
    await db.query('INSERT INTO chat_push_subscriptions (app_id,room_id,user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[claims.appId,roomId,claims.userId]);
    return {ok:true};
  });
  app.delete<{Params:{roomId:string}}>('/v1/rooms/:roomId/notifications',async(req,reply)=>{
    const claims=requireUser(req,reply,deps.jwtSecret);if(!claims)return;
    if(claims.userId.startsWith('__') || (claims.roomId && claims.roomId!==req.params.roomId))return reply.code(403).send({error:'User token for this room required'});
    if(!getPool())return reply.code(503).send({error:'Database unavailable'});
    await removeChatSubscription(claims.appId,req.params.roomId,claims.userId);
    return {ok:true};
  });
  app.get<{ Params: { roomId: string }; Querystring: { before?: string; limit?: string } }>(
    "/v1/rooms/:roomId/messages",
    async (req, reply) => {
      const claims = requireUser(req, reply, deps.jwtSecret);
      if (!claims) return;

      const { roomId } = req.params;

      // A room-scoped token must not read a different room's history.
      if (claims.roomId && claims.roomId !== roomId) {
        return reply.status(403).send({ error: "Token is not valid for this room" });
      }

      // History is readable by current room members only. Call this after the
      // SDK's roomJoined event, which fires once membership is recorded.
      if (!(await scopedRooms(deps.rooms, claims.appId).isMember(roomId, claims.userId))) {
        return reply.status(403).send({ error: "Join the room first" });
      }

      try {
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        if ((limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) ||
            (req.query.before !== undefined && !/^[1-9]\d*$/.test(req.query.before))) {
          return reply.status(400).send({ error: "limit must be 1-200 and before must be a positive message ID" });
        }
        return await listMessages(claims.appId, roomId, { before: req.query.before, limit });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load messages";
        return reply.status(503).send({ error: message });
      }
    }
  );
}
