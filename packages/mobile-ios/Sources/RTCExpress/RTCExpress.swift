import Foundation
import WebRTC

public protocol RTCExpressDelegate: AnyObject {
    func rtcExpress(_ rtc: RTCExpress, didConnect userId: String)
    func rtcExpressDidDisconnect(_ rtc: RTCExpress)
    func rtcExpress(_ rtc: RTCExpress, didJoinRoom roomId: String, members: [String])
    func rtcExpress(_ rtc: RTCExpress, didReceive message: RoomMessage)
    func rtcExpress(_ rtc: RTCExpress, didReceive invite: CallInvite)
    func rtcExpress(_ rtc: RTCExpress, callState: CallStateUpdate)
    func rtcExpress(_ rtc: RTCExpress, remoteVideoTrack: RTCVideoTrack)
    func rtcExpress(_ rtc: RTCExpress, didJoinVoiceRoom roomId: String)
    func rtcExpress(_ rtc: RTCExpress, didLeaveVoiceRoom roomId: String)
    func rtcExpress(_ rtc: RTCExpress, didJoinVideoRoom roomId: String)
    func rtcExpress(_ rtc: RTCExpress, didLeaveVideoRoom roomId: String)
    func rtcExpressDidStartRecording(_ rtc: RTCExpress)
    func rtcExpress(_ rtc: RTCExpress, didStopRecording result: RecordingResult)
    func rtcExpress(_ rtc: RTCExpress, didError message: String)
}

public extension RTCExpressDelegate {
    func rtcExpress(_ rtc: RTCExpress, didConnect userId: String) {}
    func rtcExpressDidDisconnect(_ rtc: RTCExpress) {}
    func rtcExpress(_ rtc: RTCExpress, didJoinRoom roomId: String, members: [String]) {}
    func rtcExpress(_ rtc: RTCExpress, didReceive message: RoomMessage) {}
    func rtcExpress(_ rtc: RTCExpress, didReceive invite: CallInvite) {}
    func rtcExpress(_ rtc: RTCExpress, callState: CallStateUpdate) {}
    func rtcExpress(_ rtc: RTCExpress, remoteVideoTrack: RTCVideoTrack) {}
    func rtcExpress(_ rtc: RTCExpress, didJoinVoiceRoom roomId: String) {}
    func rtcExpress(_ rtc: RTCExpress, didLeaveVoiceRoom roomId: String) {}
    func rtcExpress(_ rtc: RTCExpress, didJoinVideoRoom roomId: String) {}
    func rtcExpress(_ rtc: RTCExpress, didLeaveVideoRoom roomId: String) {}
    func rtcExpressDidStartRecording(_ rtc: RTCExpress) {}
    func rtcExpress(_ rtc: RTCExpress, didStopRecording result: RecordingResult) {}
    func rtcExpress(_ rtc: RTCExpress, didError message: String) {}
}

public final class RTCExpress: SignalingListener {
    public weak var delegate: RTCExpressDelegate?
    public weak var incomingCallNotifier: IncomingCallNotifier?

    private let signaling = SignalingClient()
    private let callRecorder = CallRecorder()
    private var p2p: P2pMediaEngine?
    private var sfu: SfuMediaEngine?

    private var serverUrl = ""
    private var appId = ""
    private var token = ""
    private var userId = ""
    private var roomId: String?
    private var mediaModePref = "p2p"
    private var sfuUrl: String?
    private var inVoiceRoom = false
    private var inVideoRoom = false

    private struct ActiveCall {
        let callId: String
        let peerUserId: String
        let roomId: String
        let isCaller: Bool
        let callType: String
    }

    private var activeCall: ActiveCall?

    public init() {
        signaling.listener = self
    }

