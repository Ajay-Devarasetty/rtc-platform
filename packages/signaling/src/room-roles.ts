import type { RoomRole } from "@rtc/protocol";

export type { RoomRole };

export interface RoomRoleStore {
  assign(roomId: string, userId: string, role: RoomRole): RoomRole;
  get(roomId: string, userId: string): RoomRole | null;
  remove(roomId: string, userId: string): void;
  clearRoom(roomId: string): void;
  list(roomId: string): Array<{ userId: string; role: RoomRole }>;
  hasHost(roomId: string): boolean;
}

export function canPublish(role: RoomRole | null): boolean {
  return role === "host" || role === "publisher" || role === "subscriber";
}

export function canModerate(role: RoomRole | null): boolean {
  return role === "host";
}

export function isAudience(role: RoomRole | null): boolean {
  return role === "audience";
}

export class MemoryRoomRoleStore implements RoomRoleStore {
  private roles = new Map<string, Map<string, RoomRole>>();

  private room(roomId: string) {
    if (!this.roles.has(roomId)) this.roles.set(roomId, new Map());
    return this.roles.get(roomId)!;
  }

  assign(roomId: string, userId: string, role: RoomRole): RoomRole {
    const members = this.room(roomId);
    // Rejoining after socket replacement must not demote the current host.
    if (members.get(userId) === "host" && role !== "audience") return "host";
    const hasHost = [...members.values()].includes("host");
    const effective = !hasHost && role !== "audience" ? "host" : role;
    members.set(userId, effective);
    return effective;
  }

  get(roomId: string, userId: string) {
    return this.room(roomId).get(userId) ?? null;
  }

  remove(roomId: string, userId: string) {
    this.room(roomId).delete(userId);
    if (this.room(roomId).size === 0) this.roles.delete(roomId);
  }

  clearRoom(roomId: string) {
    this.roles.delete(roomId);
  }

  list(roomId: string) {
    return [...this.room(roomId).entries()].map(([userId, role]) => ({ userId, role }));
  }

  hasHost(roomId: string) {
    return [...this.room(roomId).values()].includes("host");
  }
}
