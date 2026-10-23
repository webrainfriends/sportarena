# Sponsorship termination, refunds, returns and final settlement (#298)

Ending an agreement is a workflow, not a status flip. It extends the canonical agreement (#145), its dues, payments and deliveries;
there is no second agreement, ledger or identity. Nothing is deleted.

## Model
| Object | Purpose |
|---|---|
| `sponsorship_terminations` | one termination per agreement: `given_side`, `reason_code` (`mutual`, `breach`, `non_performance`, `budget`, `other`), `reason`, `notice_on`, `effective_on`, `base_version`, `rev`, `status` (`notice` → `agreed` → `ended` → `settled`, or `withdrawn`), dispute fields, the frozen `settlement` snapshot. A partial unique index allows one live termination per agreement. |
| `sponsorship_returns` | goods sent back, referencing a canonical `sponsorship_deliveries` row. The trigger `sponsorship_return_guard` locks the delivery and refuses a total above `received_quantity`. |
| `sponsorship_refunds` | money given back, referencing a canonical `sponsorship_payments` row (and through it the provider `payments` row for online money), in that payment's own currency. |
| `sponsorship_obligations.conceded_cents` | the part of a due conceded by an approved termination refund, so a refund does not re-open the due as a debt. |

## Flow (all `cap(...)`: REST + OpenAPI + MCP)
| Capability | Who | Rule |
|---|---|---|
| `get_sponsorship_termination` `GET /sponsorships/:id/termination` | participants, admin (read) | notice, returns, refunds, what can still be returned or refunded, the live settlement, earlier notices, `can`. Without a notice it returns the impact preview. |
| `give_sponsorship_termination` `POST /sponsorships/:id/termination` | brand: `end` right (manager/approver); organisation recipient: owner/admin | reason, effective date (not in the past), `expected_version`; one live notice. The agreement keeps running until the date. |
| `answer_sponsorship_termination` `POST /sponsorship-terminations/:id/answer` | `accept`: the other side; `withdraw`: the giver, before acceptance; `dispute`: either side (note required); `resolve_dispute`: the person who disputed, or an admin | `rev` required: a stale one is 409 `stale_version`. A dispute may link a support case that already references the agreement. |
| `request_sponsorship_return` / `decide_sponsorship_return` | sponsor asks; recipient accepts/declines; sponsor confirms arrival | quantity ≤ received − non-declined returns, under a delivery lock (409 `return_exceeds_received`) |
| `request_sponsorship_refund` / `decide_sponsorship_refund` | sponsor asks against one **confirmed** payment; recipient approves/declines; money is recorded only when it is back | amount ≤ paid − refunded − open requests (409 `refund_exceeds_payment`). Approval concedes the due. Online money is refunded at the provider with an idempotent key (`status: refunded` retries it); bank/cash is confirmed by the sponsor. |
| `finalise_sponsorship_settlement` `POST /sponsorship-terminations/:id/settlement` | either side with the right | only after the agreement ended. Blocked (409 `unresolved_items`) by unverified payments, goods in transit, evidence under review, open returns/refunds or an open dispute. Dues still owed need `carry_forward` (409 `dues_owed`) and stay on record. Result is frozen. |
| `export_sponsorship_settlement` | participants; brand needs `export` | CSV, no payee, contact or private note |

`decide_sponsorship` with `status: ended` still works: it is recorded as a termination applied now (same safe handling). The hub's
"End deal…" now opens the agreement, where the notice workflow lives.

## What ending does
Only **future dues that nothing has happened to** are cancelled (`cancelFutureObligations`). Anything already due, overdue, part-paid,
dispatched, submitted or fulfilled stays; delivered goods and confirmed payments are never touched. A notice whose effective date has
passed is applied by the worker (`sponsor_terminations` step) and, defensively, before the termination is read or changed. It applies once.

## Dependencies, migration, rollback, recovery
* Needs #145 (042), the checkout payments (094) and amendments (095). Migration `096_sponsorship_termination.sql` is additive: new tables, one nullable-free defaulted column, one trigger. No row is rewritten; existing ended agreements simply have no termination record.
* Rollback = deploy the previous code; the new tables/column are ignored. Returns, refunds, concessions and settlements stay as history.
* Recovery: a stale error reloads the termination; every state derives from the termination, its returns/refunds and the dues. `endDueTerminations` is idempotent.

## Limits
* Only the sponsor asks for goods or money back; the recipient decides. A recipient-initiated refund or return is not modelled.
* Online refunds need the payment provider; if it refuses, the refund stays `approved` and can be retried. Escrow is not claimed.
* Dues that remain owed after the end cannot be waived here; they are carried forward on the settlement record.
* The termination screen is part of the agreement screen; disputes can be linked to a case but case handling stays in Support.
