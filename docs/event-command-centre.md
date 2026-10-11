# Event Command Centre

Run an event from first idea to the final whistle: lifecycle (open, start, **pause**, resume, end), departments and rosters,
a kanban board per department, fixtures, **live match tracking**, sport-aware scoring (Olympic / Asian Games style), a
**score sheet that is signed, approved and published** before it counts, and optional AI help. Every feature is a capability
(REST + OpenAPI + MCP). Migrations 031–036 are additive; nothing is ever deleted (archive / "left" / void / superseded).

## Lifecycle (031) — `event-lifecycle.js`
`pause_event` (reason required; live games freeze and everyone entered or on the crew is told), `resume_event` (restores only the games the pause froze),
`end_event` (refuses while games are live or paused unless `force` + reason; awards the podium like `complete_event`; stuck games become `abandoned`),
`get_event_status_history` (who, when, why; written by a database trigger so no path can skip it).
Statuses: `draft → open → ongoing ⇄ paused → completed`, `cancelled`. Fixture statuses add `paused`, `finished` (full time, awaiting sign-off), `postponed`, `abandoned`.

## Departments and rosters (032) — `event-departments.js`
Kinds: operations, medical, media, hospitality, security, volunteers, officials, logistics, tech, ceremonies, custom (`list_department_kinds`).
Organiser creates departments and names a lead; organiser or lead invites people; the invitee accepts (optionally adding phone, date of birth, ID number) or declines.
Roster personal fields are **encrypted** (`*_enc`, blind index on the ID number); `list_roster?include_pii=true` is limited to the organiser and leads and is **audit-logged** (`read_roster_pii`).
Accreditation: none → requested → issued / revoked (issuing needs an ID on file).

## Plans and kanban boards (033) — `event-boards.js`
A plan per department with its own columns (default Backlog / Doing / Blocked / Review / Done; the last means done). Cards carry priority, due date, start/end time, assignees (must be department members),
labels, a checklist, comments and a move history. Moving into `blocked` needs a reason. `my_event_schedule` (your tasks across events) and `get_event_timeline` (run sheet) give the time views.

## Live match tracking (034) — `match-tracking.js`, `src/scoring/*`, `src/live.js`
* **Rulesets** (`src/scoring/rulesets.js`): built-in for football, futsal, handball, hockey, water polo, netball, lacrosse, basketball, 3x3, kabaddi, rugby (+sevens), baseball, softball, volleyball (+beach), badminton, table tennis, squash, pickleball, sepak takraw, tennis/padel/soft tennis (games). Other sports fall back on their scoring family, then **manual totals**.
  Organisers can replace the rules for their event with `set_event_scoring_template` (until the first game is scored).
* The score is **computed from the event log, never typed in**: weighted scoring events, periods, rally-point sets with win-by-two, caps and deciding sets, tracked parameters (fouls, cards, timeouts, aces …).
* `start_match`, `pause_match`, `resume_match`, `log_match_event` (idempotent with `client_key`), `void_match_event` (kept, marked void), `get_live_fixture` (public; poll with `since_seq`), `get_event_live`, `check_schedule_clashes` (court, team, official, minimum rest).
* **Live stream**: `GET /api/v1/live/fixtures/:id` is Server-Sent Events; the app falls back to polling. The bus is in-process, which fits the single-process deployment; for several processes swap `publish/subscribe` in `src/live.js` for Postgres LISTEN/NOTIFY.

## Score sheets (035) — `score-sheets.js`
`end_match` (full time) → draft sheet pre-filled from the log → `update_score_sheet` (a change from the log needs a reason) → `submit_score_sheet` (checks run: impossible sets, level knockout with no winner, log mismatch …; errors stop it)
→ team managers `sign_score_sheet` or dispute → organiser `approve_score_sheet` (needs every sign-off, or a recorded `waived_reason`) or `reject_score_sheet` → `publish_score_sheet`.
**Only publishing writes the official result** (standings, knockout advancement). Corrections are new versions (`revise_score_sheet`); superseded sheets and every step are kept.
`record_result` is closed for games that have a sheet. Public: `list_published_results`, `get_published_score_sheet`.

## AI help (036) — `event-ai.js`, `src/ai.js`
`ai_plan_event` + `apply_event_plan` (departments and dated starter tasks), `ai_review_score_sheet`, `ai_match_recap` (hype / neutral / formal), `ai_schedule_suggest` (proposed moves that clear each clash).
Claude is used when `ANTHROPIC_API_KEY` is set (`AI_MODEL`, default `claude-sonnet-5-5`); **without it every feature answers from built-in rules**, so nothing depends on the key.
Prompts carry facts only (sport, scores, event kinds, counts, team names), never people's names or ids; user text is quoted as data; answers are schema-validated, cached in `ai_outputs`, and real model calls are audit-logged.
The deploy workflow passes `ANTHROPIC_API_KEY` (secret) and `AI_MODEL` (variable) to the server only when they are set.

## App
"Arena" look (`apps/app/src/arena.js`): deep midnight canvas, electric gradients, pulsing LIVE badges, score numbers that pop. Event screens opt in; the rest of the app keeps its theme.
Screens: `EventCommand` (hub, reached from the event page for organisers), `EventDepartments`, `EventBoard`, `EventFixtures`, `MatchCentre` (referee console and public scoreboard), `ScoreSheet`, `EventResults`.
Inputs use the right control: pickers for dates and times, search-and-pick (`entity-picker.js`) for people, chips for fixed choices, steppers for numbers.
