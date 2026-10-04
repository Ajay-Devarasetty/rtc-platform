# Mobile call and offline chat notifications

Deploy signaling with migrations 015 and 016 and a stable `PUSH_CREDENTIALS_KEY` (64 hex characters). Migrations run on startup. Back up this encryption key outside the repository. Upload Firebase service-account JSON and Apple APNs .p8 keys through Service management → In-app chat. Separate APNs configurations are supported per Bundle ID and sandbox/production environment. Uploaded keys are encrypted; APIs return metadata only. Format validation does not verify provider permissions.

## Device setup

All device/subscription APIs require an RTC **user** token for the correct project, not a portal session or app secret. Register after login, re-register refreshed native tokens, and unregister before logout.

`POST /v1/push/devices`:

```json
{"installationId":"stable-device-uuid","platform":"android","token":"FCM-token","appState":"foreground"}
```

For iOS, enable Push Notifications in the Apple app identifier and Xcode target, request UNUserNotificationCenter authorization, call registerForRemoteNotifications, and convert the device token bytes to hexadecimal. Register with:

```json
{"installationId":"stable-device-uuid","platform":"ios","pushType":"alert","token":"APNs-hex-token","bundleId":"com.example.app","environment":"sandbox"}
```

For incoming iOS calls, add PushKit and CallKit in the host app. Register the **separate PushKit token** with `pushType: "voip"` and the same installation ID. The server sends calls with push type `voip` and topic `<bundleId>.voip`; chat uses `alert` and topic `<bundleId>`. Never use VoIP notifications for chat. On incoming PushKit events, promptly report the incoming call to CallKit and invoke the completion handler. Use production for TestFlight/App Store builds, sandbox for development builds. Host app signing, entitlements, permissions and native handlers remain necessary; uploading credentials does not configure them.

`PATCH /v1/push/devices/<installationId>` with `{"appState":"background"}` or `{"appState":"foreground"}` updates both tokens. Hook this into app lifecycle transitions. `DELETE` that URL removes both tokens on logout. Do not explicitly leave chat rooms just to background/disconnect the app if offline alerts are wanted.

## Room subscriptions and message history

After the SDK's `roomJoined` event, `PUT /v1/rooms/<roomId>/notifications` opts the current user into alerts. No request body is needed. Only a current member can subscribe; room-scoped tokens cannot subscribe elsewhere. Subscriptions persist across socket disconnects and server restarts. `DELETE` that URL opts out, including while disconnected. Explicit `leave_room`, moderator kick, or room termination removes subscriptions. Room termination also removes offline subscribers.

Current room authorization semantics are unchanged: joining is governed by the RTC token and existing room rules. Use room-scoped tokens issued by your trusted application backend for private rooms. New participants must join/subscribe before going offline; the service does not infer recipients from message text or past event logs.

On a message, the database atomically stores the message and enqueues jobs for subscribed recipients' current alert devices, excluding the sender. A stable, nonempty `clientMsgId` (max 64 characters, unique within a room) prevents duplicate persistence and jobs on client retries. Connected foreground recipients are skipped; disconnected users or devices explicitly marked background are notified. A single socket is tracked per user by the existing signaling architecture, so foreground suppression is user-level unless the device is marked background.

Chat payloads contain `type: rtc_chat_message`, `messageId`, and `roomId`; the visible text is generic (“You have a new chat message.”). No chat text is sent to the push provider. On notification tap, authenticate, join the room, and fetch `GET /v1/rooms/<roomId>/messages`. Paginate history and deduplicate using message IDs. These are notification subscriptions and history recovery, not an offline message editor or unread/read-receipt system.

The signaling worker polls every 2 seconds. Jobs use database leases and SKIP LOCKED across instances, retry transient failures with backoff up to five attempts, and expire after 24 hours. Unsubscriptions and device ownership are rechecked before sending. Invalid provider tokens are removed; configuration failures appear in diagnostics. Delivery is at-least-once: a crash after provider acceptance can produce a duplicate, so clients should deduplicate by messageId/callId. Provider acceptance is not proof of display or reading. Already accepted notifications cannot be recalled after unsubscribe. Call invites remain short-lived, best-effort deliveries rather than durable chat jobs.

## React Native helper

```ts
import { RTCPushClient } from '@rtc/react-native-sdk';
const push = new RTCPushClient(serverUrl, () => getFreshRtcUserToken());
await push.registerDevice({ installationId, platform: 'android', token: fcmToken });
// After roomJoined:
await push.subscribeToRoom(roomId);
// On AppState change:
await push.setAppState(installationId, 'background');
// On logout, before clearing the user's token:
await push.unregisterDevice(installationId);
```

The helper supplies authenticated API operations, not native notification permission prompts, token generation, CallKit UI, or navigation. Implement those in your mobile application.

## Verification

Automated tests cover credential scoping/encryption, provider request types, invalid tokens, subscription authorization, queue retry/suppression, and atomic enqueue semantics. Before enabling production notifications, test signed iOS/Android builds with real provider credentials: foreground/background, disconnect/reconnect, token rotation, denied permissions, logout/account switch, unsubscribe/kick/end-room, and provider failure. No real-device delivery is claimed by mocked tests.

References: [Apple APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns), [Apple PushKit](https://developer.apple.com/documentation/pushkit/supporting-pushkit-notifications-in-your-app), [Firebase Android message handling](https://firebase.google.com/docs/cloud-messaging/android/receive-messages).
