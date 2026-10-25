# Coach Command Center and shared training plans

Coach-facing slice over canonical records (issue #87). The training-plan model is shared: the athlete sees and answers the same plan the coach proposes. There is no separate coach or athlete plan table.

## Who counts as "my athlete"
Only explicit, current relationships (`src/coaching.js`, `RELATIONSHIP_SQL`):
- a **confirmed or completed coach hire**;
- a **team** where the coach is an active `coach` member and the athlete an active player;
- an **active cohort** the coach leads, with the athlete enrolled;
- a **plan the athlete has accepted** and not closed.

Public search or an unaccepted request never creates a relationship. A cancelled hire, a member who left, a withdrawn enrolment or a closed plan ends it. Young people are shown only when `canSeeYouth` allows (guardian or consent). Coach endpoints never return medical, health-provider or contact data.

## Plan lifecycle
`draft → proposed → active`, or `declined` / `change_requested`; `closed` at any time by either party.
- Revisions are append-only. Once proposed, content is immutable; only the athlete's response is recorded.
- Any change to an accepted plan is a new revision that the athlete must accept. While it is pending the previously accepted sessions stay as they were.
- On acceptance the revision's sessions are applied: moved or edited future sessions are updated, future sessions left out are marked `cancelled` (kept, never deleted), new ones are created.
- Completed or skipped sessions are never changed. The athlete's effort (1–10) and feedback are non-clinical and final once recorded; the coach adds feedback afterwards.
- Plan mutations lock the plan row, so concurrent proposals or responses resolve to exactly one winner.
- When the relationship ends, history stays; the coach can no longer create, revise or propose. The athlete can always close a plan, which cancels future sessions.

## Endpoints (all capabilities, so REST, OpenAPI and MCP)
`coach_home`, `coach_athletes`, `coach_calendar`, `coach_team_roster`, `create/list/archive_coach_template`, `create_training_plan`, `edit_training_plan_draft`, `start_training_plan_revision`, `propose_training_plan`, `respond_training_plan`, `close_training_plan`, `list_training_plans`, `get_training_plan`, `update_training_session`.

The coach calendar is a read projection: every item carries `source_type` and `source_id` (coach hire, training session, fixture), nothing is copied, and overlaps are flagged.

## Team coach permissions
`canCoachTeam` (in `capabilities/teams.js`) allows an active team coach, or anyone who passes `canManageTeam`, to view the roster and availability through `coach_team_roster`. It grants no ownership, rate, settlement, finance or medical access, and `canManageTeam` is unchanged.

## Not in this change (follow-ups)
Match preparation and post-match review, performance analytics with provenance, the AI coaching assistant, template sharing with teams or organisations, coach availability and buffers (#56), rule packs (#68), the concierge framework (#72), and earnings/opportunity links (#67, #71) — none of these exist on main yet.

# Performance Studio — coaching journal (issue #269, slice 1)
Execution and review layer over the records above. Migration `076_coaching_journal.sql` is additive (new tables only); nothing is deleted.

## What it adds
- **Session record** (`coaching_session_records`): one per coach and canonical source (`training_session`, `coach_hire`, `fixture`) or `team_session` for a team/group training that has no other record. It never creates a booking or calendar entry; the source keeps owning time, venue and money. A team session has one record with many participants, not one copy per player. Repeating the create returns the same record.
- **Plan versions** (`coaching_session_plan_versions`, append-only): ordered blocks (objective, duration, cues, setup, target RPE, tags, coach-only notes). The version a session started with is kept (`plan_at_start`); a completed session's plan is frozen. Block progress (`block_log`) is stored apart from the plan.
- **Attendance** (`coaching_session_participants`): expected / present / late / left early / absent / excused. Idempotent; only people on the roster. People never marked are reported as *not recorded*, never silently absent.
- **Observations** (`coaching_observations`): typed, tagged, linked to a session/block/athlete/team, with an idempotency `client_key`, optimistic `row_version` and an append-only revision history. Observations hold coaching opinions only — no diagnoses, treatment or medication.
- **Timelines**: `list_player_coaching_timeline` / `list_team_coaching_timeline` project observations, attendance and completed plan sessions from their sources (nothing is copied).
- **Performance Studio** (`get_coach_performance_home` + app screens `PerformanceStudio`, `CoachSession`, `CoachJournal`): running sessions, today's sessions to open, reviews owed, notes flagged for follow-up.

## Visibility (enforced in the query, so REST, OpenAPI and MCP agree)
| visibility | who can read it |
|---|---|
| `coach_private` (default) | the author only |
| `staff` | the author and active coaches of the note's team |
| `player` | the author and that athlete (`my_shared_coaching_notes`) |
| `team` | the author and active members of the team; team-level notes only |

## Access and relationship end
Creating or editing needs a *current* relationship (`RELATIONSHIP_SQL`) or coaching authority over the team, and youth rules apply. When it ends, a coach can no longer add or edit, and no longer sees other coaches' staff notes; they keep read access to what they wrote themselves. Notes the athlete or team were already shown stay visible to them.

## Slice 2 — goals, rubrics, actions, metrics, match context
Migration `077_coaching_goals_actions.sql` (additive).
- **Goals** (`coaching_goals`, `coaching_goal_events`): scoped to an athlete or team, with category, measurable criterion, priority, dates and review cadence. Status changes are the coach's decision and are logged; `achieved` needs a note. Evidence (`coaching_goal_evidence`) *references* the coach's own observations, sessions, plan sessions, measurements or a team fixture; adding evidence or completing actions never changes a goal's status. Athletes see only the wording written for them (`my_coaching_goals`).
- **Rubrics** (`coaching_rubrics`, `coaching_rubric_versions`): coach-defined dimensions with their own scale and direction. Saving again creates a new version; a score keeps the version and scale it was given under. Rubric scores are subjective and are never converted into official statistics. **Standard library:** `src/standard-rubrics.js` holds frameworks aligned with the governing bodies' assessment areas (FIFA, ICC, FIBA, FIVB, FIH, BWF, ITF, World Aquatics, World Athletics, Asian Games kabaddi, plus general Olympic physical and mental profiles). `list_coaching_rubrics` gives a coach each one that matches the sports they coach (coach sport profiles and teams they coach) exactly once (`standard_key`, unique per coach); they are editable like any rubric, and archiving one means it is never handed out again. A rubric can serve several sports (`coaching_rubric_sports`, soft-removed) and a sport can have any number of rubrics; no sports means every sport.
- **Measurements**: coach-entered numbers with a mandatory unit.
- **Actions** (`coaching_actions`): from a session, observation or goal; owner is the coach, the athlete (always visible to them) or a team coach. Athletes can only set status and a completion note. Open actions and follow-ups show in the next session workspace and on the Studio home with overdue items.
- **Metrics / comparison** (`get_coaching_metrics`, `compare_coaching_metrics`): attendance, plan completion, reported-vs-target effort, action completion, measurements and rubric dimensions. Each states its definition, unit, provenance (coach-observed / athlete-reported / coach-entered / derived), sample size and exclusions; missing data is `null`, never zero. Comparison modes: previous period, target, or team distribution. Mixed units or rubric versions are refused. Team distribution needs at least 5 comparable adults you coach, excludes young people, and returns statistics only (no names, no ranking).
- **Match context** (`get_coaching_match_context`): read-only fixture, official result labelled `official`, squad availability, goals and actions; the debrief itself is a normal session record with `source_type: fixture`. Coaching notes never touch scores or events.

## Slice 3 — AI coaching copilot
Migration `078_coaching_ai_drafts.sql` (additive). `draft_ai_coaching_assist`, `get_/list_ai_coaching_draft(s)`, `resolve_ai_coaching_draft`.
- **Draft only.** The model has no tools and cannot write. A draft (`coaching_ai_drafts`) becomes a plan version, actions or a private summary only when the coach resolves it, and the same permission checks run again at that moment. Each draft is resolved once and records accepted / edited / discarded and what was written.
- **Permission before retrieval.** The athlete, team or session is authorised (`requireRelationship`, `requireTeam`, `ownRecord`) before any record is read. Only the coach's own notes, goals, open actions and attendance for that scope are read; other coaches' staff notes, other athletes and clinical data are never queried. Private session summaries are shared only if the coach ticks that option.
- **Privacy in the prompt.** Players are replaced by labels ("Player A") and names inside note text are scrubbed; ids and emails are not sent. Note text is quoted as data with the platform's `AI_RULES`.
- **Transparency.** Every draft lists the records it used (`sources`), data limitations, and for each item whether it is *observed* (has a source) or a *suggestion*. A claim citing no valid source is downgraded to a suggestion; unknown source refs are dropped.
- **Guardrails.** Items or headlines with medical wording (diagnosis, injury, treatment, return to play …) are removed and noted. No ranking of players.
- **Fallback.** With no provider, a timeout or a bad answer, the coach gets a plain, source-linked summary of their own records (`ai: false`) and nothing else changes.
- **Audit and cost.** Calls are audit-logged and cached in `ai_outputs` (kind `coaching_assist`, keyed by the pseudonymised facts and model), and the draft links to that row.

## Slice 4 — reports, branded PDF, retry outbox
Migration `079_coaching_reports.sql` (additive: two tables, one nullable column on `generated_documents`).
- **Reports** (`coaching_reports`): a definition — audience (just me / athlete / guardian / team coaches), period, what to include (goals, numbers, next steps, chosen notes and sessions) and the coach's own summary. References are stored, never copies.
- **Audience safety is enforced on the server.** Only notes already visible to the audience can be selected (`player` → athlete and guardian; `staff`/`player`/`team` → team coaches; everything → the coach's own copy). Goals show the athlete wording to athletes and guardians; rubric scores appear only in the coach's private copy; actions need to be shared. Sections are rebuilt from live records at preview and publish time, so the client cannot add anything.
- **Published versions are immutable** (`coaching_report_versions`, database trigger refuses UPDATE/DELETE). Publishing again with unchanged content returns the existing version; changed content makes the next version and leaves earlier ones as issued.
- **Who can read a version**, checked live on every read and download: the author; the athlete (athlete audience); a currently verified guardian (guardian audience); active coaches of the team (staff audience). When a coaching relationship ends the coach can no longer create or publish, but what an athlete was already shown stays visible to them.
- **AI summaries**: a report's summary can start from an AI draft only if the draft was generated for the same audience (`audience` on `draft_ai_coaching_assist` limits the evidence to what that audience may see), and publishing requires an explicit `confirm_reviewed`.
- **Branded PDF (#249)**: `coaching_report` is now a document family on the shared template system (brand kit, logo, versioned templates; layout blocks header / title / text / footer). `generate_coaching_report_document` renders a published version's frozen snapshot; the template only chooses presentation. Downloads reuse `GET /branded-documents/{id}/file` with the report audience check.
- **Retry outbox (app)**: session notes go through an in-memory queue with the server's idempotency key. It survives a dropped connection but deliberately not an app restart, is emptied on sign-out/session expiry, and shows its state in the session screen.

## Completion work (parts A–H)
Migrations 080–085, all additive.

- **Notifications** (`coaching-notify.js`, run by the worker tick): action assigned / due soon / overdue / completed, goal review approaching, session review overdue, match debrief pending, report published. Wording is generic (no note text, goal, name or report content), each message has a dedupe key, and the recipient's channel switches and muted kinds apply. The platform has no quiet-hours setting, so none is applied beyond those preferences.
- **Usage metrics** (`get_coaching_usage_metrics`, admin only): counts and timestamps only, nothing per coach or athlete.
- **Studio home** filters and sections: sport, individual/group/team, athlete, team, skill tag, dates, open actions; matches to prepare/debrief, goals not reviewed for a month, draft reports, AI drafts waiting. Timelines also show goal decisions, actions, published reports and official matches.
- **Templates, clone, groups, delegation** (`coaching-templates.js`): session/block templates extend `coach_templates` (private, shareable with a team you coach or an organisation where you hold a coaching role, versioned, never carrying player data); applying copies blocks into a new plan version; cloning copies only the generic plan. Groups aim blocks at part of the roster. A head coach can delegate `attendance` and/or `observe` for one session to another coach of the same team (live-checked; no access to private notes or summaries). Player summaries and the team summary are shared only when the coach says so. Actions can recur.
- **Programmes** frame goals over a season/term/block; observations can be linked to goals when written; rubrics can be limited to a sport and to positions (the positions teams already record); dimension units and direction are kept.
- **Match workspace**: prep (opponent notes, checklist, objectives with optional indicators) sits beside the fixture's session record; objectives are checked against the **official** result and events only once the result is published (`completed`); bookmarks point at official events and never copy or change them. Official event counts and squad matches join the metrics labelled `official`. Comparisons now include same-position cohorts (adults, at least five, no names). The copilot can explain selected metrics (`compare_metrics`) and finds notes by keyword for questions.
- **Young people**: a new `coaching` consent purpose. Sharing coaching records about a young person (player-visible notes, goal wording, shared actions and summaries, athlete/guardian reports) needs a guardian's current consent; a verified guardian sees what the child sees (`guardian_coaching_overview`); withdrawing consent hides every shared item everywhere (kept, never deleted) and allowing it again restores them.
- **Evidence and voice**: photos, short videos (MP4/MOV/WebM) and PDFs up to 10 MB, up to ten per note, encrypted on disk, readable by exactly the people who can read the note (re-derived on every request; a note made private again hides its files at once). Voice-to-text works only when `COACHING_TRANSCRIBE_URL` points at a speech-to-text bridge; without it the app says so. A transcript is a draft the coach edits before it becomes a note.
- **App**: Performance Studio filters, tablet/desktop two-column layouts for the main screens, labelled controls (chips, switches, rows), programmes, rubrics, match prep, templates/groups/delegation tools, evidence and voice, athlete and guardian views. Verified end to end on the web build at phone, tablet and desktop sizes (see the PR for the run).

## Known limitations
- Voice-to-text needs a configured bridge; none is bundled.
- The retry outbox is in memory only (it deliberately does not store notes on the device) and is emptied on sign-out.
- Reordering plan blocks uses up/down buttons; drag-and-drop and a multi-player observation matrix are not built.
- Native apps open evidence files on the web app; there is no in-app video player.
- With no AI provider configured the copilot returns the plain source-linked summary; the model path is covered by tests with a stubbed provider.

## Player view
The athlete's and guardian's view of everything above is the player development workspace (`docs/player-development.md`, `GET /me/development`); it replaces the old "From my coach" screen.
