# Officials Development & Assessment (#486)

The long-term development lifecycle of referees, umpires, assistant referees and scorers: **assessor appointments, match observations, versioned rubrics,
formal assessment reports, acknowledgement and appeal, grade requirements, mentoring, CPD, fitness/competency results and a development home.**

It is a follow-on to #88 (assignments and match-day work) and sits on the federation OS (#475, grades and licences). It owns only what is new; everything
else is **referenced, never copied**. Formal assessments are private development records: they are not a public reputation score and they never touch
public feedback (#215), match results or disciplinary cases.

## Overlap and source-of-truth matrix
| Need | Source of truth (reused) | Gap | What this adds |
|---|---|---|---|
| Who is officiating which fixture | #88 `fixture_officials` (+ history), `fixtures`, `events` | none | `off_observations` **points at** an accepted assignment; it never creates, edits or releases one |
| Grade, licence, expiry, renewal | federation OS `fed_licence_types` (grade, rank, duration), `fed_licences` (status read live) | requirements beyond the licence's own checks; demotion with an effective date | `off_grade_requirements` read by the **existing** licence approval; `demote_official` |
| Promotion / renewal decision | `decide_licence` (explicit, reasoned, override recorded as an exception) | none | the approval now also lists prerequisite grade, assessments, CPD and fitness as checks; nothing is auto-approved |
| Is this person an official | referee profile + current official licence | assessor authority | `off_assessors`: scoped appointment resting on the person's own live licence |
| Sport / rules governance | #68 rulesets, `governing_body_sports` | scoring rubrics | `off_rubrics` + immutable `off_rubric_versions` |
| Courses, certificates | education `credentials` (issued by institutions, verifiable) | an official's CPD ledger | `off_cpd_records`; a record linked to an issued credential counts at once, a self-reported one after verification. No content library is created |
| Public reviews | #215 testimonials | none | kept apart: no shared table, no shared API, no shared score |
| Health | Health domain | operational fitness result only | `off_fitness_*`: type, version, date, outcome, validity, optional measured value. No clinical data, no diagnosis |
| Notifications, audit, jobs | `notify`, `audit_log`, worker | history of every step | `off_events` (append-only), `officials_development` worker step |

## Rules
- **Assessors.** Appointed by the body's licensing staff for a sport, the official roles they may assess, a highest grade, an optional single competition and a
  period (max 3 years). The appointment rests on the assessor's own licence and **lapses with it**, read live. Being a referee grants nothing. An assessor cannot
  assess themselves or sit on the crew of the match, and must declare no conflict of interest to accept (a declared conflict declines and tells the body).
- **Observations.** Assigned by the body's licensing staff, or by the organiser of an event the body has sanctioned, to an existing confirmed assignment inside
  the body's jurisdiction (sanctioned event or licensed official). Bodies choose whether officials are told in advance.
- **Rubrics.** Per sport, role and grade range; every version is immutable (database trigger). An assessment binds to the version in force on its first save
  and keeps it. Each dimension carries a definition, the evidence expected, whether evidence is required and whether N/A is allowed.
- **Reports.** Draft (assessor only) → submitted (immutable version 1) → published to the official, straight away or after the body's review (policy).
  Corrections add a version with a reason. Staff cannot edit; they can **void** with a reason (visible, content kept, stops counting). Final versions cannot be
  edited or deleted at the database. The narrative is encrypted at rest, every read by someone other than the assessor is audit-logged, and notifications carry
  no content. A recommendation (maintain grade, ready for review, further observation) is advice, never a decision.
- **Acknowledgement and appeal.** The official (or, for a young person, their verified guardian) acknowledges, comments, and asks for a review or lodges an
  appeal within the body's window. The body decides; an upheld appeal asks the assessor to correct or the body to void, each with history.
- **Progression.** Promotion, first issue and renewal are ordinary licence applications; approval runs the type's own checks **and** the body's requirements
  (prerequisite grade and months held, a count of formal assessments and supportive recommendations in a window, one promotion assessment, verified CPD hours,
  a current fitness test). A score alone never promotes. Demotion is its own decision: reason, effective date up to 60 days back, optionally the lower grade.
- **Mentoring.** Both people accept. The mentor reads only that relationship's goals, actions and meetings (a mentor may keep notes mentor-only); the body sees
  that a relationship exists, never its text. A mentorship grants no access to assessments, fitness results or competitions.
- **Privacy.** Fitness results (and any measured value) are visible to the official and the body's licensing staff only. CPD evidence text belongs to its owner.
  Bodies above see roll-ups with groups under three hidden; exports are counts only and logged with a hash in `fed_exports`.
- **AI.** `draft_development_plan` sees only the caller's own published assessments, has no tools, is labelled a draft, and is told never to grade, promote,
  demote or comment on a licence. Without AI configured it returns a plain list of the same records.

## Surfaces
REST, OpenAPI and MCP come from the same capabilities (`apps/api/src/capabilities/officials-*.js`, tag *Officials development*).
App (one Expo codebase for iOS, iPadOS, Android and web): the official's home is **Officials development** (opened from the referee workspace and from My
licences), reports open in **Assessment** (and the assessor's editor), and the body's console is the **Officials** tab of Federation Home.

## Not done on purpose
- Event organisers can assign assessors over the API/MCP for events a body sanctioned; their screen is not duplicated in the event console (the body console is the one place).
- Match-assignment eligibility does not copy or enforce a grade. The federation OS already reads `fed_licences` for sanction conditions (`min_official_grade_rank`),
  and `currentGrade()` is available to #88 when a competition wants to require one.
