# Doctors & physios (SPOR-60, SPOR-128)

Providers are ordinary users with the `physio` / `doctor` role and (optionally) a sport profile. Nothing replaces the
existing appointment, consent and encrypted-record model; this adds a **public** side next to the **private clinical**
side and keeps them apart.

| | Public discovery | Private clinical |
|---|---|---|
| Tables | `provider_profiles`, `provider_availability`, `provider_time_off` | `appointments` (reason encrypted), `medical_grants`, `medical_records` (summary/details encrypted) |
| Who sees it | anyone | the two parties; providers only with an active consent |
| Content | type, bio, clinic, city, languages, specialties, fee, hours, rating, verification badge | reasons, notes, clearance, injury details |

## Where the physio workspace lives in the app (issue #210)

All of it is under **More → Health**. A physio or doctor gets a **My practice** tab (default for providers) with sub-tabs: **Services** (prices with versions, tax treatment), **Offers**, **Packages**, **Plans** (patient treatment plans: draft → publish → revise, pause/complete/discharge), **Exercises** (library with search and body-region filter) and **Tax & revenue** (tax profile, recorded rates with source, billed/collected report). Everyone gets **My plans**: published exercise plans (read and acknowledge) and purchased session packages (pay, cancel unpaid). Booking a provider (**Find a pro → Book**) now offers a service picker, an offer-code field with a server price quote, package purchase and "use a package session". Doctor care plans (`/medical/care-plans`) are a separate doctor-only medical plan; these treatment plans are exercise prescriptions for physios and doctors.

## Services & price catalogue (issue #210, slice 1)

