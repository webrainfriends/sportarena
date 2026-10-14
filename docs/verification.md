# Verification service (SPOR-100 … 108)

A verified badge (like Instagram / LinkedIn) is a **case** the platform team reviews. It is attached to the canonical
user / sponsor / event row — nothing is cloned — and the badge is *derived* from an approved, unexpired, unrevoked case.
A self-declared role (athlete, coach, physio, doctor…) never counts as verified.

| Type | Subject | Eligibility | Evidence | Valid |
|---|---|---|---|---|
| `gamer` | your profile | `athlete` role | photo ID + a profile link, club letter or match record | 12 mo |
| `coach` | your profile | `coach` role | photo ID + coaching certificate or federation licence | 24 mo |
| `physio` | your profile | `physio` role | photo ID + professional licence | 12 mo |
| `doctor` | your profile | `doctor` role | photo ID + medical council registration | 12 mo |
| `insurer` | your profile | `insurer` role | insurance regulator licence + business registration or authorisation letter | 12 mo (approval also marks the insurer profile verified; revoking clears it) |
| `sponsor` | a sponsor you own | sponsor owner | business registration + domain proof or authorisation letter | 12 mo |
| `event` | an event you organise | organiser | sanction letter, venue confirmation or public listing | 12 mo |

Rules, the reviewer checklist per type and the process are served by `GET /verification/rules` (source: `src/verification.js`,
versioned; each case records the version it was submitted under).

## Workflow
`submitted → in_review → approved | rejected | needs_info → (resubmit) submitted …`; also `withdrawn` (requester) and `revoked` (platform).
`expired` is derived when an approved case passes `expires_at`; renewal (a new case linked by `previous_case_id`) opens 30 days before expiry.

* Requester: `submit_verification`, `add_verification_evidence`, `resubmit_verification`, `withdraw_verification`, `list_my_verifications`, `get_verification`.
* Platform team (`admin`): `list_verification_queue`, `claim_verification`, `get_verification_evidence`, `decide_verification`, `revoke_verification`.
* Public: `list_verification_rules`, `get_verification_badge`, plus a `verified` list on people, sponsors and events.

## Safeguards
* Evidence references and files are AES-256-GCM encrypted (`src/crypto.js`), never listed to the requester or public, and every reviewer read is written to `audit_log` (`read_verification_evidence`).
* Approving needs every checklist item ticked and the required evidence on file; rejecting / asking for more / revoking need a reason the requester sees.
* A reviewer cannot claim, read or decide their own request, and only the claiming reviewer can decide.
* Nothing is deleted: cases, evidence and the append-only `verification_events` history (actor, action, before/after status, reason, time) are kept.

## Clinical enforcement (issue #59)
A `doctor` / `physio` badge is the gate for clinical writes and reads of other people's records: `src/clinical-access.js` re-checks
the case in the database on every call (approved, unrevoked, unexpired, profession matches the role, optional sport/jurisdiction),
so expiry or revocation applies immediately. Cases may carry an optional `jurisdiction` (set on `submit_verification`).
Grace, emergency exception, error codes and the per-action table are in `docs/health.md` (Clinical credential).
Config: `CLINICAL_GRACE_DAYS` (default 0), `CLINICAL_JURISDICTIONS` (default any).

## Onboarding timeline & document access
Physios, doctors, insurers, sponsors (and every other type) follow one timeline: **documents submitted → review queue → platform review → decision → verified & public**.
* `list_my_onboarding` (`GET /me/onboarding`): one card per thing you can get verified (by role, plus each sponsor you own) with state, next step and required-document progress.
* `get_verification_timeline` (`GET /verification/cases/:id/timeline`): stages (done / current / upcoming / blocked), `next_step` with who must act, the required / one-of documents with which are provided or missing.
* Documents stay AES-256-GCM encrypted. `get_verification_document` returns one only to the uploader or to someone the uploader shared it with (`share_verification_documents`: one person, chosen documents or all, 1–365 days, revocable with `revoke_verification_share`, listed by `list_verification_shares` / `list_verification_shared_with_me`). Everyone else gets `404`; every read is written to `audit_log`. Platform reviewers keep their separate, audit-logged evidence read.
* Shares are never deleted, only revoked (`revoked_at`). Migration `071` only widens the type check and adds `verification_shares`.

## UI
Me → **Onboarding & verification**: a light, card-per-role board; tapping a card opens the vertical timeline with the next step, a documents checklist (upload per slot, view, add), and a *Who can see these documents* panel (search-and-pick a person, choose 7/30/90 days, revoke); admins also get the **Verification queue** there.
Verified people show a "✓ Verified …" badge on their public profile.
