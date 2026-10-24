# Sponsor collaboration: tasks, assignments, notes, reminders and escalation (#306)

Tasks and working notes on a sponsorship agreement or a funding program, with assignments, due / review / expiry reminders and escalation.
It reuses the canonical access rules (`sponsor-access.js` live roles, `sponsor-beneficiaries.js` representatives), the existing negotiation
comments for agreement discussion, and `notify()` (#243: per-user mute and channel preferences, per-recipient dedupe). No second agreement,
identity or notification system.

## Data (migrations `100_sponsorship_collaboration.sql` and `102_sponsorship_collaboration_threads.sql`, additive)
* `sponsorship_tasks`: belongs to exactly one agreement **or** one program, and to one `side` (`sponsor` / `recipient`); `visibility` `internal`
  (owning side only) or `shared` (both sides read, only the owner edits); `kind` task / review / expiry; assignee, `due_on`, `remind_days`,
  `status` open / done / cancelled, `row_version`, `reminder_cycle`, escalation fields. A program task is always sponsor-side and internal (CHECK).
* `sponsorship_notes`: immutable working notes / discussion on an agreement, a program, one task, or one **application** of a program (`application_id`: the brand-to-applicant thread).
* `sponsorship_tasks.system_key`: set on tasks the platform made itself (`expiry:<end date>`); unique per agreement, side and key.
* `sponsorship_task_notices`: one row per (task, cycle, milestone) actually sent, so repeated or parallel worker runs notify once.
* Nothing is deleted: tasks are cancelled, notes are immutable. Existing agreements, privacy defaults and financial history are untouched.
* Rollback: no other table depends on these; export then drop them. Dependency order: after `099`.

## Permissions (server-side, read live on every call)
* New sponsor action `collaborate` (manager, approver, legal, evaluator, finance). Auditors and viewers read but cannot write. Sharing a note with the
  other side needs `revise` (the right to speak for the brand). Export needs `export` (manager, finance, auditor); a recipient's representative for the recipient.
* Recipient side: the recipient themself, or a live owner/admin representative for an organisation / group target.
* Someone who is not part of the agreement, or whose side the item is not shared with, gets **404** (existence is not revealed). A platform admin
  reads shared items only and never writes. Programs are the brand's own workspace: other sides and admins get 404.
* Removed staff lose read, write, export and notification deep-link access at once; they drop out of "assigned to me", are not reminded, and an
  open task of theirs is reported to the managers (`orphaned`). A leaver cannot be assigned.
* Declined / withdrawn agreements and archived programs take no new tasks or notes and send no reminders.

## Capabilities (REST + OpenAPI + MCP)
`create_sponsorship_task` POST `/sponsorship-tasks` · `list_sponsorship_tasks` GET `/sponsorship-tasks` (by `sponsorship_id` / `program_id`, or `mine=true`;
deterministic: due date, undated last, then id; paginated; returns `assignable` people and `can_write`) · `get_sponsorship_task` GET `/sponsorship-tasks/:id`
(notification deep link, re-authorised) · `update_sponsorship_task` PATCH (needs `expected_version`; stale = 409 `stale_version`; open→done/cancelled,
done→open; cancelled is final, others 409 `invalid_transition`) · `escalate_sponsorship_task` POST `/sponsorship-tasks/:id/escalate` ·
`add_sponsorship_note` POST `/sponsorship-notes` · `list_sponsorship_notes` GET · `export_sponsorship_tasks` GET `/sponsorship-task-export` (CSV, audit-logged,
only items the caller's side may see).

## Program discussion with applicants
`add_sponsorship_note` / `list_sponsorship_notes` with `application_id` are a private thread between the brand and that one applicant. The brand needs the
`program` right (manager, approver) to speak to the applicant; evaluators and others with `collaborate` may add internal notes; auditors only read. An applicant
writes once the application is submitted and always as `shared`. Other applicants, other brands and platform admins get 404. A person under the age of
independence is never put in a direct thread (403, `youth_blocked`), and an archived program's threads are read-only. Notifications are generic (`New message
about a sponsorship application`); the applicant's link carries only the application id, never the program.

## Automatic expiry tasks
Worker sweep `ensureExpiryTasks` (before the reminders, same step): an accepted `active` agreement within 90 days of its end gets one internal `expiry` task per
side, "Decide whether to renew this agreement", dated 30 days before the end (or today), assigned to the side's contact. Idempotent per (agreement, side, end date);
a moved end date cancels the old one (never deleted) and makes a new one; recording a renewal plan completes it; a live renewal means none is made.

## Email and worker
The deploy workflow now passes `NOTIFY_WEBHOOK_URL` (variable or secret) and `NOTIFY_WEBHOOK_SECRET` (secret) to the server, and the deploy log warns when the URL is
empty. `list_sponsorship_tasks` returns `reminders: { worker, email, in_app }` (worker = a heartbeat within `WORKER_STALE_SECONDS`), and the tasks screen says
plainly when reminders are delayed or email is not set up. In-app and push notifications work without the webhook.

## Reminders and escalation (worker step `sponsor_tasks`)
Per open dated task, in the agreement's timezone (programs: UTC): the assignee gets one reminder per milestone (`upcoming` within `remind_days`, `due`, `overdue`);
after downtime only the latest is sent. No assignee, or an assignee who left: the managers are told once (`orphaned`). Two days overdue: escalated once to the
managers of the side (and the creator if still on the team). Changing the assignee or date starts a new cycle. Rows are locked `SKIP LOCKED` and the notice is
written in the same transaction as the notification; notification dedupe keys make retries inert. Manual escalation is idempotent per `row_version`.
Notification wording is generic ("A sponsorship task is overdue", "Open Gotmygame to see it."): never the task text, amounts or names. Kinds:
`sponsorship_task`, `sponsorship_task_escalation` (mutable in notification preferences). Email still needs `NOTIFY_WEBHOOK_URL`.

## UI
`apps/app/src/screens/sponsor-collaboration.js` ("Tasks & notes" on the agreement screen and the program screen): filters, assigned-to-me, empty / loading / error
(retry) / denied states, new / edit / escalate sheets (person picker limited to the live team, calendar date picker, stepper, chips), notes thread, stale-version message.

## Tests
`apps/api/test/sponsorship-collaboration.test.js` (PostgreSQL) and `scripts/e2e/sponsorship-collaboration-journey.mjs` (browser, phone / tablet / desktop).
