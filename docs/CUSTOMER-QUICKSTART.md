# Customer quickstart

## Get a project

Create an account on the website. Save the App ID and one-time App Secret. Free enables chat; Starter adds voice; Pro adds video. Paid activation is still manual while payments are deferred.

Use separate project credentials and separate deployments for staging and production. Account-level multi-project management is not available yet; an operator can provision additional apps through the admin API.

## Issue tokens from your backend

Use [the server example](../examples/customer-token-server.mjs). Authenticate your user and authorize their room before calling it. Supply `RTC_SERVER_URL`, `RTC_APP_ID`, and `RTC_APP_SECRET` through your server's secret configuration. Return only the RTC token and expiry to the client. Never trust a user ID or room permission merely because a browser submitted it.

## Install the development SDK

Until a tested release is published, build and pack from this repository:

```sh
npm run build:sdk
npm pack -w @rtc/protocol
npm pack -w @rtc/sdk
```

Install both generated tarballs in your web app. See [release gates](RELEASES.md) for native SDK status and supported-platform validation.

```js
import { RTCExpress } from '@rtc/sdk';
const rtc = new RTCExpress();
rtc.on('connected', () => rtc.joinRoom(roomId));
rtc.on('roomJoined', () => { /* Enable your chat and call buttons. */ });
rtc.on('message', message => { /* Render the received message. */ });
rtc.on('error', error => { /* Display/log error.message and error.code. */ });
await rtc.init({ serverUrl, appId, userId, token }); // token from your backend
// After roomJoined and a user action:
rtc.sendMessage('Hello');
// Voice/video require the corresponding plan and microphone/camera permissions.
```

## Test with two identities

Use two distinct users in the same project and room. Test chat, voice, video, hangup, rejection, reconnect, permissions denied, and Wi-Fi/mobile-data switching. Then repeat using two projects with identical user and room IDs and verify isolation. Use real Android and iOS devices before promising background call behavior.

## Find failures

Open Portal → Diagnostics and search by exact call ID. Events, calls, quality reports, and push attempts use the filter; webhook delivery records show recent activity for the entire project. Quality information appears only when the client submits reports.

| Error | What to check |
|---|---|
| `plan_feature_denied` | Feature is not in the current plan. |
| `room_scope_denied` | Token was issued for a different room. |
| `invalid_call` | Call expired, ended, or the sender is not a participant. |
| `call_busy` | One participant already has an active call. |
| `message_failed` | Check server logs using the request ID and reproduce on staging. |
| HTTP 401 | Token expired or portal session was revoked; authenticate again. |
| HTTP 403 on SFU | Room membership, role, or plan denied the operation. |
| HTTP 503 on SFU | Verify `SIGNALING_URL` and signaling readiness. |

See [notification setup](MANAGED-PUSH.md) and [startup operations](STARTUP-OPERATIONS.md).
