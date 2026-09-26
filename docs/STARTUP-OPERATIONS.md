# Startup operations — local implementation, not a launch certification

## Staging and release

Use a separate VM/database/domain, JWT secret, admin key, app credentials, and notification credentials for staging. Do not attach staging to production databases or Redis. The current supported topology is one signaling process. Call/role state is not replicated across signaling processes and active media sessions cannot survive a server restart.

Run CI and [release gates](RELEASES.md), then `node scripts/check-health.mjs https://staging-host`. Point the separate website build at staging with `VITE_API_URL`. Deploy signaling and SFU together: SFU requires `SIGNALING_URL` to authorize media operations.

## Database backups

From the platform root on the operator's server, run `node scripts/backup-db.mjs /secure/backup/directory`. It reads the configured production Compose PostgreSQL service and writes an owner-readable custom-format dump, finalizing the filename only after pg_dump succeeds. Schedule this through the host's scheduler and copy completed backups to encrypted off-host storage using your chosen provider.

Run `node scripts/restore-drill.mjs /path/to/backup.dump` to restore into a new disposable PostgreSQL container with no exposed ports or shared production volumes. The script removes only that generated container when finished. It queries the core tables after restore. The scripts have not been run against the live database. Docker is required. Record backup age, restore result, and recovery time before accepting paying customers.

## Optional provider configuration

- Android push: `FCM_CONFIG_FILE`, pointing to a read-only mounted service-account mapping. See [push setup](MANAGED-PUSH.md).
- Account email: `RESEND_API_KEY`, `EMAIL_FROM` (a provider-verified sender), `PUBLIC_WEBSITE_URL` (HTTPS website origin). Email verification/reset use [Resend's sending API](https://resend.com/docs/api-reference/emails/send-email), with hashed single-use 30-minute tokens. No live mail provider has been configured or tested by this change. Request/consume routes are rate-limited.
- Secret rotation and password changes revoke existing portal sessions. RTC tokens are not revoked immediately; they expire normally. Email verification records status but is not yet a mandatory access gate for existing users.

Pass these variables explicitly through your deployment configuration and mount secrets server-side. Never put private keys or mail API keys into `VITE_*` variables. No credentials are required to build the code.

## Support and incidents

The website provides live readiness checks and the existing support email. It does not yet provide historical uptime monitoring, paging, or an SLA. Connect an external uptime monitor to `/ready` and `/sfu/ready`; route alerts to an operator before public launch. Do not treat an API readiness response as proof that media traverses real networks.

For reports collect App ID, call ID, UTC timestamp, SDK/app version, device/OS, and network type. Never request passwords, App Secrets, provider keys, or bearer tokens. Use portal diagnostics and server logs to correlate failures. Maintain a written rollback procedure and incident log.

## Retention and customer data

`node scripts/retention.mjs APP_ID DAYS` previews old chat messages, push attempts, and stale device tokens. `--apply` performs deletion transactionally for that project only. Minimum retention is 90 days in this tool; choose and document your policy before applying it. It is not scheduled automatically and was not run against customer data.

Call/event metering, accounts, and recordings are deliberately outside this cleanup tool. A complete customer export/deletion workflow, recording-file retention, backup expiry, and legal retention rules still need product/legal decisions. Do not advertise automated account deletion or a compliance certification yet.

## Costs and business readiness

Fill [operating-costs.csv](operating-costs.csv) from real provider invoices each month. Compare revenue against hosting, relay/media bandwidth, storage, email, monitoring, and support costs. Keep one-to-one call minutes and group participant-minutes separate until your pricing policy is chosen.

Before a public paid launch: review service terms, privacy/recording consent, refund policy, support commitments, and business/payment onboarding with appropriate advisers. No legal policies or SLA claims have been published by these changes.

## Still required

## Local validation on 2026-09-25

The platform, web SDK, React Native TypeScript package, website, demo, and dashboard builds passed. All 37 signaling tests and 3 media authorization tests passed. The Android SDK library compiled with Gradle; Flutter analysis passed with no issues. These are source/build checks, not a repeat of the phone acceptance tests. No APK was generated or package published.

Database integration checks are wired into CI but were not run locally because a disposable PostgreSQL/Docker environment was unavailable. Backup/restore scripts were not run against production. Email and push tests use mocked providers; live delivery still needs credentials and device testing. Nothing in this change was deployed.

## Remaining launch work

- Docker/PostgreSQL restore and migration integration checks on staging.
- macOS/iOS compilation and real-device cross-platform testing.
- Firebase/APNs account setup, incoming-call UI integration, and actual delivery tests. APNs sender is not implemented.
- Durable call recovery/shared state, multi-instance coordination, load tests, and historical uptime monitoring.
- Multiple projects/team roles per customer account.
- Payment checkout and the subscription/cutoff/overage policy, deferred by request.
