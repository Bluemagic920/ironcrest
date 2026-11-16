# November 17 release target

Development checkpoint: November 15, 2026. Target: November 17, 2026 (America/Phoenix).
This is a development target, not production authorization or a promise of launch readiness.

## Smaller fixes completed first

- Attendance write receipts explicitly project public fields; arbitrary privileged RPC fields are no longer forwarded to employees.
- CI syntax checks now include Worker modules and CommonJS test files.

## Invitations, attendance and geofencing

Existing application tests pass. Database regression suites are now versioned under `tests/database`, rather than existing only in a previous workspace. They initialize disposable loopback-only PostgreSQL clusters with invented users and stop them in cleanup. They never use hosted credentials or production records. PostgreSQL logs remain in the OS temporary directory for diagnostics.

Run application checks with `node --test tests/*.test.cjs tests/*.test.mjs`.
Run database checks with `node --test tests/database/*.test.cjs`.
Set `IRONCREST_PG_BIN` to the PostgreSQL binary directory if needed (Windows default: PostgreSQL 17; Linux default: `/usr/lib/postgresql/17/bin`). CI uses `pg_config --bindir`.

Database coverage includes invitation reservation capacity, simultaneous acceptance, wrong-recipient denial, revocation, one-time delivery claims, concurrent shifts, exact-shift recovery, permission revocation, geofence accuracy/freshness/bounds and transaction rollback. The existing acceptance-function SQL is a **test fixture**, not a migration or deployment source. These fixtures cannot prove hosted schema compatibility or real-device GPS behavior.

The full deployed Worker is still not versioned here. Do not replace it with an old workspace candidate without comparing the active deployment, preserving its existing release approvals and controlled-test restrictions, and rebuilding it with current modules. `createAttendanceWorkflowRoute` continues to default to `releaseApproved=false`.

## Business billing component prepared

`worker/business-billing.mjs` provides catalog validation, monthly/annual Business and employee/unlimited add-on interpretation, fresh paid-invoice verification, timestamp-bounded raw-body HMAC verification, lifecycle event dispatch, and explicit reconciliation hooks for refund/dispute/fraud events. It rejects unknown prices, mixed intervals/currencies, partial item lists, duplicate bases, mismatched customers/products, unpaid invoices and unsupported compositions. Trials do not grant access. Paid cancellation at period end preserves access until expiry. Paused, expired, canceled and failed subscriptions do not grant access.

Chris confirmed Ironcrest is included in ProfitHarbor AI Business. The connected live Stripe account was inspected read-only on November 15 and confirms **$129.99 USD/month** and **$1,325.90 USD/year**, matching Chris's screenshot. `worker/business-catalog.mjs` records those exact live product/price IDs and the existing **$49.99 USD/month unlimited-employees add-on**. The current hosted entitlement function supplies **20 employees** for Business; no arbitrary per-seat package is approved.

The inspected hosted helper currently reads legacy `ph_subscriptions_live` rows and only has a monthly Business mapping. It does not read `ph_business_subscriptions_live`; annual Business is absent from its price mapping. `docs/business-entitlement-proposal.sql` prepares a separate, service-only v2 helper supporting both verified Business prices, current Business rows, conservative legacy compatibility, preserved lifetime owners and unlimited add-ons. A canceled current record blocks stale legacy fallback. This SQL was tested in a disposable local database but **was not applied to hosted Supabase**. The live helper and all production callers remain unchanged. Integration must verify the writer's subscription-type conventions and explicitly switch approved callers to the new helper.

The catalog is an explicitly supplied server configuration. General test catalog IDs/counts remain invented fixtures; a separate test verifies the observed live catalog. Subscription validation checks the exact unit amount and Stripe mode as well as price, product, currency and interval. Ordinary Pro subscriptions are never automatically Business subscriptions. Lifetime entitlements and legacy billing rows are not modified.

The module is **not imported into a production entry point** and defaults to a closed source approval gate. It also requires `ENABLE_BUSINESS_BILLING=true`, an explicit `BUSINESS_STRIPE_MODE` and a separate `BUSINESS_STRIPE_WEBHOOK_SECRET`. Do not reuse a live webhook secret in a test environment.

Persistence is a required adapter contract, not an implemented database integration:

- `withCustomerLock(customerId, callback)` must durably serialize access, resolve immutable customer-to-owner mapping, reject replacement subscriptions pending reconciliation and expose transactional `hasEvent` and `commitEvent` methods.
- `commitEvent` must atomically journal the event and update only the mapped owner's Business entitlement. A failed transaction must not journal success or lose the prior entitlement.
- `reconcileRisk(event, stripe)` must resolve Stripe object relationships, durably journal and suspend/reconcile affected entitlement. Missing or failing reconciliation returns a retryable error.
- Stripe retrieval adapters must use the approved account, API version, bounded requests, complete item lists, and fresh subscription/invoice reads under the lock.

