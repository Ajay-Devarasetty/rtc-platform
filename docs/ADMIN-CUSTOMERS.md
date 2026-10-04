# Admin customer and payment reporting

Open the existing administrator dashboard at the backend domain (`https://rtcplatform.duckdns.org/admin/`), sign in with the administrator key, and select **Customers & payments**. Do not distribute the administrator key to customers. The marketing/customer website and this dashboard are separate builds.

The directory includes signup name/email/company, project, assigned plan, registration date, customer-provided business profile, verified payment count, cumulative amount paid and latest payment date. Search covers name, email, company/business name and App ID. Filter customers with/without verified payments; each page contains 25 accounts. Customer details show paginated payment IDs, plan/term, amount, refunds, status, payment/verification dates and purchased period. Times use the admin's browser timezone.

All-time INR totals show registered customers, distinct paying customers, verified transaction count, gross payments, refunds, and gross less refunds. Totals do not change with directory filters. Net here does not subtract provider fees. Amounts are stored as integer paise and serialized as strings. Only payments with a verified timestamp, paid timestamp and paid/partially-refunded/refunded status count; assigned paid plans, usage cost estimates, pending/failed transactions and unverified records do not count. Fully refunded transactions remain part of historical payer/gross counts and their refunds reduce net totals.

Customer business profiles are edited under **Account settings → Business & billing profile** on the customer website. These fields are self-reported, not KYC verification: individual/business type, trading name, phone, website, address, city, state, postal code, country and optional GST/tax identifier. Existing signup company is shown separately; missing fields remain missing. No passwords, provider keys, device tokens, payment-card details or bank credentials are exposed by these endpoints.

## Payment integration remains pending

Instamojo checkout and server-side verification are not connected. The UI explicitly states this. Migration 017 creates the payment ledger for that integration, but no customer/admin HTTP endpoint can fabricate or mark a payment paid. Do not populate it from client callbacks or manually assigned plans. A future trusted payment integration must verify provider status, payer/order association, expected amount/currency, and record the provider's unique payment ID idempotently; plan activation, expiry, renewal and refunds are separate work. Update the `paymentIntegration` response and UI notice when that integration actually exists.

## Deploy

1. Deploy signaling: migration `017_customer_reporting.sql` runs on startup.
2. Rebuild the VM's admin dashboard using the existing `web-build` service:
   `sudo docker compose -f docker-compose.prod.yml --env-file .env.production build web-build`
   then `sudo docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps web-build`.
   This refreshes the static files in the volume already served by Caddy.
3. Reload the Caddy routes: `sudo docker compose -f docker-compose.prod.yml --env-file .env.production exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`. The backend root and old `/dashboard/` paths now return 404; only `/admin/` serves the admin UI.
4. Deploy the customer website to publish the business-profile form and remove the public admin link.

Admin APIs `GET /v1/admin/customers` and `GET /v1/admin/customers/:accountId` require `x-admin-key`; customer bearer tokens cannot access them. Portal APIs `GET/PUT /v1/portal/business-profile` validate the portal session version and derive the account from authenticated App ID, never caller-supplied account IDs. Responses use no-store caching. Profile updates are rate limited and bounded; admin queries are parameterized and paginated.

The admin URL is not linked from the customer site. Anyone who knows its URL can reach the login screen, but all customer/payment records still require admin authentication. The URL and noindex directives are not access controls.
