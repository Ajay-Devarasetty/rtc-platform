package com.rtcexpress.reactnative

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.rtcexpress.sdk.CallInvite
import com.rtcexpress.sdk.CallStateUpdate
import com.rtcexpress.sdk.RTCExpress
import com.rtcexpress.sdk.RTCInitOptions
import com.rtcexpress.sdk.RoomMessage
import com.rtcexpress.sdk.TokenClient
import com.rtcexpress.sdk.TokenRequest

class RTCExpressModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), RTCExpress.Listener {

    private var rtc: RTCExpress? = null

    override fun getName() = "RTCExpress"

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for RN NativeEventEmitter; we use RCTDeviceEventEmitter.
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for RN NativeEventEmitter.
    }

    private fun emit(event: String, payload: Any?) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(event, payload)
    }

    @ReactMethod
    fun fetchToken(serverUrl: String, request: ReadableMap, promise: Promise) {
        try {
            val tokenRequest = TokenRequest(
                appId = request.getString("appId") ?: "",
                appSecret = request.getString("appSecret") ?: "",
                userId = request.getString("userId") ?: "",
                roomId = if (request.hasKey("roomId")) request.getString("roomId") else null
            )
            val response = TokenClient().fetchToken(serverUrl, tokenRequest)
            val map = Arguments.createMap()
            map.putString("token", response.token)
            map.putInt("expiresIn", response.expiresIn)
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("token_error", e.message, e)
        }
    }

    @ReactMethod
    fun init(options: ReadableMap, promise: Promise) {
        try {
            val rtcExpress = RTCExpress(reactContext.applicationContext)
            rtcExpress.setListener(this)
            rtcExpress.init(
                RTCInitOptions(
                    serverUrl = options.getString("serverUrl") ?: "",
                    appId = options.getString("appId") ?: "",
                    userId = options.getString("userId") ?: "",
                    token = options.getString("token") ?: "",
                    mediaMode = options.getString("mediaMode") ?: "auto"
                )
            )
            rtc = rtcExpress
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("init_error", e.message, e)
        }
    }

    private fun runRtc(block: () -> Unit) {
        try {
            if (rtc == null) throw IllegalStateException("RTC not initialized — open chat first")
            block()
        } catch (e: Exception) {
            emit("error", Arguments.createMap().apply { putString("message", e.message ?: "RTC error") })
        }
    }

    @ReactMethod
    fun joinRoom(roomId: String) {
        runRtc { rtc?.joinRoom(roomId) }
    }

    @ReactMethod
    fun sendMessage(text: String, clientMsgId: String) {
        runRtc { rtc?.sendMessage(text, clientMsgId) }
    }

    @ReactMethod
    fun callUser(peerUserId: String, video: Boolean) {
        runRtc { rtc?.callUser(peerUserId, video) }
    }

    @ReactMethod
    fun acceptCall() {
        runRtc { rtc?.acceptCall() }
    }

    @ReactMethod
    fun rejectCall() {
        runRtc { rtc?.rejectCall() }
    }

    @ReactMethod
    fun endCall() {
        runRtc { rtc?.endCall() }
    }

    @ReactMethod
    fun muteMicrophone(muted: Boolean) {
        rtc?.muteMicrophone(muted)
    }

    @ReactMethod
    fun muteCamera(muted: Boolean) {
        rtc?.muteCamera(muted)
    }

    @ReactMethod
    fun switchCamera() {
        rtc?.switchCamera()
    }

    @ReactMethod
    fun destroy() {
        rtc?.destroy()
        rtc = null
    }

    override fun onConnected(userId: String) {
        emit("connected", Arguments.createMap().apply { putString("userId", userId) })
    }

    override fun onDisconnected() {
        emit("disconnected", null)
    }

    override fun onRoomJoined(roomId: String, members: List<String>) {
        emit(
            "roomJoined",
            Arguments.createMap().apply {
                putString("roomId", roomId)
                putArray("members", Arguments.fromList(members))
            }
        )
    }

    override fun onMessage(message: RoomMessage) {
        emit(
            "message",
            Arguments.createMap().apply {
                putString("roomId", message.roomId)
                putString("fromUserId", message.fromUserId)
                putString("text", message.text)
                putDouble("sentAt", message.sentAt.toDouble())
                putString("clientMsgId", message.clientMsgId)
            }
        )
    }

    override fun onCallInvite(invite: CallInvite) {
        emit(
            "callInvite",
            Arguments.createMap().apply {
                putString("callId", invite.callId)
                putString("roomId", invite.roomId)
                putString("fromUserId", invite.fromUserId)
                putString("callType", invite.callType)
            }
        )
    }

    override fun onCallState(update: CallStateUpdate) {
        emit(
            "callState",
            Arguments.createMap().apply {
                putString("callId", update.callId)
                putString("state", update.state)
                putString("peerUserId", update.peerUserId)
                putString("roomId", update.roomId)
                putString("callType", update.callType)
            }
        )
    }

    override fun onError(message: String) {
        emit("error", Arguments.createMap().apply { putString("message", message) })
    }
    override fun onDiagnostics(message: String) {
        emit("diagnostics", Arguments.createMap().apply { putString("message", message) })
    }
}
