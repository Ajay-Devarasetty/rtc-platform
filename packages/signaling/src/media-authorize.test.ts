import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerMediaAuthorizeRoutes } from "./routes/media-authorize.js";
import { MemoryRoomStore } from "./store/memory.js";
import { MemoryRoomRoleStore } from "./room-roles.js";
import { scopedRooms, scopedRoles } from "./tenant-scope.js";
import { issueToken } from "./auth.js";
import { getPool, closeDb } from "./db.js";

test("media authorization enforces current plan, project membership, and host role", async (t) => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://unused/test";
  t.after(async () => { await closeDb(); if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  let plan = "starter";
  t.mock.method(getPool()!, "query", async () => ({ rows: [{ plan }] }));
  const app = Fastify(); t.after(() => app.close());
  const rooms = new MemoryRoomStore(); const roomRoles = new MemoryRoomRoleStore();
  await scopedRooms(rooms, "app").join("room", "host");
  await scopedRooms(rooms, "app").join("room", "viewer");
  scopedRoles(roomRoles, "app").assign("room", "host", "host");
  scopedRoles(roomRoles, "app").assign("room", "viewer", "audience");
  await registerMediaAuthorizeRoutes(app, { jwtSecret: "test", rooms, roomRoles });
  async function status(action: string, userId = "host", appId = "app") {
    return (await app.inject({ method: "POST", url: "/v1/media/authorize", headers: { authorization: `Bearer ${issueToken({ appId, userId }, "test")}` }, payload: { roomId: "room", action } })).statusCode;
  }
  assert.equal(await status("audio"), 200);
  assert.equal(await status("video"), 403);
  plan = "pro";
  assert.equal(await status("video"), 200);
  assert.equal(await status("recording-start", "viewer"), 403);
  assert.equal(await status("audio", "viewer"), 403);
  assert.equal(await status("read", "viewer"), 200);
  assert.equal(await status("read", "host", "other-app"), 403);
  plan = "free";
  assert.equal(await status("read"), 403);
  assert.equal(await status("recording-stop"), 200);
});
