# Sports agent & player representation

Issue [#484](https://github.com/webrainfriends/sportarena/issues/484). Migration `124_agent_representation.sql`; API in `apps/api/src/capabilities/representation-*.js`
(engine `apps/api/src/representation.js`); screen `Representation` (More → Representation, Workspace for agents, Family → child → Representation).

This is a **mandate layer** over canonical features. There is no second contract, transfer, opportunity, payment, review or legal table.

| Reused as is | How |
|---|---|
| Verification (`verification_cases`, new type `agent`) | the agent badge and exactly what the reviewer checked (checklist + notes); licences are declarations until a review covers them |
| #333 player contracts | an agent reads a shared contract (no ledger, bank, expenses or payout data), keeps notes and a review state; signatures stay canonical |
| #67 Billboard / recruitment | the agent shares a canonical post; an approved application is sent by `respond_to_post` as the athlete (a guardian for a young person) |
| Sponsorships + confirmed payments | read-only view of a shared agreement; commission basis |
| Youth guardians and consent | live consent checks; guardian signs; guardian approves |
| Organisations | agency identity and delegated staff |

## Mandate / access matrix (also published at `GET /representation/matrix`)

| | Athlete | Guardian (young person) | Young person | Agent | Agency staff |
|---|---|---|---|---|---|
| Propose / sign a mandate version | yes | yes, and required | signs with a guardian | yes | never signs |
| Revoke (immediate) | yes | yes | yes | ends from their side | no |
| Share one exact item (video, application, contract, sponsorship) | yes | yes | no | no | no |
| Public Sports Passport | own | yes | own | if allowed | if allowed + staff allowed |
| A shared private item | own | yes | own | only that item, while live | same, if the athlete allowed staff |
| Express interest / submit application | approves, sent as athlete | approves | no | asks for approval only | asks only |
| Accept position/offer, sign, approve a transfer, accept sponsorship | only the athlete | also required | with guardian | **never** | **never** |
| Medical, private coaching, family finances, passwords, unrelated messages | own | per guardian rules | own | **never** | **never** |

**Live check on every call** (REST, MCP, exports, documents): mandate in force and inside its dates; agent not suspended; agent verification current; the licence the
mandate relies on current and checked; purpose, data category and action in the agreed version; for a young person the guardian's current consent; for a private item a
grant for that exact item; no open conflict on it. Nothing is cached, so revocation, expiry, suspension and withdrawn consent stop access at once. The agent keeps reading
their own business record (terms, notes, commission, history) afterwards.

## Commission

Terms live in the mandate version (fixed, percentage with threshold/cap on earned fees or paid money, or milestones the athlete confirms). A term applies to a **deal the
athlete shared and both sides confirmed**; it is computed from that deal's canonical facts (contract ledger fees/payments, confirmed sponsorship payments net of refunds),
once per deal per agent however often it is amended (only the difference posts; corrections are new lines). Currencies are never converted. States are separate: **owed →
invoiced → reported by the payer → settled** (only when the agent confirms receipt). The ledger is append-only.

## Conflicts

Agent-declared interests are compared with every deal joined; representing the person on the other side and dual representation are flagged. Platform flags are only flags:
people decide (acknowledge where policy allows - `REPRESENTATION_NO_WAIVER`, default `opposing_sides` - reject, recuse). An open conflict blocks the affected item.

## Configuration, operations, rollback

`REPRESENTATION_NO_WAIVER` (conflict kinds an athlete cannot simply accept), `REPRESENTATION_APPROVAL_DAYS` (default 14). Worker step `representation` expires mandates and
approvals and keeps confirmed deals' commission current. Rollback: stop using the capabilities; tables are additive and only read by the new code; the only widened constraint is
`verification_cases.type` (adds `agent`). No data is deleted by anything here.

## Sports coverage

Mandates and agent profiles carry sport ids from the whole catalogue (a test creates a mandate for every sport). Nothing here is sport-specific scoring, so there is no fallback.

## Limits (stated plainly)

* **#478 transfers/loans are not on `main`**: a transfer cannot be shared or assisted yet (`workflow_unavailable`); the Transfers tab says so. Flip `TRANSFER_WORKFLOW_AVAILABLE` and add its ownership check when it ships.
* **#215 reviews are not on `main`**: no agent reputation store was created; reviews will attach to the canonical system.
* There is no person-to-person invoice in canonical finance: commission statements are numbered snapshots stored here. No payment rail; "settled" is the agent's confirmation.
* Territories are recorded and shown to every party but not matched against free-text regions; sport is enforced for posts and team contracts.
* Public representation shows on the public profile (`get_person`), not the career timeline.
* iOS, iPadOS and Android are built with `expo export` from the same React Native code; no on-device testing was possible. Web was rendered at phone, tablet and desktop widths.
