# RTC Platform

Zego-style embeddable SDK for **one-on-one chat**, **voice calls**, and **group voice** via mediasoup SFU.

## Structure

```
rtc-platform/
├── packages/
│   ├── protocol/     # Shared message types
│   ├── signaling/    # WebSocket + REST + app registry
│   ├── sdk/          # @rtc/sdk — embed in any app (npm-ready)
│   ├── mobile-android/  # Android SDK (Kotlin)
│   ├── mobile-ios/      # iOS SDK (Swift)
│   ├── media-sfu/    # mediasoup SFU service
│   └── demo/         # Integration demo
├── docker-compose.yml
```

## Quick start

```bash
cd rtc-platform
npm install
npm run dev:infra    # postgres, redis, coturn (first time)
cp packages/signaling/.env.example packages/signaling/.env
npm run dev          # signaling + SFU + demo
```

- Signaling: http://localhost:4000
- SFU: http://localhost:4100
- Demo: http://localhost:5180
- **Admin Dashboard**: http://localhost:5181/admin/

## Phase 2 — Developer SaaS

Self-service dashboard for projects, webhooks, events, and usage metering.

### Dashboard

```bash
npm run dev   # starts signaling + SFU + demo + dashboard
```

Open http://localhost:5181 — sign in with `dev-admin-key` (from `.env`).

| Tab | What it shows |
|-----|---------------|
| Overview | Messages, call minutes, event counts |
| Events | Live event log |
| Webhooks | Register, pause, delete webhooks |
| Deliveries | Webhook delivery audit trail |
| Quick start | SDK integration snippet |

See [docs/QUICKSTART.md](docs/QUICKSTART.md) for a 5-minute integration guide.

## Mobile SDKs (iOS & Android)

Native Kotlin and Swift packages for chat and P2P voice/video calls.

- [Mobile overview](docs/MOBILE.md)
- [Android SDK](packages/mobile-android/README.md)
- [iOS SDK](packages/mobile-ios/README.md)

Use `mediaMode: "p2p"` on mobile. SFU group calls are on the roadmap.

### Admin API (dashboard uses these)

| Endpoint | Description |
|----------|-------------|
| `POST /v1/admin/apps` | Create project |
| `GET /v1/admin/apps` | List projects |
| `POST /v1/admin/apps/:id/webhooks` | Register webhook |
| `GET /v1/admin/apps/:id/webhook-deliveries` | Delivery log |
| `GET /v1/admin/apps/:id/metering` | Usage (messages, call minutes) |
| `GET /v1/admin/apps/:id/events` | Event log |

All admin routes require header `x-admin-key`.

### Docker full stack

```bash
npm run dev:stack
```

Runs postgres, redis, coturn, signaling, and media-sfu.

## Phase 3 — Video, screen share & group video

Web-only (no React Native required). Test in the demo at http://localhost:5180.

### SDK — video APIs

```ts
await rtc.videoCallUser("user_b");           // 1:1 video call
await rtc.callUser("user_b", { callType: "video" });

await rtc.joinVideoRoom();                   // group video (SFU)
rtc.leaveVideoRoom();

rtc.muteCamera(true);
await rtc.shareScreen();
await rtc.stopScreenShare();

rtc.on("localStream", ({ stream }) => { /* attach to <video> */ });
rtc.on("remoteTrack", ({ stream, userId, kind }) => { /* attach remote video */ });
```

### Demo features
- **Video call** — 1:1 with camera
- **Group video** — multi-user video via SFU
- **Screen share** — during call or group video
- **Cam off / Mute** — toggle camera and microphone

## Phase 4 — Call recording

Record calls and media sessions locally, notify the platform when done.

### SDK

```ts
rtc.startRecording();                        // during active call or group media
const { url, blob, durationMs } = await rtc.stopRecording();  // download via url

rtc.on("recordingStarted", () => { /* UI indicator */ });
rtc.on("recordingReady", ({ url, blob, durationMs }) => {
  // blob = WebM file, url = object URL for download
});
```

Recording metadata is sent to signaling as `recording.ready` (webhook when DB is configured).

### Demo
During a call, click **Record** → **Stop & save** → download link appears in the log. Transcript and AI summary appear shortly after (demo text without `OPENAI_API_KEY`).

## Phase 5 — Transcription + AI summaries

After a recording stops, the SDK uploads audio to signaling. The server transcribes (OpenAI Whisper) and generates a summary (GPT).

### Server setup

```bash
# packages/signaling/.env
OPENAI_API_KEY=sk-...   # optional — demo transcript/summary without it
```

Webhook events: `recording.uploaded`, `transcript.ready`, `summary.ready`

### SDK

```ts
rtc.on("recordingReady", ({ recordingId, url }) => { /* download */ });
rtc.on("transcriptReady", ({ recordingId, transcript }) => { /* show captions */ });
rtc.on("summaryReady", ({ recordingId, summary }) => { /* meeting notes */ });
```

## Phase 6 — Call quality observability

