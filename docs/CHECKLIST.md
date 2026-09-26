# RTC Platform — Product Checklist (Agora / Zego parity)

Pin this file in Cursor. **Billing, payments, VM deploy, and commercial plans are excluded** — this list is only what’s needed to make the RTC product itself fully work like Agora/Zego.

**Last updated:** 2026-09-05  
**How to use:** Say *"fix item #N from CHECKLIST.md"* — we update this file after each completion.

---

## What you already have (Agora/Zego basics)

| Feature | Web | Android | iOS |
|---------|-----|---------|-----|
| Token auth + app registry | ✅ | ✅ | ✅ |
| Room join/leave + presence | ✅ | ✅ | ✅ |
| Text chat | ✅ | ✅ | ✅ |
| 1:1 voice call (P2P) | ✅ | ✅ | ✅ |
| 1:1 video call (P2P) | ✅ | ✅ | ✅ |
| 1:1 voice/video via SFU | ✅ | ✅ | ✅ |
| Group voice (SFU) | ✅ | ✅ | ✅ |
| Group video (SFU) | ✅ | ✅ | ✅ |
| Screen share | ✅ | ❌ | ❌ |
| Mute mic/camera, flip camera | ✅ | ✅ | ✅ |
| Client-side recording (both parties) | ✅ | ❌ | ❌ |
| Chat history (paginated) | ✅ | ✅ | ✅ |
| Recording upload + transcript/summary | ✅ | — | — |
| Call quality metrics | ✅ | ❌ | ❌ |
| Webhooks + event log | ✅ | — | — |
| ICE/TURN config API | ✅ | ✅ | ✅ |
| SFU token authentication | ✅ | — | — |
| Auto-reconnect (signaling) | ✅ | — | — |
| Call busy handling | ✅ | — | — |

---

## 🔴 Phase A — Core reliability (DONE ✅)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | **Two-party call recording** (mix local + remote audio/video) | `[x]` | Web Audio mix + canvas composite |
| 2 | **SDK build fix** (protocol types out of sync) | `[x]` | Rebuild protocol before SDK; DTS passes |
| 3 | **SFU authentication** | `[x]` | JWT required on all SFU routes; peerId must match token |
| 4 | **Auto-reconnect** (network drop → resume room/call) | `[x]` | `autoReconnect` option + `reconnecting`/`reconnected` events |
| 5 | **Call busy / already-in-call** handling | `[x]` | Server blocks + client auto-rejects second invite |
| 8 | **Automated tests** (signaling call-state) | `[x]` | `npm test` — 5 tests for call busy logic |

---

## 🟠 Important — expected in Agora/Zego-class product

| # | Item | Status | Notes |
|---|------|--------|-------|
| 9 | **Server-side / cloud recording** | `[x]` | REST start/stop + SFU recording hooks; host-only |
| 10 | **Per-session TURN credentials** | `[x]` | HMAC-SHA1 time-limited creds via `/v1/config` + `/v1/ice` with Bearer token |
| 11 | **Room-scoped tokens** (enforce on join_room WS) | `[x]` | `assertRoomScope()` on join_room, send_message, call_invite, join_media |
| 12 | **Host / publisher / subscriber roles** | `[x]` | `room-roles.ts`; first joiner → host; token `role` claim |
| 13 | **Moderator controls** (kick, mute remote, end room) | `[x]` | `kick_user`, `mute_remote`, `end_room` WS + SDK helpers |
| 14 | **Live broadcast mode** (host publishes, audience subscribes) | `[x]` | `audience` role blocks publish; `joinBroadcastAsAudience()` SDK |
| 15 | **RTMP / HLS CDN streaming** | `[x]` | nginx-rtmp ingest + SFU ffmpeg bridge; `startCdnStream()` SDK |
| 16 | **Simulcast + adaptive bitrate** | `[x]` | 3-layer simulcast encodings on SFU video produce |
| 17 | **H.264 codec support** (mobile compatibility) | `[x]` | H.264 added to SFU router; SDK prefers H.264 when available |
| 18 | **Mobile: screen share** | `[ ]` | Web only |
| 19 | **Mobile: call recording** | `[x]` | Local mic recording (Android + iOS) |
| 20 | **Mobile: chat history API** | `[x]` | `getMessageHistory()` on Android + iOS |
| 21 | **React Native SDK** | `[x]` | `@rtc/react-native-sdk` wraps native Android/iOS |
| 22 | **Flutter SDK** | `[x]` | `rtcexpress` plugin wraps native Android/iOS |
| 23 | **Device / audio route selection** (speaker, BT) | `[ ]` | Browser/OS defaults only |
| 24 | **Active speaker detection** | `[ ]` | Auto layout in group calls |
| 25 | **Object storage for recordings** | `[ ]` | Local disk only |
| 26 | **Real-time analytics** (concurrent users, live stats) | `[~]` | Dashboard has history only |

