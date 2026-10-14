# Doctors & physios (SPOR-60, SPOR-128)

Providers are ordinary users with the `physio` / `doctor` role and (optionally) a sport profile. Nothing replaces the
existing appointment, consent and encrypted-record model; this adds a **public** side next to the **private clinical**
side and keeps them apart.

| | Public discovery | Private clinical |
|---|---|---|
| Tables | `provider_profiles`, `provider_availability`, `provider_time_off` | `appointments` (reason encrypted), `medical_grants`, `medical_records` (summary/details encrypted) |
| Who sees it | anyone | the two parties; providers only with an active consent |
| Content | type, bio, clinic, city, languages, specialties, fee, hours, rating, verification badge | reasons, notes, clearance, injury details |

## Services & price catalogue (issue #210, slice 1)

Providers publish configurable services (`upsert_provider_service`, `archive_provider_service`, `list_my_provider_services`; patients use `list_provider_services`). A service has a title, public description (never clinical detail), category, delivery modes, duration and cancellation text. Prices are append-only versions (`provider_service_prices`) carrying currency and a tax class (`unspecified|taxable|exempt|zero_rated|out_of_scope`); no rate or tax determination is made here. `book_appointment` accepts `service_id`: it uses the service duration and the price in force, and snapshots service, price version, tax class and cancellation text on the appointment, so later price edits or archiving never change it. Bookings without a service keep using the legacy consultation fee, and the prepay guard is unchanged. Not yet built (later slices of #210): offers, packages, pay-later policy, invoices/receivables, tax reports, treatment plans.

## Offers (issue #210, slice 2)

Providers create time-limited percentage or fixed-amount offers (`upsert_provider_offer`, `archive_provider_offer`, `list_my_provider_offers`), automatic or behind a code, for chosen services or all of them, with total and per-patient limits. `quote_appointment` returns the server-authoritative list price, discount and total; `book_appointment` (with `service_id` and optional `offer_code`) charges exactly that and records the offer, list price and discount on the appointment plus one redemption row (unique per appointment, so retries cannot double count; counted under the provider booking lock, so limits hold under concurrency). Offers never stack: the best single one wins; a code that cannot be used is rejected. Cancelled or expired appointments stop counting toward limits; archiving an offer leaves booked discounts intact. Fixed offers only apply in their own currency. Packages, subscriptions and pay-later remain for later slices. These are separate from venue discounts because they belong to a provider and apply to appointments.

## Provider profile and hours
* `upsert_provider_profile` (physio/doctor): headline, bio, clinic, city, in-person / remote, languages, specialties, fee,
  time zone, slot length, `accepting_patients`, `listed` (false hides the provider from search). Never put patient
  information in it.
* `set_provider_availability`: weekly windows (`weekday`, `HH:MM`–`HH:MM`) in the provider's time zone; replaced windows
  are kept (`removed_at`). `add_provider_time_off` / `remove_provider_time_off` block periods.
* `list_provider_slots`: open start times (hours minus time off minus requested/confirmed appointments, at least an hour
  ahead, up to 31 days). A provider without hours has no grid and can still be asked for a time.
* `book_appointment` accepts only open slots when a grid exists, serialises bookings per provider (one winner when
  several people race for a slot), refuses providers who are not accepting appointments, and notifies the provider.

## Search (SPOR-128)
`search_providers` (public, server-side filtering and paging): text, type, sport, specialty, language, city, remote,
accepting patients, fee range, minimum rating (from testimonials), verified credential (current approved verification
case), availability window; sorts `rating`, `fee`, `name`, `soonest`. Results are public-safe and carry the ids to continue
into `book_appointment` and `grant_medical_access`. With an availability window the candidate set is capped at 200
before paging. `list_providers` and providers without a profile keep working.

Verification: search shows and filters on the badge from the verification service. Clinical actions additionally
**require a current doctor/physio credential** (issue #59) on top of athlete consent: see "Clinical credential" below.

## Consent (revocable, auditable)
* `grant_medical_access` now takes a `scope` (`full` = records and fit-to-play, `clearance` = fit-to-play status only) and
  an optional expiry. Existing grants became full, non-expiring, active grants.
* `revoke_medical_access` is soft (`revoked_at`); access stops immediately, the row and an append-only
  `medical_grant_events` history (grant / revoke) stay. Every clinical read path checks "active, not expired, right scope".
* `list_my_grants` (athlete) shows state and history; `list_my_patients` (provider) shows who currently consents.
* Notifications about appointments and consent use generic wording only (no names, no clinical text).

## Appointment state
`requested → confirmed → completed`, `cancelled` until completed; final states cannot change; the other party is
notified; `cancelled_by` and `updated_at` are recorded.

## Payment (SPOR-60)
Appointments are a payable purpose (`payments.purpose_type = 'appointment'`) using the same hosted checkout as coach
hires. The fee is the provider's consultation fee (or their hourly rate pro-rated); it is `unpaid` only when a payment
provider is enabled and the fee is above zero. The provider cannot confirm or complete an unpaid appointment; cancelling a
paid one refunds at the provider first (if the provider refuses, nothing is cancelled). The payment provider only ever sees
"Appointment with <provider name>" and the amount, never the reason. Payouts to providers do not exist yet.

## Follow-ups (SPOR-75, SPOR-76)
`appointment_followups` link back to the appointment. The provider agrees `create_followup` (due date or window, plain
`instruction_summary`, optional encrypted `details`). The athlete tracks them with `list_my_followups`, and can mark them
done, cancel, change the date, or book the visit (`book_appointment` with `followup_id`: `due → booked → done`; a cancelled
visit puts it back to `due`). Sensitive `details` are encrypted, readable by the athlete or by a provider with an active full
consent, and every read is audit-logged. Provider-private clinical notes stay in `medical_records` and never appear here.
The worker sends one generic reminder per follow-up (and per confirmed appointment) inside each user's reminder window;
mute settings apply and the text never says what it is about.

## Third-party booking (SPOR-77)
A provider can say they take bookings on another site (`upsert_provider_profile.external_booking`, adapters in
`src/health/external-booking.js`: `generic`, `calendly`, `cal_com`; https only, no credentials in the link, host checked
per adapter). Patients get the address plus a mandatory notice that they are leaving Gotmygame
(`start_external_booking`). Afterwards `link_external_booking` records the booking: only the external provider, reference,
address, sync status and timestamps are stored, one Gotmygame appointment per `(provider, external provider, reference)`
(repeat calls update, never duplicate; someone else's reference cannot be claimed). The provider (or their integration with
an API token) reports changes with `reconcile_external_booking`, which applies the same status rules as everywhere else.
No scraping and no stored third-party credentials. Where a system offers an API, an adapter can add a `sync` hook later;
none is implemented yet.

## Clinical credential (issue #59)
Self-declaring `doctor`/`physio` is not enough. Both are required, every time, resolved live from the database
(`src/clinical-access.js`, backed by `verification_cases`, no re-login needed):

1. a current **verified credential** (approved, not revoked, not expired, profession matches the account's role, sport scope and,
   if configured, jurisdiction fit), and
2. the athlete's **consent** (`medical_grants`) where the action touches an athlete's records.

| Action | Credential | Consent |
|---|---|---|
| `add_medical_record`, `list_medical_records` (provider read), `create_followup` | required | required (full) |
| `update_appointment` confirm / complete (provider) | required (complete may use grace) | existing booking |
| `link_external_booking` (provider registering for a patient), `reconcile_external_booking` moving a booking to confirmed / completed | required (completed may use grace) | existing booking |
| `update_followup` by the provider: mark done (may use grace) or reschedule | required | existing follow-up |
| `book_appointment` | the **provider** must be current | athlete's medical consent |
| `get_clearance` via a clearance grant | required | required |
| `report_medical_incident` (event doctor/physio) | required, emergency exception | event staffing |
| `grant_medical_access` | not required; response carries `provider_verified` + `warning` | athlete's choice |
| cancelling an appointment or follow-up (either side), an athlete booking externally or editing their own follow-up, athlete reading own records | never blocked | - |

Blocked calls return `403` with code `credential_required` and `details: { reason, profession, expires_at, renewal }`; `reason` is one of
`not_verified | pending | expired | revoked | role_mismatch | sport_scope | jurisdiction`. `renewal` names the route:
`submit_verification` with the profession (the new case is linked to the earlier one via `previous_case_id`).
`get_my_clinical_status` (`GET /medical/credential`) returns the same state for the signed-in provider.

Policies (explicit, never silent):
* **Grace**: `CLINICAL_GRACE_DAYS` (default `0` = none). After *expiry only* (never revocation) a provider may complete an
  already-confirmed appointment for that many days. New records, follow-ups and reads are never covered.
* **Emergency exception**: an event doctor/physio with a lapsed credential may log a `serious`/`emergency` incident only with
  `emergency_reason`. It is audited (`credential_emergency_override`) and stored with the incident (`credential_override`, encrypted reason).
  First aiders have no platform credential and are unaffected.
* **Jurisdiction**: `submit_verification` accepts `jurisdiction`; set `CLINICAL_JURISDICTIONS=IN,GB` to accept only those.
  Unset = any (default).
* **Cancel is exempt**: cancelling (appointment, external booking, follow-up) only withdraws care and carries no clinical content, so a lapsed
  or revoked provider can always release a patient's slot. Provider-side follow-up *done* and *reschedule* are care management and are gated.
* **Atomic writes**: `add_medical_record` checks the credential, then inserts inside one transaction that first takes `SELECT ... FOR SHARE`
  on the verification case and on the athlete's grant row and re-reads them under that lock. A revocation (an UPDATE of that case) therefore
  waits for an in-flight write, and a revocation that already committed is seen by the write, so nothing is stored after a revocation commits.
  The earlier unlocked check still runs first for the audit trail and error messages.
* **Machine contract**: operations that can return `credential_required` (`credential: true` on the capability) list the `CredentialRequired`
  403 response in OpenAPI; MCP tools return the same code and details.
* **Audit**: every check writes `credential_check_allowed|denied|grace` (entity `clinical:<action>[:reason]`, athlete id) - never clinical text.

Least-privilege history (59-1b): a grant has `history_scope`. `since_grant` (default for new grants) lets the provider read the
records they wrote plus anything written since the grant; `all` (the athlete's explicit choice, `history: 'all'` on
`grant_medical_access`) also shows earlier records by other providers. Grants that existed before migration 050 are backfilled to
`all` so nothing the athlete already shared changes; granting again narrows it. Re-granting restarts the `since_grant` window.
The athlete always sees every record. `list_my_grants` returns `history_scope`, `provider_verified` and `credential_reason`.

UI (Health): providers see **Your professional verification** (state, expiry, why actions are blocked, a Renew/Get verified button to
Me > Verification). Athletes get a share sheet (what the provider can see, a warning when the provider is not verified) and a
warning in the Access list for providers whose verification lapsed. Server messages for blocked actions are shown as-is.

Limitations: sport scope is evaluated from the case's `sport_id` against the supplied `sport_id` or the athlete's sport profiles.
Existing data is untouched; migration 049 only adds nullable/defaulted columns (rollback: leave them, older code ignores them).

## Structured encounters (issue #212, doctor workspace slice 1)
Existing -> gap -> change: `medical_records` holds one free-text note per entry and `appointments` only a lifecycle; there was no signed,
versioned consultation. Added (migration 064, additive; nothing converted from legacy text): `clinical_encounters`.

* `create_encounter` / `update_encounter` / `sign_encounter` / `amend_encounter` / `void_encounter` / `list_encounters` / `get_encounter`
  (doctor only; REST + OpenAPI + MCP, token scope `clinical`). SOAP or free template; observations need value, unit and measurement time.
* Same gates as records: current verified **doctor** credential and the athlete's active **full** consent, re-checked under `FOR SHARE` locks in the
  signing transaction, so a revocation that commits first blocks the signature. The credential case relied on is stored.
* States `draft -> ready -> signed`, or `voided` with a reason. Edits carry `version`; a stale version is a 409. Signed rows are immutable in
  the API **and** by a database trigger; corrections are linked `amendment` encounters that are signed separately. One live encounter per
  appointment. Copied-forward text must be marked reviewed before signing.
* Working notes (`content`) are clinician-only. The athlete sees only the **visit summary** of signed encounters (Health > My records) and can
  acknowledge it - that records "read", not agreement or recovery. Other consented doctors see signed notes only, within the grant's history scope.
* Notifications are generic; all content is encrypted (`clinical_encounters.*`); reads and signatures are audit-logged.

Not in this slice (tracked in #212): problems/allergies/medications, care plans, results review, referrals, clearance versions, practice billing and
tax (shared with #210/#71), teleconsultation, guardian access to summaries. Rollback: leave the table; older code ignores it.
