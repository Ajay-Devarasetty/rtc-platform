# RTCExpress iOS SDK

Swift package for chat and WebRTC calls against the RTC Platform signaling server.

## Features

- WebSocket signaling (chat, 1:1 calls)
- P2P voice + video
- **SFU group voice + video** (via [mediasoup-client-swift](https://github.com/VLprojects/mediasoup-client-swift))
- 1:1 calls via SFU when `mediaMode` is `auto` or `sfu`
- Chat history (`GET /v1/rooms/:id/messages`)
- Local call recording (microphone)
- Incoming call notifier hook for PushKit/CallKit
- Call busy handling

## Setup

Add via Swift Package Manager (requires **macOS + Xcode 15+** to build):

```
File → Add Package Dependencies → path: packages/mobile-ios
```

`Info.plist`:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Voice calls</string>
<key>NSCameraUsageDescription</key>
<string>Video calls</string>
```

## Usage

```swift
let token = try await TokenClient.fetchToken(serverUrl: url, request: TokenRequest(...))

let rtc = RTCExpress()
rtc.delegate = self
rtc.initClient(RTCInitOptions(
    serverUrl: url,
    appId: appId,
    userId: userId,
    token: token.token,
    mediaMode: "auto"
))
rtc.joinRoom("room-1")

// Group SFU
try await rtc.joinVoiceRoom()
try await rtc.joinVideoRoom()

// 1:1
try rtc.callUser("user_b", video: true)
```

## API

| Method | Description |
|--------|-------------|
| `initClient(options)` | Connect signaling |
| `joinRoom` | Join chat room |
| `joinVoiceRoom` / `joinVideoRoom` | Group SFU media |
| `callUser` / `acceptCall` / `rejectCall` / `endCall` | 1:1 calls (P2P or SFU) |
| `getMessageHistory` | Paginated chat history |
| `startRecording` / `stopRecording` | Local mic recording |

See [docs/MOBILE-SFU.md](../../docs/MOBILE-SFU.md) for cross-platform SFU notes.

## Roadmap

- [x] P2P voice + video
- [x] SFU group + 1:1 via mediasoup-client-swift
- [x] Chat + history
- [ ] CocoaPods / SPM registry publish
