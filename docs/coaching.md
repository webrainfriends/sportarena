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
Match preparation and post-match review, performance analytics with provenance, the AI coaching assistant, template sharing with teams or organisations, team training sessions and attendance, coach availability and buffers (#56), rule packs (#68), the concierge framework (#72), and earnings/opportunity links (#67, #71) — none of these exist on main yet.
