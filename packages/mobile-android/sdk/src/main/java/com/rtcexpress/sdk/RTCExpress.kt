package com.rtcexpress.sdk

import android.content.Context
import org.json.JSONObject
import org.webrtc.VideoTrack

class RTCExpress(private val context: Context) : SignalingClient.Listener {
    interface Listener {
        fun onConnected(userId: String) {}
        fun onDisconnected() {}
        fun onRoomJoined(roomId: String, members: List<String>) {}
        fun onMessage(message: RoomMessage) {}
        fun onCallInvite(invite: CallInvite) {}
        fun onCallState(update: CallStateUpdate) {}
        fun onRemoteVideo(track: VideoTrack) {}
        fun onVoiceRoomJoined(roomId: String) {}
        fun onVoiceRoomLeft(roomId: String) {}
        fun onVideoRoomJoined(roomId: String) {}
        fun onVideoRoomLeft(roomId: String) {}
        fun onRecordingStarted() {}
        fun onRecordingStopped(result: RecordingResult) {}
        fun onError(message: String) {}
        fun onDiagnostics(message: String) {}
    }

    private val signaling = SignalingClient()
    private val tokenClient = TokenClient()
    private val configClient = ConfigClient()
    private val historyClient = HistoryClient()
    private val callRecorder = CallRecorder(context)
    private var p2p: P2pMediaEngine? = null
    private var sfu: SfuMediaEngine? = null

    private var serverUrl = ""
    private var appId = ""
    private var token = ""
    private var userId = ""
    private var roomId: String? = null
    private var listener: Listener? = null
    private var incomingCallNotifier: IncomingCallNotifier? = null

    private var mediaModePref = "p2p"
    private var sfuUrl: String? = null
    private var iceServers = listOf(org.webrtc.PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer())
    private var inVoiceRoom = false
    private var inVideoRoom = false

    private var activeCall: ActiveCall? = null
    private var signalingReady = false
    private var pendingJoinRoomId: String? = null

    private data class ActiveCall(
        val callId: String,
        val peerUserId: String,
        val roomId: String,
        val isCaller: Boolean,
        val callType: String
    )

    fun setListener(listener: Listener?) {
        this.listener = listener
    }

    fun setIncomingCallNotifier(notifier: IncomingCallNotifier?) {
        this.incomingCallNotifier = notifier
    }

    fun init(options: RTCInitOptions) {
        serverUrl = options.serverUrl.trimEnd('/')
        appId = options.appId
        userId = options.userId
        token = options.token
        runCatching { configClient.fetchIceServers(serverUrl, token) }
            .onSuccess { if (it.isNotEmpty()) iceServers = it }
        mediaModePref = options.mediaMode
        signalingReady = false
        signaling.listener = this
        signaling.connect(serverUrl, options.token)
        runCatching {
            val config = configClient.fetchPlatformConfig(serverUrl, appId)
            sfuUrl = config.sfuUrl
        }
    }

    fun joinRoom(roomId: String) {
        this.roomId = roomId
        pendingJoinRoomId = roomId
        flushJoinRoom()
    }

    private fun flushJoinRoom() {
        val id = pendingJoinRoomId ?: return
        if (!signalingReady) return
        signaling.send("join_room", JSONObject().put("roomId", id))
    }

    fun sendMessage(text: String, clientMsgId: String = "") {
        val room = roomId ?: throw IllegalStateException("Join a room first")
        signaling.send(
            "send_message",
            JSONObject().put("roomId", room).put("text", text).apply {
                if (clientMsgId.isNotBlank()) put("clientMsgId", clientMsgId)
            }
        )
    }

    fun getMessageHistory(roomId: String, before: String? = null, limit: Int = 50): MessageHistoryPage {
        return historyClient.getMessageHistory(serverUrl, token, roomId, before, limit)
    }

    fun joinVoiceRoom() {
        val room = roomId ?: throw IllegalStateException("Join a room first")
        val url = sfuUrl ?: throw IllegalStateException("SFU not available")
        if (sfu == null) {
            sfu = SfuMediaEngine(
                context = context,
                sfuUrl = url,
                userId = userId,
                authToken = token,
                sendSignaling = { type, payload -> signaling.send(type, payload) },
                onRemoteVideo = { track -> listener?.onRemoteVideo(track) }
            )
        }
        sfu?.joinRoom(room, SfuJoinOptions(audio = true, video = false, announceToRoom = true))
        inVoiceRoom = true
        signaling.send("join_media", JSONObject().put("roomId", room).put("kind", "voice"))
        listener?.onVoiceRoomJoined(room)
    }

    fun leaveVoiceRoom() {
        if (!inVoiceRoom) return
        val room = roomId
        if (!inVideoRoom) {
            sfu?.destroy()
            sfu = null
        }
        inVoiceRoom = false
        if (room != null && !inVideoRoom) {
            signaling.send("leave_media", JSONObject().put("roomId", room).put("kind", "voice"))
            listener?.onVoiceRoomLeft(room)
        }
    }

