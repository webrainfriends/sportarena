# Sponsorship disputes, complaints and risk controls (#308)

A dispute is **one canonical support case** (`cases`, `kind=dispute`, category `sponsorship`) plus a thin `sponsorship_disputes` row that says what it
is about and carries the sponsorship workflow. The thread, evidence and timeline stay in `case_messages`, `case_evidence` and `case_events`; nothing
is copied. It lives on the agreement screen (next to "Ending this agreement") — there is no separate console.

## What it does
- **Subjects**: a payment, a goods delivery, endorsement evidence, or the agreement (optionally a money due). Each is linked in `case_links`
  (`sponsorship_payment`, `sponsorship_delivery`, `sponsorship_submission`, `sponsorship_obligation`, `sponsorship`). A payment dispute's amount can
  not exceed the payment and takes its currency; currencies are never combined or converted.
- **Contested, not changed**: opening a dispute never alters a due, a payment, a delivery or any evidence. The dispute shows as *contested* until a
  decision; an open dispute is a blocking item in a termination's final settlement.
- **Who can see it**: sponsor staff whose live role has `dispute` (manager, finance, legal, approver) or `dispute_read` (auditor too) — evaluators and
  viewers never; the recipient side (athlete, organisation owner/admin, guardian); and *assigned reviewers*. A platform admin who is not an assigned
  reviewer gets "not found" from the dispute, the generic case read, the evidence read, the case queue and every case action. Reads by reviewers are
  audit-logged. The generic case form cannot open a sponsorship dispute, and the generic withdraw/reopen/resolve actions refuse one.
- **Reviewers**: the first platform reviewer *claims* a dispute with a reason; afterwards only assigned reviewers add/remove reviewers. Removal
  keeps the row (`removed_at`) and access ends at once. Parties can not review.
- **Risk flags**: kind + required reason, attributed and timestamped; either side or a reviewer can raise, only a reviewer can clear (with a reason).
  Flags are never deleted (DB trigger).
- **Resolution**: assigned reviewer decides with a reason both sides read — `concession`, `no_financial_change` or `dismissed`. A concession is applied
  through the canonical obligation (`sponsorship_obligations.conceded_cents`, the mechanism termination refunds already use), bounded by what the due still
  owes and the disputed amount, in the due's currency, and recorded in `sponsorship_dispute_adjustments` (one per round; no second ledger).
- **Appeal**: either side, once, within 14 days, with a reason and optional new evidence; a *different* reviewer decides and that decision is final.
  The first decision stays in `sponsorship_dispute_appeals.decision_before` and the timeline.
- **Stale versions / idempotency**: every write names the dispute `rev` (409 `stale_version`); opening is retry-safe with `idempotency_key`; a unique
  index allows one live dispute per payment/delivery/evidence; concurrent decisions apply once (agreement then dispute row locks).

## API (all `cap(...)`: REST + OpenAPI + MCP)
`GET/POST /sponsorships/:id/disputes` · `GET /sponsorships/:id/disputes/export` · `GET /sponsorship-disputes/:id` · `GET …/:id/evidence/:evidence_id` ·
`POST …/:id/replies|flags|flags/:flag_id/clear|reviewers|resolve|appeal|withdraw`.

## Schema, migration and rollback
`migrations/101_sponsorship_disputes.sql` is additive: widens the `case_links` type list and adds `sponsorship_disputes`, `…_reviewers`, `…_flags`,
`…_appeals`, `…_adjustments`. No existing row is rewritten; agreements, privacy defaults and financial history are untouched. Rollback = deploy the
previous code: the new tables are ignored and every due, payment and case keeps its recorded state. Dependency order: #298 termination (conceded
cents), cases (016/017).

## Limits
- Resolutions waive part of a money due; refunding already-confirmed money still goes through the termination refund flow (it needs a termination).
- Notifications go to sponsor staff with `dispute`, the recipient contact and reviewers; they carry no terms or amounts.
