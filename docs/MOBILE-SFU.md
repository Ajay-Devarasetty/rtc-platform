# Mobile SFU integration

## Status

| Platform | Group voice/video (SFU) | 1:1 via SFU | Dependency |
|----------|-------------------------|-------------|------------|
| **Web** | ✅ Full | ✅ | `mediasoup-client` (JS) |
| **Android** | ✅ Full | ✅ | `io.github.haiyangwu:mediasoup-client:3.4.0` |
| **iOS** | ✅ Full | ✅ | [mediasoup-client-swift](https://github.com/VLprojects/mediasoup-client-swift) `0.13.2` |

## Android

Set `mediaMode` to `"auto"` or `"sfu"` in `RTCInitOptions`:

```kotlin
rtc.init(
    RTCInitOptions(
        serverUrl = "https://rtcplatform.duckdns.org",
        appId = "demo-app",
        userId = "user_a",
        token = token,
        mediaMode = "auto"
    )
)
rtc.joinRoom("room-1")
rtc.joinVoiceRoom()   // group voice via SFU
rtc.joinVideoRoom()   // group video via SFU
```

SFU API calls include `Authorization: Bearer <JWT>` (same token as signaling).

## iOS

The iOS SDK depends on **Mediasoup-Client-Swift** via SPM (`Package.swift`). Build on macOS with Xcode 15+.

```swift
rtc.initClient(RTCInitOptions(
    serverUrl: "https://rtcplatform.duckdns.org",
    appId: "demo-app",
    userId: "user_a",
    token: token,
    mediaMode: "auto"
))
rtc.joinRoom("room-1")
try await rtc.joinVoiceRoom()
try await rtc.joinVideoRoom()
```

For 1:1 only without SFU, use `mediaMode: "p2p"`.

## Server requirements

- `SFU_URL` configured on signaling server
- `JWT_SECRET` shared between signaling and media-sfu
- GCP firewall: UDP `40000-40100` for mediasoup

## Cross-platform group call

| Client A | Client B | Works? |
|----------|----------|--------|
| Web | Web | ✅ |
| Android | Android | ✅ |
| iOS | iOS | ✅ |
| Web | Android | ✅ |
| Web | iOS | ✅ |
| iOS | Android | ✅ |