The SDK samples WebRTC stats every 5s during calls and group media sessions.

### Metrics

RTT, jitter, packet loss, bitrate, connection/ICE state — scored 0–100 (`excellent` → `poor`).

### SDK

```ts
rtc.on("callQuality", ({ score, label, metrics, callId, roomId }) => {
  console.log(label, score, metrics.rttMs, metrics.packetLossPct);
});
rtc.setQualityMonitoring(false); // disable if needed
```

Webhook events: `call.quality.report`, `call.quality.degraded`

### Dashboard

**Quality** tab at http://localhost:5181 — per-app summaries and recent reports.

## Phase 7 — Billing + usage metering

Usage-based billing with plan tiers, limit tracking, and cost estimates.

### Plans

| Plan | Features | Call minutes | Messages |
|------|----------|-------------|----------|
| Free | Chat only | 100 | 1,000 |
| Starter | Chat + voice + group voice | 1,000 | 10,000 |
| Pro | Chat + voice + video + recording + screen share | 10,000 | 100,000 |

Feature gating is enforced server-side (chat, voice calls, video calls, group media, recording).
Change a project's plan in the dashboard **Billing** tab or `PATCH /v1/admin/apps/:appId/plan`.

### Admin API

```
GET  /v1/admin/apps/:appId/billing     — usage, limits, estimated cost
PATCH /v1/admin/apps/:appId/plan       — { "plan": "starter" }
GET  /v1/admin/billing/plans           — plan definitions
```

Webhook: `billing.threshold` — fired when usage exceeds 80% of plan limits.

### Dashboard

**Billing** tab — usage vs limits, plan selector, estimated invoice.

## SFU voice + group calls (reference)

The SDK routes voice through **mediasoup** when `SFU_URL` is configured and `mediaMode` is `auto` or `sfu`.

### Media modes

| Mode | Behavior |
|------|----------|
| `auto` | SFU when available, else P2P (default) |
| `sfu` | Always use mediasoup (falls back to P2P if SFU offline) |
| `p2p` | Direct WebRTC between peers |

### SDK — 1:1 call + group voice

```ts
import { RTCExpress } from "@rtc/sdk";

const rtc = new RTCExpress();
await rtc.init({
  serverUrl: "http://localhost:4000",
  appId: "demo-app",
  userId: "user_123",
  token,
  mediaMode: "auto", // or "sfu" | "p2p"
});

await rtc.joinRoom("room-1");
rtc.sendMessage("Hello");

// 1:1 voice — uses SFU when mediaMode resolves to sfu
await rtc.callUser("user_456");

// Group voice — all room members hear each other via SFU
await rtc.joinVoiceRoom();
rtc.leaveVoiceRoom();

rtc.getMediaMode(); // "p2p" | "sfu"
```

### Demo

1. Open http://localhost:5180 in two tabs (User A / User B panels, or two browser windows).
2. Connect both with different user IDs, same room ID.
3. **Join room** on both.
4. Try **1:1 Call** (SFU when Auto/SFU mode) or **Join group voice** for multi-user audio.

## Phase 5 — Production hardening

### Health checks

| Service | Liveness | Readiness |
|---------|----------|-----------|
| Signaling | `GET /health` | `GET /ready` (Redis + PostgreSQL when configured) |
| Media SFU | `GET /health` | `GET /ready` (mediasoup worker) |

### Production env guards

Set `NODE_ENV=production` and provide strong secrets. The server **fails fast** if:

- `JWT_SECRET` or `ADMIN_API_KEY` use dev defaults
- `DATABASE_URL` is missing (signaling)
- `ANNOUNCED_IP` is still `127.0.0.1` (media-sfu)

### Docker full stack

```bash
docker compose up -d --build
```

Starts postgres, redis, coturn, signaling, and media-sfu.

### Graceful shutdown

Both services handle `SIGTERM` / `SIGINT` — drain WebSockets, close Redis/DB, stop mediasoup worker.

### Publish SDK to npm

```bash
npm run build:sdk
npm run pack:sdk    # verify tarballs locally
# Publish @rtc/protocol first, then @rtc/sdk
npm publish -w @rtc/protocol
npm publish -w @rtc/sdk
```

## Events + webhooks

Room, message, and call activity is persisted to the `events` table (requires `DATABASE_URL`)
and pushed to registered webhook endpoints.

### Event types

| Event | Emitted when |
|-------|--------------|
| `user.joined` / `user.left` | A user joins or leaves a room (incl. disconnect) |
| `message.sent` | A room message is delivered |
| `call.ringing` | A call invite is relayed |
| `call.connected` | Callee accepts |
| `call.failed` | Callee rejects |
| `call.ended` | Either side ends the call |

### Register a webhook

```bash
curl -X POST http://localhost:4000/v1/admin/apps/demo-app/webhooks \
  -H "x-admin-key: dev-admin-key" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://your-app.com/hooks/rtc\",\"events\":[\"call.ended\",\"user.joined\"]}"
```

Returns the webhook `secret` once — store it. Deliveries are `POST`ed as:

