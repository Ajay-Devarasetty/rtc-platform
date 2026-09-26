// Read-only deployment check. Exits nonzero for a failed dependency.
const base = process.argv[2];
if (!base || !/^https?:\/\//.test(base)) throw new Error('Usage: node scripts/check-health.mjs https://your-staging-host');
let failed = false;
for (const path of ['/health', '/ready', '/sfu/ready']) {
  try {
    const res = await fetch(base.replace(/\/$/, '') + path, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    const body = await res.json();
    if (!res.ok || body.ok !== true) throw new Error(`HTTP ${res.status}`);
    console.log(`PASS ${path}`);
  } catch { failed = true; console.error(`FAIL ${path}`); }
}
process.exitCode = failed ? 1 : 0;
