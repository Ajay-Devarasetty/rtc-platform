import type { WebSocket } from "ws";
import type {
  CallInvitePayload,
  CallPeerPayload,
  CallQualityReportPayload,
  ClientMessage,
  EndRoomPayload,
  JoinMediaPayload,
  JoinRoomPayload,
  KickUserPayload,
  MuteRemotePayload,
  RecordingReadyPayload,
  RoomMessagePayload,
  ServerMessage,
  TokenClaims,
  WebRtcPayload,
} from "@rtc/protocol";
import type { RoomStore } from "./store/types.js";
import type { RoomRoleStore } from "./room-roles.js";
import { canModerate, canPublish, isAudience } from "./room-roles.js";
import { joinMediaSession, leaveMediaSession } from "./media-sessions.js";
import { MAX_MESSAGE_LENGTH, saveMessage } from "./messages.js";
import { endCallSession, startCallSession } from "./metering.js";
import { saveRecording } from "./recordings.js";
import { saveQualityReport } from "./quality.js";
import { maybeDispatchBillingAlert } from "./billing.js";
import { checkAppFeature } from "./plan-features.js";
import type { PlanFeature } from "./billing-plans.js";
import {
  clearCall,
  findUserCall,
  markCallConnected,
  registerRinging,
} from "./call-state.js";

interface HandlerContext {
  message: ClientMessage;
  claims: TokenClaims;
  ws: WebSocket;
  rooms: RoomStore;
  roomRoles: RoomRoleStore;
  send: (ws: WebSocket, message: ServerMessage) => void;
  sendToUser: (userId: string, message: ServerMessage) => Promise<boolean>;
  dispatch: (type: string, payload: Record<string, unknown>) => void;
  forceLeaveRoom: (roomId: string, userId: string, reason: string) => Promise<void>;
}

function assertRoomScope(ctx: HandlerContext, roomId: string, ws: WebSocket) {
  if (ctx.claims.roomId && ctx.claims.roomId !== roomId) {
    ctx.send(ws, {
      type: "error",
      payload: { message: "Token is not valid for this room", code: "room_scope_denied" },
    });
    return false;
  }
  return true;
}

async function relayToUser(
  ctx: HandlerContext,
  toUserId: string,
  type: ServerMessage["type"],
  payload: unknown
) {
  const delivered = await ctx.sendToUser(toUserId, { type, payload } as ServerMessage);
  if (!delivered) {
    ctx.send(ctx.ws, {
      type: "error",
      payload: { message: `User ${toUserId} is offline` },
    });
  }
}

async function requireFeature(
  ctx: HandlerContext,
  feature: PlanFeature
): Promise<boolean> {
  const result = await checkAppFeature(ctx.claims.appId, feature);
  if (result.allowed) return true;
  ctx.send(ctx.ws, {
    type: "error",
    payload: {
      message: result.message,
      code: "plan_feature_denied",
      feature: result.feature,
      plan: result.plan,
    },
  });
  return false;
}

