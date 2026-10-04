# Customer console

The `rtc-express-website` account console uses the existing portal session and a new set of authenticated routes in `packages/signaling/src/routes/console.ts`.

Deploy the signaling backend before the website. Apply migrations through `016_offline_notifications.sql`. Set `PUSH_CREDENTIALS_KEY` to a securely generated 32-byte key encoded as 64 hexadecimal characters to enable Firebase and APNs credential uploads. Back up this key separately; changing it makes existing encrypted credentials unreadable. On an older backend, the website displays an unavailable message for the new endpoints instead of fabricated data.

## Routes

- `GET /v1/portal/project`: the authenticated project's metadata and webhook configuration, excluding secrets.
- `PATCH /v1/portal/project`: rename that project with `{ "name": "My project" }`.
- `GET /v1/portal/reports?from=YYYY-MM-DD&to=YYYY-MM-DD`: inclusive UTC dates, at most 93 days. Daily one-to-one call minutes, persisted messages, and users/rooms with recorded events. Also returns up to 200 call sessions, group sessions, recording metadata, message-room summaries, and recently updated Android/iOS push-device registrations per section.
- `POST /v1/portal/test-token`: accepts `userId` and `roomId`; issues a 15-minute publisher token for the authenticated project. Reserved user IDs cannot be minted.
- `POST /v1/portal/verify-test-token`: verifies signature, expiry, and project ownership of an RTC user token.

All routes validate the existing portal session version. Project IDs supplied by a caller never override the authenticated project. Responses use `Cache-Control: no-store`. Report generation and token tools are rate limited.

## Report semantics

Call time is clipped into UTC days, including ongoing calls. Group sessions remain separate. Daily user and room counts are distinct IDs in recorded events: these are not peak concurrency, connected-user counts, or monthly unique users. Messages use persisted room messages; message text and device tokens are not exposed. CSV export applies to the currently loaded, filtered records and escapes spreadsheet formula prefixes.

## Product limits

The account model still supports one project per account. The UI does not create fake projects, wallet balances, payment history, package purchases, expiry dates, or invoices. Plan requests reuse the existing upgrade-request endpoint and include the requested monthly/yearly manual-renewal term. Checkout, pricing, entitlement expiry, and Instamojo verification remain separate work.

Webhook registration remains support-managed. Android Firebase and iOS APNs credentials can be uploaded, replaced, and removed under Service management ? In-app chat when secure storage is enabled. The console can inspect registered callbacks and push delivery diagnostics. Recording reports show metadata; playback is not offered. Secrets retain the existing one-time display and password-protected rotation flow.

## Validation

Run `npm test` and `npm run build -w @rtc/signaling` in this repository. Console tests cover date validation, authentication, revoked sessions, project isolation, rename scope, reserved-user rejection, and token expiry/verification. Browser checks use fixture data; live database and provider behavior must be verified after deployment.

## Push credential handling

Portal push settings endpoints authenticate project ownership and never return private keys. Android service-account keys are validated as RSA keys of at least 2048 bits, stored with AES-256-GCM and project-bound authenticated data, and used by the existing incoming-call sender. Upload verifies format, not Firebase IAM access or delivery. Removal disables the sender even when a legacy `FCM_CONFIG_FILE` entry exists. The legacy file is used only when the project has never saved or removed credentials through the portal.

Managed iOS APNs alerts/VoIP calls and queued Android/iOS offline chat alerts are implemented. See [Offline notifications](OFFLINE-NOTIFICATIONS.md) for device registration, persistent room subscriptions, delivery semantics, and native app requirements. Do not label a credential as verified until a real provider/device test succeeds.
