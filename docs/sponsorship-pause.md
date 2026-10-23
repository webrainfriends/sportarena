# Pausing and resuming sponsorship agreements (#297)

An accepted agreement can be paused by agreement of both sides and resumed later. The pause records why, from when, and exactly what happens
to the dues in it. It extends the canonical `sponsorships` / `sponsorship_obligations` rows; there is no second ledger or agreement system.

## Data (migration `095_sponsorship_pause.sql`, additive)
* `sponsorships.status` also allows `paused`; `sponsorships.pause_rev` is the version callers send so a decision made on a stale view is refused (409).
* `sponsorship_pauses`: side and person who asked, reason (`injury`, `season_break`, `funding_review`, `force_majeure`, `other` + note), `policy`
  (`hold` | `reschedule`), `effective_from`, optional `planned_resume_on`, status (`requested`, `scheduled`, `active`, `declined`, `withdrawn`,
  `resumed`, `ended`), who decided/resumed and when, and a `summary` of what was held and moved. A partial unique index allows one open pause per agreement.
* `sponsorship_obligations.held_by_pause_id` and `original_due_on`. No new obligation status: "held" is a flag, so every existing consumer keeps working.
  Held dues are excluded from "overdue" and from the overdue/due-in-30-days counts.

## Flow
1. **Request** (`request_sponsorship_pause`): either side. Sponsor side needs the new `pause` action (manager, approver); the recipient side is its
   authorised owner/representative. Start date is today or later; "Other" needs a note.
2. **Decision** (`decide_sponsorship_pause`): the *other* side approves or declines (decline needs a reason); the requester can withdraw. Nobody
   approves their own request. A start date of today takes effect at once; a later date is `scheduled` and the worker (`sponsor_pauses` step) starts it.
3. **Effect**: the agreement becomes `paused`. Dues dated on/after the start are flagged held, **except** dues that already have money reported or in
   checkout, goods, or an endorsement submission. Dues already due before the start are untouched: **a pause never erases debt**. Held dues cannot be
   paid, dispatched or submitted until resume (clear `held_by_pause_id` error); already-owed dues stay payable.
4. **Resume preview** (`preview_sponsorship_resume`): every held due with its current and new date, per-currency totals and the new agreement end. Read-only.
5. **Resume** (`resume_sponsorship`): either side, with the `pause_rev` from the preview.
   * `hold`: held dues fall due on the later of their date and the resume date.
   * `reschedule`: held dues move later by the length of the pause; the agreement end moves by the same amount.
   Dues are updated **in place** (never inserted), so the `(sponsorship, version, line, seq)` key makes duplicates impossible; a second resume is refused.
6. **Ending** a paused agreement closes the pause and releases held dues, so money that is still owed stays payable.

## Visibility, audit and safety
* `get_sponsorship` returns `pauses` and `pause_rev` to both sides, so both see the same agreed policy; `list_sponsorship_obligations` returns `held` and `original_due_on`.
* Every step is in `sponsorship_history` and notifies the other side (no amounts or terms in the notification).
* Authorisation and tenant isolation are enforced by `dealContext`; outsiders get 403 on reads and writes.
* Concurrency: every write locks the agreement row (`FOR NO KEY UPDATE`, so a simultaneous payment insert cannot deadlock) and bumps `pause_rev`; the pause
  candidates are re-checked under lock, so a payment reported at the same moment keeps its due out of the pause.

## UI
`apps/app/src/screens/sponsor-pause.js`, shown on the agreement screen (one place): request sheet (reason chips, calendar pickers, policy chips), pending
state for each side, paused state with the agreed policy, resume preview sheet, "held" tags and "moved from" notes on commitments, stale-version and
error messages, and denied-role messages.

## Dependencies, rollback, limitations
* Builds on #145 (agreement operations). Related: #71 (settlement), #243 (notifications email), #249 (branded documents).
* Rollback: nothing else depends on the new columns/table; restore the previous `sponsorships_status_check` once no row is `paused`. No data is removed.
* Not included: automatic resume on `planned_resume_on` (it is a plan; a person resumes), pausing individual lines, and pauses of agreements that are still being negotiated.
