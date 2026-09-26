import type { RoomStore } from "./store/types.js";
import type { RoomRoleStore } from "./room-roles.js";

// IDs remain unchanged on the wire; only storage and relay keys are scoped.
export function tenantKey(appId: string, id: string): string {
  return `${Buffer.from(appId).toString("base64url")}.${Buffer.from(id).toString("base64url")}`;
}

function originalId(key: string): string {
  return Buffer.from(key.slice(key.indexOf(".") + 1), "base64url").toString();
}

export function scopedRooms(store: RoomStore, appId: string): RoomStore {
  const key = (id: string) => tenantKey(appId, id);
  return {
    join: (room, user) => store.join(key(room), key(user)),
    leave: (room, user) => store.leave(key(room), key(user)),
    leaveAll: async (user) => (await store.leaveAll(key(user))).map(originalId),
    getMembers: async (room) => (await store.getMembers(key(room))).map(originalId),
    isMember: (room, user) => store.isMember(key(room), key(user)),
  };
}

export function scopedRoles(store: RoomRoleStore, appId: string): RoomRoleStore {
  const key = (id: string) => tenantKey(appId, id);
  return {
    assign: (room, user, role) => store.assign(key(room), key(user), role),
    get: (room, user) => store.get(key(room), key(user)),
    remove: (room, user) => store.remove(key(room), key(user)),
    clearRoom: (room) => store.clearRoom(key(room)),
    list: (room) => store.list(key(room)).map(({ userId, role }) => ({ userId: originalId(userId), role })),
    hasHost: (room) => store.hasHost(key(room)),
  };
}
