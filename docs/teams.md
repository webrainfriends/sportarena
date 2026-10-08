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