    public func initClient(_ options: RTCInitOptions) {
        serverUrl = options.serverUrl.trimmingCharacters(in: .init(charactersIn: "/"))
        appId = options.appId
        userId = options.userId
        token = options.token
        mediaModePref = options.mediaMode
        signaling.connect(serverUrl: serverUrl, token: options.token)
        Task {
            if let config = try? await PlatformApi.fetchPlatformConfig(serverUrl: serverUrl, appId: appId) {
                sfuUrl = config.sfuUrl
            }
        }
    }

    public func joinRoom(_ roomId: String) {
        self.roomId = roomId
        try? signaling.send(type: "join_room", payload: ["roomId": roomId])
    }

    public func sendMessage(_ text: String) throws {
        guard let roomId else { throw NSError(domain: "RTCExpress", code: 3) }
        try signaling.send(type: "send_message", payload: ["roomId": roomId, "text": text])
    }

    public func getMessageHistory(_ roomId: String, before: String? = nil, limit: Int = 50) async throws -> MessageHistoryPage {
        try await PlatformApi.getMessageHistory(serverUrl: serverUrl, token: token, roomId: roomId, before: before, limit: limit)
    }

    public func joinVoiceRoom() async throws {
        guard let roomId else { throw NSError(domain: "RTCExpress", code: 3) }
        guard let sfuUrl else { throw NSError(domain: "RTCExpress", code: 32, userInfo: [NSLocalizedDescriptionKey: "SFU not available"]) }
        if sfu == nil {
            sfu = SfuMediaEngine(
                sfuUrl: sfuUrl,
                userId: userId,
                authToken: token,
                sendSignaling: { [weak self] type, payload in
                    try self?.signaling.send(type: type, payload: payload)
                },
                onRemoteVideo: { [weak self] track in
                    guard let self else { return }
                    self.delegate?.rtcExpress(self, remoteVideoTrack: track)
                }
            )
        }
        try await sfu?.joinRoom(roomId: roomId, options: SfuJoinOptions(audio: true, video: false, announceToRoom: true))
        inVoiceRoom = true
        try signaling.send(type: "join_media", payload: ["roomId": roomId, "kind": "voice"])
        delegate?.rtcExpress(self, didJoinVoiceRoom: roomId)
    }

    public func leaveVoiceRoom() throws {
        guard inVoiceRoom else { return }
        let room = roomId
        if !inVideoRoom {
            sfu?.destroy()
            sfu = nil
        }
        inVoiceRoom = false
        if let room, !inVideoRoom {
            try signaling.send(type: "leave_media", payload: ["roomId": room, "kind": "voice"])
            delegate?.rtcExpress(self, didLeaveVoiceRoom: room)
        }
    }

    public func joinVideoRoom() async throws {
        guard let roomId else { throw NSError(domain: "RTCExpress", code: 3) }
        guard let sfuUrl else { throw NSError(domain: "RTCExpress", code: 32) }
        if sfu == nil {
            sfu = SfuMediaEngine(
                sfuUrl: sfuUrl,
                userId: userId,
                authToken: token,
                sendSignaling: { [weak self] type, payload in
                    try self?.signaling.send(type: type, payload: payload)
                },
                onRemoteVideo: { [weak self] track in
                    guard let self else { return }
                    self.delegate?.rtcExpress(self, remoteVideoTrack: track)
                }
            )
        }
        try await sfu?.joinRoom(roomId: roomId, options: SfuJoinOptions(audio: true, video: true, announceToRoom: true))
        inVoiceRoom = true
        inVideoRoom = true
        try signaling.send(type: "join_media", payload: ["roomId": roomId, "kind": "video"])
        delegate?.rtcExpress(self, didJoinVideoRoom: roomId)
    }

    public func leaveVideoRoom() throws {
        guard inVideoRoom else { return }
        let room = roomId
        sfu?.destroy()
        sfu = nil
        inVideoRoom = false
        inVoiceRoom = false
        if let room {
            try signaling.send(type: "leave_media", payload: ["roomId": room, "kind": "video"])
            delegate?.rtcExpress(self, didLeaveVideoRoom: room)
        }
    }

