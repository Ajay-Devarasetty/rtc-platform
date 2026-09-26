import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { createAuthHook, type AuthenticatedRequest } from "./auth.js";

const secret = "test-only-secret";
function token(appId = "a", roomId = "room") {
  return jwt.sign({ appId, userId: "alice", roomId }, secret);
}
function server() {
  const app = Fastify();
  app.addHook("preHandler", createAuthHook(secret, "http://authorization.test"));
  app.post<{ Params: { roomId: string; action: string } }>("/v1/rooms/:roomId/:action", async (req) => ({ internalRoom: req.params.roomId, roomId: (req as AuthenticatedRequest).rtcRoomId }));
  return app;
}

test("SFU isolates matching room IDs and consults live plan authorization", async (t) => {
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ allowed: true }), { status: 200 });
  });
  const app = server(); t.after(() => app.close());
  const a = await app.inject({ method: "POST", url: "/v1/rooms/room/produce", headers: { authorization: `Bearer ${token()}` }, payload: { peerId: "alice", kind: "video" } });
  const b = await app.inject({ method: "POST", url: "/v1/rooms/room/join", headers: { authorization: `Bearer ${token("b")}` }, payload: { peerId: "alice" } });
  assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200);
  assert.notEqual(a.json().internalRoom, b.json().internalRoom);
  assert.equal(a.json().roomId, "room");
  assert.deepEqual(requests, [{ roomId: "room", action: "video" }, { roomId: "room", action: "read" }]);
});

test("SFU rejects a different room and a forged peer identity", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not reach authorization"); });
  const app = server(); t.after(() => app.close());
  for (const [room, peerId] of [["other", "alice"], ["room", "bob"]]) {
    const response = await app.inject({ method: "POST", url: `/v1/rooms/${room}/join`, headers: { authorization: `Bearer ${token()}` }, payload: { peerId } });
    assert.equal(response.statusCode, 403);
  }
});

test("SFU refuses operations when plan authorization denies or is unavailable", async (t) => {
  const app = server(); t.after(() => app.close());
  const mocked = t.mock.method(globalThis, "fetch", async () => new Response("denied", { status: 403 }));
  const request = { method: "POST" as const, url: "/v1/rooms/room/join", headers: { authorization: `Bearer ${token()}` }, payload: { peerId: "alice" } };
  assert.equal((await app.inject(request)).statusCode, 403);
  mocked.mock.mockImplementation(async () => { throw new Error("offline"); });
  assert.equal((await app.inject(request)).statusCode, 503);
});