    fun joinVideoRoom() {
        val room = roomId ?: throw IllegalStateException("Join a room first")
        val url = sfuUrl ?: throw IllegalStateException("SFU not available")
        if (sfu == null) {
            sfu = SfuMediaEngine(
                context = context,
                sfuUrl = url,
                userId = userId,
                authToken = token,
                sendSignaling = { type, payload -> signaling.send(type, payload) },
                onRemoteVideo = { track -> listener?.onRemoteVideo(track) }
            )
        }
        sfu?.joinRoom(room, SfuJoinOptions(audio = true, video = true, announceToRoom = true))
        inVoiceRoom = true
        inVideoRoom = true
        signaling.send("join_media", JSONObject().put("roomId", room).put("kind", "video"))
        listener?.onVideoRoomJoined(room)
    }

    fun leaveVideoRoom() {
        if (!inVideoRoom) return
        val room = roomId
        sfu?.destroy()
        sfu = null
        inVideoRoom = false
        inVoiceRoom = false
        if (room != null) {
            signaling.send("leave_media", JSONObject().put("roomId", room).put("kind", "video"))
            listener?.onVideoRoomLeft(room)
        }
    }

    fun callUser(peerUserId: String, video: Boolean = false) {
        val room = roomId ?: throw IllegalStateException("Join a room first")
        if (activeCall != null) throw IllegalStateException("Already in a call")
        val callId = JsonUtil.newCallId()
        val callType = if (video) "video" else "voice"
        activeCall = ActiveCall(callId, peerUserId, room, true, callType)
        if (resolvedMediaMode() == "sfu") {
            signaling.send(
                "call_invite",
                JSONObject()
                    .put("roomId", room)
                    .put("toUserId", peerUserId)
                    .put("callId", callId)
                    .put("callType", callType)
            )
            emitCallState("ringing", peerUserId, room, callId, callType)
            return
        }
        ensureP2p(video)
        signaling.send(
            "call_invite",
            JSONObject()
                .put("roomId", room)
                .put("toUserId", peerUserId)
                .put("callId", callId)
                .put("callType", callType)
        )
        emitCallState("ringing", peerUserId, room, callId, callType)
    }

    fun acceptCall() {
        val call = activeCall ?: throw IllegalStateException("No incoming call")
        signaling.send("call_accept", callPayload(call, call.peerUserId))
        if (resolvedMediaMode() == "sfu") {
            startSfuCall(call)
        } else {
            ensureP2p(call.callType == "video")
        }
        emitCallState("connecting", call.peerUserId, call.roomId, call.callId, call.callType)
    }

    fun rejectCall() {
        val call = activeCall ?: return
        signaling.send("call_reject", callPayload(call, call.peerUserId))
        cleanupCall("rejected")
    }

    fun endCall() {
        val call = activeCall ?: return
        signaling.send("call_end", callPayload(call, call.peerUserId))
        cleanupCall("ended")
    }

    fun startRecording() {
        if (activeCall == null && !inVoiceRoom && !inVideoRoom) {
            throw IllegalStateException("Join a call or media room before recording")
        }
        callRecorder.startRecording()
        listener?.onRecordingStarted()
    }

    fun stopRecording(): RecordingResult {
        val result = callRecorder.stopRecording()
        listener?.onRecordingStopped(result)
        return result
    }

    fun isRecording() = callRecorder.isRecording

    fun muteMicrophone(muted: Boolean) {
        sfu?.muteMicrophone(muted) ?: p2p?.muteMicrophone(muted)
    }

    fun muteCamera(muted: Boolean) {
        sfu?.muteCamera(muted) ?: p2p?.muteCamera(muted)
    }

    fun switchCamera() {
        sfu?.switchCamera() ?: p2p?.switchCamera()
    }

    fun destroy() {
        endCall()
        leaveVoiceRoom()
        leaveVideoRoom()
        signaling.listener = null
        signaling.close()
        p2p?.destroy()
        p2p = null
    }

    companion object {
        fun fetchToken(serverUrl: String, request: TokenRequest): TokenResponse {
            return TokenClient().fetchToken(serverUrl, request)
        }
    }

    override fun onConnected(userId: String) {
        signalingReady = true
        flushJoinRoom()
        listener?.onConnected(userId)
    }

    override fun onDisconnected() {
        signalingReady = false
        cleanupCall("ended")
        listener?.onDisconnected()
    }

    override fun onRoomJoined(roomId: String, members: List<String>) {
        listener?.onRoomJoined(roomId, members)
    }

    override fun onUserJoined(roomId: String, userId: String) {
        // Presence updates are surfaced via onRoomJoined for now.
    }

    override fun onUserLeft(roomId: String, userId: String) {
        // No-op — room membership is refreshed on the next join.
    }

    override fun onMessage(message: RoomMessage) {
        listener?.onMessage(message)
    }

