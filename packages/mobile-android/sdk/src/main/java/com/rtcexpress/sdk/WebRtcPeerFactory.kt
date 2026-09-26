package com.rtcexpress.sdk

import android.content.Context
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory

/** One PeerConnectionFactory per process — used only for voice/video (P2P). */
object WebRtcPeerFactory {
    @Volatile
    private var initialized = false

    @Volatile
    private var nativesLoaded = false

    private var eglBase: EglBase? = null
    private var factory: PeerConnectionFactory? = null

    fun egl(): EglBase {
        ensureFactory()
        return eglBase!!
    }

    fun factory(): PeerConnectionFactory {
        ensureFactory()
        return factory!!
    }

    private fun loadNatives() {
        if (nativesLoaded) return
        val names = listOf(
            "jingle_peerconnection_so",
            "googlewebrtc",
        )
        var loaded = false
        for (name in names) {
            try {
                System.loadLibrary(name)
                loaded = true
                break
            } catch (_: UnsatisfiedLinkError) {
                /* try next */
            }
        }
        if (!loaded) {
            throw IllegalStateException(
                "WebRTC native library missing from APK. Rebuild the app after updating dependencies."
            )
        }
        nativesLoaded = true
    }

    @Synchronized
    private fun ensureFactory() {
        if (factory != null) return
        val app = WebRtcAppContext.get()
        loadNatives()
        if (!initialized) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(app)
                    .createInitializationOptions()
            )
            initialized = true
        }
        eglBase = EglBase.create()
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase!!.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase!!.eglBaseContext))
            .createPeerConnectionFactory()
    }

    /** Call before starting a voice/video call (not needed for chat). */
    fun warmUp(context: Context) {
        WebRtcAppContext.set(context.applicationContext)
        ensureFactory()
    }
}

object WebRtcAppContext {
    @Volatile
    private var appContext: Context? = null

    fun set(context: Context) {
        appContext = context.applicationContext
    }

    fun get(): Context =
        appContext ?: throw IllegalStateException("WebRTC not initialized")
}
