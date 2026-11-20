# Ironcrest release verification

November 20, 2026 (Arizona). This records the observed deployment and supersedes older status statements in the attendance and invitation release notes.

| Area | Observed in production | Remaining acceptance |
| --- | --- | --- |
| Employee invitations | The Worker reports owner invitations and recipient acceptance available. The separate legacy creation and sending flags report disabled. | Compare the active Worker source, deploy the reviewed invitation recovery routes, then publish the matching recipient page. Verify one agreed invitation from delivery through acceptance and receipt recovery. |
| Profiles, jobs and scheduling | The Worker advertises employee profiles, scheduling, employee job workflows and job updates. Supabase has the corresponding tables and restricted write functions. | Verify owner and employee flows with agreed test accounts, including assigned jobs and published shifts. |
| Owner controls | The site contains company settings, worksite and employee management, scheduling, job assignment and attendance reports. | Verify the authenticated owner flows. The Worker reports attendance corrections unavailable. |
| Geofenced attendance | Worker `0.8.54-attendance-corrections` reports general workflows and attendance writes enabled. Supabase has the operation journal, service-only write function and unique open-shift index. | Verify the active source and feature variables, then complete the controlled real-device test below. |
| Business access | Hosted Supabase has the composite entitlement and checkout RPCs. The sandbox webhook reports configured in test mode. The proposed Business checkout Worker health endpoint returned 404. The database has zero live Business webhook customer mappings and snapshots. | Verify sandbox checkout and hosted payment-failure, refund and dispute handling. Obtain separate verification and approval for paid billing. |

The release branch includes the reviewed invitation recovery and Business webhook code. It keeps the live billing source gate closed by default. GitHub Pages publishes from `main`, so hold the branch until the invitation backend and corresponding frontend can be released together.

## Verification performed

The public site and Worker health endpoint responded. Read-only Supabase catalog checks confirmed RLS on the Ironcrest tables, denial of browser-role execution on the attendance, invitation, profile, scheduling, job and billing write RPCs, and no browser-role table grants on the attendance journal or billing storage. The security advisor flagged the job-assignment trigger's mutable search path. Its hosted definition is an invoker trigger with schema-qualified table references. Review and clear the finding before signing off. The database inspection made no changes to records or configuration.

The combined candidate passed 174 application tests and 40 isolated PostgreSQL results. Database checks bind disposable clusters to IPv4 loopback and use fixture records. No authenticated production flow or physical GPS sample was exercised.

## Controlled attendance acceptance

1. Compare the active Cloudflare deployment with the reviewed source and confirm the general and restricted-test settings separately. Record the previous deployment for rollback. Verify the hosted RPC definition and resolve relevant advisory findings before sign-off.
2. Identify an existing consenting employee test account with an active assigned test worksite and no open shift. Use a physical device with location permission. From beyond the configured boundary, confirm a clock-in is rejected and creates no shift.
3. From inside the boundary, record one clock-in and one clock-out through **My current shift**. Verify both receipts reference the same shift, each operation appears once in the journal and audit, the shift is closed, and the owner report agrees.
4. If acceptance fails, suspend the general attendance workflow using the existing release gate once the authorized operator has verified the active configuration. Retain the records and receipts for review.
