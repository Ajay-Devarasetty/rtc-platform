package com.rtcexpress.sdk

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

class SignalingClient(
    private val http: OkHttpClient = OkHttpClient()
) {
    interface Listener {
        fun onConnected(userId: String)
        fun onDisconnected()
        fun onRoomJoined(roomId: String, members: List<String>)
        fun onUserJoined(roomId: String, userId: String)
        fun onUserLeft(roomId: String, userId: String)
        fun onMessage(message: RoomMessage)
        fun onCallInvite(invite: CallInvite)
        fun onCallAccept(payload: JSONObject)
        fun onCallReject(payload: JSONObject)
        fun onCallEnd(payload: JSONObject)
        fun onWebRtcOffer(payload: JSONObject)
        fun onWebRtcAnswer(payload: JSONObject)
        fun onWebRtcIceCandidate(payload: JSONObject)
        fun onSfuProducer(payload: JSONObject)
        fun onError(message: String, code: String? = null)
    }

    private var socket: WebSocket? = null
    var listener: Listener? = null

    fun connect(serverUrl: String, token: String) {
        val wsBase = serverUrl.trimEnd('/').replace("^http".toRegex(), "ws")
        val request = Request.Builder()
            .url("$wsBase/ws?token=${java.net.URLEncoder.encode(token, Charsets.UTF_8.name())}")
            .build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(JSONObject(text))
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                listener?.onDisconnected()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                listener?.onError(t.message ?: "WebSocket failed")
                listener?.onDisconnected()
            }
        })
    }

    fun send(type: String, payload: JSONObject) {
        val ws = socket ?: throw IllegalStateException("Not connected")
        check(ws.send(JsonUtil.clientMessage(type, payload))) { "Connection closed. Reconnect before sending." }
    }

    fun close() {
        socket?.close(1000, "bye")
        socket = null
    }

    private fun handleMessage(message: JSONObject) {
        val type = message.getString("type")
        val payload = message.optJSONObject("payload") ?: JSONObject()
        when (type) {
            "connected" -> listener?.onConnected(payload.optString("userId"))
            "room_joined" -> {
                val members = mutableListOf<String>()
                val arr = payload.optJSONArray("members")
                if (arr != null) for (i in 0 until arr.length()) members.add(arr.getString(i))
                listener?.onRoomJoined(payload.getString("roomId"), members)
            }
            "user_joined" -> listener?.onUserJoined(payload.getString("roomId"), payload.getString("userId"))
            "user_left" -> listener?.onUserLeft(payload.getString("roomId"), payload.getString("userId"))
            "message" -> listener?.onMessage(
                RoomMessage(
                    roomId = payload.getString("roomId"),
                    fromUserId = payload.getString("fromUserId"),
                    text = payload.getString("text"),
                    sentAt = payload.optLong("sentAt"),
                    clientMsgId = payload.optString("clientMsgId")
                )
            )
            "call_invite" -> listener?.onCallInvite(
                CallInvite(
                    callId = payload.getString("callId"),
                    roomId = payload.getString("roomId"),
                    fromUserId = payload.getString("fromUserId"),
                    toUserId = payload.getString("toUserId"),
                    callType = payload.optString("callType", "voice")
                )
            )
            "call_accept" -> listener?.onCallAccept(payload)
            "call_reject" -> listener?.onCallReject(payload)
            "call_end" -> listener?.onCallEnd(payload)
            "webrtc_offer" -> listener?.onWebRtcOffer(payload)
            "webrtc_answer" -> listener?.onWebRtcAnswer(payload)
            "ice_candidate" -> listener?.onWebRtcIceCandidate(payload)
            "sfu_producer" -> listener?.onSfuProducer(payload)
            "error" -> listener?.onError(
                payload.optString("message", "Unknown error"),
                payload.optString("code").ifBlank { null }
            )
        }
    }
}
