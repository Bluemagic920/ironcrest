# Ironcrest — Workforce Operations

Ironcrest is a workforce workspace for small businesses: employee records and invitations, scheduling, jobs, company announcements, and location-checked time and attendance. It is powered by ProfitHarbor AI and served at https://ironcrest.profitharborai.com.

## What is in this repository

| Path | Purpose |
| --- | --- |
| `index.html` | Public landing page and the owner workspace |
| `employee-portal.html` | Employee sign-in and workspace |
| `accept-invitation.html` | Invitation acceptance and password recovery |
| `privacy.html`, `terms.html`, `support.html`, `404.html` | Legal, support and error pages |
| `*.js` (top level) | Browser modules shared by the pages |
| `worker/` | Route modules for the `ironcrest-invitations-api` Cloudflare Worker |
| `docs/` | Feature notes and reviewed database schema snapshots |
| `tests/` | Node test suite for the browser modules and Worker routes |

The site is static and is published by GitHub Pages from `main` (see `CNAME`). Anything merged to `main` goes live.

The complete Cloudflare Worker, its secrets and feature switches, the Supabase database and Stripe billing are managed outside this repository. `worker/` contains route extensions that are integrated into that Worker; it is not the full deployed source.

## Checks

Run with Node 22 or later:

```
node --test tests/*.test.cjs tests/*.test.mjs
```

The tests use local DOM, auth and network fixtures. They never contact the database, send emails, change passwords, or write attendance. CI runs them, plus JavaScript syntax checks for standalone and inline scripts, on every pull request and on pushes to `main`.

## Behaviour notes

The employee portal invalidates prior job and worksite reads when authentication changes, including switches between employees in the same organization. A delayed job action cannot post using a replacement account's session. Password reset completion handles the authenticated recovery event and re-verifies the same account before an explicit form submission. Recovery can complete without a pending invitation token; the original invitation acceptance requirements remain in place.

Owner and employee password resets both return through `accept-invitation.html`, which must stay on the Supabase redirect allowlist.

## Release status

See `docs/ATTENDANCE_RELEASE.md` for the attendance release steps and the remaining billing work. Feature availability is controlled by switches on the Worker, not by this repository.
