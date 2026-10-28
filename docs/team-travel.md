# Team & delegation travel operations (#485)

One operating loop for a team, club, school, academy, national delegation or event organiser travelling to a competition:
**fixture/event commitment → trip → travel party → transport and stay → documents and readiness → movement and check-in → per diem and expenses → return and close-out.**

It is a thin operational layer. A trip **points at** canonical records; it never copies them, and it is not a travel agency: SportArena has no airline or hotel inventory, so no booking reference is ever shown as verified.

## Where it lives (no overlap)

| Surface | Where |
|---|---|
| All trips you run, travel on or guard a young traveller on | **More → Trips & travel** (`Trips`), filter by destination country |
| One trip (board, party, transport, stay, documents, equipment, money, reports, history) | `Trip` |
| Trips for one event | **Event console → Travel** (the single home for running an event) |
| A trip invitation or change | tap the notification → opens the trip |

API: `apps/api/src/capabilities/trips-*.js` (REST `/api/v1/trips/...`, OpenAPI, MCP tools of the same names). Rules shared by all of them are in `src/trips.js` and `src/trips-finance.js`.

## Source of truth

| Need | Canonical source (reused, never copied) | What the trip stores |
|---|---|---|
| Event, fixture, schedule | `events`, `fixtures` (read-only: a travel change never edits a fixture) | link rows `trip_events` (unlinking keeps history) |
| People | `users`, `team_members`, `organisation_members`, accepted `fixture_officials` | trip role + invitation state (`trip_participants`); basis says why they may be invited |
| Young travellers and guardians | `guardian_links` (live, verified) | trip-specific consent `trip_consents`, separate from general participation consent |
| Sourcing, quotes, orders, supplier fulfilment | #458 supplier services (`svc_rfqs`, `svc_orders`) | only a link (`trip_supplier_links`, `svc_order_id` on a leg or stay). No RFQ, quote or order is created here |
| Money out | `event_budget_lines` / `event_budget_payments` (event organiser) | `trip_payments`, optionally posted to the event budget; otherwise an explicit *external record* |
| Notifications | `notify()` | none |
| Calendar | the event/fixture calendar | none (no second calendar) |
| Equipment stock | `resources` | optional `resource_id`; the consignment tracks movement only |

## Sensitive-data matrix

| Data | Who can see it | How it is stored / protected |
|---|---|---|
| Passport / visa **status and expiry** | trip staff, the holder, a young holder's verified guardian | plain status + date (operational readiness only) |
| Passport / visa **number**, evidence reference | the holder or a young holder's verified guardian only (trip staff cannot reveal it) | encrypted (`*_enc`, context-bound); every reveal is audit-logged; no scans are stored |
| Receipt references on claims | stored encrypted; never returned | `receipt_ref_enc` |
| Room number and roommates | staff: all; adult traveller: own room and adult roommates; young traveller: property and room type only; guardian: the ward's room and adult roommates | server-side filtering; a young traveller can share only with other young travellers or their own verified guardian |
| Young travellers' names | trip staff, themselves, their guardians; other travellers see "Young traveller" | masked on the server |
| Itinerary legs | staff: all; traveller / guardian: only legs they are on | server-side filtering |
| Emergency contact | trip staff, from a day before departure to a day after return, only guardians who agreed; names only; contact goes through the platform | audit-logged; no phone numbers or emails are exposed |
| Safeguarding incident | trip manager and the owning team / organisation approvers | summary is operational only |
| Money | staff: everyone; traveller or guardian: their own statement | per-diem policy needs team-owner / organisation-admin approval |
| Notifications, history snapshots, reports, logs | never contain document numbers | enforced and tested |

Nothing is public. Reports are audience-safe (`manager`, `traveller`, `supplier`), audit-logged and marked with a 24 h expiry.

## Rules enforced on the server

- A trip needs a team or organisation you manage; events and fixtures must be ones your team is entered in or you organise; outsiders get 404.
- Party members come from the roster, the organisation or accepted officials on a linked fixture; guests only if the trip allows it. Being on the team is not being on the trip.
- A young traveller can travel only as an athlete, **cannot confirm for themselves**, and is confirmed only by a verified guardian's trip consent. A trip with young travellers cannot be confirmed without an adult manager or chaperone. Revoking the guardian link or the consent stops it counting at once.
- Legs and stays carry a UTC offset and an IANA zone per end; a wrong zone is rejected; times are compared as instants. Every edit needs the current `row_version` (409 otherwise), keeps the previous version in `trip_changes` (append-only, enforced by a database trigger) and tells only the affected people.
- Places: a name plus an optional ISO country and map point. The point can come from a pasted Google or Apple Maps link, coordinates or the device location; there is no map key or SDK.
- Entitlement (policy × days) → claim (submitted/approved/rejected) → payment (advance, per diem, reimbursement) → balance are four separate states. Per diem cannot exceed the approved entitlement; a claimant cannot decide their own claim; payments and claims are idempotent.

## Sports

Travel is sport-agnostic: nothing in a trip depends on a sport's scoring or rules, so every sport in the catalogue works natively. The trip records the team's sport only for display.

## Not in scope / honest limits

- No airline, rail or hotel inventory or live-status adapter: references are labelled "typed by the team" or "supplier order", never verified.
- No live location tracking. Planned times only.
- No immigration eligibility decisions or advice.
- No payroll. Passport / visa scans are not stored (an encrypted reference only).
- Branded documents (#249) are not used for the reports yet; they export as CSV.
- Short Google / Apple Maps links (`maps.app.goo.gl`) cannot be read; paste the full link or coordinates.
- Not run on a physical iOS, iPadOS or Android device; the web build was exercised at phone, tablet and desktop widths and the iOS and Android bundles export.
