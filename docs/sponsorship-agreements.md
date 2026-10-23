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
   Every read and write is limited to the brand owner (and, for a brand linked to an organisation, that organisation's staff
   under their sponsor roles, see [organisations.md](organisations.md#corporate-sponsor-workspace)), the recipient, or an admin.

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
* **Pause, renewal successor, and termination with refunds/returns.** (Amendments of an accepted agreement: see [sponsorship-amendments.md](sponsorship-amendments.md).)
* **Performance review for teams/events/groups** and pre-agreement review (the athlete slice is below; sharing through #64 Sports Passport is not wired),
  CSV export, approaching-due reminders, per-line payer/payee/channel fields, disputes→cases linking, guardian/youth rules
  for sponsorship agreements.
* Agreement builder in the app covers fixed-term monthly money only; goods/endorsement lines are available through the API.

## Contracts and signatures (#295)
A branded contract can be issued for any proposed or active agreement's current terms version, then signed by the named signatories. Acceptance (`decide_sponsorship`) is unchanged and still exact-version. See [sponsorship-contracts.md](sponsorship-contracts.md).

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

## Online checkout, payouts and reconciliation (#294)
Extends the canonical `payments` purposes and the #71 settlement ledger; there is no second ledger.
* **Pay online** (`start_sponsorship_checkout`, `POST /sponsorship-obligations/:id/checkout`): a sponsor user whose role may `pay` opens a hosted Stripe/PayPal
  checkout for a money due, in full or in part (several checkouts per instalment, never beyond what is still due). Each checkout is a
  `sponsorship_payments` row (`method='online'`, status `awaiting_payment`) and a `payments` row with purpose `sponsorship_payment`; amount and
  currency are read from the row, never from the client. The amount is reserved against the due while the checkout is open (row lock on the due), so concurrent
  checkouts cannot over-reserve. Refused until the recipient has a payout account in that currency and the currency is payable (`recipient_not_onboarded`,
  `currency_unsupported`); the recipient is notified.
* **Success is not a payout.** The row becomes `confirmed` only when the verified provider result settles the payment (webhook, return page or `confirm_payment`);
  `settle` is idempotent (locked, status-guarded, `provider_events` replay guard), so retries/webhooks never double-charge or double-settle. Settling posts the
  recipient's sale and the platform fee into `provider_ledger` once (idempotency keys), subject to the hold period. Paying the recipient out is the existing, separate
  payout flow under Earnings. A payment that arrives for a cancelled/expired checkout or an inactive due is refunded automatically.
* **Manual reports remain unverified.** `report_sponsorship_payment` rows stay `reported` until the recipient confirms them; online rows cannot be confirmed,
  rejected or reversed by hand (409). Refunds (`refund_payment`, platform team) are mirrored onto the due (`refunded_cents`; fully refunded -> `reversed`); confirmed money is net of
  refunds and a refund that uncovers a due reopens it.
* `cancel_sponsorship_checkout` abandons an open checkout (the provider payment stays pending; if it is still completed the money is refunded). Checkouts older than two hours or whose payment failed stop reserving the due.
* `get_sponsorship_reconciliation` (`GET /sponsorship-reconciliation`) reconciles per currency (never across currencies): committed, collected online, refunded, confirmed manual, reported, in progress, outstanding, against the
  ledger's sale/refund/chargeback lines; `reconciles` is true only when both sides agree. Reads use the same participant scope as the dues list, so another tenant sees nothing.
* UI: agreement screen -> Commitments (Pay online sheet with full/half/other amount and provider choice, verified/unverified labels, cancel checkout) and a Reconciliation section.
* Browser check: `scripts/e2e/sponsorship-checkout-journey.mjs` drives the real web build (phone, tablet, desktop; sponsor and recipient) against the API with a fake Stripe: blocked-until-onboarded, amount validation, provider redirect and return, partial payment, stale conflict, cancel, recipient confirm/no-reverse, reconciliation. Run instructions are in the script header (needs `playwright-core`, which is not a repo dependency).
* Migration `094_sponsorship_checkout.sql` is additive (widened CHECK lists, `payment_id`, `refunded_cents`; existing rows untouched). Rollback = deploy the previous code; no row uses the new values until online checkout is used.
* Limits: payouts use the existing manual/verified payout flow of #71 (no automatic provider payouts); disputes lost are shown on the ledger side only; Stripe/PayPal need live keys and the webhook configured as in [settlement.md](settlement.md).

## Programs
Funding programs, rounds and applications that end in an agreement are described in [sponsorship-programs.md](sponsorship-programs.md).

## Rollback
Tables are new and additive: `DROP` is not part of any deploy. To switch the feature off, stop sending `lines`; legacy
behaviour is unchanged. No existing data is rewritten.

Negotiation, counteroffers and sign-off: see [sponsorship-negotiation.md](sponsorship-negotiation.md).
