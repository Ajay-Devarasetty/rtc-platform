package com.rtcexpress.sdk

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

class ConfigClient(private val http: OkHttpClient = OkHttpClient()) {
    fun fetchIceServers(serverUrl: String, token: String): List<org.webrtc.PeerConnection.IceServer> {
        // Use authenticated ICE configuration for both static and session TURN credentials.
        val request = Request.Builder().url("${serverUrl.trimEnd('/')}/v1/ice")
            .header("Authorization", "Bearer $token").get().build()
        return http.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "Failed to fetch ICE configuration" }
            val servers = JSONObject(response.body?.string() ?: "{}").getJSONArray("iceServers")
            (0 until servers.length()).map { index ->
                val server = servers.getJSONObject(index)
                val urls = server.optJSONArray("urls")?.let { list ->
                    (0 until list.length()).map { list.getString(it) }
                } ?: listOf(server.getString("urls"))
                org.webrtc.PeerConnection.IceServer.builder(urls)
                    .setUsername(server.optString("username"))
                    .setPassword(server.optString("credential"))
                    .createIceServer()
            }
        }
    }

    fun fetchPlatformConfig(serverUrl: String, appId: String? = null): PlatformConfig {
        val base = serverUrl.trimEnd('/')
        val query = if (!appId.isNullOrBlank()) "?appId=${java.net.URLEncoder.encode(appId, Charsets.UTF_8.name())}" else ""
        val request = Request.Builder().url("$base/v1/config$query").get().build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("Failed to fetch platform config")
            val json = JSONObject(response.body?.string() ?: "{}")
            val features = json.optJSONObject("features")
            return PlatformConfig(
                sfuUrl = json.optString("sfuUrl").ifBlank { null },
                voiceSfu = features?.optBoolean("voiceSfu", false) ?: false,
                videoSfu = features?.optBoolean("videoSfu", false) ?: false
            )
        }
    }
}

data class PlatformConfig(
    val sfuUrl: String?,
    val voiceSfu: Boolean,
    val videoSfu: Boolean
)
