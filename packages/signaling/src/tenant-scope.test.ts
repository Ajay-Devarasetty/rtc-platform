import test from "node:test";
import assert from "node:assert/strict";
import { MemoryRoomStore } from "./store/memory.js";
import { MemoryRoomRoleStore } from "./room-roles.js";
import { scopedRooms, scopedRoles, tenantKey } from "./tenant-scope.js";

test("customers can reuse room and user IDs without sharing membership or roles", async () => {
  const store = new MemoryRoomStore();
  const roles = new MemoryRoomRoleStore();
  const a = scopedRooms(store, "customer-a");
  const b = scopedRooms(store, "customer-b");
  await a.join("room", "alice");
  await b.join("room", "bob");
  assert.deepEqual(await a.getMembers("room"), ["alice"]);
  assert.equal(await b.isMember("room", "alice"), false);
  scopedRoles(roles, "customer-a").assign("room", "alice", "host");
  assert.equal(scopedRoles(roles, "customer-b").get("room", "alice"), null);
  await b.join("room", "alice");
  assert.deepEqual(await a.leaveAll("alice"), ["room"]);
  assert.equal(await b.isMember("room", "alice"), true);
  assert.notEqual(tenantKey("a:b", "c"), tenantKey("a", "b:c"));
});
