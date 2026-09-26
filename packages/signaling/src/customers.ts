import bcrypt from "bcryptjs";
import { createApp } from "./apps.js";
import { getPool } from "./db.js";
import { isValidEmail, MAX_COMPANY_LENGTH, MAX_EMAIL_LENGTH } from "./leads.js";

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const MAX_NAME_LENGTH = 255;

export interface CustomerAccount {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  appId: string;
  createdAt: string;
}

function hashPassword(password: string) {
  return bcrypt.hashSync(password, 12);
}

export function isValidPassword(password: string) {
  return (
    typeof password === "string" &&
    password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH
    && Buffer.byteLength(password, "utf8") <= 72
  );
}

export async function createCustomerAccount(input: {
  email: string;
  password: string;
  name?: string;
  company?: string;
}) {
  const db = getPool();
  if (!db) throw new Error("Database not configured");

  const email = input.email.trim().toLowerCase();
  const name = input.name?.trim().slice(0, MAX_NAME_LENGTH) || null;
  const company = input.company?.trim().slice(0, MAX_COMPANY_LENGTH) || null;

  if (!isValidEmail(email) || email.length > MAX_EMAIL_LENGTH) {
    throw new Error("A valid email address is required");
  }
  if (!isValidPassword(input.password)) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const existing = await db.query(`SELECT 1 FROM customer_accounts WHERE LOWER(email) = $1`, [email]);
  if (existing.rowCount) {
    throw new Error("An account with this email already exists");
  }

  const appName = company || name || email.split("@")[0] || "My Project";
  const { appId, appSecret, name: createdName } = await createApp(appName);
  const passwordHash = hashPassword(input.password);

  try {
    const result = await db.query(
      `INSERT INTO customer_accounts (email, password_hash, name, company, app_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [email, passwordHash, name, company, appId]
    );

    return {
      accountId: String(result.rows[0].id),
      email,
      name,
      company,
      appId,
      appSecret,
      appName: createdName,
      createdAt: result.rows[0].created_at as string,
    };
  } catch (err) {
    await db.query(`DELETE FROM apps WHERE app_id = $1`, [appId]);
    throw err;
  }
}

export async function authenticateCustomer(email: string, password: string) {
  const db = getPool();
  if (!db) throw new Error("Database not configured");

  const normalized = email.trim().toLowerCase();
  const result = await db.query(
    `SELECT ca.email, ca.password_hash, ca.name, ca.company, ca.app_id, a.name AS app_name, a.active, a.portal_version
     FROM customer_accounts ca
     JOIN apps a ON a.app_id = ca.app_id
     WHERE LOWER(ca.email) = $1`,
    [normalized]
  );

  if (!result.rowCount) return null;

  const row = result.rows[0];
  if (!row.active) return null;
  if (!bcrypt.compareSync(password, row.password_hash)) return null;

  return {
    email: row.email as string,
    name: row.name as string | null,
    company: row.company as string | null,
    appId: row.app_id as string,
    appName: row.app_name as string,
    sessionVersion: row.portal_version as number,
  };
}

export async function getCustomerByAppId(appId: string): Promise<CustomerAccount | null> {
  const db = getPool();
  if (!db) return null;

  const result = await db.query(
    `SELECT id, email, name, company, app_id, created_at FROM customer_accounts WHERE app_id = $1`,
    [appId]
  );
  if (!result.rowCount) return null;

  const row = result.rows[0];
  return {
    id: String(row.id),
    email: row.email,
    name: row.name,
    company: row.company,
    appId: row.app_id,
    createdAt: row.created_at,
  };
}
