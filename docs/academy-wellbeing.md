# Academy student wellbeing & personal development (#795)

Whole-person programmes need mentoring, soft skills and welfare follow-up next to athletic performance. This module adds those **inside Organisation → Academy**
(a "Wellbeing" section) and, for athletes and guardians, inside **My academy** (a "Wellbeing" tab). It is additive: nothing existing was removed or narrowed.

## What it does
| Need | How |
|---|---|
| Optional personal-development tracks (values, leadership, life skills, nutrition education, study skills) with age-appropriate content | `save_dev_track` (owner/admin): age band, sports, delivery, ordered modules. Joining is always optional, needs consent for `tracks`, and the age band is checked from birth year only (no DOB is decrypted). Modules are append-only so recorded progress never points at another module. |
| Role-safe mentor assignments, check-in scheduling, transparent follow-up | `assign_mentor` (director / safeguarding staff): the mentor must hold the new `wellbeing` permission (`Mentor` template) and pass the academy's youth-access obligations (#595). `schedule_wellbeing_checkin` (one or a series), `update_wellbeing_checkin` (complete / reschedule / cancel / missed / follow-up done). Follow-up status is visible to the family. |
| Counselling, diagnosis, psychiatric and confidential safeguarding content stays out of Academy notes | There is no column for it. Free text is short, screened (422 `restricted_content`), and a concern is raised **into the existing safety-event workflow** (`academy_safety_events`: encrypted, safeguarding staff only). The family and the director are not shown it from the schedule. |
| Human-reviewed goals, guardian communications, consented referrals | `propose_dev_goal` / `review_dev_goal` / `respond_dev_goal`: a named reviewer decides, the family agrees first, achieving needs a note, nothing is automatic. `send_wellbeing_update`: fixed templates + a screened note. `propose_wellbeing_referral` / `respond_wellbeing_referral` / `update_wellbeing_referral`: reason is a category, the family says yes, hand-over reuses the existing `refer_academy_athlete_to_provider` (generic notification only; booking and care stay in Health). |
| Aggregated, anonymised indicators, not risk scores | `get_academy_wellbeing_overview`: coverage, mentor coverage and rhythm, check-ins held, follow-ups, goals and referrals by status, track participation. Groups under five are returned as `null`. No person-level score exists. |

## Consent (enforced on the server, revocable at any moment)
`set_wellbeing_consent` records per-academy scopes: `tracks`, `mentoring`, `checkins`, `goals`, `guardian_updates`, `referrals`. An adult decides for themself; a verified guardian
holding the `consent` scope decides for a young person (the young person cannot). Every read path re-checks the live row, so withdrawing is immediate: scheduled check-ins are
cancelled, mentoring pauses, open specialist suggestions are withdrawn, and the earlier choice is kept as history. A guardian's grant lapses if their link is revoked or the athlete is no longer a young person.

## Who sees what
* **Director / safeguarding staff**: who mentors whom, rhythm, what is due (athlete, kind, due date, owner), statuses. Never topics, outcomes, agreed steps, goal wording, referral reasons or concerns.
* **Mentor**: their own mentees' record, only while consent is live and the assignment is current.
* **Athlete / guardian** (`get_my_wellbeing`): everything above for them, plus a transparency log including each time staff opened the record. A concern raised for safeguarding is shown as an ordinary check-in.

## Reuse (requested feature → source of truth → extension)
| Requested | Existing source | Extension |
|---|---|---|
| Safeguarding concern | `academy_safety_events` + `openSafetyEvent` (#788) | called, not copied |
| Guardian authority and consent | `guardian_links` scopes, `youth.js` (#70) | new per-academy scopes table; same live-link rule |
| Specialist referral | `org_provider_associations`, `refer_academy_athlete_to_provider` (#395) | consent-tracked referral record that invokes it |
| Youth-access clearance for mentors | `compliance.mayAccessYouth` (#595) | checked at assignment |
| Goals | `coaching_goals` are the coach's athletic goals | separate personal-development goals shared with the family |
| Staff permissions | `academy-ops.js` PERMS / templates | `wellbeing` permission + `mentor` template |

## Data, migration, rollback
Migration `157_academy_wellbeing.sql` is additive and idempotent (no `DROP`, no `CASCADE`, history table guarded against update/delete). To roll back deploy the previous build; the new tables are ignored by it and no data has to be removed.

## Sports
Wellbeing is not sport-specific: tracks can be limited to sports or left for every sport, and every catalogue sport works the same way.
