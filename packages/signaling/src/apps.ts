import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { getPool } from "./db.js";

import type { BillingPlan } from "./billing-plans.js";

/** Published in the README, so it must never be live on a public deployment. */
const DEV_DEMO_SECRET = "demo-secret";

export interface AppRecord {
  appId: string;
  name: string;
  active: boolean;
  plan: BillingPlan;
  createdAt: string;
}

function hashSecret(secret: string) {
  return bcrypt.hashSync(secret, 10);
}

function generateAppId() {
  return `app_${randomBytes(8).toString("hex")}`;
}

function generateAppSecret() {
  return `sec_${randomBytes(16).toString("hex")}`;
}

export async function createApp(name: string) {
  const db = getPool();
  if (!db) throw new Error("Database not configured");

  const appId = generateAppId();
  const appSecret = generateAppSecret();
  const secretHash = hashSecret(appSecret);

  await db.query(
    `INSERT INTO apps (app_id, name, secret_hash) VALUES ($1, $2, $3)`,
    [appId, name, secretHash]
  );

  return { appId, appSecret, name };
}

/** The app id the demo client is served against, if one is configured. */
export function getDemoAppId() {
  return process.env.DEMO_APP_ID || "demo-app";
}

/**
 * True only when a demo app exists and is enabled. Used to decide whether the
 * public demo-token route will issue anything — a deactivated demo app (see
 * seedDemoApp) means the demo is off.
 */
export async function isDemoAppEnabled(): Promise<boolean> {
  const db = getPool();
  if (!db) return false;

  const result = await db.query(`SELECT active FROM apps WHERE app_id = $1`, [getDemoAppId()]);
  return Boolean(result.rowCount && result.rows[0].active);
}

export async function listApps(): Promise<AppRecord[]> {
  const db = getPool();
  if (!db) throw new Error("Database not configured");

  const result = await db.query(
    `SELECT app_id, name, active, plan, created_at FROM apps ORDER BY created_at DESC`
  );
  return result.rows.map((row) => ({
    appId: row.app_id,
    name: row.name,
    active: row.active,
    plan: (row.plan || "free") as BillingPlan,
    createdAt: row.created_at,
  }));
}

export async function getAppPlan(appId: string): Promise<BillingPlan> {
  const db = getPool();
  if (!db) {
    if (appId === (process.env.DEMO_APP_ID || "demo-app")) return "free";
    return "free";
  }
  const result = await db.query(`SELECT plan FROM apps WHERE app_id = $1`, [appId]);
  if (!result.rows[0]) return "free";
  return (result.rows[0].plan || "free") as BillingPlan;
}

export async function setAppPlan(appId: string, plan: BillingPlan) {
  const db = getPool();
  if (!db) throw new Error("Database not configured");
  await db.query(`UPDATE apps SET plan = $1 WHERE app_id = $2`, [plan, appId]);
}

export async function verifyAppCredentials(appId: string, appSecret: string) {
  const db = getPool();
  if (!db) return verifyEnvCredentials(appId, appSecret);

  const result = await db.query(
    `SELECT secret_hash, active FROM apps WHERE app_id = $1`,
    [appId]
  );
  if (!result.rowCount) return false;
  const row = result.rows[0];
  if (!row.active) return false;
  return bcrypt.compareSync(appSecret, row.secret_hash);
}

function verifyEnvCredentials(appId: string, appSecret: string) {
  const expectedAppId = process.env.DEMO_APP_ID || "demo-app";
  const expectedSecret = process.env.DEMO_APP_SECRET || DEV_DEMO_SECRET;
  return appId === expectedAppId && appSecret === expectedSecret;
}

export async function seedDemoApp() {
  const db = getPool();
  if (!db) return;

  const appId = process.env.DEMO_APP_ID || "demo-app";
  const appSecret = process.env.DEMO_APP_SECRET || DEV_DEMO_SECRET;

  // The demo credentials are published in the README, so seeding them on a
  // public deployment hands anyone a working token — and because the row is
  // seeded as `plan = 'pro'`, it would bypass plan gating entirely. In
  // production the demo app is only created when an explicit, non-default
  // secret is supplied.
  if (process.env.NODE_ENV === "production" && appSecret === DEV_DEMO_SECRET) {
    // Also deactivate a demo app left behind by an earlier deploy that did
    // seed it, so redeploying is enough to close the hole — no manual SQL.
    const stale = await db.query(`SELECT secret_hash, active FROM apps WHERE app_id = $1`, [appId]);
    if (stale.rowCount && bcrypt.compareSync(DEV_DEMO_SECRET, stale.rows[0].secret_hash)) {
      if (stale.rows[0].active) {
        await db.query(`UPDATE apps SET active = FALSE WHERE app_id = $1`, [appId]);
        console.warn(
          `Deactivated demo app "${appId}": it was seeded with the published default secret.`
        );
      }
    }
    console.log(
      "Skipping demo app seed: DEMO_APP_SECRET is unset or default. " +
        "Set it to a strong value to enable a demo app in production."
    );
    return;
  }

  const existing = await db.query(`SELECT 1 FROM apps WHERE app_id = $1`, [appId]);
  const secretHash = hashSecret(appSecret);

  if (existing.rowCount) {
    // Also reset the secret and reactivate. Without this, a demo app that an
    // earlier deploy deactivated for using the published secret could never be
    // switched back on — setting DEMO_APP_SECRET would appear to do nothing.
    await db.query(
      `UPDATE apps SET name = $2, plan = 'pro', secret_hash = $3, active = TRUE WHERE app_id = $1`,
      [appId, "Demo Application", secretHash]
    );
    console.log(`Updated demo app: ${appId}`);
    return;
  }

  await db.query(`INSERT INTO apps (app_id, name, secret_hash, plan) VALUES ($1, $2, $3, 'pro')`, [
    appId,
    "Demo Application",
    secretHash,
  ]);
  console.log(`Seeded demo app: ${appId}`);
}
