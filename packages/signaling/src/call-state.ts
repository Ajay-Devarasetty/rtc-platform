import { tenantKey } from "./tenant-scope.js";
export type CallPhase = "ringing" | "connected";

export interface ActiveCall {
  appId: string;
  callId: string;
  roomId: string;
  callerUserId: string;
  calleeUserId: string;
  phase: CallPhase;
  callType: "voice" | "video";
  ringingExpiresAt: number;
}

const callsById = new Map<string, ActiveCall>();
const callIdByUser = new Map<string, string>();

function userKey(appId: string, userId: string) {
  return tenantKey(appId, userId);
}

export function findUserCall(appId: string, userId: string): ActiveCall | null {
  const callId = callIdByUser.get(userKey(appId, userId));
  if (!callId) return null;
  return callsById.get(tenantKey(appId, callId)) ?? null;
}

export function registerRinging(
  appId: string,
  callId: string,
  roomId: string,
  callerUserId: string,
  calleeUserId: string,
  callType: "voice" | "video" = "voice"
): { ok: true } | { ok: false; busyUserId: string } {
  if (callsById.has(tenantKey(appId, callId))) {
    return { ok: false, busyUserId: callerUserId };
  }
  if (findUserCall(appId, callerUserId)) {
    return { ok: false, busyUserId: callerUserId };
  }
  if (findUserCall(appId, calleeUserId)) {
    return { ok: false, busyUserId: calleeUserId };
  }

  const call: ActiveCall = {
    appId,
    callId,
    roomId,
    callerUserId,
    calleeUserId,
    phase: "ringing",
    callType,
    ringingExpiresAt: Date.now() + 60_000,
  };
  callsById.set(tenantKey(appId, callId), call);
  callIdByUser.set(userKey(appId, callerUserId), callId);
  callIdByUser.set(userKey(appId, calleeUserId), callId);
  return { ok: true };
}

export function markCallConnected(appId: string, callId: string) {
  const call = callsById.get(tenantKey(appId, callId));
  if (call) call.phase = "connected";
}

export function clearCall(appId: string, callId: string) {
  const key = tenantKey(appId, callId);
  const call = callsById.get(key);
  if (!call) return;
  callsById.delete(key);
  callIdByUser.delete(userKey(call.appId, call.callerUserId));
  callIdByUser.delete(userKey(call.appId, call.calleeUserId));
}

export function clearUserCalls(appId: string, userId: string) {
  const call = findUserCall(appId, userId);
  if (call) clearCall(appId, call.callId);
}

export function expireRingingCalls(now = Date.now()): ActiveCall[] {
  const expired = [...callsById.values()].filter((call) => call.phase === "ringing" && call.ringingExpiresAt <= now);
  for (const call of expired) clearCall(call.appId, call.callId);
  return expired;
}

/** Test helper */
export function resetCallState() {
  callsById.clear();
  callIdByUser.clear();
}
