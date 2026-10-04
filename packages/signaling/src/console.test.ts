import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerConsoleRoutes, reportPeriod } from "./routes/console.js";
import { getPool, closeDb } from "./db.js";
import { issueToken, verifyToken } from "./auth.js";

test("console dates reject invalid calendar dates, reverse ranges, and oversized reports", () => {
  assert.equal(reportPeriod("2026-02-30", "2026-03-02"), null);
  assert.equal(reportPeriod("2026-10-02", "2026-10-01"), null);
  assert.equal(reportPeriod("2026-01-01", "2026-10-01"), null);
  assert.equal(reportPeriod("bad", "2026-10-01"), null);
  assert.deepEqual(reportPeriod("2026-09-30", "2026-10-01"), { from: "2026-09-30T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" });
});

test("console endpoints enforce project isolation and short-lived scoped test tokens", async t => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://unused/console-test";
  t.after(async () => { await closeDb(); if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  t.mock.method(getPool()!, "query", async (sql: string, args: unknown[]) => {
    if (sql.includes("SELECT portal_version")) return { rows: [{ portal_version: 3 }] };
    queries.push({ sql, args });
    return { rows: [], rowCount: 1 };
  });
  const app = Fastify(); t.after(() => app.close());
  await app.register(async scope => registerConsoleRoutes(scope, "console-test-secret"));
  const auth = (userId = "__portal__", version = 3) => ({ authorization: `Bearer ${issueToken({ appId: "my-project", userId, sessionVersion: version }, "console-test-secret")}` });
  assert.equal((await app.inject({ url: "/v1/portal/project" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/v1/portal/project", headers: auth("ordinary-user") })).statusCode, 403);
  assert.equal((await app.inject({ url: "/v1/portal/project", headers: auth("__portal__", 2) })).statusCode, 401);
  assert.equal(queries.length, 0);
  const report = await app.inject({ url: "/v1/portal/reports?from=2026-09-01&to=2026-09-30&appId=another-project", headers: auth() });
  assert.equal(report.statusCode, 200);
  assert.equal(report.headers["cache-control"], "no-store");
  assert.equal(queries.length, 6);
  for (const query of queries) {
    assert.equal(query.args[0], "my-project");
    assert.match(query.sql, /app_id=\$1/);
    assert.equal(query.args[2], "2026-10-01T00:00:00.000Z");
  }
  queries.length = 0;
  const invalid = await app.inject({ url: "/v1/portal/reports?from=2026-02-30&to=2026-03-01", headers: auth() });
  assert.equal(invalid.statusCode, 400); assert.equal(queries.length, 0);
  const rename = await app.inject({ url: "/v1/portal/project", method: "PATCH", headers: auth(), payload: { name: "Renamed project", appId: "another-project" } });
  assert.equal(rename.statusCode, 200); assert.deepEqual(queries[0].args, ["Renamed project", "my-project"]);
  const tokenResponse = await app.inject({ url: "/v1/portal/test-token", method: "POST", headers: auth(), payload: { userId: "test-user", roomId: "test-room", appId: "another-project", role: "host" } });
  assert.equal(tokenResponse.statusCode, 200);
  const claims = verifyToken(tokenResponse.json().token, "console-test-secret");
  assert.equal(claims.appId, "my-project"); assert.equal(claims.roomId, "test-room"); assert.equal(claims.role, "publisher");
  assert.equal(claims.exp! - claims.iat!, 900);
  const reserved = await app.inject({ url: "/v1/portal/test-token", method: "POST", headers: auth(), payload: { userId: "__portal__", roomId: "test-room" } });
  assert.equal(reserved.statusCode, 400);
  const otherToken = issueToken({ appId: "other-project", userId: "user" }, "console-test-secret");
  const wrongProject = await app.inject({ url: "/v1/portal/verify-test-token", method: "POST", headers: auth(), payload: { token: otherToken } });
  assert.equal(wrongProject.statusCode, 400);
  const verified = await app.inject({ url: "/v1/portal/verify-test-token", method: "POST", headers: auth(), payload: { token: tokenResponse.json().token } });
  assert.equal(verified.statusCode, 200);
  const tampered = await app.inject({ url: "/v1/portal/verify-test-token", method: "POST", headers: auth(), payload: { token: tokenResponse.json().token + "x" } });
  assert.equal(tampered.statusCode, 400);
});
