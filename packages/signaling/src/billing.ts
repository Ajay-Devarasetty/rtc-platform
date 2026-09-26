import { getPool } from "./db.js";
import { currentMonth } from "./usage-period.js";
import { getAppPlan } from "./apps.js";
import {
  type BillingPlan,
  type BillingSummary,
  type UsageBreakdown,
  BILLING_PLANS,
  checkThresholdAlerts,
  computeBillingSummary,
} from "./billing-plans.js";
import { getMeteringSummary } from "./metering.js";
import { countQualityReportsForApp } from "./quality.js";
import { countRecordingsForApp } from "./recordings.js";

export type { BillingPlan, BillingSummary, UsageBreakdown };
export { BILLING_PLANS };

const lastAlertAt = new Map<string, number>();
const ALERT_COOLDOWN_MS = 60_000;

async function getUsageBreakdown(
  appId: string,
  opts: { from?: string; to?: string } = {}
): Promise<UsageBreakdown> {
  const metering = await getMeteringSummary(appId, opts);

  const db = getPool();
  let recordings = 0;
  let transcriptionMinutes = 0;

  if (db) {
    const recParams: unknown[] = [appId];
    let recFilter = "app_id = $1";
    if (opts.from) {
      recParams.push(opts.from);
      recFilter += ` AND created_at >= $${recParams.length}`;
    }
    if (opts.to) {
      recParams.push(opts.to);
      recFilter += ` AND created_at <= $${recParams.length}`;
    }

    const recResult = await db.query(
      `SELECT
         COUNT(*)::int AS count,
         COALESCE(SUM(duration_ms) FILTER (WHERE transcript IS NOT NULL), 0)::bigint AS transcribed_ms
       FROM recordings WHERE ${recFilter}`,
      recParams
    );
    recordings = recResult.rows[0]?.count ?? 0;
    const transcribedMs = Number(recResult.rows[0]?.transcribed_ms ?? 0);
    transcriptionMinutes = Math.round((transcribedMs / 60_000) * 100) / 100;
  } else {
    recordings = await countRecordingsForApp(appId, opts);
    transcriptionMinutes = 0;
  }

  const qualityReports = await countQualityReportsForApp(appId, opts);

  return {
    callMinutes: metering.callMinutes,
    messagesSent: metering.messagesSent,
    recordings,
    transcriptionMinutes,
    qualityReports,
    callsConnected: metering.callsConnected,
    callsEnded: metering.callsEnded,
    totalEvents: metering.totalEvents,
  };
}

export async function getBillingSummary(
  appId: string,
  opts: { from?: string; to?: string } = {}
): Promise<BillingSummary> {
  const plan = await getAppPlan(appId);
  const usage = await getUsageBreakdown(appId, opts);
  return computeBillingSummary(appId, plan, usage, {
    from: opts.from ?? null,
    to: opts.to ?? null,
  });
}

export async function maybeDispatchBillingAlert(
  appId: string,
  dispatch: (type: string, payload: Record<string, unknown>) => void
) {
  const key = appId;
  const now = Date.now();
  if (now - (lastAlertAt.get(key) ?? 0) < ALERT_COOLDOWN_MS) return;

  const summary = await getBillingSummary(appId, currentMonth());
  const alerts = checkThresholdAlerts(summary);
  if (!alerts.length) return;

  lastAlertAt.set(key, now);
  dispatch("billing.threshold", {
    appId,
    plan: summary.plan,
    alerts,
    usage: summary.usage,
    limits: summary.limits,
    estimatedCostUsd: summary.estimatedCostUsd,
  });
}
