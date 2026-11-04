# Academy Academics & school integration (#783)

Sport-plus-study academies (Rafa Nadal Academy, La Masia, Real Madrid Academy patterns) coordinate education with sport. This layer links an enrolled athlete to a **verified external school**, holds a **consented** school timetable, flags **sport-study clashes before the sport timetable is published**, summarises school attendance, keeps **restricted** attainment snapshots with provenance, and runs coach / school / guardian coordination tasks. Home: **Organisation → Academy → Academics** (staff) and **My academy → School** (athlete / guardian). Nothing here is a second calendar, identity or score engine.

## Reuse / gap matrix (requested → canonical source → gap → smallest extension)

| Requested | Canonical source (reused) | Gap | Extension |
|---|---|---|---|
| External schools, no duplicate identity | `organisations` (`kind` school / college / university, `approval_status='approved'` = verified); the education desk (#335/#392) stays the admissions path | link per academy enrolment | `academy_school_links` (references the school by id; school's own student reference encrypted) |
| School day, exams, tutoring | `academy_sessions` is the *sport* timetable | school-side blocks | `academy_school_blocks` (once / weekly, term dates, skipped dates, own time zone) |
| Clash before publication | `checkSession` / `publish_academy_sessions` (staff, cohort, venue clashes) | school clashes | `academy-clashes.js` feeds `checkSession`; exam / lesson / school day refuse publication, tutoring / study / exam rest buffer warn; `academy_clash_resolutions` (append-only) excuses an athlete, marking them excused (reason `school`) through `markAttendance` once published |
| Consent | `youth_consents`, guardian links, `requireGuardian`, `hasConsent`; clearance share pattern (#394) | academic purpose, two levels | youth consent purpose `academic`; `academy_academic_shares` (`schedule`, `progress`; revocable, hides data at once) |
| Attendance summaries | sport attendance stays in `academy_attendance` (a different fact) | school attendance | `academy_school_attendance` (append-only, source labelled) + configurable exception rules |
| Attainment snapshots | none | grades with provenance | `academy_academic_frameworks` (immutable versions), `academy_academic_snapshots` (append-only, versioned per term, encrypted, restricted visibility) |
| Tasks | none for academy coordination (`cases` is platform support, `sponsorship_tasks` sponsor-only) | coordination | `academy_academic_tasks` (no grades; notes encrypted) |
| Partner import / API | API tokens (organisation-scoped), capability registry | submission path | `import_academy_school_records` (academy, manual verified) and `submit_school_records` (school org, only for links the academy authorised) with preview / atomic commit / idempotency |
| Permissions | `org_staff_engagements.permissions` | two grants | `academics` (timetable, attendance, tasks) and `academic_records` (grades, comments, subject names); templates `education_coordinator`, `school_liaison` |

## Who sees what
| Role | Sees |
|---|---|
| Owner / admin | everything (hold both grants); grades only while the family's `progress` share is live; every grade read is audit-logged |
| Education coordinator (`academic_records`) | links, timetable with subjects, attendance, grades, tasks, frameworks |
| School liaison (`academics`) | links, timetable (kinds and times, no subjects), attendance, tasks; snapshots appear as *restricted* |
| Coach / other staff | clash lines when scheduling (athlete + kind of commitment, never the subject), tasks assigned to them. 403 elsewhere |
| Athlete (adult) / verified guardian | their own school and sport timetables (separate, with sources), attendance, snapshots the academy marked visible to the family; controls the two shares |
| School organisation owner / admin | `submit_school_records` for linked students whose link has `import_authorised`; nothing else |
| Scouts, recruiters, sponsors | nothing: no capability here reads or exports academic data, and the test asserts passport / profile surfaces carry none |

Authorisation is enforced in the capabilities (live, per call); outsiders get 404. Subject names, grades, comments, the school student reference and task notes are encrypted (`*_enc`, column-bound). Append-only tables have triggers that refuse `UPDATE`/`DELETE`.

## API (REST + OpenAPI + MCP from one definition)
`search_academy_schools`, `list_academy_school_candidates`, `link_academy_school`, `update_academy_school_link`, `list_academy_school_links`, `save_academy_school_block`, `cancel_academy_school_block`, `list_academy_school_blocks`, `check_academy_academic_clashes`, `resolve_academy_academic_clash`, `set_academy_academic_settings`, `get_academy_academics`, `get_my_academy_academics`, `set_academy_academic_share`, `record_academy_school_attendance`, `list_academy_school_attendance`, `list_/save_academy_academic_frameworks`, `record_/list_academy_academic_snapshots`, `save_/update_/list_academy_academic_tasks`, `import_academy_school_records`, `submit_school_records`. Writes are idempotent (`idempotency_key`, duplicate blocks collapse), concurrent edits use `row_version`, lists paginate.

## Migration and rollback
`154_academy_academics.sql` is additive: nine tables, one widened `youth_consents.purpose` CHECK (adds `academic`). No data is dropped, rewritten or cascaded. Rollback = stop using the capabilities; a scratch environment can drop the nine tables, nothing else depends on them. An academy that never links a school has no rows.

## Sports
School integration is sport-agnostic (it models a school day, not a sport). Sport timetables, attendance and results stay in their own native modules.

## Not covered / limits
Configurable thresholds are a starting point, not a statement of any jurisdiction's rules. Partner adapters beyond the REST/MCP submission path (for example a scheduled pull from a school MIS) are not built. Sessions spanning midnight are matched against weekly school blocks by their start day only. Translations are machine-drafted (`reviewed: false`).