export async function handleClientMessage(ctx: HandlerContext) {
  const { message, claims, ws } = ctx;
  const userId = claims.userId;
  if (!message || typeof message.type !== "string" || !message.payload || typeof message.payload !== "object" || Array.isArray(message.payload)) {
    ctx.send(ws, { type: "error", payload: { message: "Invalid message format" } });
    return;
  }
  const roomId = (message.payload as { roomId?: unknown }).roomId;
  const isPeerSignal = ["webrtc_offer", "webrtc_answer", "ice_candidate"].includes(message.type);
  if (!isPeerSignal && (typeof roomId !== "string" || !roomId.trim() || !assertRoomScope(ctx, roomId, ws))) {
    if (typeof roomId !== "string" || !roomId.trim()) ctx.send(ws, { type: "error", payload: { message: "roomId is required" } });
    return;
  }

  switch (message.type) {
    case "join_room": {
      const { roomId, role } = message.payload as JoinRoomPayload;
      if (!roomId) {
        ctx.send(ws, { type: "error", payload: { message: "roomId is required" } });
        return;
      }
      if (!assertRoomScope(ctx, roomId, ws)) return;
      // A client may opt into audience mode, but cannot elevate its signed role.
      const requestedRole = role === "audience" ? "audience" : ctx.claims.role || "publisher";
      const assignedRole = ctx.roomRoles.assign(roomId, userId, requestedRole);
      await ctx.rooms.join(roomId, userId);
      const members = (await ctx.rooms.getMembers(roomId)).filter((id) => id !== userId);
      ctx.send(ws, {
        type: "room_joined",
        payload: { roomId, members, role: assignedRole },
        requestId: message.requestId,
      });
      for (const memberId of members) {
        await ctx.sendToUser(memberId, {
          type: "user_joined",
          payload: { roomId, userId, role: assignedRole },
        });
      }
      ctx.dispatch("user.joined", { roomId, userId, role: assignedRole });
      break;
    }

    case "leave_room": {
      const { roomId } = message.payload as { roomId: string };
      if (!(await ctx.rooms.isMember(roomId, userId))) return;
      const call = findUserCall(claims.appId, userId);
      if (call?.roomId === roomId) {
        await endCallSession(claims.appId, call.callId, "left_room");
        clearCall(claims.appId, call.callId);
        const toUserId = call.callerUserId === userId ? call.calleeUserId : call.callerUserId;
        await ctx.sendToUser(toUserId, { type: "call_end", payload: { callId: call.callId, roomId, fromUserId: userId, toUserId } });
        ctx.dispatch("call.ended", { callId: call.callId, roomId, fromUserId: userId, toUserId, reason: "left_room" });
      }
      await ctx.rooms.leave(roomId, userId);
      ctx.roomRoles.remove(roomId, userId);
      // Leaving the room ends any group media in it. Done as a direct call
      // rather than a media.left event so subscribers aren't sent a delivery
      // for someone who was never in media — the update matches no rows then.
      await leaveMediaSession(ctx.claims.appId, roomId, userId, "left_room");
      const members = await ctx.rooms.getMembers(roomId);
      for (const memberId of members) {
        await ctx.sendToUser(memberId, {
          type: "user_left",
          payload: { roomId, userId },
        });
      }
      ctx.dispatch("user.left", { roomId, userId });
      break;
    }

    case "send_message": {
      const { roomId, text, clientMsgId } = message.payload as {
        roomId: string;
        text: string;
        clientMsgId?: string;
      };
      if (!(await requireFeature(ctx, "chat"))) return;
      if (typeof text !== "string" || !text.length) {
        ctx.send(ws, { type: "error", payload: { message: "text is required" } });
        return;
      }
      if (text.length > MAX_MESSAGE_LENGTH) {
        ctx.send(ws, {
          type: "error",
          payload: { message: `text exceeds ${MAX_MESSAGE_LENGTH} characters` },
        });
        return;
      }
      if (!(await ctx.rooms.isMember(roomId, userId))) {
        ctx.send(ws, { type: "error", payload: { message: "Join the room first" } });
        return;
      }
      if (!assertRoomScope(ctx, roomId, ws)) return;
      const payload: RoomMessagePayload = {
        roomId,
        fromUserId: userId,
        text,
        sentAt: Date.now(),
        clientMsgId,
      };
      // Persist before delivery so a refresh cannot race the history write.
      await saveMessage(ctx.claims.appId, roomId, userId, text, clientMsgId);
      const members = await ctx.rooms.getMembers(roomId);
      for (const memberId of members) {
        if (memberId !== userId) {
          await ctx.sendToUser(memberId, { type: "message", payload });
        }
      }
      // Text is persisted here rather than routed through dispatch, so chat
      // content stays out of the event log and customer webhook payloads.
      ctx.dispatch("message.sent", { roomId, fromUserId: userId });
      await maybeDispatchBillingAlert(ctx.claims.appId, (type, payload) =>
        ctx.dispatch(type, payload)
      );
      break;
    }

    case "call_invite": {
      const { roomId, toUserId, callId } = message.payload as CallInvitePayload;
      if (typeof toUserId !== "string" || !toUserId.trim() || toUserId === userId || typeof callId !== "string" || !callId.trim()) {
        ctx.send(ws, { type: "error", payload: { message: "Valid callId and a different toUserId are required" } });
        return;
      }
      if (!(await ctx.rooms.isMember(roomId, userId))) {
        ctx.send(ws, { type: "error", payload: { message: "Join the room first" } });
        return;
      }
      if (!assertRoomScope(ctx, roomId, ws)) return;
      const callType = (message.payload as CallInvitePayload).callType || "voice";
      if (callType !== "voice" && callType !== "video") {
        ctx.send(ws, { type: "error", payload: { message: "Invalid call type" } });
        return;
      }
      const feature: PlanFeature = callType === "video" ? "video" : "voice";
      if (!(await requireFeature(ctx, feature))) return;

      const busy = registerRinging(ctx.claims.appId, callId, roomId, userId, toUserId, callType);
      if (!busy.ok) {
        ctx.send(ws, {
          type: "error",
          payload: {
            message:
              busy.busyUserId === userId
                ? "You are already in a call"
                : `User ${toUserId} is busy`,
            code: "call_busy",
            busyUserId: busy.busyUserId,
          },
        });
        return;
      }

      const delivered = await ctx.sendToUser(toUserId, {
        type: "call_invite",
        payload: {
          callId,
          roomId,
          fromUserId: userId,
          toUserId,
          callType: (message.payload as CallInvitePayload).callType,
        } satisfies CallPeerPayload,
      });
      ctx.dispatch("call.ringing", {
        callId,
        roomId,
        fromUserId: userId,
        toUserId,
        callType: (message.payload as CallInvitePayload).callType || "voice",
        delivered,
      });
      break;
    }

    case "call_accept":
    case "call_reject":
    case "call_end": {
      const payload = message.payload as CallPeerPayload;
      const call = findUserCall(claims.appId, userId);
      const peer = call?.callerUserId === userId ? call?.calleeUserId : call?.callerUserId;
      if (!call || call.callId !== payload.callId || call.roomId !== payload.roomId || peer !== payload.toUserId ||
          (message.type !== "call_end" && (call.calleeUserId !== userId || call.phase !== "ringing")) ||
          (call.phase === "ringing" && call.ringingExpiresAt <= Date.now())) {
        ctx.send(ws, { type: "error", payload: { message: "Invalid call state or participant", code: "invalid_call" } });
        return;
      }
      if (message.type === "call_accept") {
        const callType = call.callType;
        const feature: PlanFeature = callType === "video" ? "video" : "voice";
        if (!(await requireFeature(ctx, feature))) return;
        if (findUserCall(claims.appId, userId) !== call || call.ringingExpiresAt <= Date.now()) return;
        markCallConnected(claims.appId, payload.callId);
        try {
          await startCallSession(claims.appId, call.callId, call.roomId, call.callerUserId, call.calleeUserId);
        } catch (error) {
          call.phase = "ringing";
          throw error;
        }
      }
      await relayToUser(ctx, payload.toUserId, message.type, {
        ...payload,
        fromUserId: userId,
        callType: call.callType,
      });
      const eventType =
        message.type === "call_accept"
          ? "call.connected"
          : message.type === "call_reject"
            ? "call.failed"
            : "call.ended";
      ctx.dispatch(eventType, { ...payload, fromUserId: userId });

      if (message.type === "call_end" || message.type === "call_reject") {
        clearCall(claims.appId, payload.callId);
      }

      if (message.type === "call_end") {
        await endCallSession(ctx.claims.appId, payload.callId, "hangup");
        await maybeDispatchBillingAlert(ctx.claims.appId, (type, p) => ctx.dispatch(type, p));
      } else if (message.type === "call_reject") {
        // No session exists for a call that was never accepted, so this is a
        // no-op in the normal case. It matters when the callee rejects a second
        // invite for a call they had already answered.
        await endCallSession(ctx.claims.appId, payload.callId, "rejected");
      }
      break;
    }

    case "webrtc_offer":
    case "webrtc_answer":
    case "ice_candidate": {
      const payload = message.payload as WebRtcPayload;
      const call = findUserCall(claims.appId, userId);
      const peer = call?.callerUserId === userId ? call?.calleeUserId : call?.callerUserId;
      if (!call || call.callId !== payload.callId || peer !== payload.toUserId || !assertRoomScope(ctx, call.roomId, ws)) {
        ctx.send(ws, { type: "error", payload: { message: "Invalid call participant", code: "invalid_call" } });
        return;
      }
      if (typeof payload.sdp?.sdp === "string" && /^m=video\s/m.test(payload.sdp.sdp) && !(await requireFeature(ctx, "video"))) return;
      await relayToUser(ctx, payload.toUserId, message.type, {
        ...payload,
        fromUserId: userId,
      });
      break;
    }

    case "sfu_producer": {
      const payload = message.payload as {
        roomId: string;
        producerId: string;
        toUserId?: string;
        callId?: string;
        kind?: "audio" | "video";
        source?: "camera" | "screen";
      };
      if (!payload.roomId || !payload.producerId) {
        ctx.send(ctx.ws, { type: "error", payload: { message: "Invalid SFU payload" } });
        return;
      }
      if (!(await ctx.rooms.isMember(payload.roomId, userId))) return;
      const role = ctx.roomRoles.get(payload.roomId, userId);
      if (!canPublish(role)) {
        ctx.send(ctx.ws, {
          type: "error",
          payload: {
            message: "Audience members cannot publish media",
            code: "publish_denied",
          },
        });
        return;
      }
      if (payload.kind === "video") {
        const feature: PlanFeature =
          payload.source === "screen" ? "screenShare" : "video";
        if (!(await requireFeature(ctx, feature))) return;
      } else if (!(await requireFeature(ctx, "voice"))) {
        return;
      }
      const messagePayload = {
        roomId: payload.roomId,
        producerId: payload.producerId,
        fromUserId: userId,
        toUserId: payload.toUserId,
        callId: payload.callId,
        kind: payload.kind,
        source: payload.source,
      };
      if (payload.toUserId) {
        await relayToUser(ctx, payload.toUserId, "sfu_producer", messagePayload);
      } else {
        const members = await ctx.rooms.getMembers(payload.roomId);
        for (const memberId of members) {
          if (memberId !== userId) {
            await ctx.sendToUser(memberId, { type: "sfu_producer", payload: messagePayload });
          }
        }
      }
      break;
    }

    case "join_media":
    case "leave_media": {
      const { roomId, kind } = message.payload as JoinMediaPayload;
      if (!roomId) {
        ctx.send(ws, { type: "error", payload: { message: "roomId is required" } });
        return;
      }
      if (kind !== "voice" && kind !== "video") {
        ctx.send(ws, { type: "error", payload: { message: "kind must be voice or video" } });
        return;
      }
      if (!(await ctx.rooms.isMember(roomId, userId))) {
        ctx.send(ws, { type: "error", payload: { message: "Join the room first" } });
        return;
      }
      if (!assertRoomScope(ctx, roomId, ws)) return;

      if (message.type === "join_media") {
        const feature: PlanFeature = kind === "video" ? "groupVideo" : "groupVoice";
        if (!(await requireFeature(ctx, feature))) return;
        const role = ctx.roomRoles.get(roomId, userId);
        if (isAudience(role)) {
          ctx.send(ws, {
            type: "error",
            payload: {
              message: "Audience role can only subscribe — use recv-only SFU join",
              code: "audience_publish_denied",
            },
          });
          return;
        }
      }

      const joining = message.type === "join_media";
      const members = (await ctx.rooms.getMembers(roomId)).filter((id) => id !== userId);
      for (const memberId of members) {
        await ctx.sendToUser(memberId, {
          type: joining ? "media_participant_joined" : "media_participant_left",
          payload: { roomId, userId, kind },
        });
      }

      if (joining) {
        await joinMediaSession(ctx.claims.appId, roomId, userId, kind);
      } else {
        await leaveMediaSession(ctx.claims.appId, roomId, userId, "left");
      }
      ctx.dispatch(joining ? "media.joined" : "media.left", { roomId, userId, kind });
      await maybeDispatchBillingAlert(ctx.claims.appId, (type, p) => ctx.dispatch(type, p));
      break;
    }

    case "kick_user": {
      const { roomId, targetUserId } = message.payload as KickUserPayload;
      if (!roomId || !targetUserId) {
        ctx.send(ws, { type: "error", payload: { message: "roomId and targetUserId required" } });
        return;
      }
      if (!canModerate(ctx.roomRoles.get(roomId, userId))) {
        ctx.send(ws, { type: "error", payload: { message: "Only host can kick users", code: "forbidden" } });
        return;
      }
      await ctx.forceLeaveRoom(roomId, targetUserId, "kicked");
      ctx.dispatch("user.kicked", { roomId, userId: targetUserId, byUserId: userId });
      break;
    }

    case "mute_remote": {
      const payload = message.payload as MuteRemotePayload;
      if (!payload.roomId || !payload.targetUserId) {
        ctx.send(ws, { type: "error", payload: { message: "Invalid mute payload" } });
        return;
      }
      if (!canModerate(ctx.roomRoles.get(payload.roomId, userId))) {
        ctx.send(ws, { type: "error", payload: { message: "Only host can mute remote users", code: "forbidden" } });
        return;
      }
      await ctx.sendToUser(payload.targetUserId, {
        type: "user_muted",
        payload: {
          roomId: payload.roomId,
          targetUserId: payload.targetUserId,
          kind: payload.kind,
          muted: payload.muted,
          byUserId: userId,
        },
      });
      break;
    }

    case "end_room": {
      const { roomId } = message.payload as EndRoomPayload;
      if (!roomId) {
        ctx.send(ws, { type: "error", payload: { message: "roomId is required" } });
        return;
      }
      if (!canModerate(ctx.roomRoles.get(roomId, userId))) {
        ctx.send(ws, { type: "error", payload: { message: "Only host can end the room", code: "forbidden" } });
        return;
      }
      const members = await ctx.rooms.getMembers(roomId);
      for (const memberId of members) {
        if (memberId !== userId) {
          await ctx.forceLeaveRoom(roomId, memberId, "room_ended");
        }
      }
      await ctx.forceLeaveRoom(roomId, userId, "room_ended");
      ctx.roomRoles.clearRoom(roomId);
      ctx.dispatch("room.ended", { roomId, byUserId: userId });
      break;
    }

    case "recording_ready": {
      const payload = message.payload as RecordingReadyPayload;
      if (!(await requireFeature(ctx, "recording"))) return;
      if (!payload.roomId || payload.durationMs == null || !payload.mimeType) {
        ctx.send(ctx.ws, { type: "error", payload: { message: "Invalid recording payload" } });
        return;
      }
      const saved = await saveRecording(ctx.claims.appId, userId, payload);
      ctx.send(ctx.ws, {
        type: "recording_ack",
        payload: {
          recordingId: saved.id,
          roomId: payload.roomId,
          callId: payload.callId,
        },
        requestId: message.requestId,
      });
      ctx.dispatch("recording.ready", { ...payload, userId, recordingId: saved.id });
      await maybeDispatchBillingAlert(ctx.claims.appId, (type, p) => ctx.dispatch(type, p));
      break;
    }

    case "call_quality_report": {
      const payload = message.payload as CallQualityReportPayload;
      if (!payload.roomId || payload.qualityScore == null || !payload.qualityLabel || !payload.metrics) {
        ctx.send(ctx.ws, { type: "error", payload: { message: "Invalid quality report" } });
        return;
      }
      await saveQualityReport(ctx.claims.appId, userId, payload);
      ctx.dispatch("call.quality.report", { ...payload, userId });
      if (payload.qualityLabel === "poor") {
        ctx.dispatch("call.quality.degraded", { ...payload, userId });
      }
      await maybeDispatchBillingAlert(ctx.claims.appId, (type, p) => ctx.dispatch(type, p));
      break;
    }

    default:
      ctx.send(ws, { type: "error", payload: { message: "Unknown message type" } });
  }
}