```json
{ "type": "user.joined", "appId": "demo-app", "data": { "roomId": "room-1", "userId": "u1" },
  "eventId": "42", "createdAt": "2026-01-01T00:00:00.000Z" }
```

### Verify the signature

Each delivery carries an `X-RTC-Signature` header — HMAC-SHA256 of the raw body using your secret.
Failed deliveries retry up to 3 times with backoff; every attempt is logged to `webhook_deliveries`.

```js
import { createHmac, timingSafeEqual } from "crypto";

const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-rtc-signature"]));
```

## Phase 3 — App registry + infrastructure

### 1. Start infrastructure

```bash
npm run dev:infra
```

Starts **PostgreSQL**, **Redis**, and **coturn**.

### 2. Configure signaling

```bash
cp packages/signaling/.env.example packages/signaling/.env
```

Key variables:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL app registry |
| `ADMIN_API_KEY` | Create new customer apps |
| `REDIS_URL` | Multi-instance signaling |
| `SFU_URL` | mediasoup service URL for clients |

### 3. Register a new app (like Zego App ID)

```bash
curl -X POST http://localhost:4000/v1/admin/apps \
  -H "x-admin-key: dev-admin-key" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"My Product\"}"
```

Returns `appId` + `appSecret` (store the secret securely).

### 4. Build publishable SDK

```bash
npm run build:sdk
```

Output: `packages/sdk/dist` (ESM + CJS + types). See `packages/sdk/README.md` for integration guide.

## Demo credentials (development only)

| Key | Value |
|-----|-------|
| App ID | `demo-app` |
| App Secret | `demo-secret` |
| Admin key | `dev-admin-key` |

> **These are public, so they are never seeded in production.** With
> `NODE_ENV=production` the demo app is skipped unless `DEMO_APP_SECRET` is set
> to a strong value, and a demo app left over from an earlier deploy that used
> the default secret is deactivated automatically on startup.
>
> To keep a working demo on a public deployment, set `DEMO_APP_SECRET` to a
> generated value (`openssl rand -hex 24`) — it is then seeded with that secret
> instead, and a previously deactivated demo app is re-enabled.

### The demo page never holds a secret

`packages/demo` does not embed an app secret. It is served publicly, so anything
in its bundle is public too. It calls **`POST /v1/demo/token`**, and the server
issues the token — rate limited per IP, and only while a demo app is enabled.

`GET /v1/demo/status` reports whether the demo is available, so the page can say
so rather than failing at the first click.

Behaviour in production:

| `DEMO_APP_SECRET` | Demo app | `/v1/demo/token` |
|---|---|---|
| unset, no prior demo app | not created | `404` |
| unset, prior app used the **published** secret | deactivated on boot | `404` |
| set to a strong value | created or re-enabled with that secret | issues tokens |
| unset, but a prior app used a **strong** secret | left enabled | issues tokens |

That last row is intentional: nothing is exposed, since the secret is unknown
and `/v1/demo/token` is public by design. To switch a demo off entirely,
deactivate the app rather than removing the variable.

## API overview

| Endpoint | Description |
|----------|-------------|
| `POST /v1/token` | Issue user JWT |
| `GET /v1/config` | ICE/TURN + SFU URL + feature flags |
| `POST /v1/admin/apps` | Register new app |
| `GET /v1/admin/apps` | List apps |
| `POST /v1/admin/apps/:appId/webhooks` | Register webhook endpoint |
| `GET /v1/admin/apps/:appId/webhooks` | List webhooks |
| `DELETE /v1/admin/apps/:appId/webhooks/:id` | Remove webhook |
| `GET /v1/admin/apps/:appId/events` | Call/message event log (`?type=&limit=`) |
| `GET /v1/admin/apps/:appId/usage` | Event counts per type |
| `WS /ws?token=` | Signaling (chat, calls, SFU producer discovery) |
| `POST /v1/rooms/:id/join` | SFU — join media room |

## Architecture

```
Customer App → @rtc/sdk
                 ├─ WebSocket → Signaling (chat + call setup + sfu_producer)
                 ├─ WebRTC P2P → Voice (mediaMode: p2p)
                 └─ mediasoup SFU → 1:1 + group voice (mediaMode: sfu)

Signaling → PostgreSQL (apps) + Redis (rooms/relay)
media-sfu → mediasoup router/transports/producers
```

## Roadmap status

| Phase | Status |
|-------|--------|
| P2P chat + voice | Done |
| Redis multi-node | Done |
| TURN + ICE API | Done |
| PostgreSQL app registry | Done |
| SDK npm packaging | Done |
| mediasoup SFU service | Done |
| SDK ↔ SFU voice path | Done |
| Group voice (SFU) | Done |
| Developer dashboard + metering | Done |
| Video + screen share + group video | Done |
| Call recording + recording.ready events | Done |
| Transcription + AI summaries | Done |
| Call quality metrics + observability | Done |
| Billing + usage metering | Done |
| npm publish + cloud deploy | Next |
