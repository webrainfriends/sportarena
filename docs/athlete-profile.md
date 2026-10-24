# Athlete profile (issue #310, item 1)

The athlete-controlled part of a sport card, extending the existing "My sports" page (no separate console).

## What it adds
- **Dominant side, several positions, playing preferences** per sport card. Suggestions come from `GET /sports/:slug/profile-options`; sports without a fixed list accept typed positions.
- **Field scopes**: each field is `private` (default), `coach`, `recruiter` or `public`. `get_person` returns a field only if the viewer's tier allows it. A coach tier means an active coach/manager on a team the athlete is on. The `recruiter` scope is stored now; it is enforced for recruiters once the verified recruiter workspace (#313) exists.
- **Measurements** (opt-in): height, weight, wingspan, vertical jump, 20/40 m sprint, each with unit (cm/in, kg/lb, s), measurement date, source (self, coach, test), note, scope and revocation. Values are validated per metric and unit, stored encrypted (`athlete_measurements.value`) and reads are audit-logged. Withdrawing a measurement hides it at once; the record is kept and can be restored (private).
- **Verified affiliations** are derived from existing records (active team membership, issued credentials). Nothing is duplicated or typed in.
- **Completeness** is computed from what is filled in; no biometric is required.
- **Young athletes** can keep everything private only; sharing waits for guardian-controlled sharing (#319).

## Archive, not delete
`DELETE /me/sport-profiles/:id` now **archives** the card (`archived_at`). Logged and imported matches, official history, links and measurements are untouched. The card leaves public profiles, passports and lookups (they read the `active_sport_profiles` view); career history still counts its matches. `POST /me/sport-profiles/:id/restore` or adding the sport again restores the same row (no duplicate). An archived default hands the default to the oldest remaining card; a restored card returns as non-default unless it is the only one.

## Schema and rollback (migration 102, additive)
Adds `sport_profiles.archived_at/dominant_side/positions/play_prefs/field_scopes`, the `active_sport_profiles` view and the `athlete_measurements` table. Nothing is dropped or rewritten; `positions` is backfilled from `position`, which stays. Rolling back the code needs no schema change: the old code ignores the new columns (it would hard-delete again, so deploy the old code only if you accept that). To remove the feature entirely, drop the view and table by hand after exporting them; this is never done automatically.
