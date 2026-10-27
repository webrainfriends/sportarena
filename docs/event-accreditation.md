# Event accreditation (#481)

Role-based, time-limited access credentials for the people who play or work an event: athletes, team staff, officials, medical, media, vendors, sponsors,
volunteers, security, operations and organiser-invited guests. It is **not** spectator ticketing, participant registration or venue employment, and it does
not copy any of them.

## One home
The event console's **Accreditation** tab is the only place accreditation is run: summary, applications, badges, scheme (zones and categories), nominations,
and "Mine" (your own badge, or apply). The gate scanner (`GateScan`) and the holder's pass (`MyAccreditations`, also **More → My badges**) are the two other
surfaces. The old per-member badge buttons on the department roster were merged into this: `set_accreditation` is gone, the roster's *Accredit* chip opens
this tab, and `event_department_members.accreditation` is kept as a projection of the real state (nothing in it was lost: migration 117 backfills every
`requested` / `issued` / `revoked` flag into a real accreditation in a per-event "Department crew" category).

## Who is eligible: canonical engagements, never copies
Eligibility is read **live** from the records that already exist (`src/accreditation.js → engagementsOf`):

| Engagement | Read from |
|---|---|
| `athlete` | accepted individual entry; active player of a team with an accepted entry |
| `team_staff` | coach / manager / physio of an accepted team; the team's owner |
| `official` | accepted staff role referee/umpire/linesman/scorer/assessor; accepted fixture official; officials department |
| `medical`, `volunteer`, `security` | accepted staff role; medical / volunteers / security department |
| `vendor`, `sponsor` | accepted `event_vendors` (retail, catering, other / sponsor); vendor staff roles |
| `media`, `hospitality`, `operations` | active member of a media / hospitality / other department; the organiser is `operations` |
| `guest` | organiser invitation only, no other role needed |

A credential is re-checked against this on **every scan**: when the entry is withdrawn, the staff assignment released or the department membership ended, the badge
stops working (`not_eligible`) without anyone having to remember to revoke it. Young people also need current guardian consent (`participation`, or `media` for
media-only categories); withdrawing it stops the badge on the next scan.

## Scheme
* **Zones** (`accreditation_zones`): field of play, athlete area, locker room, officials room, media centre, mixed zone, hospitality, operations, loading/service, medical, custom; optionally tied to one of the event's venues. Archived, never deleted.
* **Categories** (`accreditation_categories`): eligible engagements, zones opened, validity (event days by default, or dates), optional daily hours in a time zone, site restriction, escort / vehicle / equipment flags, required platform verification (`verification_cases`), photo at the gate, capacity, approval authority (`organiser`, `department_lead`, `auto`) and whether eligible people may apply themselves. A zone removed from a category is kept (`removed_at`).

## Lifecycle
`draft → submitted → under_review → approved | rejected`, plus `withdrawn` and `revoked`; *suspended* is a reversible hold on an approved credential and *expired* is derived from the window. Every transition is appended to `accreditation_history`.

| Route in | Who | Result |
|---|---|---|
| Self-application | eligible person, category must allow it | `submitted` (or `approved` when the category is automatic) |
| Team nomination | manager of an **accepted** team, for that team's active members | `submitted` |
| Department nomination | lead of the department, for its active members | `submitted` |
| Organiser invitation / bulk | organiser, up to 200 people per call, anyone eligible (or a guest) | `approved` |

Approval: the organiser always; the department lead only where the category says so and never for themselves. Approval re-checks capacity, the required
verification, guardian consent and the person's role. Nobody can override a prerequisite.

## Credential and QR
`GA1.<credential id>.<version>.<mac>`: no name, no user id, no event id, nothing personal. The token is **derived** (HMAC with the server's key), never stored;
a reissue bumps `credential_version`, so every earlier code reads `replaced` on the next scan. Revoke, suspend, withdraw and reissue are therefore effective at
once on every surface, with no cache to purge. Gate devices that cache can poll `list_accreditation_revocations`.

## Scan verdicts (`scan_accreditation`)
Always HTTP 200 with a verdict judged from live data: `valid`, `invalid`, `expired`, `not_yet_valid`, `revoked`, `suspended`, `replaced`, `wrong_event`, `wrong_zone`, `outside_hours`, `not_eligible`.
Gate staff are the organiser, accepted security staff and members of security or operations departments. The response carries only the minimum operational identity
(name, category, zones, escort / vehicle / equipment); the photo only when the category allows it and never for a young person; an unknown code, a code of another event
or a replaced code reveals nothing about the holder. Every scan (operator, zone, direction, verdict, time) is append-only; a repeat with the same `idempotency_key` returns the first verdict without recording again.

## Privacy and security
* Authorization, validation, eligibility and consent are enforced in the capabilities, not the UI. Strangers get 403/404, never a hint that a credential exists.
* Free-text decision notes are field-encrypted (`note_enc`); reading one is audit-logged. Revoke, reissue, approve and reject write `audit_log` entries.
* Media, vendor and medical holders gain nothing beyond their own credential; the scan log and report are organiser / gate staff only.
* No data is deleted: history and scans are append-only (database triggers), zones and categories are archived, removed zone links are kept.

## Reporting (`accreditation_report`)
Per category: waiting, approved, **live** (approved, not held, not expired), held, expired, revoked, rejected and **checked in** (a valid entering scan exists); per zone: permitted holders, admitted, refused, who is inside now (last valid scan was *in*); event gate likewise. Totals add outstanding approvals, never-used live badges and refusals in the last 24 hours.

## Capabilities (REST + OpenAPI + MCP from one definition, `src/capabilities/accreditation.js`)
`list_accreditation_kinds`, `create_accreditation_zone`, `update_accreditation_zone`, `list_accreditation_zones`, `create_accreditation_category`, `update_accreditation_category`,
`list_accreditation_categories`, `apply_for_accreditation`, `nominate_for_accreditation`, `list_accreditation_candidates`, `submit_accreditation`, `decide_accreditation`,
`withdraw_accreditation`, `change_accreditation_access` (suspend / restore / revoke), `reissue_accreditation`, `list_my_accreditations`, `list_event_accreditations`,
`get_accreditation`, `scan_accreditation`, `list_accreditation_scans`, `list_accreditation_revocations`, `accreditation_report`.

## Devices
One React Native codebase: web, iOS, iPadOS and Android. The gate reads QR codes with the camera (`expo-camera`) and always also accepts typed or pasted codes, so a hardware
scanner that types into a field works everywhere. Layouts adapt phone → tablet → desktop; controls are at least 44pt; verdicts are announced as alerts.
Not run on a physical phone from this environment: camera scanning on iOS/Android hardware (the web build, iOS and Android bundles were exported successfully).
