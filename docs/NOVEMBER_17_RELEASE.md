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

Chris confirmed Ironcrest Business at **$129.99** on November 15. The existing product page identifies this as a monthly price; monthly cadence and USD are working assumptions to confirm in the Stripe catalog before production approval. Annual pricing and employee/add-on terms remain unconfirmed.

The catalog is an explicitly supplied server configuration. Test catalog IDs and employee counts are invented fixtures, not approved commercial terms. Ordinary Pro subscriptions are never automatically Business subscriptions. Lifetime entitlements and legacy billing rows are not modified.

The module is **not imported into a production entry point** and defaults to a closed source approval gate. It also requires `ENABLE_BUSINESS_BILLING=true`, an explicit `BUSINESS_STRIPE_MODE` and a separate `BUSINESS_STRIPE_WEBHOOK_SECRET`. Do not reuse a live webhook secret in a test environment.

Persistence is a required adapter contract, not an implemented database integration:

- `withCustomerLock(customerId, callback)` must durably serialize access, resolve immutable customer-to-owner mapping, reject replacement subscriptions pending reconciliation and expose transactional `hasEvent` and `commitEvent` methods.
- `commitEvent` must atomically journal the event and update only the mapped owner's Business entitlement. A failed transaction must not journal success or lose the prior entitlement.
- `reconcileRisk(event, stripe)` must resolve Stripe object relationships, durably journal and suspend/reconcile affected entitlement. Missing or failing reconciliation returns a retryable error.
- Stripe retrieval adapters must use the approved account, API version, bounded requests, complete item lists, and fresh subscription/invoice reads under the lock.

The tests use mock adapters. They validate component behavior, **not database durability or actual Stripe delivery**.

## Work required before approval

November 15: review commercial price/employee contract, locate authoritative billing deployment and schema, and compare active Ironcrest Worker with candidate sources. Current repository lacks an approved Business price catalog and checkout implementation.

November 16: implement and database-test durable checkout reservations, customer mapping, event journaling, entitlement synchronization and risk reconciliation against that contract. Connect checkout, portal and lifecycle handling in the authoritative ProfitHarbor billing service. Run isolated Stripe integration checks for monthly/annual purchases, add-ons, async payment, renewal/failure/cancellation, duplicate/out-of-order events, lost responses and refunds/disputes. Confirm tax registrations and recurring-payment tax configuration before enabling tax collection; see [Stripe recurring taxes](https://docs.stripe.com/billing/taxes/collect-taxes).

November 17: review exact migration and Worker/frontend artifacts, passing CI and test-environment evidence, rollback instructions and one agreed real-device acceptance procedure. If any dependency remains incomplete, keep the corresponding feature gated and report the launch gap.

**Production approval gates:** merging/publishing frontend changes, applying hosted migrations, deploying Workers, changing feature flags, changing live Stripe prices/settings/webhooks and performing a real invitation or attendance acceptance check all require explicit approval. No production action is authorized by the target date. Preserve production records during rollback; disable newly introduced gates rather than deleting data.