Providers publish configurable services (`upsert_provider_service`, `archive_provider_service`, `list_my_provider_services`; patients use `list_provider_services`). A service has a title, public description (never clinical detail), category, delivery modes, duration and cancellation text. Prices are append-only versions (`provider_service_prices`) carrying currency and a tax class (`unspecified|taxable|exempt|zero_rated|out_of_scope`); no rate or tax determination is made here. `book_appointment` accepts `service_id`: it uses the service duration and the price in force, and snapshots service, price version, tax class and cancellation text on the appointment, so later price edits or archiving never change it. Bookings without a service keep using the legacy consultation fee, and the prepay guard is unchanged. Not yet built (later slices of #210): offers, packages, pay-later policy, invoices/receivables, tax reports, treatment plans.

## Offers (issue #210, slice 2)

Providers create time-limited percentage or fixed-amount offers (`upsert_provider_offer`, `archive_provider_offer`, `list_my_provider_offers`), automatic or behind a code, for chosen services or all of them, with total and per-patient limits. `quote_appointment` returns the server-authoritative list price, discount and total; `book_appointment` (with `service_id` and optional `offer_code`) charges exactly that and records the offer, list price and discount on the appointment plus one redemption row (unique per appointment, so retries cannot double count; counted under the provider booking lock, so limits hold under concurrency). Offers never stack: the best single one wins; a code that cannot be used is rejected. Cancelled or expired appointments stop counting toward limits; archiving an offer leaves booked discounts intact. Fixed offers only apply in their own currency. Packages, subscriptions and pay-later remain for later slices. These are separate from venue discounts because they belong to a provider and apply to appointments.

## Exercise library and treatment plans (issue #210, slice 4)

**Library.** A physio/doctor keeps their own exercises (`upsert_exercise`, `archive_exercise`, `list_my_exercises`): title, body region, equipment tags, difficulty, goal, language, instructions, precautions and an optional https media link that must carry its source and licence. Saving an existing exercise appends a new version; plans keep the version they used. The library starts empty (no seeded content) and the list returns the real count. A governed shared library is not built yet.

**Plans.** `create_treatment_plan` needs a current verified credential and the patient's active **full** consent (clearance-only is refused), re-checked under lock inside the write. A plan has numbered versions: one editable draft (`update_plan_draft`, refused with 409 if `base_version` is stale), published versions that are immutable (`publish_plan_version` supersedes the previous one and sends a generic notification), and `revise_treatment_plan` to start a new draft from the published one. Items carry exercise version, phase, side, sets, reps, hold/rest, times per week, load and unit, tempo, a patient note and stop instructions; every field is optional except the exercise. Goals, instructions and notes are encrypted; **private notes are never returned to the patient**, and drafts are invisible to them. Patients acknowledge a version (`acknowledge_plan_version`) and keep read access to their own published plans even after consent is revoked; the provider loses access at once on revocation, expiry or credential lapse. Reads are audit-logged. Status: draft → active ⇄ paused → completed/discharged (final). Not yet built: dated session occurrences, check-ins, adherence, clip feedback, clinician-governed alternatives (later slices).
## Practice tax profile and revenue report (issue #210, slice 5)

The platform makes **no tax determination and hard-codes no rate**. A provider records their practice tax profile (`set_tax_profile`: legal billing name, jurisdiction, registered / not registered, registration number encrypted) and the rate for their `taxable` services with its source (`set_tax_rate`, source required). Both are append-only and effective-dated: the version in force at an appointment's creation (or at payment time for the collected basis) is the one used, so a later change never rewrites earlier periods. Prices are treated as **tax-inclusive** (tax-exclusive charging is a later slice). `practice_revenue_report` groups appointment revenue by currency and tax class (never summing currencies): `billed` = confirmed/completed appointments by start date, `collected` = paid appointment payments by payment date net of refunds (a partial refund reduces tax proportionally). Per line, tax = round half-up of `gross × r / (100% + r)`, so net + tax = gross; exempt, zero-rated, out-of-scope and unclassified services carry no tax, and taxable lines without a registration or rate are flagged (`untaxed_taxable_lines`). Dates use the provider's time zone. It is a management report, not a tax invoice, return or compliance statement; packages, subscriptions and pay-later are not included yet. Invoices with immutable tax snapshots, credit notes, CSV export and a receivables ageing worklist come in later slices.
## Prepaid packages (issue #210, slice 3)

Providers define packages of 2+ sessions of one service (`upsert_provider_package`, `archive_provider_package`, `list_my_provider_packages`; public `list_provider_packages`) with an optional validity in days and refund terms shown before purchase. A patient buys one (`buy_provider_package`; needs medical consent and a verified provider), which snapshots the terms and waits for payment through the canonical payments flow (`purpose_type: physio_package`, amount read from the DB, no service or clinical detail sent to the processor). Payment activates it and starts the expiry clock. `book_appointment` with `patient_package_id` spends one session (fee 0): the package row is locked under the provider booking lock, and one redemption row per appointment is unique, so concurrent or retried bookings cannot overspend. Cancelled/expired appointments give their session back. A package cannot be combined with an offer code. Paid-package refunds are not automated yet: terms are stated and handled by the provider (later slice with invoices/credit notes). Subscriptions (recurring charges) are not built; none are created automatically.

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

## Versioned care plans (issue #212, slice 2d)
Existing -> gap -> change: follow-ups were single dated items; there was no patient-specific plan with goals, owners and versions. Added (migration 068, additive):
`clinical_care_plans`, `clinical_care_plan_versions`, `clinical_care_plan_entries`; capabilities `create_care_plan`, `update_care_plan_draft`, `publish_care_plan`,
`revise_care_plan`, `set_care_plan_state`, `log_care_plan_entry`, `list_care_plans`, `get_care_plan` (scope `clinical`).

* A verified **doctor** with the athlete's full consent drafts goals (with baseline), patient-visible instructions, a review interval and actions (responsible person,
  due date, completion criteria). The patient sees nothing until `publish_care_plan`. Drafts use `row_version` (stale = 409).
* Published versions are immutable (API and DB trigger) and never deleted. A revision copies the published version (action keys are kept), and publishing it supersedes
  the previous one, which stays in history. Plan state: `draft -> active <-> paused -> completed`; completing is the doctor's decision, not inferred.
* The patient logs `completed` / `unable` / `symptom` in a separate append-only log; it cannot rewrite instructions. Action state is derived: `open`, `done_reported`
  (patient said so), `unable`, `confirmed` / `cancelled` (doctor only - medically confirmed is distinct from task done). `overdue` only means the date passed: there is
  no adherence score and nothing is adjusted automatically. Symptom notes are not monitored in real time and say so.
* Encrypted, audit-logged, generic notifications; the athlete keeps read access regardless of consent or credential state.

