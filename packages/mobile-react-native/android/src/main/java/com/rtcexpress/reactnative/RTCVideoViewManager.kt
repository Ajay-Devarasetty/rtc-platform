package com.rtcexpress.reactnative

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.rtcexpress.sdk.CallVideoView

class RTCVideoViewManager : SimpleViewManager<CallVideoView>() {
    override fun getName() = "RTCVideoView"
    override fun createViewInstance(context: ThemedReactContext) = CallVideoView(context)
    @ReactProp(name = "local", defaultBoolean = false)
    fun setLocal(view: CallVideoView, local: Boolean) { view.local = local }
}
