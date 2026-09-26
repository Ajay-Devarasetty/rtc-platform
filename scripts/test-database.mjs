import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required (a disposable local *_test database)');
const parsed = new URL(url);
if (!['localhost','127.0.0.1'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) throw new Error('Refusing a nonlocal or non-test database');
process.env.DATABASE_URL = url;
const { getPool, runMigrations, closeDb } = await import('../packages/signaling/dist/db.js');
const { createCustomerAccount, authenticateCustomer } = await import('../packages/signaling/dist/customers.js');
const { tokenHash, consumeAccountLink, changeAccountSecurity } = await import('../packages/signaling/dist/account-security.js');
const { verifyAppCredentials } = await import('../packages/signaling/dist/apps.js');
let appId;
try {
  await runMigrations(); await runMigrations(); // Migration files must remain rerunnable.
  const email = `integration-${randomBytes(8).toString('hex')}@example.com`;
  const created = await createCustomerAccount({ email, password: 'Initial-test-password' }); appId = created.appId;
  const db = getPool();
  const token = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO account_tokens (token_hash, account_id, purpose, expires_at) VALUES ($1,$2,'reset',NOW()+INTERVAL '1 minute')`, [tokenHash(token), created.accountId]);
  const attempts = await Promise.allSettled([consumeAccountLink(token,'reset','New-test-password'), consumeAccountLink(token,'reset','New-test-password')]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await authenticateCustomer(email,'Initial-test-password'), null);
  assert.equal((await authenticateCustomer(email,'New-test-password')).sessionVersion, 1);
  const rotated = await changeAccountSecurity(appId,'New-test-password');
  assert.equal(await verifyAppCredentials(appId,created.appSecret), false);
  assert.equal(await verifyAppCredentials(appId,rotated.appSecret), true);
  assert.equal((await authenticateCustomer(email,'New-test-password')).sessionVersion, 2);
  console.log('PASS: migrations, one-use concurrent reset, password replacement, credential rotation, and session revocation');
} finally {
  if (appId) await getPool().query('DELETE FROM apps WHERE app_id=$1',[appId]);
  await closeDb();
}
