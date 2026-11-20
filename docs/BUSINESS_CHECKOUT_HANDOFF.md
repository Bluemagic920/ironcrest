# Business checkout handoff — November 16, 2026

This records work done after the [webhook and invitation review package](WEBHOOK_AND_INVITATION_RELEASE.md). It supersedes two statements in the earlier notes, marked below.

## What changed in production

Approved by Chris and applied to hosted Supabase (`nhiqbcevcdxfzvrprgck`) on November 16:

- Migration `ironcrest_business_checkout_onboarding`, corrected by `ironcrest_business_checkout_remove_auth_lookup`.
- **New** `public.ironcrest_business_checkout(mode, user, operation, data)`, service-role only. Operations `status`, `prepare` (creates the buyer's organization, owner membership and settings rows) and `customer` (inserts the immutable `ironcrest_billing_customers` mapping). This is the trusted enrollment path the review package required; nothing is derived from Stripe metadata or the browser.
- **Replaced** `public.ironcrest_business_entitlement(organization)`. It now also grants access for an active, paid `mode='live'` Business snapshot, using the same owner, expiry and review-hold rules as `ironcrest_webhook_business_entitlement`. Results for lifetime owners and legacy `ph_subscriptions_live` rows are identical to the previous definition, and test-mode snapshots never grant access.

Superseded statements:

- "The live helper and all production callers remain unchanged" (November 17 release target). The helper is now the composite; callers are unchanged and need no redeploy.
- `docs/business-entitlement-proposal.sql` (the `_v2` helper reading `ph_business_subscriptions_live`) was not applied and is not needed for this path.

Verified after applying: the existing company still returns `LIFETIME_BUSINESS` with 20 employees; row counts are unchanged; `anon` and `authenticated` cannot execute the new function. No rows were created or changed.

The source and tests are in the ProfitHarbor site repository (`wealthforge-ai`, pull request 5): `docs/business-checkout.sql`, `worker/business-api.mjs`, `ph-business.js`, `docs/BUSINESS_LAUNCH.md`.

## What is not deployed

- **Checkout Worker** `profitharbor-business-api` (from `wealthforge-ai/worker/business-api.mjs`). Not created. The site keeps "Coming Soon" until it reports live checkout open.
- **Production webhook Worker.** Not deployed. Build with:

  ```
  node tools/build-business-worker.cjs --production-approved
  ```

  Without the flag the build is unchanged and stays closed. The flag opens only the source gate; the Worker still requires `ENABLE_BUSINESS_BILLING=true`, `BUSINESS_STRIPE_MODE=live`, `BUSINESS_STRIPE_KEY` (live), `BUSINESS_DATABASE_KEY`, `SUPABASE_URL` and `BUSINESS_STRIPE_WEBHOOK_SECRET`. Register `/api/business/billing/webhook` in live Stripe for the same events as the sandbox endpoint.
- **Pro features for Business members.** `profitharbor-ai-live-api` still grants the AI Assistant and unlimited customers only for the Pro price.
- **Live Stripe settings.** Unchanged.

## Constraints the checkout enforces

- Checkout never sets `ph_user_id` metadata, so the Pro webhook ignores Business customers and subscriptions.
- An account with an active Pro subscription not set to cancel is stopped before payment.
- Because webhook processing rejects a replacement subscription, an account with any earlier Business subscription is stopped before payment and sent to support. Reactivation needs the guarded reconciliation described in the review package.
- Employees and accounts with ambiguous memberships cannot create a company.
- The owner test account has lifetime Business and is stopped before checkout; a sandbox purchase test needs a different verified account.

## Pending acceptance

Sandbox purchase through the checkout Worker in test mode, then live activation. Hosted refund, dispute and declined-payment acceptance from the review package are still open. Every deployment, flag change and live Stripe change remains a separate approval.
