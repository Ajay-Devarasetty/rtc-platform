# Non-payment fixes — 2026-09-25

Implemented locally; not deployed. No mobile binaries were rebuilt.

## Changes

- Scope signaling sockets, presence, room membership, roles, call IDs, media rooms, recording sessions, and CDN sessions by customer App ID. SDK-facing user and room IDs remain unchanged.
- Check call participants before accepting, rejecting, ending, or relaying WebRTC signaling. Preserve the original call type and reject client role elevation.
- Serialize signaling mutations within each project so accept/end, join/send, and reconnect/cleanup operations do not race across sockets on the same instance. Catch asynchronous handler failures.
- Emit `call.ringing` even when the recipient is offline. Keep the pending invite for up to 60 seconds, replay it when the recipient reconnects to the same signaling instance, and expire unanswered calls. Disconnect and room departure notify the peer and close tracked usage.
- Persist chat before delivery and validate history pagination.
- Enforce media room scope and consult `/v1/media/authorize` for current membership, role, and plan checks before direct SFU operations. Refuse operations if authorization is unavailable.
- Scope recording/stream control to the customer's room, enforce host access, permit stops after a downgrade, and retain retryable state when stopping a recording/stream fails. Failed starts release their reservations.
- Include active one-to-one calls in usage totals and preserve millisecond precision when closing database sessions. This does not implement monthly allowances or hard cutoffs.
- Keep the portal session on temporary backend/network errors, provide retry, and escape customer-supplied display text.

## Validation

- Signaling TypeScript build passed.
- Media SFU TypeScript build passed.
- Website production build passed.
- 31 signaling tests and 3 media-authorization tests passed. These include project isolation, call participants, offline invites, current-plan enforcement, recording failures, task ordering, host preservation on reconnect, and active call metering.
- An isolated live local WebSocket smoke test passed for chat delivery, customer isolation, malformed-message recovery, and reconnect/host preservation, using temporary test credentials and no database or Redis.
- Database-dependent authorization tests use a mocked PostgreSQL query layer. Real PostgreSQL/Redis, SFU media transport, and physical-device behavior still require staging integration tests.

## Deployment requirements

Deploy signaling and media SFU together and reconnect clients: internal room/relay keys have changed. Do not mix old and new instances against the same room/presence data.

The SFU now needs `SIGNALING_URL`. Production Compose uses `https://${DOMAIN}`; development Compose uses `http://signaling:4000`; local processes default to `http://127.0.0.1:4000`. The authorization request has a five-second timeout and denies access on failure.

Call state, role state, pending invites, and project task queues are still in process memory. Use one signaling instance for this configuration; multi-instance call coordination and persistence across server restarts are not implemented by these fixes.

## Deferred work

- Payment checkout, subscriptions, renewal/expiry, and the business policy for hard minute cutoffs versus overage.
- A unified billing policy for one-to-one call minutes versus group participant-minutes; group session usage remains separately tracked.
- Managed Firebase/APNs delivery and device token registration. The webhook can trigger a customer's configured notification backend; it is not itself a phone push notification.
- Device verification of background/terminated-app incoming calls and the updated signaling/media flows before production rollout.