    override fun onCallInvite(invite: CallInvite) {
        if (activeCall != null) {
            signaling.send(
                "call_reject",
                JSONObject()
                    .put("callId", invite.callId)
                    .put("fromUserId", userId)
                    .put("toUserId", invite.fromUserId)
                    .put("roomId", invite.roomId)
                    .put("callType", invite.callType)
            )
            return
        }
        activeCall = ActiveCall(
            invite.callId,
            invite.fromUserId,
            invite.roomId,
            false,
            invite.callType
        )
        incomingCallNotifier?.onIncomingCall(invite, IncomingCallDisplay.from(invite))
        listener?.onCallInvite(invite)
        emitCallState("ringing", invite.fromUserId, invite.roomId, invite.callId, invite.callType)
    }

    override fun onCallAccept(payload: JSONObject) {
        val call = activeCall ?: return
        if (resolvedMediaMode() == "sfu") {
            startSfuCall(call)
            emitCallState("connected", call.peerUserId, call.roomId, call.callId, call.callType)
            return
        }
        ensureP2p(call.callType == "video")
        p2p?.createOffer(call.peerUserId, call.callId)
        emitCallState("connecting", call.peerUserId, call.roomId, call.callId, call.callType)
    }

    override fun onCallReject(payload: JSONObject) {
        cleanupCall("rejected")
    }

    override fun onCallEnd(payload: JSONObject) {
        cleanupCall("ended")
    }

    override fun onWebRtcOffer(payload: JSONObject) {
        val call = activeCall ?: return
        if (payload.optString("callId") != call.callId) return
        ensureP2p(activeCall?.callType == "video")
        p2p?.handleOffer(payload)
    }

    override fun onWebRtcAnswer(payload: JSONObject) {
        val call = activeCall ?: return
        if (payload.optString("callId") != call.callId) return
        p2p?.handleAnswer(payload)
    }

    override fun onWebRtcIceCandidate(payload: JSONObject) {
        p2p?.handleIceCandidate(payload)
    }

    override fun onSfuProducer(payload: JSONObject) {
        sfu?.handleRemoteProducer(payload)
    }

    override fun onError(message: String, code: String?) {
        if (code in listOf("call_busy", "user_offline") && activeCall?.isCaller == true) {
            cleanupCall("rejected")
        }
        listener?.onError(message)
    }

    private fun resolvedMediaMode(): String {
        if (mediaModePref == "p2p") return "p2p"
        if (mediaModePref == "sfu" && !sfuUrl.isNullOrBlank()) return "sfu"
        if (mediaModePref == "auto" && !sfuUrl.isNullOrBlank()) return "sfu"
        return "p2p"
    }

    private fun startSfuCall(call: ActiveCall) {
        val url = sfuUrl ?: throw IllegalStateException("SFU not available")
        if (sfu == null) {
            sfu = SfuMediaEngine(
                context = context,
                sfuUrl = url,
                userId = userId,
                authToken = token,
                sendSignaling = { type, payload -> signaling.send(type, payload) },
                onRemoteVideo = { track -> listener?.onRemoteVideo(track) }
            )
        }
        val sfuRoomId = "${call.roomId}-call-${call.callId}"
        sfu?.joinRoom(
            sfuRoomId,
            SfuJoinOptions(
                audio = true,
                video = call.callType == "video",
                targetUserId = call.peerUserId,
                callId = call.callId
            )
        )
    }

    private fun ensureP2p(video: Boolean) {
        WebRtcPeerFactory.warmUp(context)
        if (p2p == null) {
            p2p = P2pMediaEngine(
                context = context,
                userId = userId,
                iceServers = iceServers,
                sendSignaling = { type, payload -> signaling.send(type, payload) },
                activeCall = {
                    activeCall?.let { it.callId to it.peerUserId }
                }
            ).also {
                it.onRemoteVideoTrack = { track -> listener?.onRemoteVideo(track) }
                it.onDiagnostics = { message -> listener?.onDiagnostics(message) }
                it.onConnectionState = { state ->
                    activeCall?.let { call ->
                        if (state == "failed") {
                            endCall()
                            listener?.onError("Media connection failed. Try another network.")
                        } else emitCallState(state, call.peerUserId, call.roomId, call.callId, call.callType)
                    }
                }
                it.onError = { message ->
                    endCall()
                    listener?.onError(message)
                }
            }
        }
        p2p?.prepare(video)
    }

    private fun callPayload(call: ActiveCall, toUserId: String): JSONObject {
        return JSONObject()
            .put("callId", call.callId)
            .put("fromUserId", userId)
            .put("toUserId", toUserId)
            .put("roomId", call.roomId)
            .put("callType", call.callType)
    }

    private fun emitCallState(state: String, peerUserId: String, roomId: String, callId: String, callType: String) {
        listener?.onCallState(CallStateUpdate(callId, state, peerUserId, roomId, callType))
    }

    private fun cleanupCall(state: String) {
        val call = activeCall ?: return
        emitCallState(state, call.peerUserId, call.roomId, call.callId, call.callType)
        if (!inVoiceRoom && !inVideoRoom) {
            sfu?.destroy()
            sfu = null
        }
        p2p?.destroy()
        p2p = null
        activeCall = null
    }
}
