# ironcrest
Ironcrest — Workforce Operations


## Employee access regression checks

Run `node --test tests/*.test.cjs` with Node 22 or later. The tests use a local DOM/auth/network fixture and never contact the database, send emails, change passwords, or write attendance. CI runs these alongside the HTML inline-script syntax checks.

The portal invalidates prior jobs and worksite reads when authentication changes, including switches between employees in the same organization. A delayed job action cannot post using a replacement account's session. Password reset completion handles the authenticated recovery event and re-verifies the same account before an explicit form submission. Recovery can complete without a pending invitation token; the original invitation acceptance requirements remain in place.

Deployment still needs a controlled real employee recovery/invitation check using the existing allowlisted acceptance URL. Business entitlement and attendance rollout are separate from these frontend changes; no permission or release gate is broadened here.
