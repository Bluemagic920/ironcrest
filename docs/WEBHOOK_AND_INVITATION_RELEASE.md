# Webhook processing and invitation recovery — review package

November 15, 2026. This checkpoint supersedes the earlier adapter-only billing status. Implementation and local integration are complete for the scope below; hosted delivery acceptance and production rollout are not complete.

## Webhook implementation

`worker/business-billing-entry.mjs` constructs the complete handler from the verified catalog, Stripe retrieval adapter, Supabase RPC adapter and durable database store. The source defaults to production approval off. Test and live price IDs, keys, events, customer mappings, journal entries and snapshots are separated by explicit mode. The default entry handles `/api/business/billing/webhook`; it does not replace an existing billing service by itself.

`docs/business-webhook-storage-proposal.sql` adds three new RLS-protected, service-only tables: `ironcrest_billing_customers`, `ironcrest_billing_events` and `ironcrest_billing_snapshots`. It adds the event-operation RPC, an entitlement-read RPC and an immutable-mapping trigger/function. It does not change existing customer, subscription, lifetime, employee, attendance or invitation records, and does not replace any existing entitlement function. This proposal has been executed only in disposable local PostgreSQL clusters. It has not been applied to hosted Supabase.

The store serializes deliveries using durable customer leases with expiring fencing tokens. A stale holder cannot commit or release a newer lease. Event journaling, snapshot updates and subscription pins commit in one transaction. A duplicate receipt does not overwrite a newer snapshot. Every processing attempt retrieves current Stripe state under the lease rather than applying stale event payloads. A failed or uncertain commit returns a retryable error; there is no blind write retry.

Monthly/annual Business and the separately subscribed unlimited add-on have independent subscription pins and snapshots. An add-on cannot grant Business by itself. Canceling the add-on retains the paid base employee allowance. A matching unpaid invoice records inactive access that can recover after a later verified paid event. Unknown compositions require review rather than granting access. Business snapshots require exact approved price, product, amount, currency, interval and Stripe mode.

Refund/dispute/fraud handling resolves current Charge → PaymentIntent → paginated InvoicePayment → Invoice → Subscription relationships. Each affected mapped account receives a durable review hold; ordinary later paid events cannot clear it. Old-subscription refunds can suspend current access without replacing its subscription pin. Complete, verified unrelated product events are ignored; relevant Business events arriving before customer enrollment remain retryable. Unresolved linkage is not falsely acknowledged as processed.

Customer enrollment must use the existing approved application's authenticated owner and organization, plus a verified Stripe customer receipt from trusted checkout code. Never derive it from customer/subscription metadata supplied by a browser. The customer table has no browser privileges, no public enrollment endpoint, and a trigger prevents reassignment of mode/customer/owner/organization. Do not create invented `auth.users` or employee records in the hosted project for these tests.

`ironcrest_webhook_business_entitlement(organization, mode)` reads these receipts only. An explicit `test` read cannot grant live access. The helper rechecks current owner membership and expiration, composes a paid base with its add-on and denies held accounts. It does not override lifetime or legacy sources. Wiring a reviewed composite entitlement into production callers is a separate approval-gated billing rollout step.

## Existing staging service

The active `profitharbor-ai-billing-staging` Cloudflare version was inspected read-only as `46c38de7`, with service version `v2-sandbox-console1`. Its source matches the saved staging baseline after normalizing line endings:

`084f64b511d6ce17c18ad56970c57b015adffd1ca960e75b137d9f92fc133713`

`tools/build-staging-business-worker.cjs` requires the inspected baseline and its SHA256 before producing a single-file review candidate. It preserves the legacy handler inside a wrapper. The sandbox bridge defaults to a closed source approval flag. Once approved, the dedicated Business path can use the existing staging test key, signing secret and database binding without copying their values into source. An additional `ENABLE_BUSINESS_WEBHOOK_BRIDGE=true` would route the old `/api/stripe-webhook` URL to the sandbox Business handler; absent that explicit flag, the old Pro/diagnostic path remains delegated to the original Worker. The bridge forces test mode and rejects live keys regardless of environment overrides. The Stripe API version matches the existing staging integration: `2026-10-28.endive`.

No Worker source or setting was saved/deployed during inspection. The previously disabled Stripe sandbox endpoint remains disabled. The separate Zeus One endpoint and live billing are unchanged.

## Invitation implementation

The recipient page now offers **Check invitation status**. This is a read-only way to resolve a lost acceptance receipt using the retained private invitation token and the current verified account. It checks the exact token hash, recipient email, accepted invitation, active matching membership, active owner and Business access. It cannot create or reactivate membership. Unverified/wrong accounts, revoked membership, mismatched provider rows and ambiguous active memberships are denied.

Acceptance uses one atomic existing `ironcrest_accept_invitation` RPC with a server-derived actor and token hash. Unknown outcomes are reported as uncertain without automatic retries. Public replies omit provider/private fields. The page rechecks the displayed account before posting; an account switch invalidates late replies, prevents posting under a replacement session and preserves the invitation until verified success. Owner invitation and delivery lists now reject foreign-company provider rows.

The active `ironcrest-invitations-api` version was inspected read-only as `07a2c4a4`, service version `0.8.54-attendance-corrections`. Its normalized source fingerprint matches the saved baseline:

`d3dd783b13b0d7dcc215bf5fdf9f90cfe61cd4af0179b514426368e6125a1287`

`tools/build-invitation-worker.cjs` requires the inspected baseline SHA256. It updates only the embedded owner-invitation module, the previously reviewed attendance receipt projection and the new invitation wrapper. Existing attendance/correction source approvals and unrelated routes remain preserved. The recipient status/acceptance replacement defaults to a closed source flag. On approved activation, `/health` exposes `invitationStatusAvailable` truthfully. The prepared service version is `0.8.55-invitation-recovery`.

Deploy the reviewed backend before publishing the updated recipient page. No live invitation email, employee acceptance or production membership write was performed in this checkpoint. A real invited employee acceptance remains an explicitly agreed acceptance test, not a local test claim.

## Evidence and approval boundary

169 application/adapter/DOM/generated-bundle checks and 40 disposable PostgreSQL results pass (the database count includes parent tests). All Worker modules and five HTML inline scripts pass syntax checks. The database suite exercises actual SQL transactions, privilege denial, immutable mapping, competing leases, stale fencing, duplicate events, atomic rollback, separate add-ons, review holds and the signed Worker → adapter → local SQL → entitlement path. Stripe reads in that integrated test are fixtures; the real earlier sandbox paid/canceled API responses remain separately captured. Actual Stripe → deployed Worker → hosted RPC delivery has not yet been verified.

Before hosted testing, approval is required to install this reviewed isolated storage in the existing shared Supabase project, enroll only the approved test owner/customer mapping and deploy/enable the sandbox-only Worker bridge. Confirm the active source fingerprints again immediately before deployment; stop on unexpected edits. Re-enable only the intended sandbox endpoint after the new path is ready, verify real signed delivery and exact journal/snapshot results, replay an agreed existing event to verify deduplication, then test payment failure/cancellation/risk behavior. Do not replay historical events blindly.

Production billing activation, live Stripe settings, a production invitation Worker deployment and recipient-page publication remain separate approval gates. Roll back by disabling the new bridge/gates or returning to the preserved deployment; retain journals, snapshots and mappings for reconciliation. Disabling a gate is not permission to delete records or clear review holds.
