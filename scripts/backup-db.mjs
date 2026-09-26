import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const directory = resolve(process.argv[2] || 'backups');
await mkdir(directory, { recursive: true, mode: 0o700 });
const file = resolve(directory, `rtc-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
const child = spawn('docker', ['compose', '-f', 'docker-compose.prod.yml', '--env-file', '.env.production', 'exec', '-T', 'postgres', 'sh', '-c', 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
const done = new Promise((ok, fail) => { child.once('error', fail); child.once('close', code => code === 0 ? ok() : fail(new Error(`pg_dump failed (${code}); partial file retained`))); });
await Promise.all([done, pipeline(child.stdout, createWriteStream(file + '.partial', { flags: 'wx', mode: 0o600 }))]);
if ((await stat(file + '.partial')).size < 5) throw new Error('Empty backup; partial file retained');
await rename(file + '.partial', file);
console.log(`Backup saved: ${file}`);