---

## 🟡 Mobile SDK gaps (Phase B)

| # | Item | Status |
|---|------|--------|
| 6 | **Mobile SFU** (group voice + video) | `[x]` |
| 7 | **Push / VoIP for incoming calls** (FCM + APNs) | `[x]` |

---

## 🟡 Nice-to-have — premium / later

| # | Item | Status |
|---|------|--------|
| 27 | AI noise suppression / echo cancellation | `[ ]` |
| 28 | Virtual background / beauty filters | `[ ]` |
| 29 | Spatial audio | `[ ]` |
| 30 | E2E encryption option | `[ ]` |
| 31 | Rich chat (images, files, typing, read receipts) | `[ ]` |
| 32 | Whiteboard / in-call file share | `[ ]` |
| 33 | Channel metadata API | `[ ]` |
| 34 | Unity / Electron / desktop SDKs | `[ ]` |
| 35 | Content moderation hooks | `[ ]` |

---

## Excluded from this list (you said later)

- Billing plans, Stripe/Razorpay, invoices
- Customer self-signup portal
- VM deploy, server sizing, firewall setup
- npm / Maven / CocoaPods publish
- Enterprise $150 / 200k-minute commercial packaging

---

## Suggested build order

```
Phase A — Core reliability          ✅ DONE
Phase B — Mobile (ride apps)          ✅ DONE
Phase C — Agora/Zego advanced         ✅ DONE (#9–#14, #16–#17)
Phase D — Scale & more platforms      ✅ DONE (#15, #21, #22)
```

---

## Phase B — Mobile (ride apps)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 6 | **Mobile SFU** (group voice + video) | `[x]` | Android + iOS via mediasoup-client-swift 0.13.2 |
| 7 | **Push / VoIP** (FCM + APNs guide + hooks) | `[x]` | `docs/PUSH.md` + `IncomingCallNotifier` on both platforms |
| 19 | **Mobile call recording** | `[x]` | Local mic recording during calls (Android + iOS) |
| 20 | **Mobile chat history API** | `[x]` | `getMessageHistory()` on Android + iOS |

---

## Progress log

| Date | Completed |
|------|-----------|
| 2026-09-03 | **Phase A** — two-party recording, SDK build fix, SFU auth, auto-reconnect, call busy, tests |
| 2026-09-03 | **Phase B** — Android SFU, chat history, push hooks/docs, mobile recording; iOS SFU partial |
| 2026-09-03 | **Phase C** — cloud recording, per-session TURN, room roles, moderation, live broadcast, simulcast, H.264 |
| 2026-09-05 | **#6 iOS SFU** — full `SfuMediaEngine` via mediasoup-client-swift 0.13.2 |

---

## Phase D — Scale & platforms

| # | Item | Status | Notes |
|---|------|--------|-------|
| 15 | **RTMP / HLS** | `[x]` | `rtmp-ingest` service; `POST /v1/rooms/:id/cdn-stream/start\|stop`; HLS at `/hls/{key}/index.m3u8` |
| 21 | **React Native SDK** | `[x]` | `packages/mobile-react-native` — `@rtc/react-native-sdk` |
| 22 | **Flutter SDK** | `[x]` | `packages/mobile-flutter` — `rtcexpress` plugin + example app |

---

## Phase C — Agora/Zego advanced

| # | Item | Status | Notes |
|---|------|--------|-------|
| 9 | **Cloud recording** | `[x]` | `POST /v1/rooms/:id/cloud-recording/start\|stop`; SFU session markers |
| 10 | **Per-session TURN** | `[x]` | `getIceConfig({ userId })` — pass Bearer on `/v1/config` |
| 11 | **Room-scoped tokens** | `[x]` | Enforced on WS join_room, chat, calls, media |
| 12 | **Room roles** | `[x]` | host / publisher / subscriber / audience |
| 13 | **Moderator controls** | `[x]` | kick, mute remote, end room |
| 14 | **Live broadcast** | `[x]` | audience recv-only via `joinBroadcastAsAudience()` |
| 16 | **Simulcast** | `[x]` | l/m/h layers on camera + screen share |
| 17 | **H.264** | `[x]` | SFU router codec + SDK preference |
