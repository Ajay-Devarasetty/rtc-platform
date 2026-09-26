package com.rtcexpress.sdk

import org.json.JSONObject
import java.util.UUID

data class RTCInitOptions(
    val serverUrl: String,
    val appId: String,
    val userId: String,
    val token: String,
    val mediaMode: String = "p2p"
)

data class TokenRequest(
    val appId: String,
    val appSecret: String,
    val userId: String,
    val roomId: String? = null
)

data class TokenResponse(
    val token: String,
    val expiresIn: Int
)

data class RoomMessage(
    val roomId: String,
    val fromUserId: String,
    val text: String,
    val sentAt: Long,
    val clientMsgId: String = ""
)

data class CallInvite(
    val callId: String,
    val roomId: String,
    val fromUserId: String,
    val toUserId: String,
    val callType: String
)

data class CallStateUpdate(
    val callId: String,
    val state: String,
    val peerUserId: String,
    val roomId: String,
    val callType: String
)

object JsonUtil {
    fun clientMessage(type: String, payload: JSONObject, requestId: String? = null): String {
        val root = JSONObject()
        root.put("type", type)
        root.put("payload", payload)
        if (requestId != null) root.put("requestId", requestId)
        return root.toString()
    }

    fun newCallId(): String = UUID.randomUUID().toString()
}
