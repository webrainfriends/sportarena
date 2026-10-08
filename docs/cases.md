# Support & dispute cases (SPOR-66, 78, 111, 112)

One canonical case model for platform questions/incidents (`kind=support`) and transactional conflicts (`kind=dispute`).
A case **references** existing records through `case_links` (reservation, booking, invoice, payment, shop order, coach hire,
event, game, appointment, insurance policy, sponsorship); it never copies their data.

| Table | Purpose |
|---|---|
| `cases` | case number, kind, category, priority, status, requester, assignee, contact channel, structured non-personal `details`, resolution, SLA due/first-response timestamps |
| `case_links` | references to canonical records (`entity_type`, `entity_id`) |
| `case_messages` | the thread; `visibility` is `public` (requester sees) or `internal` (platform team only); bodies are encrypted |
| `case_evidence` | https references and PDF/JPEG/PNG/WebP files (≤5 MB), encrypted; only metadata is listable |
| `case_events` | append-only action timeline (actor, action, before/after status, reason, data) |

Nothing is deleted: withdrawing or resolving only changes status.

## Statuses and rules
`open → in_progress ⇄ awaiting_user → escalated → resolved`, `withdrawn`. Requesters can reply, withdraw, and reopen a
resolved case within 14 days (response targets restart). A reply to an information request moves the case back to
`in_progress`.

SLA targets (first response / resolution, hours): urgent 2/24, high 8/72, normal 24/120, low 72/240. The queue computes
`sla_state` (`breached`, `at_risk`, `ok`) live; requesters can hint `low|normal|high`, staff set `urgent`.

## Capabilities
Requester: `list_case_categories`, `open_case`, `list_my_cases`, `get_case`, `reply_case`, `withdraw_case`, `reopen_case`.
Platform team (`admin`): `list_case_queue` (status / kind / category / priority / SLA / assignee / text filters),
`triage_case`, `respond_case` (optionally requesting information), `add_internal_note`, `escalate_case`, `resolve_case`,
`get_case_evidence`.

## Authorization and privacy
* Requesters see only their own cases; any other user gets 404. Only linked records the requester is party to can be
  attached (public events/games only need to exist); a miss is reported as "not found".
* The requester never receives internal notes, staff-only events or the assignee's reasoning. `get_case` for staff is
  audit-logged (`read_case`); reading evidence is audit-logged (`read_case_evidence`).
* A platform team member cannot work or read evidence on a case they raised themselves.
* A dispute must link at least one record and only one active dispute per requester and record is allowed.
* Notifications carry generic text only (email bodies leave the system in clear text).

## What a case never does
Resolving a case does **not** refund, cancel or edit anything. Domain changes are made first through their own
capabilities (for example cancel a booking, issue a refund, correct a result) and referenced from the case with
`action_ref` / the timeline. Disputes on bookings, payments, provider payments and game data build on this model.

# Disputes (SPOR-70, 71, 72, 74)

A dispute is a case with `kind=dispute`. The category decides what it must reference and is validated against the
canonical records, never against client-supplied numbers:

| Category | Must link | Notes |
|---|---|---|
| `booking_charge` | reservation / booking / invoice / payment | disputed amount required |
| `refund` | reservation / invoice / payment / shop order / coach hire | disputed amount required |
| `payment_transfer` | payment | disputed amount required |
| `provider_payment` | payment **and** the engagement (coach hire or appointment) | raised by the payer or the payee (physio, doctor, coach, seller); if only the engagement is given its latest payment is linked |
| `game_data` | game or fixture | `contested_field`, `claimed_value` (+ `participant_id` for games) |

* The currency comes from the linked payment/invoice/reservation, and the disputed amount cannot exceed it.
* A payment may only be linked to the engagement it was made for.
* A person can link only records they are party to (a payment's payee counts); everything else is "not found".
* Only one active dispute per requester and record.

## Money: no direct edits from a case
`refund_payment` (admin) refunds all or part of a paid payment through the existing payment service
(`refundPartial`, idempotent per amount, over-refunds refused). Passing `case_id` records it on the dispute timeline and
notifies the payer. It moves money only: to undo a booking, order or hire use that capability first
(`cancel_reservation`, `update_hire`, ...), then cite the result in `resolve_case.action_ref`. The original reservation
timeline is never rewritten.

## Clinical privacy
`get_case_records` (admin, audit-logged) shows each linked record's safe facts only (amounts, statuses, dates). For an
appointment that is status, start time and duration; the reason, notes and consent-gated records are never exposed to
support or finance, and nothing clinical is copied into a case. There is no payout entity yet (see
[architecture.md](architecture.md) gaps), so provider-payment disputes reconcile against the `payments` row.

## Game data
Submitting a dispute stores the contested field and its **current value** (`details.current_value`) without changing the
game. It is routed (`routed_to=game_officials`) to the game's managers, the event organiser or the fixture's referee
(`list_game_disputes`; admin sees all). The requester can never decide their own dispute.
`decide_game_dispute` with `accept` applies the correction through `update_game_participant` or `record_result`
(so their own permission and validation rules apply), writes a `case_corrections` row with before/after, adds a public
timeline entry and notifies every participant. `reject` records the reason only.
`case_events` and `case_corrections` are append-only at the database level (updates and deletes are refused).
