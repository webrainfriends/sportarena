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

## UI
Me → **Verification** (request, track, add evidence, resubmit, withdraw); admins also get the **Verification queue** there.
Verified people show a "✓ Verified …" badge on their public profile.
