# Assigned employee job workflow

The release gate is ENABLE_EMPLOYEE_JOB_WORKFLOWS=true. Employee status writes additionally require the existing IRONCREST_EMPLOYEE_JOB_UPDATES=enabled kill switch. The previous controlled release remains unchanged when the new gate is closed.

Verified employees with one active membership and a company with an active owner and Business access may list only their assigned jobs, then change pending to in_progress or in_progress to completed. The request supplies only jobId, action and the exact expectedUpdatedAt version. Actor, membership and company are derived server-side. Assignment, version and Business access are rechecked in the database under locks before calling the existing atomic transition function.

Status, history and the existing completion-outbox marker commit together. No email is sent by this request. No attendance, clock-in/out, timesheets or payroll record is changed. No delete, reassignment, owner fields or arbitrary status transitions are exposed to employees. A stale/uncertain action requires reloading assigned jobs; no automatic resubmission.

The same release adds a Business-access check before the existing owner job create/edit/list handlers. Their existing feature switches and validation remain in force. Employee lists show the newest 100 jobs and disclose truncation; no other company or employee identifiers are returned.

Validation: 118 application/full Worker checks and 43 isolated PostgreSQL checks passed. Tests cover scope overrides, expired Business access, inactive employees/owners, foreign assignments, stale revisions, concurrent completion (one winner), and atomic rollback when outbox insertion fails. No real job or attendance records were changed in these tests.
