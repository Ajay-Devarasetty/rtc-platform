package com.rtcexpress.sdk

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.mediasoup.droid.Consumer
import org.mediasoup.droid.Device
import org.mediasoup.droid.MediasoupClient
import org.mediasoup.droid.Producer
import org.mediasoup.droid.RecvTransport
import org.mediasoup.droid.SendTransport
import org.mediasoup.droid.Transport
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnectionFactory
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

class SfuMediaEngine(
    private val context: Context,
    private val sfuUrl: String,
    private val userId: String,
    private val authToken: String,
    private val sendSignaling: (String, JSONObject) -> Unit,
    private val onRemoteVideo: (VideoTrack) -> Unit
) {
    private val http = OkHttpClient()
    private val eglBase = EglBase.create()
    private val factory: PeerConnectionFactory
    private var device: Device? = null
    private var sendTransport: SendTransport? = null
    private var recvTransport: RecvTransport? = null
    private var roomId: String? = null
    private var audioTrack: AudioTrack? = null
    private var videoTrack: VideoTrack? = null
    private var videoCapturer: VideoCapturer? = null
    private var micProducer: Producer? = null
    private var camProducer: Producer? = null
    private val consumers = mutableMapOf<String, Consumer>()
    private var usingFrontCamera = true

    init {
        MediasoupClient.initialize(context)
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .createInitializationOptions()
        )
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
    }

    fun joinRoom(roomId: String, options: SfuJoinOptions) {
        this.roomId = roomId
        val base = sfuUrl.trimEnd('/')
        val joinJson = postJson(
            "$base/v1/rooms/${encode(roomId)}/join",
            JSONObject().put("peerId", userId)
        )
        val rtpCapabilities = joinJson.getJSONObject("rtpCapabilities").toString()

        val mediasoupDevice = Device()
        mediasoupDevice.load(rtpCapabilities, null)
        device = mediasoupDevice

        createSendTransport(base, roomId, options)
        createRecvTransport(base, roomId)
        if (options.audio || options.video) publishCameraMic(options)
        consumeExisting(base, roomId)
    }

    fun handleRemoteProducer(payload: JSONObject) {
        val currentRoom = roomId ?: return
        if (payload.getString("roomId") != currentRoom) return
        if (payload.getString("fromUserId") == userId) return
        val producerId = payload.getString("producerId")
        if (consumers.containsKey(producerId)) return
        consumeProducer(sfuUrl.trimEnd('/'), currentRoom, producerId, payload.optString("fromUserId"))
    }

    fun muteMicrophone(muted: Boolean) {
        if (muted) micProducer?.pause() else micProducer?.resume()
        audioTrack?.setEnabled(!muted)
    }

    fun muteCamera(muted: Boolean) {
        if (muted) camProducer?.pause() else camProducer?.resume()
        videoTrack?.setEnabled(!muted)
    }

    fun switchCamera() {
        (videoCapturer as? org.webrtc.CameraVideoCapturer)?.switchCamera(null)
        usingFrontCamera = !usingFrontCamera
    }

    fun getLocalVideoTrack(): VideoTrack? = videoTrack

    fun destroy() {
        micProducer?.close()
        camProducer?.close()
        consumers.values.forEach { it.close() }
        consumers.clear()
        sendTransport?.close()
        recvTransport?.close()
        sendTransport = null
        recvTransport = null
        device?.dispose()
        device = null
        videoCapturer?.stopCapture()
        videoCapturer?.dispose()
        videoTrack?.dispose()
        audioTrack?.dispose()
        factory.dispose()
        eglBase.release()
        roomId = null
    }

    private fun createSendTransport(base: String, roomId: String, options: SfuJoinOptions) {
        val info = postJson(
            "$base/v1/rooms/${encode(roomId)}/transports",
            JSONObject().put("peerId", userId)
        )
        val mediasoupDevice = device ?: return
        sendTransport = mediasoupDevice.createSendTransport(
            object : SendTransport.Listener {
                override fun onConnect(transport: Transport, dtlsParameters: String) {
                    postJson(
                        "$base/v1/rooms/${encode(roomId)}/transports/${transport.id}/connect",
                        JSONObject().put("peerId", userId).put("dtlsParameters", JSONObject(dtlsParameters))
                    )
                }

                override fun onConnectionStateChange(transport: Transport, connectionState: String) {}

                override fun onProduce(
                    transport: Transport,
                    kind: String,
                    rtpParameters: String,
                    appData: String
                ): String {
                    val res = postJson(
                        "$base/v1/rooms/${encode(roomId)}/transports/${transport.id}/produce",
                        JSONObject()
                            .put("peerId", userId)
                            .put("kind", kind)
                            .put("rtpParameters", JSONObject(rtpParameters))
                    )
                    val producerId = res.getString("producerId")
                    if (options.announceToRoom || options.targetUserId != null) {
                        sendSignaling(
                            "sfu_producer",
                            JSONObject()
                                .put("roomId", roomId)
                                .put("producerId", producerId)
                                .put("kind", kind)
                                .apply {
                                    options.targetUserId?.let { put("toUserId", it) }
                                    options.callId?.let { put("callId", it) }
                                }
                        )
                    }
                    return producerId
                }

                override fun onProduceData(
                    transport: Transport,
                    sctpStreamParameters: String,
                    label: String,
                    protocol: String,
                    appData: String
                ): String = ""
            },
            info.getString("id"),
            info.getJSONObject("iceParameters").toString(),
            info.getJSONArray("iceCandidates").toString(),
            info.getJSONObject("dtlsParameters").toString()
        )
    }

    private fun createRecvTransport(base: String, roomId: String) {
        val info = postJson(
            "$base/v1/rooms/${encode(roomId)}/transports",
            JSONObject().put("peerId", userId)
        )
        val mediasoupDevice = device ?: return
        recvTransport = mediasoupDevice.createRecvTransport(
            object : RecvTransport.Listener {
                override fun onConnect(transport: Transport, dtlsParameters: String) {
                    postJson(
                        "$base/v1/rooms/${encode(roomId)}/transports/${transport.id}/connect",
                        JSONObject().put("peerId", userId).put("dtlsParameters", JSONObject(dtlsParameters))
                    )
                }

                override fun onConnectionStateChange(transport: Transport, connectionState: String) {}
            },
            info.getString("id"),
            info.getJSONObject("iceParameters").toString(),
            info.getJSONArray("iceCandidates").toString(),
            info.getJSONObject("dtlsParameters").toString()
        )
    }

    private fun publishCameraMic(options: SfuJoinOptions) {
        val send = sendTransport ?: return
        if (options.audio) {
            val audioSource = factory.createAudioSource(MediaConstraints())
            audioTrack = factory.createAudioTrack("audio0", audioSource)
            micProducer = send.produce({ }, audioTrack, null, null, null)
        }
        if (options.video) {
            startCamera()
            videoTrack?.let { camProducer = send.produce({ }, it, null, null, null) }
        }
    }

    private fun consumeExisting(base: String, roomId: String) {
        val request = Request.Builder()
            .url("$base/v1/rooms/${encode(roomId)}/producers?peerId=${encode(userId)}")
            .header("Authorization", "Bearer $authToken")
            .get()
            .build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return
            val json = JSONObject(response.body?.string() ?: "{}")
            val arr = json.optJSONArray("producers") ?: return
            for (i in 0 until arr.length()) {
                val item = arr.getJSONObject(i)
                consumeProducer(base, roomId, item.getString("producerId"), item.getString("peerId"))
            }
        }
    }

    private fun consumeProducer(base: String, roomId: String, producerId: String, fromUserId: String) {
        val recv = recvTransport ?: return
        val mediasoupDevice = device ?: return
        if (consumers.containsKey(producerId)) return

        val res = postJson(
            "$base/v1/rooms/${encode(roomId)}/transports/${recv.id}/consume",
            JSONObject()
                .put("peerId", userId)
                .put("producerId", producerId)
                .put("rtpCapabilities", JSONObject(mediasoupDevice.rtpCapabilities))
        )

        val consumer = recv.consume(
            { consumers.remove(producerId) },
            res.getString("consumerId"),
            producerId,
            res.getString("kind"),
            res.getJSONObject("rtpParameters").toString(),
            ""
        )
        consumers[producerId] = consumer
        val track = consumer.track
        if (track is VideoTrack) onRemoteVideo(track)
    }

    private fun startCamera() {
        val enumerator = Camera2Enumerator(context)
        val deviceName = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) } ?: return
        videoCapturer = enumerator.createCapturer(deviceName, null)
        val helper = SurfaceTextureHelper.create("sfu-capture", eglBase.eglBaseContext)
        val videoSource = factory.createVideoSource(videoCapturer!!.isScreencast)
        videoCapturer!!.initialize(helper, context, videoSource.capturerObserver)
        videoCapturer!!.startCapture(640, 480, 24)
        videoTrack = factory.createVideoTrack("video0", videoSource)
    }

    private fun postJson(url: String, body: JSONObject): JSONObject {
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $authToken")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("SFU request failed (${response.code})")
            return JSONObject(response.body?.string() ?: "{}")
        }
    }

    private fun encode(value: String) = java.net.URLEncoder.encode(value, Charsets.UTF_8.name())
}

data class SfuJoinOptions(
    val audio: Boolean = true,
    val video: Boolean = false,
    val announceToRoom: Boolean = false,
    val targetUserId: String? = null,
    val callId: String? = null
)
