# Team management & chat

Everything here is a capability (REST + OpenAPI + MCP). Who may do what:

| Role | Can |
|---|---|
| **Owner / admin** | everything below, incl. making managers |
| **Manager** (team role) | roster, availability, squads, recruiting, rates and settlement |
| **Captain** | roster, availability, squads, recruiting (not rates / money) |
| **Member** | set own availability, answer invitations and selections, read own payouts, use the chat |

## Roster & availability
`get_team_roster`, `update_team_member` (role, jersey, position, private notes, agreed rate), `set_member_availability`
(`available | tentative | unavailable | injured` + note; players set their own, managers anyone's), `leave_team` removes a
member (soft: status `left`, history kept). Rates and notes are never shown on the public team page.

## Invitations & recruiting
Find people with `search_people` / `list_coaches`, then `invite_team_member` (role + optional rate). They answer with
`respond_to_team_invite`; `list_my_team_invites` shows what is waiting. To advertise instead, post to the billboard with a
`team_id`: kind `team_recruiting` (players) or `coach_wanted`. The post's budget + `rate_unit` is the advertised rate:
accepting a response adds the person to the roster (as player / coach) at that rate.

## Squads (who plays what)
`set_squad` picks the people and their roles (`player, captain, vice_captain, substitute, coach, physio, manager`) for an
**event** or a single **match**. The list you send becomes the squad; dropped people stay in the table with status
`dropped`. Unavailable/injured members are refused unless `allow_unavailable`. Selected people are notified and answer with
`respond_to_selection` (`confirmed | declined`). `get_squad`, `get_team_schedule` (matches + events with confirmed counts)
and `list_my_selections` read it back.

## Settlement ledger
A record of what the team owes, in the team's currency (`create_team` takes `currency`, default INR). `create_squad_payouts`
turns each selected member's per-match rate into a due fee (idempotent), `create_team_payout` records anything else (bonus,
expense, coaching session), `update_team_payout` marks it paid or cancelled (rows are never deleted), `get_team_settlement`
gives per-person due / paid totals. Money actions need the owner or a `manager`. No money moves through the platform here.

## Team chat
One conversation per team, for active members only (`send_team_message`, `list_team_messages`, `mark_team_chat_read`,
`list_my_team_chats` for unread counts, `delete_team_message` — soft delete; your own, or any as a manager). Managers can mark
a message as an **announcement**, which notifies every member. The app polls every 5 seconds while the chat is open.

## Team workspace (tasks, schedule, attendance)

The team page opens a **workspace** (`TeamWorkspace` screen): a board, *My tasks*, *Schedule*, *Roster* and — for managers — *Squads*, *Recruit* and *Rates* (the existing management tabs). Nothing is deleted anywhere in it: tasks are archived, members who leave are marked `left`, sub-teams are archived with `update_team {archived:true}`.

### Master team and sub-teams
A team is a **master** team. For each tournament/event you can create a **sub-team** (`create_sub_team`, `POST /teams/:id/sub-teams`):
* *same as master* — `copy_roster` (default) starts with the master's active roster, or
* *different players* — `member_ids` (they must be on the master roster); change it later with `set_sub_team_roster` (`POST /teams/:id/sub-roster`).

The master's roster is never touched. Whoever can manage the master (owner, managers, captains, org grants) can manage its sub-teams. A sub-team can be entered in the event like any team, or the master can enter directly — the event entry may point at either. `list_teams` hides sub-teams unless `mine=true` or `include_sub=true`; `get_team` returns `sub_teams` and `master_team`.

### Task board
`list_team_tasks` (columns *new / in_progress / review / done* plus each member's open-task count), `get_team_task`, `create_team_task`, `update_team_task` (status moves, tags, due date, assignees), `add_task_subtask` / `update_task_subtask` (checklist + progress), `comment_on_task`, `attach_task_file` (a media path or https link), `archive_team_task`. Any active member can create a task; managers, the creator and assignees can edit it; assignees and commenters are notified.

### Attendance
Separate from squad selection (the coach's pick): attendance is who actually turns up, per event or fixture.
* `request_attendance` — managers ask the roster (or only the selected squad) to RSVP; everyone is notified.
* `set_event_rsvp` — a member answers *going / maybe / no*; managers are told about a "no".
* `confirm_attendance` — captain/manager confirms a going/maybe player (changing the answer clears it).
* `check_in_attendee` — mark arrival on the day (works without an RSVP).
* `list_event_attendance` — everyone with their answer, confirmation, check-in and counts. `get_team_workspace` returns the schedule with *my* RSVP for the side rail.

An RSVP is only accepted for events the team (or its master) is entered in, or the sub-team's own event, and for the team's fixtures.
