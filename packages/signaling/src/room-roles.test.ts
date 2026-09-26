import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { MemoryRoomRoleStore, canModerate, canPublish, isAudience } from "./room-roles.js";

describe("room-roles", () => {
  let store: MemoryRoomRoleStore;

  beforeEach(() => {
    store = new MemoryRoomRoleStore();
  });

  it("promotes first joiner to host", () => {
    const role = store.assign("room-1", "alice", "publisher");
    assert.equal(role, "host");
  });

  it("keeps audience role for live broadcast listeners", () => {
    store.assign("room-1", "host", "host");
    const role = store.assign("room-1", "viewer", "audience");
    assert.equal(role, "audience");
    assert.equal(isAudience(role), true);
    assert.equal(canPublish(role), false);
  });

  it("allows host to moderate", () => {
    store.assign("room-1", "alice", "publisher");
    assert.equal(canModerate(store.get("room-1", "alice")), true);
    store.assign("room-1", "bob", "publisher");
    assert.equal(canModerate(store.get("room-1", "bob")), false);
  });

  it("lists members with roles", () => {
    store.assign("room-1", "alice", "publisher");
    store.assign("room-1", "bob", "audience");
    assert.equal(store.list("room-1").length, 2);
  });

  it("preserves the host on rejoin while allowing an explicit audience downgrade", () => {
    store.assign("room", "alice", "publisher");
    store.assign("room", "bob", "publisher");
    assert.equal(store.assign("room", "alice", "publisher"), "host");
    assert.equal(store.assign("room", "alice", "audience"), "audience");
  });
});
