import type { FastifyInstance } from "fastify";
import type { BillingPlan } from "../billing-plans.js";
import { BILLING_PLANS, isBillingPlan } from "../billing-plans.js";
import { issueToken } from "../auth.js";
import { verifyAppCredentials } from "../apps.js";
import { getBillingSummary } from "../billing.js";
import { getCustomerByAppId } from "../customers.js";
import { getPool } from "../db.js";
import { saveLead } from "../leads.js";
import { rateLimit } from "../rate-limit.js";
import { requirePortalUser, portalVersion } from "../portal-auth.js";
import { currentMonth } from "../usage-period.js";

const PORTAL_USER_ID = "__portal__";
const LOGIN_LIMIT = 20;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

async function getAppName(appId: string) {
  const db = getPool();
  if (!db) return appId;
  const result = await db.query(`SELECT name FROM apps WHERE app_id = $1`, [appId]);
  return (result.rows[0]?.name as string) || appId;
}

export async function registerPortalRoutes(app: FastifyInstance, jwtSecret: string) {
  app.post<{ Body: { appId?: string; appSecret?: string } }>("/v1/portal/login", async (req, reply) => {
    if (!rateLimit(`portal-login:${req.ip}`, LOGIN_LIMIT, LOGIN_WINDOW_MS)) {
      return reply.status(429).send({ error: "Too many login attempts. Try again later." });
    }

    const appId = req.body?.appId?.trim();
    const appSecret = req.body?.appSecret?.trim();
    if (!appId || !appSecret) {
      return reply.status(400).send({ error: "appId and appSecret are required" });
    }

    const sessionVersion = await portalVersion(appId);
    const valid = await verifyAppCredentials(appId, appSecret);
    if (!valid) {
      return reply.status(401).send({ error: "Invalid App ID or App Secret" });
    }

    const token = issueToken({ appId, userId: PORTAL_USER_ID, role: "host", sessionVersion: sessionVersion ?? 0 }, jwtSecret, 86400);
    const [billing, name] = await Promise.all([getBillingSummary(appId), getAppName(appId)]);

    return {
      token,
      expiresIn: 86400,
      appId,
      appName: name,
      plan: billing.plan,
      planName: billing.planName,
    };
  });

  app.get<{ Querystring: { period?: string } }>("/v1/portal/overview", async (req, reply) => {
    const claims = await requirePortalUser(req, reply, jwtSecret);
    if (!claims) return;

    try {
      const [billing, name, customer] = await Promise.all([
        getBillingSummary(claims.appId, req.query.period === "all" ? {} : currentMonth()),
        getAppName(claims.appId),
        getCustomerByAppId(claims.appId),
      ]);
      return {
        appId: claims.appId,
        appName: name,
        email: customer?.email ?? null,
        billing,
        plans: BILLING_PLANS,
        integration: {
          serverUrl: process.env.PUBLIC_PLATFORM_URL || `https://${process.env.DOMAIN || "rtcplatform.duckdns.org"}`,
          tokenEndpoint: "POST /v1/token",
          webhookEvents: ["call.ringing", "call.connected", "call.ended", "message.sent", "user.joined"],
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load portal overview";
      return reply.status(503).send({ error: message });
    }
  });

  app.post<{ Body: { plan?: BillingPlan; email?: string; note?: string } }>(
    "/v1/portal/upgrade-request",
    async (req, reply) => {
      const claims = await requirePortalUser(req, reply, jwtSecret);
      if (!claims) return;

      const plan = req.body?.plan;
      if (!isBillingPlan(plan)) {
        return reply.status(400).send({ error: "Valid plan required: free, starter, pro" });
      }

      const email = req.body?.email?.trim() || `portal+${claims.appId}@rtcexpress.local`;
      const note = req.body?.note?.trim() || "";

      try {
        await saveLead({
          email,
          company: `${claims.appId} → ${plan}${note ? `: ${note}` : ""}`,
          source: "portal-upgrade",
        });
        return {
          ok: true,
          message: `Upgrade request received. Our team will contact you at ${email} to activate the ${BILLING_PLANS[plan].name} plan.`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to submit upgrade request";
        return reply.status(503).send({ error: message });
      }
    }
  );
}