The webhook orchestration tests use mock adapters. They validate component behavior, **not database durability or actual Stripe webhook delivery**.

## Stripe sandbox observations

On November 15, the connected isolated ProfitHarbor AI sandbox was used to create a separate Business test product with monthly USD 129.99 and annual USD 1325.90 prices. An invented customer with a Stripe test PaymentMethod produced active subscriptions and paid invoices for both intervals. Both subscriptions were then canceled without proration or additional invoices. No real payment, email recipient or hosted entitlement was involved. Test product, prices, customer and canceled subscription history remain in the sandbox for review.

`tests/fixtures/business-sandbox.json` contains only projected subscription/invoice response fields needed by the tests, including paid and canceled states. No payment credential, invoice access link or client secret is included. These real API responses exposed that current invoices omit the older `paid` boolean. The component checks `status='paid'`, zero remaining amount and matching subscription/customer/mode/currency; an explicitly false legacy `paid` field is rejected. Actual invoice fields now have regression coverage.

The first customer-fixture attempt used a legacy card token and was rejected by Stripe, triggering a deprecation notice. It was corrected to a PaymentMethod before the successful tests. No legacy API policy was enabled and no legacy token integration was added to the application. Chris confirmed tax is not currently collected; sandbox subscriptions had automatic tax disabled and live tax settings were unchanged.

Current validation: 142 application checks, 29 disposable PostgreSQL results (including suite parent results), Worker syntax checks and HTML inline syntax checks pass locally. GitHub CI passed after correcting private Unix socket configuration for the Linux database runner; the expanded Business changes require a fresh CI pass.

## Work required before approval

November 15: live Business catalog and current entitlement schema inspected read-only; monthly/annual catalog and v2 entitlement proposal prepared. Still locate the authoritative active billing deployment and compare the active Ironcrest Worker with candidate sources. This repository lacks a complete Business checkout implementation and production billing persistence adapter.

November 16: implement and database-test durable checkout reservations, customer mapping, event journaling, entitlement synchronization and risk reconciliation against that contract. Connect checkout, portal and lifecycle handling in the authoritative ProfitHarbor billing service. Run isolated Stripe integration checks for monthly/annual purchases, add-ons, async payment, renewal/failure/cancellation, duplicate/out-of-order events, lost responses and refunds/disputes. Confirm tax registrations and recurring-payment tax configuration before enabling tax collection; see [Stripe recurring taxes](https://docs.stripe.com/billing/taxes/collect-taxes).

November 17: review exact migration and Worker/frontend artifacts, passing CI and test-environment evidence, rollback instructions and one agreed real-device acceptance procedure. If any dependency remains incomplete, keep the corresponding feature gated and report the launch gap.

**Production approval gates:** merging/publishing frontend changes, applying hosted migrations, deploying Workers, changing feature flags, changing live Stripe prices/settings/webhooks and performing a real invitation or attendance acceptance check all require explicit approval. No production action is authorized by the target date. Preserve production records during rollback; disable newly introduced gates rather than deleting data.

## Sandbox webhook failure notice — November 15

Stripe reported 18 HTTP 503 delivery failures to `profitharbor-ai-billing-staging.bluemagic920.workers.dev/api/stripe-webhook`, starting November 9. A fresh staging `/health` read confirmed version `v2-sandbox-console1`, `stagingV2Configured=false`, `webhookProcessingEnabled=false` and `webhookDryRunEnabled=true`. The preserved staging source intentionally returns 503 for signed dry-run events rather than claiming they were processed. The earlier staging handoff records that billing was paused November 9.

Only sandbox endpoint `we_1UWddCAJcPWZlA8suKype957` in account `acct_1UWd69AJcPWZlA8s` was temporarily disabled using `disabled=true`. A subsequent Stripe read confirmed its status is disabled and the separate Zeus One endpoint remains enabled. Endpoint URL, events, API version and signing secret were preserved. No production setting, Worker deployment or database change occurred. Disabling delivery resolves the enabled-endpoint/paused-handler mismatch; it does not repair or certify webhook processing.

Before re-enabling, integrate and verify durable event processing in the isolated sandbox, including customer mapping, paid invoice verification, atomic entitlement updates, duplicate/out-of-order events and failed writes. Review retained Stripe events and reconcile any required missed sandbox state; do not replay events blindly or mark dry-run deliveries as processed. The original staged handler was monthly-Pro-only, so the new Business API tests do not establish compatibility with that handler. Re-enable this existing endpoint only when the intended handler is ready, then verify actual signed delivery and database effects.
