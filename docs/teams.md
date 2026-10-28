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

## Team communication and member finance (#516)

### Assessment: feature → current source → limitation → extension
| Feature | Current source | Limitation found | Extension (this change) |
|---|---|---|---|
| Team chat | `team_messages`, `team-chat` capabilities | one flat channel, text only, 5 s polling | same table and capabilities, plus a reconnect cursor (`seq`), replies, reactions, pins, polls, media, guardians channel; SSE + long poll |
| Announcements | `announcement` flag + `notify` | members only | also to guardians of young members; still the shared `notify` (push / WhatsApp / email per #499) |
| RSVP / reminders | `team_attendance`, `request_attendance`, `set_event_rsvp` | not reachable from chat | a chat card (`post_team_rsvp_prompt`) that *asks through* `askAttendance` and *reads* `team_attendance`; chat stores no answer |
| Photos / files | `doc-store` (encrypted files), `sniff` | none for chat | `team_chat_media`: sniffed from bytes, encrypted at rest, access re-checked on every download |
| Guardians | `guardian_links`, `youth_consents` | no guardian-facing channel | `audience = guardians` channel; access from the live guardian link |
| Charges / collections | `academy_charges` + `collection_cases` are organisation/venue owned | a team has no organisation | `team_charges` raised from `team_charge_batches`; paid through the canonical `payments` (new purposes `team_charge`, `team_contribution`) |
| Team settlement | `team_payouts` (what the team pays players) | private to managers | untouched; none of the finance capabilities read it |
| Fundraising vs sponsorship | `sponsorships` (agreements with a sponsor) | none for member gifts | `team_fundraisers` / `team_contributions`; linked to a sponsorship only through an explicit `sponsorship_id` |

### Real-time chat
* **Web**: `GET /teams/:id/messages/stream` (Server-Sent Events). Every frame is `event: messages` with whole messages as *that viewer* may see them; the frame id is the message `seq`. A reconnect sends `Last-Event-ID` (or `?cursor=`) and gets what it missed, oldest first. Access is re-checked on every frame and every 10 s; losing it sends `revoked` and closes. An outsider gets `404`.
* **iOS / iPadOS / Android** (no `EventSource`): `list_team_messages` with `after_seq` and `wait_seconds` (≤ 25) is a long poll that returns the moment a message arrives.
* **HTTP is canonical**: both read the same rows. Messages are keyed by `message_id`, so a repeat never duplicates; `send_team_message` takes a `client_id` so a retried send is the same message. After a drop the app re-reads the latest page, which also picks up reactions/removals missed while offline. The app keeps at most 300 messages in memory.
* Several API processes: set `LIVE_BRIDGE=pg` (shared with live scoring) so every process hears every publish.

### Messages
`send_team_message` (text, announcement, `reply_to_id`, `media_id`, `audience`), `list_team_messages`, `delete_team_message` (soft; the attachment stops being served), `react_to_team_message`, `pin_team_message` (managers), `create_team_poll` / `vote_team_poll` / `close_team_poll`, `post_team_rsvp_prompt` (managers), `mark_team_chat_read`, `list_my_team_chats`. Reactions and changed votes are kept as withdrawn rows, never deleted. Polls show counts only; nobody sees who voted what. Own messages carry `delivery.delivered` and `read_by`.
Media: `PUT /teams/:id/chat-media?kind=image|file|voice&name=…&audience=…&seconds=…` (raw body; photos ≤ 10 MB, PDFs ≤ 10 MB, voice ≤ 5 MB / 180 s), then `media_id` on `send_team_message`; `GET /team-chat-media/:id` needs the sign-in header. Revocation: removal from the team, a revoked guardian link, a deleted message all end access immediately.

### Young members and guardians
Channel `team` is for members; channel `guardians` is for managers and the verified guardians of young members (who need not be on the team). Guardians see names, never contact details or whose guardian someone is. A young member still needs a guardian's current `contact` consent to post. Announcements to guardians go to guardians only.

### Member finance
A contribution ledger, not a bank account: nothing here holds money.
* `create_team_charges` (dues / season fee / match fee: same amount each, for the roster, the selected squad, those who said going, or chosen people), `create_team_expense` (equal / weights / exact; exclusions; `paid_by` already carries their share), `create_team_dues_plan` (+ `list_…`, `update_team_dues_plan`; the worker raises one charge per member per period, once), `adjust_team_charge` (reduction / waiver, original amount kept), `record_team_payment` (cash / UPI / bank / card, full or part), `cancel_team_charge`, `get_team_ledger`, `set_team_finance_settings`.
* A young member is charged to a verified guardian, never to the child; with no verified guardian the member is listed in `skipped` and not charged. Payers are notified once; reminders (3 days before, on the day, a week after) are idempotent.
* Shares are exact to the minor unit and deterministic: members are ordered by id and rounding is cumulative (`allocate`). Every raise, receipt, reduction and waiver is an append-only `team_charge_entries` row with who and why; reasons and notes are encrypted and reading them is audit-logged.
* Online payment: pass `purpose: { purpose_type: "team_charge", purpose_id }` from `list_my_team_charges` to `create_payment`. A webhook replay records one receipt; a payment that arrives after the charge was waived is refunded.
* Fundraising: `create_team_fundraiser` (owner-created opens at once; otherwise the owner approves with `decide_team_fundraiser`), `contribute_to_team_fundraiser` (pay online) or `record_team_contribution` (by hand), `get_team_fundraiser`, `list_team_fundraisers`. Progress counts paid gifts only.
* Privacy: a member sees only their own obligations (`list_my_team_charges`, `get_my_team_finance`); team totals only if the team switches `members_see_totals` on (no names, no other balances). The ledger and per-member lists are for owners, managers and the organisation's finance staff. Player rates and payouts live in `team_payouts` / the roster and are never read by these capabilities.

### Known limits
No in-app dunning ladder for teams (the academy `collection_cases` are organisation/venue owned); no refund sync from an admin refund back to a team charge (the ledger reconciliation flags it); donations come from members and guardians only, not the public.

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
