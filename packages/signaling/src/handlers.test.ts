import test from "node:test";
import assert from "node:assert/strict";
import { handleClientMessage } from "./handlers.js";
import { MemoryRoomStore } from "./store/memory.js";
import { MemoryRoomRoleStore } from "./room-roles.js";
import { resetCallState, registerRinging, markCallConnected } from "./call-state.js";
import type { ClientMessage, ServerMessage, TokenClaims } from "@rtc/protocol";
import type { WebSocket } from "ws";
import { getPool, closeDb } from "./db.js";
import { findUserCall } from "./call-state.js";

function context(message: unknown, userId = "alice") {
  const sent: ServerMessage[] = [];
  const delivered: ServerMessage[] = [];
  const events: string[] = [];
  return {
    message: message as ClientMessage,
    claims: { appId: "app", userId } as TokenClaims,
    ws: {} as WebSocket,
    rooms: new MemoryRoomStore(), roomRoles: new MemoryRoomRoleStore(),
    send: (_: WebSocket, message: ServerMessage) => { sent.push(message); },
    sendToUser: async (_: string, message: ServerMessage) => { delivered.push(message); return true; },
    dispatch: (type: string) => { events.push(type); },
    forceLeaveRoom: async () => {},
    sent, delivered, events,
  };
}

test("malformed messages are rejected without throwing", async () => {
  for (const value of [null, {}, { type: "send_message", payload: null }]) {
    const ctx = context(value);
    await handleClientMessage(ctx);
    assert.equal(ctx.sent[0].type, "error");
  }
});

test("client room role cannot elevate a signed audience token", async () => {
  const ctx = context({ type: "join_room", payload: { roomId: "r", role: "host" } });
  ctx.claims.role = "audience";
  await handleClientMessage(ctx);
  assert.equal(ctx.roomRoles.get("r", "alice"), "audience");
});

test("room-scoped token cannot leave or moderate another room", async () => {
  const ctx = context({ type: "leave_room", payload: { roomId: "other" } });
  ctx.claims.roomId = "allowed";
  await ctx.rooms.join("other", "alice");
  await handleClientMessage(ctx);
  assert.equal(await ctx.rooms.isMember("other", "alice"), true);
  assert.equal(ctx.sent[0].type, "error");
});

test("unrelated users cannot end calls or relay peer signaling", async () => {
  resetCallState();
  registerRinging("app", "c", "r", "alice", "bob");
  for (const type of ["call_end", "webrtc_offer", "ice_candidate"]) {
    const ctx = context({ type, payload: { roomId: "r", callId: "c", toUserId: "alice" } }, "mallory");
    await handleClientMessage(ctx);
    assert.equal(ctx.delivered.length, 0);
    assert.equal(ctx.sent[0].type, "error");
  }
});

test("valid peer signaling does not require roomId in its wire payload", async () => {
  resetCallState();
  registerRinging("app", "c", "r", "alice", "bob");
  const ctx = context({ type: "ice_candidate", payload: { callId: "c", toUserId: "bob", candidate: {} } });
  await handleClientMessage(ctx);
  assert.equal(ctx.delivered.length, 1);
  assert.equal(ctx.sent.length, 0);
});

test("offline invites still dispatch a ringing webhook and retain a pending call", async (t) => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://unused/test";
  t.after(async () => { await closeDb(); if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  t.mock.method(getPool()!, "query", async () => ({ rows: [{ plan: "pro" }] }));
  resetCallState();
  const ctx = context({ type: "call_invite", payload: { roomId: "r", callId: "offline", toUserId: "bob", callType: "video" } });
  await ctx.rooms.join("r", "alice");
  ctx.sendToUser = async () => false;
  await handleClientMessage(ctx);
  assert.deepEqual(ctx.events, ["call.ringing"]);
  assert.equal(findUserCall("app", "bob")?.callType, "video");
  assert.equal(ctx.sent.length, 0);
});


test("SFU call producers relay only between authorized connected participants", async (t) => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://unused/test";
  t.after(async () => { resetCallState(); await closeDb(); if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  t.mock.method(getPool()!, "query", async () => ({ rows: [{ plan: "pro" }] }));
  resetCallState(); registerRinging("app", "video-call", "chat-room", "alice", "bob", "video");
  markCallConnected("app", "video-call");
  const payload = { roomId: "chat-room-call-video-call", callId: "video-call", toUserId: "bob", producerId: "camera", kind: "video", source: "camera" };
  for (const source of ["camera", "screen"]) {
    const ctx = context({ type: "sfu_producer", payload: { ...payload, source } });
    ctx.claims.roomId = "chat-room";
    ctx.roomRoles.assign("chat-room", "alice", "publisher");
    await ctx.rooms.join("chat-room", "alice");
    await handleClientMessage(ctx);
    assert.equal(ctx.delivered.length, 1);
    assert.equal(ctx.delivered[0].type, "sfu_producer");
  }
  for (const change of [{toUserId:"mallory"}, {roomId:"wrong"}, {callId:"wrong"}]) {
    const ctx = context({type:"sfu_producer",payload:{...payload,...change}});
    await ctx.rooms.join("chat-room", "alice"); await handleClientMessage(ctx);
    assert.equal(ctx.delivered.length,0);
  }
  const outsider = context({type:"sfu_producer",payload}, "mallory");
  await outsider.rooms.join("chat-room", "mallory"); await handleClientMessage(outsider);
  assert.equal(outsider.delivered.length,0);
  const scoped = context({type:"sfu_producer",payload}); scoped.claims.roomId="other";
  await scoped.rooms.join("chat-room","alice"); await handleClientMessage(scoped);
  assert.equal(scoped.delivered.length,0);
});
