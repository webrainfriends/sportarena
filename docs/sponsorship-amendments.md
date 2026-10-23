# Sponsorship agreement amendments (#296)

Changes to an **accepted** agreement need both sides. Extends the canonical agreement (#145) and its negotiation versions (#290);
there is no second agreement, ledger or payee system.

## Model
| Object | Purpose |
|---|---|
| `sponsorship_amendments` | one versioned **proposal** per row: full proposed lines (value, recurrence, deliverables, rights), period, optional payee allocations, `effective_from`, `rev`, `base_version`, status `proposed → accepted / rejected / withdrawn / superseded`. One open proposal per agreement (partial unique index). |
| `sponsorship_versions` (+ `effective_from`, `amendment_id`) | an accepted amendment writes the next numbered terms version, authored by the proposing side and signed off by the other. |
| `sponsorship_obligations` (+ `cancelled_by_amendment`, `created_by_amendment`) | which dues an amendment replaced and which it created. Old dues are cancelled, never deleted or edited. |
| trigger `sponsorship_obligation_guard` | a **fulfilled** due can never change amount, date, currency, quantity or identity, nor be cancelled. |

## Flow (all `cap(...)`, so REST + OpenAPI + MCP)
| Capability | Who | Rule |
|---|---|---|
| `preview_sponsorship_amendment` `POST /sponsorships/:id/amendments/preview` | sponsor or recipient | read-only impact: **retained** (earlier) dues, **replaced** (untouched future) dues, **new** dues, cash before/after per currency, and `blocked` |
| `propose_sponsorship_amendment` `POST /sponsorships/:id/amendments` | brand: `revise` right; recipient (organisation: owner/admin) | needs `expected_version` = the accepted version; one open proposal; changes nothing |
| `revise_sponsorship_amendment` `POST /sponsorship-amendments/:id/revise` | the proposing side | `rev` required; creates revision `rev+1` |
| `decide_sponsorship_amendment` `POST /sponsorship-amendments/:id/decision` | `accept` / `reject`: the **other** side (brand: `sign_off` = manager/approver); `withdraw`: the proposing side | exact `rev` and, to accept, the agreement `version`; stale → 409, nothing changes |
| `list_sponsorship_amendments`, `get_sponsorship_amendment` | participants and admins (read) | deterministic order, paginated; payee identities are shown to the recipient only |
| `export_sponsorship_amendments` | participants; brand needs the `export` right | CSV without payee, contact or private-note data |

`get_sponsorship` now also returns `amendments` (open proposal, total, what the caller may do) and each due carries `cancelled_by_amendment` / `created_by_amendment`.
Platform admins can read amendments but never propose or agree for either side.

## What an acceptance does (one transaction, sponsorship row locked)
1. Re-checks revision, agreement version, effective date (never in the past) and the live dues. A future due on/after the effective date that already has a reported/confirmed/in-checkout payment, a non-rejected delivery or submission, or that is fulfilled **blocks** the amendment (`409 locked_dues`, choose a later effective date). Nothing is silently skipped.
2. Writes lines for the new version, the brand identity snapshot and the version record.
3. Cancels exactly the previewed untouched future dues (guarded by the same predicate; a mismatch rolls everything back) and creates the new dues from the effective date. The schedule builder only owns dues from `effective_from`, so **rebuilding a schedule never recreates earlier dues**.
4. Payee allocations (organisation/group agreements, proposed by the organisation only) are re-validated against live membership and written through the existing allocation writer; the allocation `rev` must be unchanged since the proposal.
5. Budget-controlled agreements: extra cash must fit the authorized budget (same lock and FX rate as acceptance); a reduction frees budget. Budget usage now counts non-cancelled dues of **every** version, so retained dues keep counting.
Accepting twice, or two people accepting at once, applies once; the loser gets 409.

## Dependencies, migration, rollback, recovery
* Needs #145 (migration 042), #290 (094 negotiation), #291 allocations and #293 budgets. Migration `095_sponsorship_amendments.sql` is additive: new table, nullable columns, one trigger. Existing agreements, privacy defaults and financial history are untouched.
* Rollback = deploy the previous code: the new objects are ignored (an open proposal simply cannot be answered). Accepted amendments stay as history (their version, cancelled and created dues). Nothing is dropped.
* Recovery: a stale error reloads the agreement; every state derives from `sponsorship_amendments`, `sponsorship_versions` and the dues. `rebuild_sponsorship_schedule` remains idempotent.

## Limits
* Payee amendments cover organisation and group agreements; for event/team/athlete targets the payee is the canonical recipient and is not amendable. The organisation can still manage its internal allocation split directly (#291).
* Pause, renewal successor and termination with refunds/returns are separate items.
* Not a deployed-app validation: see the PR for what was exercised.
