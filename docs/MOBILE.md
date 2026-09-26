# Mobile SDKs (iOS & Android)

Native mobile SDKs for RTCExpress — same signaling server and token flow as the web SDK.

## Packages

| Platform | Path | Status |
|----------|------|--------|
| **Android** | `packages/mobile-android` | P2P + SFU chat/voice/video |
| **iOS** | `packages/mobile-ios` | P2P + SFU chat/voice/video |
| **Web** | `packages/sdk` | Full (P2P + SFU + recording) |

## Architecture

```
Your mobile app
    │
    ├─ POST /v1/token  (your backend, appSecret stays server-side)
    │
    ├─ WebSocket /ws?token=JWT  (signaling — chat, calls)
    │
    ├─ WebRTC P2P  (1:1 voice/video)
    └─ mediasoup SFU  (group voice/video — Android + iOS)
```

## Feature parity

| Feature | Web | Android | iOS |
|---------|-----|---------|-----|
| Chat | ✅ | ✅ | ✅ |
| Chat history (REST) | ✅ | ✅ | ✅ |
| 1:1 voice (P2P) | ✅ | ✅ | ✅ |
| 1:1 video (P2P) | ✅ | ✅ | ✅ |
| 1:1 via SFU (`mediaMode: auto`) | ✅ | ✅ | ✅ |
| Group voice (SFU) | ✅ | ✅ | ✅ |
| Group video (SFU) | ✅ | ✅ | ✅ |
| Call recording (local mic) | ✅ | ✅ | ✅ |
| Flip camera | ✅ | ✅ | ✅ |
| Push / background calls | — | [Guide](PUSH.md) | [Guide](PUSH.md) |
| Call busy handling | ✅ | ✅ | ✅ |

## Quick API

### Android

```kotlin
rtc.init(RTCInitOptions(serverUrl, appId, userId, token, mediaMode = "auto"))
rtc.joinRoom("ride-123")
rtc.getMessageHistory("ride-123")
rtc.callUser("driver-9", video = false)
rtc.joinVoiceRoom()
rtc.startRecording()
val result = rtc.stopRecording()
```

### iOS

```swift
rtc.initClient(RTCInitOptions(serverUrl: url, appId: appId, userId: userId, token: token, mediaMode: "auto"))
rtc.joinRoom("ride-123")
try await rtc.joinVoiceRoom()
let page = try await rtc.getMessageHistory("ride-123")
try rtc.callUser("driver-9", video: false)
try rtc.startRecording()
let result = try rtc.stopRecording()
```

## Related docs

- [Push notifications & VoIP](PUSH.md)
- [Mobile SFU setup](MOBILE-SFU.md)
- [Android SDK](../packages/mobile-android/README.md)
- [iOS SDK](../packages/mobile-ios/README.md)
