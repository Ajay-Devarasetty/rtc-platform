import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  clearCall,
  clearUserCalls,
  findUserCall,
  markCallConnected,
  registerRinging,
  resetCallState,
  expireRingingCalls,
} from "./call-state.js";

describe("call-state", () => {
  beforeEach(() => {
    resetCallState();
  });

  it("registers a ringing call for both participants", () => {
    const result = registerRinging("app1", "call-1", "room-1", "alice", "bob");
    assert.equal(result.ok, true);
    assert.equal(findUserCall("app1", "alice")?.phase, "ringing");
    assert.equal(findUserCall("app1", "bob")?.phase, "ringing");
  });

  it("rejects when caller is already in a call", () => {
    registerRinging("app1", "call-1", "room-1", "alice", "bob");
    const result = registerRinging("app1", "call-2", "room-1", "alice", "carol");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.busyUserId, "alice");
  });

  it("rejects when callee is already in a call", () => {
    registerRinging("app1", "call-1", "room-1", "alice", "bob");
    const result = registerRinging("app1", "call-2", "room-1", "carol", "bob");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.busyUserId, "bob");
  });

  it("marks a call connected and clears both users on end", () => {
    registerRinging("app1", "call-1", "room-1", "alice", "bob");
    markCallConnected("app1", "call-1");
    assert.equal(findUserCall("app1", "alice")?.phase, "connected");
    clearCall("app1", "call-1");
    assert.equal(findUserCall("app1", "alice"), null);
    assert.equal(findUserCall("app1", "bob"), null);
  });

  it("clears a user call on disconnect", () => {
    registerRinging("app1", "call-1", "room-1", "alice", "bob");
    clearUserCalls("app1", "alice");
    assert.equal(findUserCall("app1", "alice"), null);
    assert.equal(findUserCall("app1", "bob"), null);
  });

  it("isolates reused call IDs across customers", () => {
    registerRinging("app1", "same", "room", "alice", "bob");
    registerRinging("app2", "same", "room", "alice", "bob");
    markCallConnected("app1", "same");
    assert.equal(findUserCall("app2", "alice")?.phase, "ringing");
    clearCall("app1", "same");
    assert.equal(findUserCall("app2", "alice")?.callId, "same");
  });

  it("does not overwrite a call ID already used by other participants", () => {
    registerRinging("app1", "same", "room", "alice", "bob");
    assert.equal(registerRinging("app1", "same", "room", "carol", "dave").ok, false);
    assert.equal(findUserCall("app1", "alice")?.calleeUserId, "bob");
  });

  it("expires unanswered calls but preserves connected calls", () => {
    registerRinging("app1", "ringing", "room", "alice", "bob");
    registerRinging("app1", "connected", "room", "carol", "dave");
    markCallConnected("app1", "connected");
    assert.equal(expireRingingCalls(Date.now() + 61_000).length, 1);
    assert.equal(findUserCall("app1", "alice"), null);
    assert.equal(findUserCall("app1", "carol")?.phase, "connected");
  });
});
