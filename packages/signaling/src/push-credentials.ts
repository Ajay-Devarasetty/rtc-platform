import { createCipheriv, createDecipheriv, createPrivateKey, randomBytes } from "node:crypto";
import { getPool } from "./db.js";

export interface FirebaseCredentials { project_id: string; client_email: string; private_key: string; private_key_id?: string }
export function credentialStorageReady() { return /^[a-fA-F0-9]{64}$/.test(process.env.PUSH_CREDENTIALS_KEY || ""); }
function storageKey() {
  if (!credentialStorageReady()) throw new Error("Secure credential storage is not configured");
  return Buffer.from(process.env.PUSH_CREDENTIALS_KEY!, "hex");
}
export function validateFirebaseCredentials(input: unknown): FirebaseCredentials {
  const v = input as Record<string, unknown> | null;
  if (!v || v.type !== "service_account" || typeof v.project_id !== "string" || !/^[a-z][a-z0-9-]{4,62}$/.test(v.project_id) || typeof v.client_email !== "string" || !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(v.client_email) || typeof v.private_key_id !== "string" || !/^[a-fA-F0-9]{16,128}$/.test(v.private_key_id) || typeof v.private_key !== "string" || v.private_key.length > 16384) throw new Error("Upload a valid Firebase service-account JSON key file");
  try { const key = createPrivateKey(v.private_key); if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error(); }
  catch { throw new Error("The service-account file must contain a valid RSA private key (at least 2048 bits)"); }
  return { project_id: v.project_id, client_email: v.client_email, private_key_id: v.private_key_id, private_key: v.private_key };
}
export function sealCredentials(appId: string, credentials: FirebaseCredentials | ApnsCredentials) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", storageKey(), iv);
  cipher.setAAD(Buffer.from(appId));
  const value = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), value].map(b => b.toString("base64")).join(".");
}
export function openCredentials<T = FirebaseCredentials>(appId: string, encrypted: string): T {
  const [iv, tag, value] = encrypted.split(".").map(s => Buffer.from(s, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", storageKey(), iv);
  cipher.setAAD(Buffer.from(appId)); cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(value), cipher.final()]).toString("utf8"));
}

export interface ApnsCredentials { keyId: string; teamId: string; bundleId: string; environment: 'sandbox' | 'production'; privateKey: string }
export function validateApnsCredentials(input: unknown): ApnsCredentials {
  const v = input as ApnsCredentials | null;
  if (!v || typeof v.keyId !== 'string' || typeof v.teamId !== 'string' || !/^[A-Z0-9]{10}$/.test(v.keyId) || !/^[A-Z0-9]{10}$/.test(v.teamId) || typeof v.bundleId !== 'string' || v.bundleId.length > 200 || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(v.bundleId) || !['sandbox','production'].includes(v.environment) || typeof v.privateKey !== 'string' || v.privateKey.length > 8192) throw new Error('Provide a Key ID, Team ID, Bundle ID, environment and APNs .p8 key');
  try { const key = createPrivateKey(v.privateKey); if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error(); }
  catch { throw new Error('The APNs key must be a valid P-256 private key (.p8)'); }
  return { keyId: v.keyId, teamId: v.teamId, bundleId: v.bundleId, environment: v.environment, privateKey: v.privateKey };
}
export async function apnsCredentials(appId: string, bundleId: string, environment: string): Promise<ApnsCredentials | null> {
  const db = getPool(); if (!db) return null;
  const result = await db.query('SELECT encrypted_value FROM apns_credentials WHERE app_id=$1 AND bundle_id=$2 AND environment=$3', [appId,bundleId,environment]);
  return result.rows[0] ? openCredentials<ApnsCredentials>(`${appId}:apns:${bundleId}:${environment}`, result.rows[0].encrypted_value) : null;
}
export async function storedPushCredentials(appId: string): Promise<FirebaseCredentials | null | undefined> {
  const db = getPool(); if (!db) return undefined;
  const result = await db.query("SELECT encrypted_value FROM push_credentials WHERE app_id=$1", [appId]);
  if (!result.rows.length) return undefined;
  if (!result.rows[0].encrypted_value) return null;
  return openCredentials(appId, result.rows[0].encrypted_value);
}
