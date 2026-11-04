# Academics & school integration (issue #783)

Sport-plus-study academies run on two calendars. This module links an academy enrolment to the school the athlete attends, lets the **athlete (or a minor's
verified guardian) decide what to share**, flags school exams and lessons that clash with the academy schedule **before it is published**, and shows
academic progress next to, never merged with, sport progress. Everything is a capability (`apps/api/src/capabilities/academy-academics.js`,
`academy-attainment.js`), so REST, OpenAPI and MCP share one definition. Engine and rules: `apps/api/src/academics.js`.

## What exists already, and what this adds (no duplication)
| Requested | Existing source of truth | Gap | Extension |
|---|---|---|---|
| Verified external schools without duplicating institutions | `organisations` (kind school / college / university), platform approval | no link from an academy enrolment to a school | `academic_links` points at the organisation; the institution is never copied |
| Consent, youth safeguarding | `youth_consents`, `guardian_links` (`guardianLink`, `guardianCan`), the `academy_clearance_shares` pattern | no academic consent | `academic_consents`: per party, per scope, dated, revocable |
| Exam clash before publication | `checkSession` in `academy-ops.js` gates `publish_academy_sessions` | nothing reads school commitments | `academicClashes()` added to that same gate |
| Restricted visibility | staff engagement permissions (`org_staff_engagements.permissions`) | no permission for academic data | `academics` and `academics_detail` (never implied by seniority) |
| Staged, reviewed imports with provenance | `external-history.js` pattern | not for academics | `academic_imports`: staged, previewed, applied, rows erased |
| Sport and academic progress side by side | Athlete 360 sections (`{ access, source, origin, data }`), Academy Progress | no academic section | `sections.academic` in `get_academy_athlete_360`, bands and flags only |

## Who sees what (enforced on the server, read live on every call)
| Caller | Timetable | Attendance | Attainment |
|---|---|---|---|
| Athlete / verified guardian | full, own record | numbers | subject-level |
| Linked school's staff | what the athlete granted **that school** | numbers | subject-level (their own records) |
| Academic lead (`academics` + `academics_detail`) | subject text if **detail** consent | numbers | subject-level if **detail** consent |
| Academy staff with `academics` only, owner, admin | kind + time | numbers (lead) / flag | **progress band** only |
| Coach, scheduler (`schedule`, `attendance`, `roster`) | kind + time (clash check) | below-floor flag | progress band (roster / attendance) |
| Recruiter, sponsor, scout, anyone else | **404** | **404** | **404** |

* Nothing flows until a grant exists. A minor cannot grant; only a verified guardian with `consent` authority can. A grant names the party (academy or
  school), scopes (`timetable`, `attendance`, `attainment`), level (`summary` or `detail`) and an end date **at most one year away**. A new grant replaces
  the previous one for that party; revoking takes effect on the next request.
* **Owners and admins do not read grades automatically.** `academics_detail` is excluded from the permissions implied by owner/admin and from the
  `director` template; it is given explicitly (template `academic_lead`).
* Grades and subject text are encrypted (`values_enc`, `title_enc`, task notes and messages). Every read of timetable, attendance or attainment is
  written to `academic_access_log`; the athlete and guardian can list who looked (`list_academic_access_log`). The academy cannot read that log.
* There is **no scout / recruiter / sponsor audience in the schema**: `academic_consents.party_role` allows only `academy` and `school`.

## Data model (migration `155_academics.sql`, additive)
`academic_links`, `academic_consents`, `academic_items` (class blocks, exams, tutoring, school events, holidays, deadlines; one-off or weekly),
`academic_attendance` (period **summaries** only, versioned), `academic_frameworks` (configurable scale, subjects, thresholds, attendance floor),
`academic_snapshots` (immutable versions with provenance), `academic_tasks` + `academic_task_people` + `academic_task_messages`, `academic_imports`,
`academic_access_log`. No existing table is altered; no `DROP`, no `CASCADE`. Corrections are new versions that `supersede` the earlier one; nothing is overwritten.