    public func callUser(_ peerUserId: String, video: Bool = false) throws {
        guard let roomId else { throw NSError(domain: "RTCExpress", code: 3) }
        if activeCall != nil { throw NSError(domain: "RTCExpress", code: 5, userInfo: [NSLocalizedDescriptionKey: "Already in a call"]) }
        let callId = UUID().uuidString
        let callType = video ? "video" : "voice"
        activeCall = ActiveCall(callId: callId, peerUserId: peerUserId, roomId: roomId, isCaller: true, callType: callType)
        if resolvedMediaMode() != "sfu" { ensureP2p(video: video) }
        try signaling.send(type: "call_invite", payload: [
            "roomId": roomId, "toUserId": peerUserId, "callId": callId, "callType": callType
        ])
        emitCallState("ringing")
    }

    public func acceptCall() throws {
        guard let call = activeCall else { throw NSError(domain: "RTCExpress", code: 4) }
        try signaling.send(type: "call_accept", payload: callPayload(call))
        if resolvedMediaMode() == "sfu" {
            Task { try? await startSfuCall(call) }
        } else {
            ensureP2p(video: call.callType == "video")
        }
        emitCallState("connecting")
    }

    public func rejectCall() throws {
        guard let call = activeCall else { return }
        try signaling.send(type: "call_reject", payload: callPayload(call))
        cleanupCall("rejected")
    }

    public func endCall() throws {
        guard let call = activeCall else { return }
        try signaling.send(type: "call_end", payload: callPayload(call))
        cleanupCall("ended")
    }

    public func startRecording() throws {
        if activeCall == nil && !inVoiceRoom && !inVideoRoom {
            throw NSError(domain: "RTCExpress", code: 22, userInfo: [NSLocalizedDescriptionKey: "Join a call or media room before recording"])
        }
        _ = try callRecorder.startRecording()
        delegate?.rtcExpressDidStartRecording(self)
    }

    public func stopRecording() throws -> RecordingResult {
        let result = try callRecorder.stopRecording()
        delegate?.rtcExpress(self, didStopRecording: result)
        return result
    }

    public var isRecording: Bool { callRecorder.isRecording }

    public func muteMicrophone(_ muted: Bool) {
        if sfu != nil { sfu?.muteMicrophone(muted) } else { p2p?.muteMicrophone(muted) }
    }
    public func muteCamera(_ muted: Bool) {
        if sfu != nil { sfu?.muteCamera(muted) } else { p2p?.muteCamera(muted) }
    }
    public func switchCamera() {
        if sfu != nil { sfu?.switchCamera() } else { p2p?.switchCamera() }
    }

    public func destroy() {
        try? endCall()
        try? leaveVoiceRoom()
        try? leaveVideoRoom()
        signaling.close()
        p2p?.destroy()
        p2p = nil
    }

    func onConnected(userId: String) { delegate?.rtcExpress(self, didConnect: userId) }
    func onDisconnected() { delegate?.rtcExpressDidDisconnect(self) }
    func onRoomJoined(roomId: String, members: [String]) {
        delegate?.rtcExpress(self, didJoinRoom: roomId, members: members)
    }
    func onMessage(_ message: RoomMessage) { delegate?.rtcExpress(self, didReceive: message) }

    func onCallInvite(_ invite: CallInvite) {
        if activeCall != nil {
            try? signaling.send(type: "call_reject", payload: [
                "callId": invite.callId,
                "fromUserId": userId,
                "toUserId": invite.fromUserId,
                "roomId": invite.roomId,
                "callType": invite.callType
            ])
            return
        }
        activeCall = ActiveCall(callId: invite.callId, peerUserId: invite.fromUserId, roomId: invite.roomId, isCaller: false, callType: invite.callType)
        incomingCallNotifier?.onIncomingCall(invite, display: IncomingCallDisplay.from(invite))
        delegate?.rtcExpress(self, didReceive: invite)
        emitCallState("ringing")
    }

