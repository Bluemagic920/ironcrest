# General attendance release — prepared, not activated

November 12, 2026. This is a reviewable next release, not a declaration that all of Ironcrest is launch ready. No general attendance writes or billing were enabled by this work.

## Behavior

Verified employees with exactly one active company membership, an active company owner, and current Business access can record a shift at an active assigned worksite. Each action uses a fresh location sample (30 seconds maximum age, 5 seconds maximum clock lead, accuracy at most 100 metres). The database independently verifies that the entire accuracy circle is inside the employer's boundary. GPS can be spoofed; this is not proof of physical presence.

The server derives employee and company identity. The browser cannot supply an organization, employee, role, timestamp for the recorded attendance, or arbitrary update fields. Current-shift reads are scoped to that employee and company and expose only active assigned worksite names. Coordinates are not persisted in the new journal, attendance entry, audit, or browser recovery marker. Recorded worksite identity remains part of the attendance record.

A service-only transaction commits the shift, audit event, and request journal together. The existing global unique index allows one open shift per employee. Employee locking and transaction advisory locking serialize competing requests. Clock-out targets the exact previously displayed shift, never whichever shift happens to be open later.

Each action has an operation ID. A replay with that ID returns the original result after current company access is rechecked; changing its action, worksite, company or expected shift is rejected. The employee screen never automatically retries a write. It stores only operation identity in session storage before submission. An interrupted receipt blocks new actions and offers explicit recovery of that same operation. It retains the marker across reload and account switches. A corrupted marker requires owner review. If storage is unavailable, no new write is attempted.

## Files and isolation

- `worker/attendance-workflows.mjs`: new routes at `/api/attendance/workflows/status`, `/clock-in`, `/clock-out`.
- `attendance-workflows.js`: employee controls and explicit recovery.
- `docs/attendance-workflows-proposal.sql`: one new server-only request journal and one invoker function, not applied to the hosted database.
- `tests/attendance-workflows.test.mjs` and `tests/attendance-workflow-view.test.cjs`: application and recovery tests.
- Workspace `work/ironcrest-live-integration/attendance-release/worker-candidate.mjs` and `employee-portal.html`: complete release candidates, not the current deployed files.
- Workspace `test-attendance-postgres.cjs`: isolated PostgreSQL concurrency, privilege, geofence and atomic rollback checks.
- Workspace `test-attendance-release.mjs`: integrated source gate, health, legacy-preservation and portal parse checks.

The complete Worker has `GENERAL_ATTENDANCE_RELEASE_APPROVED = false`. Both explicit source approval and `ENABLE_ATTENDANCE_WORKFLOWS=true` are needed to activate the new paths. Changing the environment alone cannot activate this prepared artifact. The existing controlled test employee/org/worksite, clock handlers and opt-in restriction are preserved. The candidate portal keeps those controls in a collapsed diagnostics section; they are not converted into a general bypass.

## Validation completed

143 application/integrated/DOM checks and 54 isolated PostgreSQL checks passed (197 total). Database tests use invented local records, not live employees. They cover duplicate and competing clock-ins/outs, exact-shift replay after a later shift begins, revoked employee/owner/assignment/site/Business access, inaccurate/stale/future/NaN location values, public-role denial, parameter changes and journal failures rolling back both shift and audit. Application checks cover account switches, stale replies, duplicate clicks, lost receipts, durable recovery identity, storage failure, scoped reads and unauthorized sites.

The browser preview used sample responses only. Sample clock-in, a lost clock-out receipt and explicit recovery were observed successfully. A real employee device's GPS and a real hosted write through these new routes have not been exercised. The normal employee job status write UI is likewise not independently observed in the connected browser, although its route and database transaction were tested.

## Approval and release steps

General attendance activation still needs Chris's explicit approval, as required by the original task. Do not interpret “finish Ironcrest” as removing that specific restriction. After approval:

1. Compare the actual deployed Worker against the recorded v52 baseline; stop on unexpected edits.
2. Inspect the hosted schema and preserve existing rows/constraints. Apply the reviewed new journal/function migration using Supabase migrations, with no employee records inserted. Confirm RLS and anon/authenticated execution denial plus service-only grants.
3. Change only the prepared general-attendance source approval constant, verify the approved artifact, and deploy it with the existing secrets and restrictions preserved. Add only the new attendance environment gate. Preserve the existing controlled-test setting.
4. Publish the candidate employee portal and new script without replacing unrelated repository files. Verify health truthfully reports the new attendance gate and existing feature state.
5. Conduct one explicitly agreed real employee/device acceptance check and verify the exact resulting entry, audit and operation. Do not invent an employee or submit a simulated GPS reading to production. Disable the new gate if acceptance fails; preserve the records for review.

## Remaining launch scope

Paid Business sales are not wired into the current live ProfitHarbor billing handler. Read-only inspection of Cloudflare active version `d7e6dc89` showed subscription reads/writes only through `ph_subscriptions_live` and one configured `PH_PRICE_ID`; no Business-table writer or Business/unlimited product routing was present. The hosted `ph_business_subscriptions_live` table had zero rows at inspection. The Ironcrest helper still recognizes lifetime Business owners and mapped active unexpired subscriptions from the legacy table, with the existing monthly-only price map. It must not be “fixed” by trusting a browser flag or granting all Pro subscribers Business access. Annual Business/add-on routing and entitlement synchronization require a separate tested billing implementation before paid Business launch. No Stripe setting, price, webhook, subscription, billing flag or owner lifetime entitlement was changed here.

Attendance correction/exception approval and payroll integration are separate unfinished workflows; the current owner attendance report remains read-only. An employee whose assignment has been removed is directed to the owner rather than allowed to bypass it. ADP remains deferred at Chris's request. This release does not approve payroll or claim GPS prevents spoofing.
