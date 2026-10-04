import type { FastifyInstance } from "fastify";
import { getPool } from "../db.js";
import { requirePortalUser } from "../portal-auth.js";
import { rateLimit } from "../rate-limit.js";
import { credentialStorageReady, sealCredentials, validateFirebaseCredentials, validateApnsCredentials } from "../push-credentials.js";
import { pushCredentials } from "../push.js";

export async function registerPushSettingsRoutes(app: FastifyInstance, secret: string) {
  app.addHook("onSend", async (_req, reply, payload) => { reply.header("Cache-Control", "no-store"); return payload; });
  app.get("/v1/portal/push-settings", async (req, reply) => {
    const claims = await requirePortalUser(req, reply, secret); if (!claims) return;
    try {
      const credentials = await pushCredentials(claims.appId);
      const ios = await getPool()?.query('SELECT bundle_id AS "bundleId", environment, key_id AS "keyId", team_id AS "teamId" FROM apns_credentials WHERE app_id=$1 ORDER BY bundle_id, environment', [claims.appId]);
      return { canManage: credentialStorageReady(), android: credentials ? { projectId: credentials.project_id, clientEmail: credentials.client_email, privateKeyId: credentials.private_key_id || "Not provided", status: "configured" } : null, ios: { supported: true, credentials: ios?.rows || [] } };
    } catch { return reply.code(503).send({ error: "Push configuration could not be loaded. Contact support." }); }
  });
  app.put<{ Body: unknown }>("/v1/portal/push-settings/ios", { bodyLimit:16384 }, async (req,reply) => {
    const claims = await requirePortalUser(req,reply,secret); if (!claims) return;
    if (!rateLimit(`push-settings:${claims.appId}`,10,60000)) return reply.code(429).send({error:'Too many changes. Try again shortly.'});
    if (!credentialStorageReady()) return reply.code(503).send({error:'Secure credential storage is not enabled. Contact support.'});
    const db = getPool(); if (!db) return reply.code(503).send({error:'Database unavailable'});
    let value; try { value=validateApnsCredentials(req.body); } catch(error) { return reply.code(400).send({error:(error as Error).message}); }
    await db.query(`INSERT INTO apns_credentials (app_id,bundle_id,environment,encrypted_value,key_id,team_id) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (app_id,bundle_id,environment) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,key_id=EXCLUDED.key_id,team_id=EXCLUDED.team_id,updated_at=NOW()`,
      [claims.appId,value.bundleId,value.environment,sealCredentials(`${claims.appId}:apns:${value.bundleId}:${value.environment}`,value),value.keyId,value.teamId]);
    return {ok:true,message:'APNs key saved. Test on an iOS device to verify Apple permissions and delivery.'};
  });
  app.delete<{ Body: { bundleId?:string; environment?:string } }>("/v1/portal/push-settings/ios", async (req,reply) => {
    const claims = await requirePortalUser(req,reply,secret); if (!claims) return;
    if (!rateLimit(`push-settings:${claims.appId}`,10,60000)) return reply.code(429).send({error:'Too many changes. Try again shortly.'});
    if (typeof req.body?.bundleId !== 'string' || !['sandbox','production'].includes(req.body?.environment || '')) return reply.code(400).send({error:'Bundle ID and environment required'});
    const db=getPool(); if (!db) return reply.code(503).send({error:'Database unavailable'});
    await db.query('DELETE FROM apns_credentials WHERE app_id=$1 AND bundle_id=$2 AND environment=$3',[claims.appId,req.body.bundleId,req.body.environment]);
    return {ok:true};
  });
  app.put<{ Body: { serviceAccount?: unknown } }>("/v1/portal/push-settings/android", { bodyLimit: 32768 }, async (req, reply) => {
    const claims = await requirePortalUser(req, reply, secret); if (!claims) return;
    if (!rateLimit(`push-settings:${claims.appId}`, 10, 60000)) return reply.code(429).send({ error: "Too many changes. Try again shortly." });
    if (!credentialStorageReady()) return reply.code(503).send({ error: "Secure credential storage is not enabled. Contact support." });
    const db = getPool(); if (!db) return reply.code(503).send({ error: "Database unavailable" });
    let credentials;
    try { credentials = validateFirebaseCredentials(req.body?.serviceAccount); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const metadata = { projectId: credentials.project_id, clientEmail: credentials.client_email, privateKeyId: credentials.private_key_id };
    await db.query(`INSERT INTO push_credentials (app_id, encrypted_value, metadata) VALUES ($1,$2,$3)
      ON CONFLICT (app_id) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value, metadata=EXCLUDED.metadata, updated_at=NOW()`, [claims.appId, sealCredentials(claims.appId, credentials), JSON.stringify(metadata)]);
    return { ok: true, message: "Firebase credentials saved. Test an incoming call on a registered Android device to verify delivery." };
  });
  app.delete("/v1/portal/push-settings/android", async (req, reply) => {
    const claims = await requirePortalUser(req, reply, secret); if (!claims) return;
    if (!rateLimit(`push-settings:${claims.appId}`, 10, 60000)) return reply.code(429).send({ error: "Too many changes. Try again shortly." });
    const db = getPool(); if (!db) return reply.code(503).send({ error: "Database unavailable" });
    await db.query(`INSERT INTO push_credentials (app_id, encrypted_value, metadata) VALUES ($1,NULL,'{}')
      ON CONFLICT (app_id) DO UPDATE SET encrypted_value=NULL, metadata='{}', updated_at=NOW()`, [claims.appId]);
    return { ok: true };
  });
}