    func onCallAccept(_ payload: [String: Any]) {
        guard let call = activeCall else { return }
        if resolvedMediaMode() == "sfu" {
            Task {
                try? await startSfuCall(call)
                emitCallState("connected")
            }
            return
        }
        ensureP2p(video: call.callType == "video")
        p2p?.createOffer(peerUserId: call.peerUserId, callId: call.callId)
        emitCallState("connecting")
    }

    func onCallReject(_ payload: [String: Any]) { cleanupCall("rejected") }
    func onCallEnd(_ payload: [String: Any]) { cleanupCall("ended") }
    func onWebRtcOffer(_ payload: [String: Any]) {
        ensureP2p(video: activeCall?.callType == "video")
        p2p?.handleOffer(payload)
        emitCallState("connected")
    }
    func onWebRtcAnswer(_ payload: [String: Any]) {
        p2p?.handleAnswer(payload)
        emitCallState("connected")
    }
    func onIceCandidate(_ payload: [String: Any]) { p2p?.handleIceCandidate(payload) }
    func onSfuProducer(_ payload: [String: Any]) { sfu?.handleRemoteProducer(payload) }
    func onError(_ message: String, code: String?) {
        if code == "call_busy", activeCall?.isCaller == true { cleanupCall("rejected") }
        delegate?.rtcExpress(self, didError: message)
    }

    private func resolvedMediaMode() -> String {
        if mediaModePref == "p2p" { return "p2p" }
        if sfuUrl != nil { return "sfu" }
        return "p2p"
    }

    private func startSfuCall(_ call: ActiveCall) async throws {
        guard let sfuUrl else { throw NSError(domain: "RTCExpress", code: 32) }
        if sfu == nil {
            sfu = SfuMediaEngine(
                sfuUrl: sfuUrl,
                userId: userId,
                authToken: token,
                sendSignaling: { [weak self] type, payload in
                    try self?.signaling.send(type: type, payload: payload)
                },
                onRemoteVideo: { [weak self] track in
                    guard let self else { return }
                    self.delegate?.rtcExpress(self, remoteVideoTrack: track)
                }
            )
        }
        let sfuRoomId = "\(call.roomId)-call-\(call.callId)"
        try await sfu?.joinRoom(
            roomId: sfuRoomId,
            options: SfuJoinOptions(audio: true, video: call.callType == "video", targetUserId: call.peerUserId, callId: call.callId)
        )
    }

    private func ensureP2p(video: Bool) {
        if p2p == nil {
            p2p = P2pMediaEngine(
                userId: userId,
                sendSignaling: { [weak self] type, payload in try self?.signaling.send(type: type, payload: payload) },
                activeCall: { [weak self] in
                    guard let call = self?.activeCall else { return nil }
                    return (call.callId, call.peerUserId)
                }
            )
            p2p?.onRemoteVideoTrack = { [weak self] track in
                guard let self else { return }
                self.delegate?.rtcExpress(self, remoteVideoTrack: track)
            }
        }
        p2p?.prepare(video: video)
    }

    private func callPayload(_ call: ActiveCall) -> [String: Any] {
        ["callId": call.callId, "fromUserId": userId, "toUserId": call.peerUserId, "roomId": call.roomId, "callType": call.callType]
    }

    private func emitCallState(_ state: String) {
        guard let call = activeCall else { return }
        delegate?.rtcExpress(self, callState: CallStateUpdate(
            callId: call.callId, state: state, peerUserId: call.peerUserId, roomId: call.roomId, callType: call.callType
        ))
    }

    private func cleanupCall(_ state: String) {
        emitCallState(state)
        if !inVoiceRoom && !inVideoRoom {
            sfu?.destroy()
            sfu = nil
        }
        p2p?.destroy()
        p2p = nil
        activeCall = nil
    }
}
