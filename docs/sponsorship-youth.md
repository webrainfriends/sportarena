# Guardian-authorized youth sponsorship (#307)

A young person (under the independence age of their policy, see `docs/guardians.md`) is **never** discoverable or reachable by sponsors on their own. A **verified guardian** names a sponsor; only then can that sponsor send an offer, and the guardian — not the young person — answers it. Existing restrictions (discovery, programs, invitations, applications) are unchanged.

## Journey
1. Guardian: *Family & guardians → Sponsors* → search-and-pick a sponsor → **Authorize** (`authorize_youth_sponsor`). Withdraw any time (`withdraw_youth_sponsor`).
2. Sponsor staff: *Sponsors → Guardian-authorized athletes* (`list_youth_authorizations`: display name only) → **Send offer** (`propose_sponsorship`). Without a live authority the offer is refused with the generic "not open to offers" message, even if the young person opted in to discovery.
3. The offer notifies the guardians, never the young person. The guardian accepts/declines (`decide_sponsorship`, exact terms version required) and is the recipient side for revisions, payments, deliveries and reviews. The agreement is always private.
4. Separate permissions, none implied by the agreement:
   - **Results**: `set_sponsorship_performance_access` — only a verified guardian can switch on; the young person may switch off.
   - **Photos & videos** (`media` consent, `youth.js`): required to submit endorsement evidence.
   - **Sponsor messages** (`contact` consent): required for the sponsor's shared comments, reviews and objectives.
5. The young person can read the agreement (`get_sponsorship` → `youth.minor_self`) but every write is refused while a verified guardian exists.

## Rules enforced server-side
- Unverified guardian / admin / the young person cannot accept or decline. A stale version is rejected (409).
- Revoking the guardian link or withdrawing the sponsor stops future sponsor actions (revise, comment, objectives, reviews, results reads, new offers) and result sharing at once; agreement, obligations, payments and history are untouched.
- Lists, summary, renewals and the portfolio include the guardian's children's agreements; other people get 403/404. `list_youth_authorizations` is limited to the brand's own staff.
- Performance reads never include notes, ratings, clinical or contact data.

## Schema (migration `100_youth_sponsorship.sql`, additive)
- `sponsorship_guardian_authorities(child_id, sponsor_id, authorized_by, status active|withdrawn, …)`, one active row per child+sponsor.
- `sponsorships.guardian_id`, `sponsorships.guardian_decided_at` (nullable).
- Rollback: deploy the previous code; the table and columns are simply unused. Nothing is dropped or rewritten.

## Payee arrangement
- Money for a young athlete is paid to a **verified guardian**, never the young person. The accepting guardian is the default payee (`sponsorships.payee_guardian_id`); any verified guardian can choose another with `set_youth_payee` (recorded in history, audit-logged, sponsor notified without identity).
- The payee is **frozen on each payment** when it is reported or its checkout opens (`sponsorship_payments.payee_guardian_id`). Online settlement credits that guardian's provider ledger/payout account (no new ledger); manual payments are confirmed by that guardian, or by any verified guardian if the frozen payee is no longer verified.
- With a guardian relationship but no live payee, the sponsor cannot report/check out a payment (`payee_required`) until a guardian is set. Agreements made before any guardian existed keep paying the recipient as before.
- Migration `101_youth_payee.sql` (two nullable columns, additive).

## Compatibility and limits
- An existing agreement with a young athlete who has **no** verified guardian keeps working as before for them (nothing is stranded), but they cannot accept new offers or share results.
- Payee: see below.
- Dependencies: #145, #67, #64, #71, #243, #249 are untouched integration boundaries.

## Validation
`apps/api/test/sponsorship-youth.test.js` (PostgreSQL integration): authority gate, discovery, acceptance, stale version, results, revocation, withdrawal, media/contact, isolation, payee freezing/reassignment/settlement.
