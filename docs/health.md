# Doctors & physios (SPOR-60, SPOR-128)

Providers are ordinary users with the `physio` / `doctor` role and (optionally) a sport profile. Nothing replaces the
existing appointment, consent and encrypted-record model; this adds a **public** side next to the **private clinical**
side and keeps them apart.

| | Public discovery | Private clinical |
|---|---|---|
| Tables | `provider_profiles`, `provider_availability`, `provider_time_off` | `appointments` (reason encrypted), `medical_grants`, `medical_records` (summary/details encrypted) |
| Who sees it | anyone | the two parties; providers only with an active consent |
| Content | type, bio, clinic, city, languages, specialties, fee, hours, rating, verification badge | reasons, notes, clearance, injury details |

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

Verification: search shows and filters on the badge from the verification service; booking and consent are **not** blocked
for unverified providers (consent already protects athletes). Making verification mandatory is an open product decision.

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
per adapter). Patients get the address plus a mandatory notice that they are leaving SportArena
(`start_external_booking`). Afterwards `link_external_booking` records the booking: only the external provider, reference,
address, sync status and timestamps are stored, one SportArena appointment per `(provider, external provider, reference)`
(repeat calls update, never duplicate; someone else's reference cannot be claimed). The provider (or their integration with
an API token) reports changes with `reconcile_external_booking`, which applies the same status rules as everywhere else.
No scraping and no stored third-party credentials. Where a system offers an API, an adapter can add a `sync` hook later;
none is implemented yet.