Not in this slice: pushing action due dates into `appointment_followups` / the unified schedule, monitored diaries with thresholds, physio rehab-plan links, screens.
Rollback: leave the tables.
## Sports clearance decisions (issue #212, slice 3a)
Existing -> gap -> change: clearance was a single enum on a free-text record, with no assessor, context, restrictions or expiry, so an old "cleared" never aged out.
Added (migration 069, additive; `medical_records.clearance` untouched): `clinical_clearances`; capabilities `issue_clearance`, `withdraw_clearance`, `list_clearances`
(scope `clinical`); `get_clearance` and the dashboard `fit_to_play` now use the shared projection in `src/clearance.js`.

* Only a verified **doctor** with the athlete's full consent decides (credential case recorded). A decision has assessment date, optional sport and activity context,
  graded `restrictions`, a required `valid_until` (unless `not_cleared`) and optional `review_by`. It is independent of payment, appointment completion and rehab progress.
* Decisions are immutable (DB trigger, never deleted). A new decision supersedes the live one for the same athlete + sport; a doctor can withdraw one with a reason.
* Projection (`get_clearance`, home): status `cleared | restricted | not_cleared | expired | unknown`, `valid_until`, `review_due`, and the restrictions the doctor chose to share -
  never diagnosis or `internal_note`. Past `valid_until` the status is `expired`, not "cleared". With several sports the worst current status wins; `sport_id` narrows it.
  Whichever of a structured decision and a legacy clearance record is newer is the latest word, so an older "cleared" from either source cannot mask a newer "not cleared".
* Access to the projection is unchanged (athlete, guardians, consented clearance-scope providers, team staff, admin); the new fields add no private text.

Not in this slice: automatic review tasks/reminders, event-incident linkage, screens. Rollback: leave the table; `get_clearance` falls back to the legacy record when it is empty.
## Referrals (issue #212, slice 2c)
Existing -> gap -> change: no way to refer a patient with controlled sharing. Added (migration 067, additive): `clinical_referrals` and append-only
`clinical_referral_events`; capabilities `create_referral`, `update_referral`, `respond_referral_consent`, `list_referrals`, `get_referral_history` (scope `clinical`).

* A verified **doctor** with the athlete's full consent drafts a referral to a verified platform doctor/physio **or** an external provider, choosing the urgency and
  the exact `shared` items. The recipient can read nothing else - no records, notes or reports are reachable through a referral.
* The athlete must consent to **each** referral (`respond_referral_consent`). Until then the recipient cannot see it and is not notified. Declining, or declining later,
  withdraws it and access ends at once. Expired, withdrawn or closed referrals hide their content. Being on the same team/clinic grants nothing.
* Platform lifecycle: `draft -> sent -> acknowledged -> accepted | declined -> booked (appointment between recipient and athlete) -> completed (optional return summary) -> closed`;
  the referrer may `withdraw` or `close`. Each role can only take its own steps; no one edits the other's records.
* External referrals are labelled `status_known: false`: the platform produces the letter (after consent) but never infers receipt, acceptance or completion.
* Encrypted, audit-logged, generic notifications.

Not in this slice: attaching existing records/reports by reference, e-delivery to external clinics, screens. Rollback: leave the tables.
## Investigations and results review (issue #212, slice 2b)
Existing -> gap -> change: reports/results had no ownership or review trail. Added (migration 066, additive): `clinical_investigations`, `clinical_results`
(versioned, append-only), `clinical_investigation_events` (append-only); capabilities `request_investigation`, `upload_investigation_result`,
`review_investigation_result`, `update_investigation_outcome`, `reassign_investigation`, `list_investigations`, `get_investigation_history` (scope `clinical`).

* Status: `requested` (awaiting result) -> `received` -> `reviewed` -> `patient_informed` -> `closed`. **Receiving or opening a result is never a review**: only the
  responsible doctor's `review_investigation_result` (naming the exact result version) sets `reviewed`; `doctor_reviewed` per result reflects that alone.
* A request is a manual/external record - it does not send a lab order. Priority and review-due date are the clinician's choice; no thresholds are applied
  and values, units and the source's own reference intervals are stored exactly as supplied. Automatic extraction must be flagged `unverified_extraction`.
