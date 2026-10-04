import type { FastifyInstance } from "fastify";
import { getPool } from "../db.js";
import { requireUser } from "../user-auth.js";
import { rateLimit } from "../rate-limit.js";

export async function registerPushRoutes(app: FastifyInstance, jwtSecret: string) {
  app.post<{ Body: { installationId?: string; token?: string; platform?:string; pushType?:string; bundleId?:string; environment?:string; appState?:string } }>("/v1/push/devices", async (req, reply) => {
    const claims = requireUser(req, reply, jwtSecret);
    if (!claims) return;
    if (claims.userId.startsWith('__')) return reply.status(403).send({ error: "RTC user token required" });
    if (!rateLimit(`push:${claims.appId}:${claims.userId}`, 30, 60000)) return reply.status(429).send({ error: "Too many registrations" });
    const { installationId, token, platform='android', pushType='alert', bundleId, environment, appState='foreground' } = req.body || {};
    if (typeof installationId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(installationId) || typeof token !== "string" || token.length < 20 || token.length > 4096) return reply.status(400).send({ error: "Valid installationId and FCM token required" });
    if (!['android','ios'].includes(platform) || !['alert','voip'].includes(pushType) || !['foreground','background'].includes(appState) || (platform === 'android' && pushType !== 'alert')) return reply.code(400).send({error:'Invalid platform, pushType or appState'});
    if (platform === 'ios' && (!/^[a-fA-F0-9]{32,512}$/.test(token) || typeof bundleId !== 'string' || bundleId.length>200 || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId) || !['sandbox','production'].includes(environment || ''))) return reply.code(400).send({error:'iOS requires an APNs device token, Bundle ID and sandbox/production environment'});
    const db = getPool(); if (!db) return reply.status(503).send({ error: "Database unavailable" });
    // A stable installation ID follows the active signed-in user on shared devices.
    // Clear stale tokens belonging to another signed-in user on this installation.
    await db.query('DELETE FROM push_devices WHERE app_id=$1 AND installation_id=$2 AND user_id<>$3',[claims.appId,installationId,claims.userId]);
    await db.query(`INSERT INTO push_devices (app_id, installation_id, user_id, token,platform,push_type,bundle_id,environment,app_state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (app_id, installation_id,push_type) DO UPDATE SET user_id = EXCLUDED.user_id, token = EXCLUDED.token,platform=EXCLUDED.platform,bundle_id=EXCLUDED.bundle_id,environment=EXCLUDED.environment,app_state=EXCLUDED.app_state, updated_at = NOW()`, [claims.appId, installationId, claims.userId, token,platform,pushType,platform==='ios'?bundleId:null,platform==='ios'?environment:null,appState]);
    return { ok: true };
  });
  app.patch<{ Params:{installationId:string}; Body:{appState?:string} }>('/v1/push/devices/:installationId',async(req,reply)=>{
    const claims=requireUser(req,reply,jwtSecret); if(!claims)return;
    if(claims.userId.startsWith('__'))return reply.code(403).send({error:'RTC user token required'});
    if(!['foreground','background'].includes(req.body?.appState || ''))return reply.code(400).send({error:'appState must be foreground or background'});
    const db=getPool();if(!db)return reply.code(503).send({error:'Database unavailable'});
    await db.query('UPDATE push_devices SET app_state=$4,updated_at=NOW() WHERE app_id=$1 AND user_id=$2 AND installation_id=$3',[claims.appId,claims.userId,req.params.installationId,req.body.appState]);
    return {ok:true};
  });
  app.delete<{ Params: { installationId: string } }>("/v1/push/devices/:installationId", async (req, reply) => {
    const claims = requireUser(req, reply, jwtSecret); if (!claims) return;
    if(claims.userId.startsWith('__'))return reply.code(403).send({error:'RTC user token required'});
    const db = getPool(); if (!db) return reply.status(503).send({ error: "Database unavailable" });
    await db.query(`DELETE FROM push_devices WHERE app_id = $1 AND user_id = $2 AND installation_id = $3`, [claims.appId, claims.userId, req.params.installationId]);
    return { ok: true };
  });
}
