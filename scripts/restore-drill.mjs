// Restores only to a fresh, disposable PostgreSQL container. Never targets production.
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

if (!process.argv[2]) throw new Error('Usage: node scripts/restore-drill.mjs path/to/backup.dump');
const file = resolve(process.argv[2]); await access(file);
const name = `rtc-restore-drill-${randomUUID()}`;
function run(args, input) {
  const child = spawn('docker', args, { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'inherit'], windowsHide: true });
  const done = new Promise((ok, fail) => { child.once('error', fail); child.once('close', code => code === 0 ? ok() : fail(new Error(`Docker command failed (${code})`))); });
  return input ? Promise.all([done, pipeline(input, child.stdin)]) : done;
}
let started = false;
try {
  await run(['run', '-d', '--name', name, '--network', 'none', '-e', `POSTGRES_PASSWORD=${randomUUID()}`, '-e', 'POSTGRES_DB=restore_check', 'postgres:16-alpine']);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await run(['exec', name, 'pg_isready', '-U', 'postgres']); ready = true; break; }
    catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  if (!ready) throw new Error('Temporary database did not become ready');
  await run(['exec', '-i', name, 'pg_restore', '-U', 'postgres', '-d', 'restore_check', '--no-owner', '--no-acl', '--exit-on-error'], createReadStream(file));
  await run(['exec', name, 'psql', '-U', 'postgres', '-d', 'restore_check', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT COUNT(*) FROM apps; SELECT COUNT(*) FROM customer_accounts;']);
  console.log('PASS: backup restored and core tables queried in a disposable database');
} finally { if (started) await run(['rm', '-fv', name]); }