* Duplicate uploads (same values + document) return the existing result. A different result after review is a new version: review reopens, earlier versions stay.
* The review queue (`list_investigations` without `athlete_id`) is the doctor's own work across currently consenting patients, urgent and overdue first.
  `reassign_investigation` (absence cover) requires the cover doctor to be verified and to hold the athlete's own consent; notes are never shown to the athlete.
* Athletes always see their own tests and results regardless of any other state. Notifications are generic. Encrypted; audit-logged.

Not in this slice: file upload/storage UI (a `document_ref` to existing private storage is recorded), automated coverage rules, linking to encounters, screens.
Rollback: leave the tables.
## Problems, allergies and medications (issue #212, slice 2a)
Existing -> gap -> change: no structured patient context existed (only free-text records). Added (migration 065, additive): `clinical_context_entries`
and `clinical_context_declarations`; capabilities `add_context_entry`, `reconcile_context_entry`, `set_context_declaration`, `list_context` (scope `clinical`).

* Patients record their own entries (`patient_reported`, `unverified`). A verified **doctor** with the athlete's full consent records, confirms, disputes or
  corrects (`clinician_recorded`/`confirmed`). Physios can read (credential + consent) but not write. Athletes may correct only their own entry that no doctor has reviewed.
* Append-only: a correction is a new entry that supersedes the old one (kept, `include_history`); a DB trigger blocks edits and deletes; concurrent
  corrections of one entry have a single winner (409 for the rest).
* `list_context` reports a state per kind: `entries`, `none_reported` (explicit declaration, refused while live entries exist) or `unknown` (the default).
  Missing data is never shown as "none". Nothing infers adherence or safety, and there is no prescribing, dose or interaction logic.
* Encrypted at rest, audit-logged; history scope of the grant applies to entries written by others.

Not in this slice: UI screens, linking entries to encounters, guardian access. Rollback: leave the tables.
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

## Health-data governance across 11 countries (US, UK, Canada, UAE, India, Singapore, Malaysia, China, Japan, Australia, New Zealand)

Existing -> gap -> change: consent, encryption, audit, credentials and MFA already existed, but there was no notion of *whose rules apply*, no way for a person to see who used their data or exercise their rights, no breach clock and no view of how a deployment measures up. Added (migration 070, additive; nothing dropped or rewritten): `users.health_country`, `health_notice_acceptances`, `health_data_requests` (+ append-only events), `privacy_incidents` (+ append-only events). All of it lives in the one Health screen (**Privacy** tab for everyone, **My practice → Overview / Compliance** for clinicians) and in **Me → Health privacy (platform team)**. No second console was added.

**What this is and is not.** The catalogue (`src/health-regimes.js`, public via `list_health_regimes`) is *operator reference configuration*: laws, regulator, doctors' and physios' regulators and associations, consent model, rights deadline, first breach clock, retention, cross-border rule, remote-care and minors notes, with a `reviewed_on` date and a disclaimer on every response. It is **not legal advice and not a compliance certificate**. Where a law has no fixed number the entry says so and the platform's own 30-day commitment is used (`access_days.statutory: false`). Binding rules come from statutes and their regulators; professional associations (AMA, BMA, ...) issue ethics codes on top. Counsel must confirm every entry (and state, provincial and emirate rules) before an operator relies on it. Bump `REGIME_VERSION` when an entry changes: people who accepted the earlier notice are asked again.

