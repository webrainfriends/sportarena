# Adaptive coaching expertise & credential discovery (#837, PS-07)

Athletes find coaches qualified in adaptive/para disciplines and see their verified scope. It lives in **Hire → Find a coach → Adaptive coaching** (athletes),
**Coach tools → Specialist credentials** (coaches), the coach profile, **My coaching → Session adjustments** (booking) and the **Academy → Staff** list.
Additive: nothing existing was removed or narrowed; no row is seeded; migration `161_coach_adaptive.sql` only adds columns and tables.

## Requirement → source of truth → gap → extension
| Requirement | Existing source of truth (reused) | Gap | Extension |
|---|---|---|---|
| Opt-in para disciplines, specialist training, declared vs verified | `coach_profiles`, `coach_specialisations`, discipline templates in `src/inclusion.js` (#808) | no opt-in, no governed discipline list, no declared/verified marker | `coach_profiles.adaptive_*`, `coach_adaptive_expertise` (`set_my_adaptive_coaching`, `upsert_adaptive_expertise`, `archive_adaptive_expertise`, `get_my_adaptive_coaching`); "verified" is derived, never stored on the coach |
| Issuing authority, scope, validity, renewal, revocation | `verification_cases` (#59/#475: decide, revoke, `previous_case_id` renewal) | coach case had no issuer, title, scope or own expiry | four columns on `verification_cases` via the existing `submit_verification`; approval never outlives the credential's own date; expiry/revocation downgrade the display live |
| Search filters (discipline, format, communication, verified) | `list_coaches` (`GET /coaches`) | no adaptive filters | `adaptive_discipline`, `delivery_format`, `comm_support`, `credential_verified_only` on the same endpoint; only coach-declared or verified attributes; ordering is unchanged |
| Consented session adaptations at booking | #808 need vocabulary, guardian authority (`actingFor`), coach hires, payments | #808 shares are academy-scoped; an independent coach booking has no academy | `coach_hire_adjustments` (catalogue codes, screened + encrypted note, expiry, immediate withdrawal, read log visible to the athlete); booking/relationship permissions unchanged |
| Warn when no formal credential; never imply medical authorisation | `get_coach`, verification badges | no para-specific state | `adaptive.state` (verified, self_declared, expired, revoked, none) plus the fixed disclaimer in search, profile, booking and the credentials screen |
| Academy instructor validation | `list_academy_staff`, verification badges | no adaptive state | `adaptive` on each staff row (state and disciplines only) |

Para classification (#488) is untouched and never inferred. Academy coach education (#791) has no shipped code on `main`; nothing was duplicated.

## Privacy rules (server-side)
* No diagnosis, class or health field exists in any of these responses; the optional notes are screened (422 `restricted_content`) and encrypted.
* Search and ranking never use anything about the athlete.
* An adult decides for themself; a verified guardian with the `consent` scope decides for a young person; anyone else gets `404`.
* The coach sees only live (not withdrawn, not expired) adjustments, and every read is logged and shown to the athlete.

## Sports
The discipline list is the native adaptation templates of #808: wheelchair basketball, wheelchair tennis, para swimming, para athletics, para football, goalball and
boccia, para cycling, sitting volleyball, para badminton and table tennis. Sports without a native template are served by the labelled generic fallback
(`generic_fallback` in the catalogue); coaches in those sports can still opt in, but cannot yet pick a discipline, which is a known gap.

## Rollback
`161_coach_adaptive.sql` is idempotent and additive. Deploy the previous build; it ignores the new columns and tables. No data is removed.
