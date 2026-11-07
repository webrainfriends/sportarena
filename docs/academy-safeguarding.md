# Academy safeguarding & welfare case orchestration (issue #784)

Child-focused academies need operational safeguarding beyond participation consent and coach credential checks. This module adds **case orchestration** inside
**Organisation → Academy → Safety & pickup → Safeguarding cases**. It extends the safety-event workflow (#788) and the compliance module (#595); it does not add a parallel case database.

## Requested feature → source of truth → verified gap → minimal extension
| Requested | Existing source of truth | Verified gap | Extension (this change) |
|---|---|---|---|
| Designated officers and campus escalation hierarchy | `safeguarding` ops permission, `safeguardingOfficers()` (#788), campus tree `org_units` (#781) | no named officers, no tiers, no per-campus routing | `academy_sg_officers` (tier 1 campus, 2 lead, 3 leadership liaison; ended, never deleted) |
| Confidential intake, risk, restricted assignment, evidence, actions, deadlines, closure, audit | `academy_safety_events` (encrypted summary, safeguarding staff only), `audit()` | an event has no owner, deadlines, actions or closure outcome | `academy_sg_cases` **linked to the event** (`event_id`), `academy_sg_actions`, `academy_sg_evidence` (references only), append-only `academy_sg_case_log` |
| Staff suitability and background-check status at roster/session level | compliance `youth_access` obligations (`gate`, `evaluateSubject`), `staffIssues()` | not applied to roster views or new assignments | `staffSuitability()` reads compliance only (nothing copied); `staffIssues()` now refuses a not-cleared person; roster view `get_academy_staff_suitability` |
| Mandatory-reporting policy by jurisdiction and incident type, human review | none | no configuration | `academy_sg_report_rules` + `academy_sg_report_decisions`. The platform **never decides or sends** a report: it surfaces the rule and records the person's decision |
| Safe communication boundaries, separation of duty, redacted leadership indicators | guardian links (#70), wellbeing consent (#795) | no boundary rules, no conflict-of-interest rule | `academy_sg_policies` (guardian copy, private channels off by default, quiet hours), `conflicted_user_id`, `get_academy_sg_overview` (counts only, groups under 5 hidden), `evaluate_academy_contact` |

## Rules enforced on the server
* A case is readable **only by a designated, active officer** whose campus covers it, and never by the person it concerns. Everyone else (ordinary staff, finance, scouts, owners who are not designated, athletes, guardians) gets **404**. Lists carry no narrative; opening a case is written to the case log and the audit log.
* The reporter (staff, the athlete, or a verified guardian) receives only a case number and "received".
* Routing: tier 1 officer of the campus, else up the ladder; never the reporter or the person concerned. The assignee must be a designated officer of that campus, cleared, and not the reporter or the person concerned. The reporter cannot close the case.
* Deadlines (acknowledge, risk review, escalate) come from the academy policy by risk. A background sweep (`sweepSafeguardingCases`, in the worker) raises an overdue case one tier; the deadline moves on, so a second run does nothing.
* Closing needs an acknowledgement, an outcome and a reason, and, where a reporting rule applies, a **recorded human decision**. A retention date is set from the policy. Closed cases take no new actions.
* **Revoked or lapsed eligibility** blocks new session assignment (`staffIssues`) and officer designation, and is shown on the roster with the sessions to reassign. Nothing existing is unassigned automatically.
* Summaries, outcomes, action notes, evidence labels/links and decision rationales are encrypted (`*_enc`).

## Data, migration, rollback
Migration `185_academy_safeguarding_cases.sql` is additive and idempotent: new tables and a sequence only, no `DROP`, no `CASCADE`, history table guarded against update/delete. Rollback: deploy the previous build; the new tables are ignored and no data has to be removed.

## API (REST + OpenAPI + MCP, one definition each)
Officers `designate_academy_sg_officer`, `end_academy_sg_officer`, `list_academy_sg_officers` · Policy `get_academy_sg_policy`, `set_academy_sg_policy`, `save_academy_sg_report_rule` · Intake `open_academy_sg_case` (idempotency key), `list_academy_sg_athletes` · Desk `list_academy_sg_cases`, `get_academy_sg_case`, `update_academy_sg_case` (acknowledge, reclassify, assign, escalate, advance, close; `row_version`), `save_academy_sg_action`, `add_academy_sg_evidence`, `record_academy_sg_report_decision` · Oversight `get_academy_sg_overview`, `get_academy_staff_suitability` · Family `get_my_academy_safeguarding` · Staff `evaluate_academy_contact`.

## Screens and platforms
One Expo codebase (web, iOS, iPadOS, Android), Dusk theme tokens only (light and dark), 44 pt targets, accessible labels, shared pickers (searchable multi-select, chips, steppers, switches, date/time). Staff and officers use Safety & pickup → Safeguarding cases; athletes and guardians use Family → Wellbeing → Safe communication.

## Known limits (stated plainly)
* **Contact boundaries are evaluated and shown, not enforced inside team chat / messaging yet.** `evaluate_academy_contact` returns the rule outcomes; wiring the check into every messaging path is a follow-up.
* Evidence is a reference to a compliance file, safety event or https link; secure file upload for case evidence reuses the compliance file service and is not added here.
* Language packs: the most visible labels are translated (machine-drafted, `reviewed: false`); long hints fall back to English until a native speaker signs them off.
* This is a technical control set, not a claim of regulatory compliance in any jurisdiction.

## Sports
Safeguarding is not sport-specific; every catalogue sport works the same way.
