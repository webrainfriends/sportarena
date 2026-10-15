# Legal Services & Matter Management (issue #231) - phase 1

Web: **More → Legal**. API: tag `Legal` (REST, OpenAPI and MCP from the same `cap(...)` definitions in `capabilities/legal.js` and `legal-matters.js`).

## Existing → gap → change
| Existing | Gap | Change |
|---|---|---|
| Roles, `verification_cases` (evidence, review, expiry, revoke, jurisdiction) | No lawyer role; `doctor`/`physio` must not be reused | `lawyer` role and `lawyer` verification type (needs `id_document` + `bar_admission`, and a named country) |
| Clinical grants, medical records | Not a lawyer authorisation model | Untouched. A lawyer holds no clinical access; legal data lives in `legal_*` tables |
| Support/dispute cases | A legal matter is a different, private entity | No link. Support and platform admins get 404 on intakes and matters |
| Billboard kinds, shared quotes/scheduling | Legal requests must not carry free text | `legal_requests` has enums/numbers only (no text column exists). Shared scheduling, invoices and payments are phase 2/3 |
| Health regimes (`health/regimes.js`) | None for legal | `legal/packs.js`: eleven research-anchor packs |

## What phase 1 does
1. **Jurisdiction packs** (`list_legal_packs`). Country selection is not compliance: *requests, responses, intake, quotes, engagement* stay **off** per country until the platform team records qualified local counsel's approval (`record_legal_pack_approval`: reviewer, firm, review date; append-only; withdrawal switches it off again). Informational search and profiles need no approval. India is a restricted informational directory: responses are off unless explicitly approved. Never offered anywhere: client/trust money, escrow, referral fees, commission on legal fees, contingency fees, automatic court deadlines, AI legal advice.
2. **Credentials** (`save_my_legal_credential`). Admission is per jurisdiction (and region). It counts only while an approved, unexpired `lawyer` verification exists for the *same* country. A lapsed/revoked verification removes the listing and stops new regulated steps; history is never deleted (credentials are archived).
3. **Discovery** (`search_legal_counsel`, `get_legal_counsel`). Listed lawyers with a current verified admission only; a jurisdiction filter matches admission, not foreign experience; ordered by name (no paid placement); no ratings, win counts or free-consult flags exist in the schema.
4. **Public requests**: practice area, country, timeframe, budget; nothing else. A lawyer's response is an availability signal and creates no intake or engagement.
5. **Private intake and conflicts**: `start_legal_intake` (legal client, who pays, acting for self/team/organisation/event with delegated authority checked; minors refused). Party names are encrypted with a blind index. A name already held by the same lawyer for another client raises a review flag; **no other client's identity is ever returned**. The lawyer records clear / blocked / waived with a reason (append-only). Blocked ends the intake. A material party change re-opens review.
6. **Quote → accept → sign → confirm → matter** are separate steps: versioned quotes (any change supersedes), exact-version acceptance, signed engagement (quote version, terms version, signer capacity, time), lawyer confirmation, then activation, which re-checks conflict, credential and pack approval. Booking or paying never creates representation.

## Permissions
Client sees own summary/names/conflict state in words; lawyer also sees match count and reasons. Everyone else (including `admin`) gets 404. Reads are audit-logged (`read_legal_intake`, `read_legal_matter`). Personal text is encrypted (`*_enc`, bound to its column).

## Not in phase 1 (stated, not hidden)
Firm entities and verified firm membership, ethical walls, appointments/availability, matter documents, messages, decisions and tasks, evidence/hash/legal hold, event-coverage workspace, invoicing/tax/settlement, AI and e-sign/court integrations, per-jurisdiction retention and breach clocks, jurisdiction control/test register, mobile builds. No country has been approved: every pack ships unapproved and the packs are research anchors, not legal advice.

Migration `074_legal_services.sql` is additive (a CHECK is widened; new tables refuse DELETE, history tables refuse UPDATE). Tests: `apps/api/test/legal-services.test.js`.
