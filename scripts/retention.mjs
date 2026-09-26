// Explicit operator tool. Default is a count-only preview; no automatic deletion.
import pg from 'pg';
const [appId, daysText, mode] = process.argv.slice(2);
const days = Number(daysText);
if (!appId || !Number.isInteger(days) || days < 90 || ![undefined, '--apply'].includes(mode)) throw new Error('Usage: node scripts/retention.mjs APP_ID DAYS [--apply]; DAYS must be >= 90');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await db.connect();
try {
  await client.query('BEGIN');
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  for (const [table, column] of [['messages','sent_at'], ['push_deliveries','created_at'], ['push_devices','updated_at']]) {
    const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE app_id=$1 AND ${column} < $2`, [appId, cutoff]);
    console.log(`${mode === '--apply' ? 'DELETE' : 'PREVIEW'} ${table}: ${result.rows[0].count} rows before ${cutoff}`);
    if (mode === '--apply') await client.query(`DELETE FROM ${table} WHERE app_id=$1 AND ${column} < $2`, [appId, cutoff]);
  }
  await client.query(mode === '--apply' ? 'COMMIT' : 'ROLLBACK');
} catch (error) { await client.query('ROLLBACK'); throw error; }
finally { client.release(); await db.end(); }
