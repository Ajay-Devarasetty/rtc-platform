import type { FastifyInstance } from "fastify";
import type { BillingPlan } from "../billing-plans.js";
import { isBillingPlan } from "../billing-plans.js";
import { BILLING_PLANS, getBillingSummary } from "../billing.js";
import { setAppPlan } from "../apps.js";
import { requireAdmin } from "./admin.js";

export async function registerBillingRoutes(app: FastifyInstance) {
  app.get<{
    Params: { appId: string };
    Querystring: { from?: string; to?: string };
  }>("/v1/admin/apps/:appId/billing", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      return await getBillingSummary(req.params.appId, {
        from: req.query.from,
        to: req.query.to,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to compute billing";
      return reply.status(503).send({ error: message });
    }
  });

  app.get("/v1/admin/billing/plans", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { plans: BILLING_PLANS };
  });

  app.patch<{ Params: { appId: string }; Body: { plan?: BillingPlan } }>(
    "/v1/admin/apps/:appId/plan",
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const plan = req.body?.plan;
      if (!isBillingPlan(plan)) {
        return reply.status(400).send({ error: "Valid plan required: free, starter, pro" });
      }
      try {
        await setAppPlan(req.params.appId, plan);
        return { appId: req.params.appId, plan };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to update plan";
        return reply.status(503).send({ error: message });
      }
    }
  );
}
