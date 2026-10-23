# Term expiry, final settlement and explicit renewals (#299)

The end date of a sponsorship agreement and the settlement of what is owed under it are separate facts. A renewal is never silent: it is a new,
linked agreement that the other side accepts at its exact terms version. It extends the canonical `sponsorships` / `sponsorship_obligations`
rows; there is no second ledger or agreement system.

## Data (migration `099_sponsorship_renewals.sql`, additive)
* `sponsorships.status` also allows `term_expired` (term over, dues still open) and `completed` (term over, every due fulfilled or cancelled).
  `ended` keeps meaning "terminated early". New columns: `renews_id` (predecessor), `renewal_rev` (optimistic version), `term_expired_at`, `settled_at`.
* Unique partial index: at most one live (not declined/withdrawn) successor per agreement.
* `sponsorship_renewal_assessments`: one current intent per side (`renew`, `renegotiate`, `not_renew`) + note.
* `sponsorship_renewal_notices`: one row per reminder sent (`d60`, `d30`, `d7`, `expired`, `settled`) so repeated or parallel runs notify once.
* Rollback: nothing else depends on the new objects; restore the previous status CHECK once no row is `term_expired`/`completed`.

## Flow
1. **Expiry** (worker step `sponsor_terms`): an accepted, `active` agreement whose `ends_on` is before today *in its own timezone* (unknown zone falls
   back to UTC) becomes `term_expired` if any due is still `scheduled`, otherwise `completed`. Dues are never paid, cancelled or waived by the date.
   Paused agreements are moved by resume, not by the clock. Rows are locked and re-checked, so it is idempotent and safe on two workers.
2. **Settlement**: after every change that closes a due (payment confirmed, delivery received, endorsement accepted) and again in the worker,
   a `term_expired` agreement with no open due becomes `completed`. Open dues stay payable/deliverable after expiry.
3. **Reminders**: at 60/30/7 days before the end, both sides are told once that nothing renews unless both agree. None once a renewal exists.
4. **Plans** (`assess_sponsorship_renewal`, `POST /sponsorships/:id/renewal-assessment`): each side states renew / renegotiate / not renew. A message only.
5. **Proposal** (`propose_sponsorship_renewal`, `POST /sponsorships/:id/renewal`): either side, in the last 90 days, after expiry, or once completed;
   the new period must start after the old one ends. Old lines are carried over with dates shifted, or `lines` are sent. Creates a `proposed`
   agreement with `renews_id`; no dues exist until the other side accepts the exact version through `decide_sponsorship` (`version` required,
   stale = 409). The proposer can withdraw; the other side can decline. Budget, program and award are not carried over.
   A sponsor cannot renew with an athlete who has closed sponsorship offers or is a minor; the athlete can still propose.
6. **List** (`list_sponsorship_renewals`, `GET /sponsorship-renewals`): agreements in the window, expired or completed with no renewal, soonest first.

## Visibility and safety
* `get_sponsorship` returns `renewal` (settlement with per-currency open amounts, plans, successor, predecessor, `renewal_rev`). The predecessor stays
  reachable with its history and payments. Authorisation and tenant isolation use `dealContext`; outsiders get 403.
* Every step is in `sponsorship_history`; notifications carry no terms or amounts. Currencies are never combined.

## UI
`apps/app/src/screens/sponsor-renewal.js` ("Term & renewal" on the agreement screen): days left, term-ended/open-dues and completed states, plans sheet,
propose sheet with calendar pickers, successor and predecessor links, withdraw/decline, stale-version and denied states.

## Tests
`apps/api/test/sponsorship-renewals.test.js` (PostgreSQL integration) and `scripts/e2e/sponsorship-renewals-journey.mjs` (browser, phone/tablet/desktop).
