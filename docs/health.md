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

Payment, follow-ups and external booking: see the next health change.