## Capabilities (REST + OpenAPI + MCP, tag `Academics`)
Links: `link_enrolment_to_school`, `list_academic_links`, `update_academic_link`, `search_academic_providers`, `list_school_athletes`.
Consent: `grant_academic_consent`, `revoke_academic_consent`, `list_my_academic_consents`, `request_academic_consent`.
Timetable and clashes: `add_academic_items`, `update_academic_item`, `list_academic_timetable`, `list_academic_calendar`, `check_academic_clashes`.
Attendance: `record_academic_attendance`, `list_academic_attendance`.
Attainment: `save_academic_framework`, `list_academic_frameworks`, `record_academic_snapshot`, `list_academic_snapshots`, `get_academic_progress`.
Coordination: `create_academic_task`, `list_academic_tasks`, `get_academic_task`, `update_academic_task`, `scan_academic_exceptions`.
Overview and audit: `get_academics_overview`, `list_academic_access_log`.
Imports and partner API: `import_academic_records` (CSV or JSON `records`, `apply`, `idempotency_key`), `commit_academic_import`, `list_academic_imports`.

## Sport-study clashes
`checkSession` (the pre-publish gate) now also calls `academicClashes`: athletes in the session's group who have an active link **and** a live
academy grant covering `timetable`, whose exam / lesson block / tutoring session / school event (`blocks_sport`) overlaps the session. A holiday never
blocks and suppresses lesson clashes that day. A clash refuses publication (`reason: conflicts`, codes `school_exam_clash`, `school_exam_high_stakes`,
`school_class_block_clash`, `school_tutoring_clash`, `school_school_event_clash`). Staff see the athlete, the kind and the time, never the subject.
Release for sport is allowed only with a recorded reason, and **never for a high-stakes exam**. `add_academic_items` also returns the sessions an item
clashes with, so a clash is seen when the exam is entered, and the **term timetable preview** lists the same clashes (as group issues, with no subject) before
any session is saved. Drafting a session is still possible; publishing it is refused. `check_academic_clashes` previews a window or a slot you are about to create.
Revoking consent removes the athlete from the check at once. The background sweep `academic_exceptions` raises one coordination task per clash.

## Attendance, tasks and imports
* Attendance is stored as period totals (present within total, late within present, authorised and unauthorised absence); no daily record exists. A
  summary below the academy's floor (default 90%) or with over 5% unauthorised absence raises **one** attendance-exception task (dedupe key) for the
  coach, school liaison, guardians and academic leads.
* Tasks carry a reason code and dates, never grades; free text is encrypted; only participants and academic leads can open one.
* Imports match rows to linked athletes by student reference or handle, require the athlete's grant for the importing party and scope, validate, and
  stage. Nothing is applied until `commit_academic_import` (or `apply: true` with every row valid). Applied rows carry `partner_import` or
  `partner_api` provenance; the staged rows (which may hold grades) are encrypted and erased once applied. A partner pushes records with the same
  capability, authenticated as a member of the school organisation.

## Validation and errors
Unknown ids and records outside the caller's scope return `404` (existence is not leaked); a missing permission returns `403`; a grade not on the
scale, a subject twice, totals that do not add up, an exam as a weekly item, a consent end date beyond a year, and a high-stakes override return `400`;
stale `row_version`, an ended link, an applied import and a closed task return `409`. Mutations are audited; imports and links are idempotent.

## Migration, rollback and non-regression
* An academy that never links a school has no rows and behaves exactly as before (tested: sessions publish unchanged).
* **Rollback**: stop using the capabilities (or revert the code); the migration only adds tables. To remove the feature's data, end links
  (`update_academic_link end`) and revoke consents: records are retained but invisible to every party. This project never deletes data.
* The permission change is additive: `PERMS` gains `academics` and `academics_detail`; owner/admin implied permissions are unchanged except that the
  new detail permission is deliberately not implied.

## Limits
* Real-device runs on iOS, iPadOS and Android were not possible in this environment; the web build was exercised at phone, tablet and desktop widths in
  light and dark, and the Expo iOS and Android bundles are exported as a compile check.
* The school pushes records by file or API; the platform does not pull from a school's own system (no outbound adapter).
* The text is machine-translated into the 11 packs and marked unreviewed until a native speaker signs it off.
