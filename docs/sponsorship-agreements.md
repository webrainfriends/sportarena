# Sponsorship agreements (#145) — first vertical slice

Extends the canonical `sponsorships` row (see `sponsorship.md`); there is no second sponsorship system. Migration
`042_sponsorship_agreements.sql` is purely additive. Existing deals keep working, get no lines, no schedule, no invented
payments and no currency; the UI labels them "legacy" (`amount_cents` / `in_kind` as free text).

## Data
| Table | Purpose |
|---|---|
| `sponsorships` (+ `agreement_ref`, `currency`, `timezone`, `terms_version`, `accepted_version`) | the agreement; `status` is the existing proposed/active/declined/ended/withdrawn |
| `sponsorship_lines` | versioned contribution lines: **money** (amount or total, currency), **goods** (quantity/unit, optional estimate), **endorsement** (promoter, channels/placement/approval/asset/exclusivity terms) |
| `sponsorship_obligations` | the dated dues; unique `(sponsorship, version, line, seq)` |
| `sponsorship_payments` / `_deliveries` / `_submissions` | what actually happened to a due (money / goods / endorsement evidence) |
| `sponsorship_history` | append-only actor, version, action, reason |

Agreement state (sponsorships.status) is separate from fulfilment state (obligation status `scheduled|fulfilled|cancelled`;
*overdue* is derived from `due_on`).

## Flow
1. `propose_sponsorship` takes optional `lines` (+ `timezone`). All lines and the whole schedule are validated up front.
   A pure-endorsement or goods-only agreement needs no cash. `preview_sponsorship_schedule` shows the complete schedule.
2. `revise_sponsorship` (sponsor, unanswered offer only) creates a new `terms_version`.
3. `decide_sponsorship` → `active` requires `version` = the current `terms_version` for an agreement with lines (stale → 409,
   missing → 400). Only the recipient (target owner) accepts. Acceptance sets `accepted_version` and generates the dues in the
   same transaction.
4. `report_sponsorship_payment` (sponsor) → `decide_sponsorship_payment` (recipient confirms / rejects / reverses).
   `dispatch_sponsorship_goods` (sponsor) → `decide_sponsorship_delivery` (recipient). `submit_sponsorship_endorsement`
   (promoter) → `review_sponsorship_endorsement` (the other party).
5. `get_sponsorship`, `list_sponsorship_obligations` (filters + per-currency totals), `get_sponsorship_summary` (home).
   Every read and write is limited to the brand owner, the recipient, or an admin.

## Schedule rules
* Dates are calendar dates; `timezone` says which zone they are meant in.
* Monthly/quarterly occurrences are anchored to the **first** due date and clamp at month end (31 Jan → 28/29 Feb → 31 Mar).
* `starts_on` and `ends_on` are inclusive; any due outside the period is rejected, so nothing exists beyond the term.
* A `total_cents` split gives each instalment `floor(total/n)`, the **last** one the remainder; goods quantity splits the same way.
* Custom dates must be strictly increasing. Zero/negative amounts, unsupported currency, end-before-start are rejected.
* Cash is totalled **per currency**; estimates are reported separately as `estimated_not_cash` and never added to cash.
* Generation is idempotent (`ON CONFLICT DO NOTHING` on the unique key + row lock): retries and parallel workers add nothing.
  Recovery: an admin calls `rebuild_sponsorship_schedule`; it only fills what is missing.

## Money semantics and provider limits
* Payments are **tracked, not collected.** The sponsor-entered report (reference, amount, currency, date, https evidence) is
  *unverified* until the recipient confirms. Totals show committed / confirmed / reported-unverified / outstanding / overdue.
* Partial and multiple payments are allowed, bounded by the amount due (under a row lock); a bank reference cannot repeat.
  A reversal reopens the due and keeps the history.
* Nothing here claims funds were transferred or held in escrow. Checkout/payout integration is **not** done (see gaps).

## Ending
Ending a deal cancels only future dues that nothing has happened to. Due, overdue, part-paid, dispatched or submitted dues
stay open: debt and delivered value are never erased. Nothing is deleted.

## Remaining gaps (not in this slice)
* **Group target** — no durable "group" entity exists (only teams); not silently treated as a team. Needs its own design.
* **Amendments of an accepted agreement**, pause, renewal successor, and termination with refunds/returns.
* **Payment-purpose integration** (`payments.js` checkout/refund/settlement links, #71 payouts) and verified provider callbacks.
* **Performance review for teams/events/groups** and pre-agreement review (the athlete slice is below; sharing through #64 Sports Passport is not wired),
  CSV export, approaching-due reminders, per-line payer/payee/channel fields, disputes→cases linking, guardian/youth rules
  for sponsorship agreements.
* Agreement builder in the app covers fixed-term monthly money only; goods/endorsement lines are available through the API.

## Performance review (athlete agreements)
* The athlete switches the sponsor's read access on or off per agreement (`set_sponsorship_performance_access`), only while the
  agreement is active. Default is off. `official` shares approved competition results only; `all_evidence` also shares
  self-reported and imported figures, always labelled. Revoking stops every future read at once; the agreement, dues and history stay.
* `get_sponsorship_performance` reads the athlete's canonical `performances` live (nothing is copied, corrections show at once, superseded
  results never count). Results are grouped per sport, metric and evidence kind with sample size, period, best in the metric's direction
  and latest; there is no combined athlete score. Private match notes/ratings, health data and contact details are never read.
* Objectives (metric, direction, baseline, target, window, evidence kind) are proposed by the sponsor and evaluated only once the athlete
  agrees. They are a review aid: **missing a target never cancels, pauses or reduces a due.**
* Reviews are dated notes (`shared` or `author_only`) with an optional next-review date and a single athlete reply. Notifications carry no content.
* Youth athletes cannot be enabled (guardian authority is not wired here); team and event deals have no performance view.
* Migration `075_sponsorship_performance.sql` is additive (new columns default to no access); rollback = deploy the previous code.

## Rollback
Tables are new and additive: `DROP` is not part of any deploy. To switch the feature off, stop sending `lines`; legacy
behaviour is unchanged. No existing data is rewritten.
