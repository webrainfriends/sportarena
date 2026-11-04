# Guardian pickup, handover & daily athlete safety (issue #788)

Training attendance alone does not prove who was allowed to collect a young athlete, or when supervision passed from the academy to a
person. This module adds that, as an extension of what already exists, not a second system.

## Requested feature → source of truth → verified gap → minimal extension

| Requested | Existing source of truth | Verified gap | Extension (this change) |
|---|---|---|---|
| Guardian-authorised pickup persons, validity, limits, emergency contacts (Family #572) | `guardian_links` + scopes, `pickup_delegates`, `add/list/revoke_pickup_delegate`, Family "Pickup & check-in" sheet | name-only delegates; no schedule, one-time use, passphrase, phone, academy limit, emergency flag, `pickup` scope | additive columns on `pickup_delegates`; `pickup` guardian scope; the Family sheet becomes **Pickup & safety** |
| Arrival, custodial handover, late pickup, departure mode, verified collector | `access_captures` (arrival), `academy_attendance` (attendance), access-layer `out` gate | no handover fact, no late/no-show state, no departure permission | `academy_handovers` (one row per session and athlete), `academy_handover_events` (append-only), `pickup_departure_modes` |
| QR / check-in without copying attendance or storing identifiers | rotating QR tokens in `access-layer.js` | collectors had no QR | `get_pickup_pass` mints the same token type for a guardian or collector; handover stores booleans only (`qr`, `passphrase`, `id_seen`, `photo_match`), never an image or ID number |
| Exceptions, no-show escalation, incident links, safeguarding routing with minimal disclosure | `notify()`, ops `safeguarding` permission (defined, unused), `cases` | no academy incident/safeguarding model | `academy_safety_events` (+ append-only log), `academy_pickup_policies`, `src/pickup-sweeps.js` |
| Desk / guardian phone / management UX, offline-safe | `ScanPanel`, offline store, `sync_access_captures` pattern | none for handovers | **Pickup & handover** session tab, **Safety & pickup** Academy tab, Family sheet, encrypted offline queue + `sync_academy_handovers` |

Nothing was duplicated: team check-in (`check_in_child`), venue/event access and attendance behave as before. A youth released through the
old QR/manual **out** gate now also leaves a handover fact, so the board is the single place to see who took custody.

## Rules
* **Unauthorised pickup is blocked** (`403 pickup_not_authorised`), recorded as a `blocked_pickup` event, guardians are notified and the athlete stays in care. It can never be overridden.
* **Revocation is immediate** and judged *as of when the handover happened*: a permission withdrawn after an offline scan still counts for that scan; one withdrawn before it is refused and raised as `offline_conflict`.
* A collector is allowed only inside their validity window, weekdays and local-time window, one-time use, academy scope, and, when a passphrase is set, only with the right phrase (server-verified; stored as a salted scrypt hash). A named adult with no account needs `id_seen` or the passphrase.
* A guardian without the **pickup** scope can neither collect, add collectors, confirm, nor mint a pass.
* **Guardian confirmation (default):** supervision transfers only when a guardian confirms (`confirm_academy_handover`), when the collector is a guardian presenting their own QR, or when staff give a written override reason (recorded; safeguarding is told). The policy can switch confirmation off per academy. A guardian can *stop* a pickup: state `disputed`, high-severity event, staff alerted.
* Walks-home / transport need a standing guardian permission (`set_pickup_departure_modes`), withdrawn instantly.
* Arrival, attendance and handover stay separate facts: handing over never rewrites attendance.
* Escalation ladder (per academy, defaults 10 / 20 / 40 min after the session ends): guardians → second guardian + emergency contacts → safeguarding officer. No-show after 15 min, officers at twice that. Unconfirmed handovers are chased after 10 min.

## Data model (migration `156_academy_pickup_safety.sql`, additive)
`pickup_delegates` (+ relationship, phone_enc, can_collect, is_emergency, emergency_rank, weekdays, from/to_time, tz, one_time, used_at, passphrase_hash, organisation_id, id_verified_*) · `pickup_departure_modes` · `academy_pickup_policies` (versioned, retired not deleted) · `academy_handovers` (unique per session+athlete; state awaiting / pending_confirmation / handed_over / disputed) · `academy_handover_events` (append-only) · `academy_safety_events` (summary and resolution encrypted) · `academy_safety_event_log` (append-only). Existing guardian links are back-filled with the `pickup` scope so nobody loses authority they already had.

**Rollback:** every statement is idempotent and additive; the previous build ignores the new columns and tables. No data is dropped or rewritten, so rolling back is a redeploy of the previous build.

## API (REST + OpenAPI + MCP, one definition each)
Guardian: `add_pickup_delegate` / `list_pickup_delegates` / `revoke_pickup_delegate` (extended, all new fields optional), `set_pickup_departure_modes`, `get_child_pickup_overview`, `confirm_academy_handover`, `get_pickup_pass`.
Staff: `get_academy_pickup_board`, `verify_academy_collector`, `record_academy_handover`, `sync_academy_handovers` (≤ 50 items, per-item `synced | already_synced | conflict | rejected`), `escalate_academy_pickup`, `get_academy_pickup_contacts`.
Management: `get_academy_safety_overview`, `report_academy_safety_event`, `list_academy_safety_events`, `get_academy_safety_event`, `update_academy_safety_event`, `get_academy_pickup_policy`, `set_academy_pickup_policy`.
Writes take an `idempotency_key`; errors use the platform envelope; lists are paged. A non-guardian gets `404` (existence is not leaked).

## Security and privacy
Server-side authorisation on every call (session access, ops permission, live guardian link and scope). Collector names, phones, safety notes and override reasons are encrypted (`*_enc`); reading decrypted names, contacts or event notes is audit-logged; lists show kind/severity/status only; event details need the `safeguarding` permission. No images or ID numbers are stored. This is a technical control set, not a claim of regulatory compliance in any jurisdiction.

## Screens and platforms
One Expo codebase: web, iOS, iPadOS, Android. Layouts adapt phone → tablet → desktop, 44 pt touch targets, accessibility labels, Dusk theme tokens only. All text is in `t()` with keys `pk.*` in the English pack and the 11 language packs (machine-drafted, `reviewed: false` until a native speaker signs off). Offline: handovers are queued in the encrypted device store (keychain / non-extractable WebCrypto key) with their real time and replayed safely.

## Tests
`apps/api/test/academy-pickup.test.js` (happy path, blocked, passphrase, confirm/stop, override, revocation, schedule, scope, departure modes, not-arrived, offline as-of, escalation ladder, no-show, policy, events and minimal disclosure, contacts, legacy gate bridge, REST/OpenAPI/MCP parity) plus the existing guardian, smart-access and academy suites as regression.
