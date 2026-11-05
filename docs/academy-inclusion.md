# Inclusive & adaptive academy programmes (#808)

Disabled, para and mixed-ability athletes join and progress in academy programmes **without disclosing a diagnosis**. The feature lives in
**Organisation → Academy → Inclusion** (staff), **My academy → Accommodations** (athletes and guardians) and **Venue console → Facility → Access features**
(venue managers). It is additive: nothing existing was removed or narrowed, no row is seeded.

## Requested feature → source of truth → gap → extension
| Need | Existing source of truth (reused) | Gap | Extension |
|---|---|---|---|
| Sport-specific, configurable eligibility and adjustments per programme | `academy_programmes`, programme versions, admissions (#100) | no inclusion profile | `academy_programme_inclusion` (`save_programme_inclusion`, `get_programme_inclusion`, public `get_programme_adjustments`) |
| Para classification | Para classification & eligibility (#488: `para_outcomes`) | none | linked and shown only to staff the athlete names; never duplicated or inferred |
| Athlete/guardian shares minimal operational needs, with expiry and revocation | guardian authority (`actingFor`, the wellbeing consent pattern #795) | no accommodation store | `academy_accommodation_shares` (`share_accommodation`, `list_my_accommodations`, `revoke_accommodation`, `list_inclusion_audience`) |
| Frontline staff see only approved flags | session staffing (`sessionFor`), venue links | no per-athlete, audience-scoped view | `get_session_accommodations` (audience-matched, every read logged to `academy_inclusion_events`) |
| Scheduling, accessible venues, qualified staff, provider cover | sessions, venues, session staff, badges (verification), duty labels | venue access features did not exist | `academy_venue_access_features` (`set_venue_access_feature`, `list_venue_access_features`), `get_session_readiness` |
| Adapted rubrics and pathway alternatives, coach-led, no universal score | pathways and assessments (#103) | no adapted layer | `academy_adapted_assessments` (`save_adapted_assessment`, `sign_off_adapted_assessment`): descriptor levels only, second-assessor sign-off, appeal stays on the assessment |
| Director view | wellbeing overview pattern | none | `get_inclusion_overview`: counts only, groups under 5 withheld |

Equipment is confirmed in the existing **Kit desk**; training load comes from the existing **load history**. Neither is rebuilt.

## Privacy rules (enforced on the server)
* No diagnosis, medical or clinical vocabulary exists: adjustments come from a fixed catalogue; the optional 300-character note is screened (422 `restricted_content`) and encrypted.
* An adult decides for themself; a verified guardian with the `consent` scope decides for a young person; a young person cannot share alone. A guardian's share lapses with the link.
* A share names an audience (named active staff, and/or the coach or venue of the athlete's sessions) and expires within 18 months. Revoking is immediate and kept as history.
* Directors without an audience place see counts, never athletes. Strangers get `404`.
* Every grant, revoke and every time staff open a share is logged and visible to the athlete.

## Sports
Native adaptation templates: wheelchair basketball, wheelchair tennis, para swimming, para athletics, para football (CP, blind, amputee), goalball and boccia, para
cycling, sitting volleyball, para badminton and table tennis. Every other sport uses the **generic** template, which is labelled "generic fallback" in the UI and API.

## Rollback
Every statement in `160_academy_inclusion.sql` is idempotent and additive. Deploy the previous build; it ignores the new tables. No data is removed.
