# Team & delegation travel operations (#485)

One operating loop for a team, club, school, academy, national delegation or event organiser travelling to a competition:
**fixture/event commitment → trip → travel party → transport and stay → documents and readiness → movement and check-in → per diem and expenses → return and close-out.**

It is a thin operational layer. A trip **points at** canonical records; it never copies them, and it is not a travel agency: GotMyGame holds no airline or hotel inventory. A typed reference is never shown as verified; only a booking confirmed by a connected travel partner (see *Travel partner adapters*) is.

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

Nothing is public. Reports are audience-safe (`manager`, `traveller`, `supplier`), audit-logged and marked with a 24 h expiry. They export as CSV and as a **branded PDF** through the shared document module (#249, optionally with your brand kit): the PDF carries exactly the same rows, every download re-checks live that you may still see the trip in that audience (a personal copy opens only for the person who made it), and it stops opening after 24 hours.

## Background reminders

The worker (`trips-sweeps.js`) re-checks passports against the trip's current dates (including after dates move) and reminds trip managers three days before departure when travellers are not ready. Reminders are deduplicated and never contain document numbers or young travellers' names.

## Rules enforced on the server

- A trip needs a team or organisation you manage; events and fixtures must be ones your team is entered in or you organise; outsiders get 404.
- Party members come from the roster, the organisation or accepted officials on a linked fixture; guests only if the trip allows it. Being on the team is not being on the trip.
- A young traveller can travel only as an athlete, **cannot confirm for themselves**, and is confirmed only by a verified guardian's trip consent. A trip with young travellers cannot be confirmed without an adult manager or chaperone. Revoking the guardian link or the consent stops it counting at once.
- Legs and stays carry a UTC offset and an IANA zone per end; a wrong zone is rejected; times are compared as instants. Every edit needs the current `row_version` (409 otherwise), keeps the previous version in `trip_changes` (append-only, enforced by a database trigger) and tells only the affected people.
- Places: a name plus an optional ISO country and map point. The point can come from a pasted Google or Apple Maps link, coordinates or the device location; there is no map key or SDK.
- Entitlement (policy × days) → claim (submitted/approved/rejected) → payment (advance, per diem, reimbursement) → balance are four separate states. Per diem cannot exceed the approved entitlement; a claimant cannot decide their own claim; payments and claims are idempotent.

## Sports

Travel is sport-agnostic: nothing in a trip depends on a sport's scoring or rules, so every sport in the catalogue works natively. The trip records the team's sport only for display.

## Travel partner adapters (#704)

Integration, not a booking engine. A hotel / flight partner is connected as an **Integration Hub** install (`travel_partner_https`, or the no-network `travel_sandbox`), so credentials, live/sandbox mode, rate limits, access approval and signed webhooks are the hub's; there is no second credential store. Partner secrets are never returned by the API.

| Step | Capability (REST + OpenAPI + MCP) | Rules |
|---|---|---|
| Consent | `set_trip_partner_consent` | only the traveller, or a young traveller's verified guardian; staff cannot consent for someone; withdrawing blocks new bookings |
| Search | `search_trip_travel` | trip staff; nothing reserved; no partner connected → `409 travel_partner_not_configured` and typed references remain |
| Hold | `hold_trip_booking` | idempotent; the partner's price and cancellation terms replace the estimate; adds a *planned* leg / stay marked `partner` |
| Book | `book_trip_booking` | trip manager; leg / stay become *booked*; cost joins `get_trip_finance.costs`; optional `budget_line_id` posts to the canonical event ledger |
| Cancel / change | `cancel_trip_booking`, signed partner webhook (`booking.changed` / `booking.cancelled`) | leg / stay status and dates follow; the booking, stay and history rows are kept; only the travellers, their guardians and the manager are told |
| Room blocks | `create_event_room_block`, `book_trip_room_block` | organiser publishes rooms, rate, cut-off and terms; rooms are counted under a row lock so a block is never over-booked |

### Channel partners per region (platform admin)

Besides an organisation's own connection, the **platform admin** connects any number of *channel partners* (an online travel site such as Booking.com, MakeMyTrip, Trip.com, Agoda or Expedia, or a travel gateway) under **Integration requests → Travel partners** (`/admin/travel-partners`, admin scope, `mustBePlatformAdmin`; hidden from everyone else). Each partner has the kinds it supplies (hotels, flights), the regions it serves (ISO countries; none = worldwide), live or sandbox mode, a priority and a status (active, paused, archived; never deleted). Credentials and the callback secret are encrypted, shown once and never returned.

- **Search fans out.** `search_trip_travel` asks every active partner that serves the destination country and kind, in parallel, and returns one list, cheapest first, each offer naming its partner. A partner that is down is reported in `partners` and never blocks the rest; if none can be reached the answer is `503`, and if none serves the region it is `409 travel_partner_not_configured` (typed references remain).
- **Book through the chosen one.** An offer carries its `partner_key`; `hold_trip_booking` re-checks that this partner still serves the region, and the booking stores which partner (`partner_label`) took it. A partner paused later can still confirm and cancel what it already holds.
- **Reservation goes to their platform.** Hold, book and cancel are sent to the partner; its signed callbacks (`booking.changed` / `booking.cancelled`, HMAC-SHA256, replay-safe) flow back into the trip exactly like any partner change.
- **Contract.** The generic HTTPS adapter speaks one JSON contract at the partner's address: `GET /health`, `POST /search`, `/hold`, `/book`, `/cancel` (bearer key). A named site whose own API is different is added as a mapper in `travel/adapters.js` (`MAPPERS`) without touching trip code. **No site-specific mapper ships yet**: each needs that site's agreement, credentials and sandbox, so the named sites currently connect through a gateway that speaks the contract. Until a real partner is connected only the sandbox partner exists, and nothing real is booked.
- Hotels onboarded directly (supplier services, organiser room blocks, typed references) keep working unchanged and are not routed through a channel partner.

What leaves the platform: the traveller's name and, for flights only, date of birth (each read is audit-logged `share_dob_with_travel_partner`), and only for travellers with a live consent. Passport / visa numbers never go to a partner. Booking history (`travel_booking_events`) is append-only and holds no personal data. Money: a partner cancellation is recorded as the partner gave it (refundable or not); a posted event-ledger payment is not reversed automatically, the organiser records the refund.

## Not in scope / honest limits

- Partner adapters cover hotel and flight search / hold / book / cancel for one or two partners; there is no rail, coach or car adapter and no live flight-status feed. Without a connected partner every reference stays "typed by the team" or "supplier order", never verified.
- No live location tracking. Planned times only.
- No immigration eligibility decisions or advice.
- No payroll. Passport / visa scans are not stored (an encrypted reference only).
- The branded PDF uses the plain layout or your brand kit; custom travel templates are not offered yet.
- Equipment can reference a canonical resource (`resource_id`) through the API; the app has no resource picker because there is no equipment catalogue screen to pick from.
- Short Google / Apple Maps links (`maps.app.goo.gl`) cannot be read; paste the full link or coordinates.
- Not run on a physical iOS, iPadOS or Android device; the web build was exercised at phone, tablet and desktop widths and the iOS and Android bundles export.
