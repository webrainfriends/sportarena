# Academy OS 2/3: session scheduling, rostering, attendance, time and compensation (#394)

An operations layer over the canonical records. Nothing here is a second calendar, athlete roster, staff profile, resource inventory, payment ledger or
training-plan system. Where it lives in the app: **Organisation → Academy → Operations** (director/staff), **My academy week** (coach, phone),
**My academy → Sessions** (athlete / guardian), and the session screen that every quick action opens.

## Reuse / gap matrix
| Requested | Canonical source (reused) | Gap, smallest extension |
|---|---|---|
| Programme, group, term | `academy_programmes`, `org_cohorts`, `org_seasons`, `org_enrolments` | cohort staffing rules (`min_coaches`, `max_ratio`, `lead_credential_required`, `enforce_staffing`) |
| Staff identity | `users` + `organisation_members` | `org_staff_engagements` (title, type, scope, permission set, HR notes encrypted); one generic member role `staff` |
| Session occurrence | none (attendance was date-only) | `academy_sessions` (who/when/where only) + append-only `academy_session_changes` |
| Coach calendar / athlete schedule | `coach_calendar`, `get_my_sport_schedule` | one more source, `academy_session`, read live (`source_type`/`source_id`); nothing is copied |
| Courts, rooms, equipment | `placeBasket` / booking engine, `session_venue_links` | link type `academy_session`; no academy resource tables |
| Attendance | `coaching_session_participants` states | `academy_attendance` (+ append-only log); Performance Studio mirrors it and refuses a second write |
| Coaching content | Performance Studio | `coaching_session_records.source_type` accepts `academy_session` |
| Credentials | verification badges (`badgesFor`) | read only; no credential store |
| Money | `currency.js` minor units | effective-dated `academy_comp_rules`, `academy_payroll_runs/lines` (statements, no payout ledger) |
| Venue duty roster, front desk (#90) | not built | **deferred**: `academy_shifts.source_type/source_id` reserved to reference it |

## Permission matrix (checked on every request)
| | owner/admin | coach | finance | staff (scoped) | auditor |
|---|---|---|---|---|---|
| Timetable, publish, staffing, venue | yes | own sessions (attendance/roster) | no | by engagement permissions + scope | read |
| Attendance | yes | own sessions | no | `attendance` | read |
| Timesheets approve | yes | own only | yes | `timesheets` | read |
| Comp terms, payroll, export | yes | own terms/statements | yes | `payroll` | read |
| HR notes | yes (audited) | no | no | no | no |

No role grants clinical access; finance never sees rosters or coaching notes; coaches never see other people's pay. Suspending an engagement or removing the member takes effect on the next request.

## Rules worth knowing
- **Conflicts** are refused before assignment/publication: staff double booking (per-person advisory lock), coach hires and commitments, approved leave, standing availability, cohort overlap, team fixtures, venue booking window. A venue is never overwritten or cancelled silently; use the booking's own change/cancel flow.
- **Staffing check** returns compliant / warning / blocked with the reason for each missing requirement. Blocked only when `enforce_staffing` is set. It is an operating policy, not a statement of legal compliance.
- **Attendance** is idempotent (idempotency key, one row per session and athlete), corrections need a reason and are logged. Venue arrival is a different fact and is only referenced.
- **Time zones**: a session stores its own zone; timetable generation converts wall-clock times with that zone (DST-safe); payroll periods use the work date.
- **Payroll**: a run is a statement of compensation obligations for one period and one currency. No tax, pension, social security or statutory deductions, no money movement, no payout ledger. Approved runs and their timesheets are frozen by database triggers; new terms cannot start inside an approved period. Currencies are never added together; unpriced timesheets are listed.
- **Venue slots**: the booking engine books on its own slot grid (typically whole hours), so a 75 minute session cannot reserve a court there.

## Migration / rollback / recovery
`102_academy_operations.sql` is additive (new tables, nullable columns, widened checks, no deletes or cascades). Rollback = deploy the previous code. A failed generation is retried with the same idempotency key. A draft payroll run can be voided to release its timesheets.

## Explicit deferrals
- Projection of #90 venue duty shifts (reserved columns only; #90 is not built).
- Assistant coaches see athlete coaching data in Performance Studio only through existing coaching relationships.
- Fee consequences of no-shows or make-ups stay with Academy billing; attendance creates no financial rows.
