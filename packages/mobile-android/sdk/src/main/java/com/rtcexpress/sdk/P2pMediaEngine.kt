package com.rtcexpress.sdk

import android.content.Context
import android.media.AudioManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioDeviceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

class P2pMediaEngine(
    private val context: Context,
    private val userId: String,
    private val iceServers: List<PeerConnection.IceServer>,
    private val sendSignaling: (String, JSONObject) -> Unit,
    private val activeCall: () -> Pair<String, String>?
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val eglBase: EglBase
    private val factory: PeerConnectionFactory
    private var peerConnection: PeerConnection? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var videoCapturer: VideoCapturer? = null
    private var textureHelper: SurfaceTextureHelper? = null
    private val pendingIce = mutableListOf<IceCandidate>()
    private var remoteDescriptionReady = false
    private var video = false
    private var usingFrontCamera = true
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var previousMode = AudioManager.MODE_NORMAL
    private var previousSpeaker = false
    private var focus: AudioFocusRequest? = null
    private var destroyed = false
    private var connected = false

    var onRemoteVideoTrack: ((VideoTrack) -> Unit)? = null
    var onConnectionState: ((String) -> Unit)? = null
    var onError: ((String) -> Unit)? = null
    var onDiagnostics: ((String) -> Unit)? = null

    init {
        WebRtcPeerFactory.warmUp(context)
        eglBase = WebRtcPeerFactory.egl()
        factory = WebRtcPeerFactory.factory()
    }

    fun prepare(enableVideo: Boolean) {
        mainHandler.post {
            prepareOnMain(enableVideo)
        }
    }

    private fun prepareOnMain(enableVideo: Boolean) {
        if (destroyed) return
        video = enableVideo
        if (peerConnection != null) return

        previousMode = audioManager.mode
        previousSpeaker = audioManager.isSpeakerphoneOn
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        if (Build.VERSION.SDK_INT >= 31) {
            audioManager.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                ?.let { audioManager.setCommunicationDevice(it) }
        } else audioManager.isSpeakerphoneOn = true
        if (Build.VERSION.SDK_INT >= 26) {
            focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setOnAudioFocusChangeListener { }.build()
            audioManager.requestAudioFocus(focus!!)
        }
        val configuration = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        peerConnection = factory.createPeerConnection(
            configuration,
            object : PeerConnection.Observer {
                override fun onIceCandidate(candidate: IceCandidate) {
                    val call = activeCall() ?: return
                    val payload = JSONObject()
                        .put("callId", call.first)
                        .put("fromUserId", userId)
                        .put("toUserId", call.second)
                        .put(
                            "candidate",
                            JSONObject()
                                .put("candidate", candidate.sdp)
                                .put("sdpMid", candidate.sdpMid)
                                .put("sdpMLineIndex", candidate.sdpMLineIndex)
                        )
                    sendSignaling("ice_candidate", payload)
                }

                override fun onAddTrack(receiver: org.webrtc.RtpReceiver?, streams: Array<out org.webrtc.MediaStream>?) {
                    receiveTrack(receiver?.track())
                }
                override fun onTrack(transceiver: org.webrtc.RtpTransceiver?) {
                    receiveTrack(transceiver?.receiver?.track())
                }

                override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                    when (state) {
                        PeerConnection.IceConnectionState.CONNECTED, PeerConnection.IceConnectionState.COMPLETED -> {
                            connected = true
                            onConnectionState?.invoke("connected")
                        }
                        PeerConnection.IceConnectionState.FAILED -> onConnectionState?.invoke("failed")
                        else -> Unit
                    }
                }
                override fun onIceConnectionReceivingChange(receiving: Boolean) {}
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
                override fun onAddStream(stream: org.webrtc.MediaStream?) {}
                override fun onRemoveStream(stream: org.webrtc.MediaStream?) {}
                override fun onDataChannel(channel: org.webrtc.DataChannel?) {}
                override fun onRenegotiationNeeded() {}
                override fun onRemoveTrack(receiver: org.webrtc.RtpReceiver?) {}
            }
        )

        val audioConstraints = MediaConstraints()
        audioSource = factory.createAudioSource(audioConstraints)
        audioTrack = factory.createAudioTrack("audio0", audioSource)
        checkNotNull(peerConnection) { "Could not create media connection" }
        audioTrack?.setEnabled(true)
        peerConnection?.addTrack(audioTrack, listOf("rtc-stream"))

        if (enableVideo) {
            startCamera()
            videoTrack?.let { peerConnection?.addTrack(it, listOf("rtc-stream")) }
        }
        reportStats()
    }

    private fun receiveTrack(track: org.webrtc.MediaStreamTrack?) {
        mainHandler.post {
            if (destroyed) return@post
            track?.setEnabled(true)
            if (track is org.webrtc.AudioTrack) track.setVolume(1.0)
            if (track is VideoTrack) {
                CallVideoTracks.update(false, track)
                onRemoteVideoTrack?.invoke(track)
            }
        }
    }

    private fun reportStats() {
        if (destroyed) return
        peerConnection?.getStats { report ->
            val totals = mutableMapOf<String, Long>()
            report.statsMap.values.forEach { stat ->
                if (stat.type == "inbound-rtp" || stat.type == "outbound-rtp") {
                    val kind = stat.members["kind"] ?: stat.members["mediaType"]
                    val direction = if (stat.type == "inbound-rtp") "received" else "sent"
                    val key = if (direction == "received") "bytesReceived" else "bytesSent"
                    totals["$kind $direction"] = (stat.members[key] as? Number)?.toLong() ?: 0L
                }
            }
            onDiagnostics?.invoke(totals.entries.joinToString(" | ") { "${it.key}: ${it.value / 1024} KB" })
        }
        mainHandler.postDelayed({ reportStats() }, 2000)
    }

    fun createOffer(peerUserId: String, callId: String) {
        mainHandler.post {
            mainHandler.postDelayed({ if (!destroyed && !connected) onError?.invoke("Media connection timed out. No audio/video path was established.") }, 30000)
            prepareOnMain(video)
            peerConnection?.createOffer(object : SimpleSdpObserver("offer") {
                override fun onCreateSuccess(description: SessionDescription) {
                    val payload = JSONObject()
                        .put("callId", callId)
                        .put("fromUserId", userId)
                        .put("toUserId", peerUserId)
                        .put("sdp", JSONObject().put("type", description.type.canonicalForm()).put("sdp", description.description))
                    peerConnection?.setLocalDescription(object : SimpleSdpObserver("local-offer") {
                        override fun onSetSuccess() { sendSignaling("webrtc_offer", payload) }
                    }, description)
                }
            }, MediaConstraints())
        }
    }

    fun handleOffer(payload: JSONObject) {
        mainHandler.post {
            prepareOnMain(video)
            val sdp = payload.getJSONObject("sdp")
            val remote = SessionDescription(SessionDescription.Type.OFFER, sdp.getString("sdp"))
            peerConnection?.setRemoteDescription(object : SimpleSdpObserver("remote-offer") {
                override fun onSetSuccess() {
                    mainHandler.post {
                        flushIce()
                        createAnswer(payload)
                    }
                }
            }, remote)
        }
    }

    private fun createAnswer(payload: JSONObject) {
            peerConnection?.createAnswer(object : SimpleSdpObserver("answer") {
                override fun onCreateSuccess(description: SessionDescription) {
                    val answer = JSONObject()
                        .put("callId", payload.getString("callId"))
                        .put("fromUserId", userId)
                        .put("toUserId", payload.getString("fromUserId"))
                        .put("sdp", JSONObject().put("type", description.type.canonicalForm()).put("sdp", description.description))
                    peerConnection?.setLocalDescription(object : SimpleSdpObserver("local-answer") {
                        override fun onSetSuccess() { sendSignaling("webrtc_answer", answer) }
                    }, description)
                }
            }, MediaConstraints())
    }

    fun handleAnswer(payload: JSONObject) {
        mainHandler.post {
            val sdp = payload.getJSONObject("sdp")
            val remote = SessionDescription(SessionDescription.Type.ANSWER, sdp.getString("sdp"))
            peerConnection?.setRemoteDescription(object : SimpleSdpObserver("remote-answer") {
                override fun onSetSuccess() { mainHandler.post { flushIce() } }
            }, remote)
        }
    }

    fun handleIceCandidate(payload: JSONObject) {
        mainHandler.post {
            val candidate = payload.getJSONObject("candidate")
            val ice = IceCandidate(
                candidate.optString("sdpMid"),
                candidate.optInt("sdpMLineIndex"),
                candidate.getString("candidate")
            )
            if (remoteDescriptionReady) peerConnection?.addIceCandidate(ice) else pendingIce.add(ice)
        }
    }

    private fun flushIce() {
        remoteDescriptionReady = true
        pendingIce.forEach { peerConnection?.addIceCandidate(it) }
        pendingIce.clear()
    }

    fun attachLocalVideo(renderer: SurfaceViewRenderer) {
        renderer.init(eglBase.eglBaseContext, null)
        renderer.setMirror(usingFrontCamera)
        videoTrack?.addSink(renderer)
    }

    fun attachRemoteVideo(track: VideoTrack, renderer: SurfaceViewRenderer) {
        renderer.init(eglBase.eglBaseContext, null)
        track.addSink(renderer)
    }

    fun switchCamera() {
        if (!video) return
        (videoCapturer as? org.webrtc.CameraVideoCapturer)?.switchCamera(null)
        usingFrontCamera = !usingFrontCamera
    }

    fun muteMicrophone(muted: Boolean) {
        audioTrack?.setEnabled(!muted)
    }

    fun muteCamera(muted: Boolean) {
        videoTrack?.setEnabled(!muted)
    }

    fun destroy() {
        mainHandler.post {
            destroyed = true
            mainHandler.removeCallbacksAndMessages(null)
            CallVideoTracks.update(true, null)
            CallVideoTracks.update(false, null)
            pendingIce.clear()
            remoteDescriptionReady = false
            peerConnection?.close()
            peerConnection?.dispose()
            peerConnection = null
            runCatching { videoCapturer?.stopCapture() }
            videoCapturer?.dispose()
            videoCapturer = null
            textureHelper?.dispose()
            textureHelper = null
            videoTrack?.dispose()
            videoTrack = null
            videoSource?.dispose()
            videoSource = null
            audioTrack?.dispose()
            audioTrack = null
            audioSource?.dispose()
            audioSource = null
            if (Build.VERSION.SDK_INT >= 26) focus?.let { audioManager.abandonAudioFocusRequest(it) }
            if (Build.VERSION.SDK_INT >= 31) audioManager.clearCommunicationDevice()
            else audioManager.isSpeakerphoneOn = previousSpeaker
            audioManager.mode = previousMode
        }
    }

    private fun startCamera() {
        val enumerator = Camera2Enumerator(context)
        val device = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) }
            ?: enumerator.deviceNames.firstOrNull()
            ?: return
        videoCapturer = enumerator.createCapturer(device, null) ?: return
        val helper = SurfaceTextureHelper.create("capture", eglBase.eglBaseContext)
        textureHelper = helper
        videoSource = factory.createVideoSource(videoCapturer!!.isScreencast)
        videoCapturer!!.initialize(helper, context, videoSource!!.capturerObserver)
        videoCapturer!!.startCapture(640, 480, 24)
        videoTrack = factory.createVideoTrack("video0", videoSource)
        CallVideoTracks.update(true, videoTrack)
    }

    private open inner class SimpleSdpObserver(private val label: String) : org.webrtc.SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String) { onError?.invoke("$label: $error") }
        override fun onSetFailure(error: String) { onError?.invoke("$label: $error") }
    }
}
