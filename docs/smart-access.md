# Smart attendance & access (#510)

One access layer for academies, teams, events and venues. A capture (a scan, a tap, a location check, a front-desk entry) is **evidence**; the canonical record is still written by the code that always wrote it.

| Domain (`domain`) | Subject (`subject_ref`) | Canonical record written | Who scans |
|---|---|---|---|
| `academy_session` | session id | `academy_attendance` (+ log) | session staff |
| `team_event` | `<team>_e_<event>` or `<team>_f_<fixture>` | `team_attendance` | team managers |
| `venue_access` | access point id | `bookings.checked_in_at` / `checked_out_at` | venue team, or a signed device |
| `event_gate` | access point id | `accreditation_scans` | gate staff, or a signed device |

Methods: rotating QR (personal pass, or the door code shown on a tablet), geofence, RFID/NFC, front desk (reason required), self.
Everything goes through `POST /access/captures` (`record_access_capture`), also an MCP tool. Code: `src/access-layer.js` (rules), `src/access-providers.js` (hardware adapters), `src/access-grants.js` (grants that follow their source), `src/capabilities/smart-access.js`.

* **QR** `GQ1.<P|S>.…`: per-subject HMAC, 30 s steps (pass) / 60 s (door code), a personal pass works once (replay is refused and reported). The static athlete QR is retired.
* **Geofence**: switched on per session / door; the device location is compared once and never stored. Outside or missing = held for staff (`pending_review`).
* **RFID/NFC**: only a blind index of the id is stored. A tag identifies; the live roster, booking or accreditation decides.
* **Hardware**: `webhook` adapter (HMAC-signed commands and device events). Only an explicit `{"ok": true}` is a grant; silence, errors and timeouts are `provider_unavailable`. The locker PIN is never sent.
* **Grants** (`access_grants`) are revoked when the booking, locker assignment or accreditation ends (hooked into cancel/release/revoke, plus a worker sweep); until the controller confirms they show `revoke_pending`.
* **Youth**: a guardian checks a young person in; a scan cannot collect them (guardian or live pickup delegate required); geofence outcomes of minors are not shown to staff.
* **Offline**: staff devices may hold a one-subject pack key; scans stay labelled unverified until `sync_access_captures` re-judges them (idempotent, conflicts surfaced). The queue is memory-only.
* **Reporting**: `get_access_report` keeps capture evidence apart from the final canonical figures; `list_access_anomalies` reports without accusing.

Sports: presence and access are sport-neutral, so every catalogue sport is covered natively and none uses a fallback (a test walks the whole catalogue).
