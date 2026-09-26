import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendCallPush } from "./push.js";
import { getPool, closeDb } from "./db.js";
import { registerRinging, resetCallState } from "./call-state.js";

test("push credentials and tokens remain scoped to their project and expired devices are removed", async (t) => {
  const previousDb = process.env.DATABASE_URL, previousConfig = process.env.FCM_CONFIG_FILE;
  const dir = await mkdtemp(join(tmpdir(), "rtc-push-test-")); const file = join(dir, "credentials.json");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(file, JSON.stringify({ app: { project_id: "test-project", client_email: "test@example.com", private_key: privateKey.export({ format: "pem", type: "pkcs8" }) } }), { mode: 0o600 });
  process.env.DATABASE_URL = "postgresql://unused/test"; process.env.FCM_CONFIG_FILE = file;
  t.after(async () => { await closeDb(); await unlink(file); await rmdir(dir); resetCallState();
    if (previousDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDb;
    if (previousConfig === undefined) delete process.env.FCM_CONFIG_FILE; else process.env.FCM_CONFIG_FILE = previousConfig;
  });
  let removed = false; const sends: string[] = [];
  t.mock.method(getPool()!, "query", async (sql: string, args: unknown[]) => {
    assert.equal(args[0], "app");
    if (sql.startsWith("SELECT")) { assert.equal(args[1], "bob"); return { rowCount: 1, rows: [{ installation_id: "device", token: "device-token" }] }; }
    if (sql.startsWith("DELETE")) { assert.equal(args[2], "device-token"); removed = true; }
    return { rowCount: 1, rows: [] };
  });
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    sends.push(url);
    if (url.includes("oauth2")) return new Response('{"access_token":"test-access","expires_in":3600}');
    const message = JSON.parse(options.body as string).message;
    assert.equal(message.token, "device-token"); assert.equal(message.data.callId, "call");
    assert.equal(message.android.priority, "HIGH"); assert.match(message.android.ttl, /^\d+s$/);
    return new Response('{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}', { status: 404 });
  });
  resetCallState(); registerRinging("app", "call", "room", "alice", "bob");
  await sendCallPush("other-app", { toUserId: "bob", callId: "call" }); assert.equal(sends.length, 0);
  await sendCallPush("app", { toUserId: "bob", callId: "call" }); assert.equal(sends.length, 2); assert.equal(removed, true);
});
