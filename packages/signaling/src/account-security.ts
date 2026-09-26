import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { getPool } from "./db.js";
import { isValidPassword } from "./customers.js";

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export function emailConfigured() { return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM && process.env.PUBLIC_WEBSITE_URL); }

export async function requestAccountLink(email: string, purpose: "verify" | "reset") {
  const db = getPool(); if (!db) throw new Error("Database unavailable");
  if (!emailConfigured()) throw new Error("Account email delivery is not configured");
  const website = new URL(process.env.PUBLIC_WEBSITE_URL!);
  if (website.protocol !== "https:" && website.hostname !== "localhost") throw new Error("Website URL must use HTTPS");
  const found = await db.query(`SELECT id, email FROM customer_accounts WHERE LOWER(email) = $1`, [email.toLowerCase()]);
  if (!found.rowCount) return;
  const account = found.rows[0];
  const token = randomBytes(32).toString("hex");
  await db.query(`INSERT INTO account_tokens (token_hash, account_id, purpose, expires_at) VALUES ($1,$2,$3,NOW() + INTERVAL '30 minutes')`, [tokenHash(token), account.id, purpose]);
  website.hash = `/account/${purpose}?token=${token}`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [account.email], subject: purpose === "verify" ? "Verify your RTCExpress email" : "Reset your RTCExpress password",
        text: `Open this link to ${purpose === "verify" ? "verify your email" : "reset your password"}:\n${website.href}\n\nThis link expires in 30 minutes and can be used once. If you did not request it, ignore this email.` }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error("Email provider rejected delivery");
  } catch (error) {
    await db.query(`DELETE FROM account_tokens WHERE token_hash = $1`, [tokenHash(token)]);
    throw error;
  }
}

export async function consumeAccountLink(token: string, purpose: "verify" | "reset", password?: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid or expired link");
  if (purpose === "reset" && !isValidPassword(password || "")) throw new Error("Password must be at least 8 characters and at most 72 UTF-8 bytes");
  const db = getPool(); if (!db) throw new Error("Database unavailable");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(`SELECT t.account_id, ca.app_id FROM account_tokens t JOIN customer_accounts ca ON ca.id = t.account_id WHERE t.token_hash = $1 AND t.purpose = $2 AND t.expires_at > NOW() FOR UPDATE OF t, ca`, [tokenHash(token), purpose]);
    if (!found.rowCount) throw new Error("Invalid or expired link");
    const { account_id, app_id } = found.rows[0];
    if (purpose === "verify") await client.query(`UPDATE customer_accounts SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = $1`, [account_id]);
    else {
      await client.query(`UPDATE customer_accounts SET password_hash = $1 WHERE id = $2`, [await bcrypt.hash(password!, 12), account_id]);
      await client.query(`UPDATE apps SET portal_version = portal_version + 1 WHERE app_id = $1`, [app_id]);
    }
    await client.query(`DELETE FROM account_tokens WHERE account_id = $1 AND purpose = $2`, [account_id, purpose]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function changeAccountSecurity(appId: string, currentPassword: string, newPassword?: string) {
  if (newPassword !== undefined && !isValidPassword(newPassword)) throw new Error("Password must be at least 8 characters and at most 72 UTF-8 bytes");
  const db = getPool(); if (!db) throw new Error("Database unavailable");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(`SELECT id, password_hash FROM customer_accounts WHERE app_id = $1 FOR UPDATE`, [appId]);
    if (!found.rowCount || !await bcrypt.compare(currentPassword, found.rows[0].password_hash)) throw new Error("Current account password is incorrect");
    let appSecret: string | undefined;
    if (newPassword !== undefined) await client.query(`UPDATE customer_accounts SET password_hash = $1 WHERE app_id = $2`, [await bcrypt.hash(newPassword, 12), appId]);
    else {
      appSecret = `sec_${randomBytes(32).toString("hex")}`;
      await client.query(`UPDATE apps SET secret_hash = $1 WHERE app_id = $2`, [await bcrypt.hash(appSecret, 10), appId]);
    }
    await client.query(`UPDATE apps SET portal_version = portal_version + 1 WHERE app_id = $1`, [appId]);
    await client.query(`DELETE FROM account_tokens WHERE account_id = $1 AND purpose = 'reset'`, [found.rows[0].id]);
    await client.query("COMMIT"); return { appSecret };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