| Country | Main rules mapped | Rights answer | First breach clock | Records kept | Cross-border |
|---|---|---|---|---|---|
| US | HIPAA (+ HITECH, state laws, 42 CFR Part 2) | 30 days | 60 days | 6 y (state law often longer) | open, BAA needed |
| UK | UK GDPR, DPA 2018, Caldicott | 1 month | 72 h to ICO | 8 y; children to 25 | safeguards |
| Canada | PIPEDA + provincial (PHIPA, HIA, Quebec Law 25) | 30 days | as soon as feasible | 10 y (e.g. Ontario); children to 28 | safeguards |
| UAE | ICT Health Law 2/2019, PDPL | 30 days (platform) | promptly | 25 y | **localised** (stays in UAE) |
| India | DPDP Act + Rules, NMC telemedicine, ABDM | 30 days (platform) | 72 h report to the Board | 3 y minimum | safeguards |
| Singapore | PDPA, Healthcare Services Act | 30 days | 3 days once notifiable | 6 y | safeguards |
| Malaysia | PDPA 2010 (2024 amendment), PHFS Act | 21 days | 72 h | 7 y | safeguards |
| China | PIPL, DSL, CSL, medical-records measures | 30 days (platform) | promptly | 15 y outpatient | **restricted** (CAC route + separate consent) |
| Japan | APPI, Medical Care Act, MHLW guidelines | without delay (30 d platform) | ~3-5 days prelim, 30 d final | 5 y | safeguards |
| Australia | Privacy Act/APPs, NDB scheme, My Health Records Act | 30 days | assess in 30 days | 7 y; children to 25 | safeguards |
| New Zealand | Privacy Act 2020, Health Information Privacy Code | 20 working days | ~72 h | 10 y | safeguards |

**Region and notice.** `get_my_health_region` / `set_my_health_region` (patients choose their own country; clinicians the country of their practice). Choosing needs `accept_notice: true` and records the notice version. Once a country is chosen, `grant_medical_access` is refused with `409 health_notice_required` until the current notice is accepted. With no country chosen behaviour is unchanged (existing data and flows are untouched).

**Cross-border remote care.** `book_appointment` with `mode: remote` where patient and clinician chose different countries returns `409 cross_border_care` (which rules apply, the patient's transfer rule) until the patient sends `acknowledge_cross_border: true`. Unknown countries are never blocked.

**Who accessed my data.** `list_my_health_access_log` shows every clinical read/write by a physio or doctor and every blocked attempt (who, what, when; never clinical content), derived from the credential-check audit trail that every clinical capability already writes.

**Rights requests.** `create_health_data_request` (access, correction, restriction, objection, erasure) stamps the due date of the person's country; one open request per kind; `withdraw_health_data_request`. Platform team: `list_health_data_request_queue` (overdue first) and `resolve_health_data_request`. Fulfilling restriction, erasure or objection **never deletes**: it ends every active provider consent at once (grant history stays) and sets `retain_until` from the country's retention rule (children: the later of last entry + adult years and the birthday age; the DOB read is audit-logged). The patient keeps their own copy. Every step lands in `health_data_request_events` (append-only; DB triggers refuse updates and deletes).

**Export / portability.** `export_my_health_data` returns a decrypted machine-readable copy (appointments, records, problems/allergies/medicines, follow-ups, consents and history, fit-to-play decisions, requests; newest 5000 per list), audit-logged and recorded as a fulfilled `export` request. Exercise plans, care plans, referrals and test results are not in the file yet: they are answered through an access request.

**Incident register.** Clinicians `report_privacy_incident` (kind, severity, country, people affected, event if it happened at one, description with no names). The regulator clock of the chosen country starts from awareness (`regulator_due_at`, null = "as soon as practicable"); admins are notified. `update_privacy_incident` (platform team) moves it open -> assessed -> notified -> closed, records when the regulator and the people were told, and refuses to close without a notification unless a reason is given. `regulator_overdue` is computed.

**Posture and practice checklist.** `get_health_compliance_posture` (platform team) reports key protection (KMS), MFA enforcement and enrolment, TLS, licence-jurisdiction allow-list, declared hosting country (`HEALTH_DATA_HOSTING_COUNTRY`) against localised/restricted countries, unread notices, overdue requests and incident clocks. `get_my_practice_compliance` (clinician) checks region, notice, current credential, licence country vs practice country, MFA and open incident clocks. Both return findings, never a pass certificate.

**Event coverage data.** On-site incident logs stay encrypted, minimum-necessary (organisers see fit-to-play only) and audit-logged as before; privacy incidents can name the event; the event's country is chosen when reporting. Country retention rules do not yet govern event incident logs (nothing is deleted either way).

Not in this slice: automatic erasure/retention jobs (nothing is ever auto-deleted), data-subject requests routed to individual practices rather than the platform team, per-province Canadian and per-state US rule sets, signed BAAs/processing agreements, exporting plans/results/referrals in the data file, notifications of the regulator itself. Rollback: leave the tables.
