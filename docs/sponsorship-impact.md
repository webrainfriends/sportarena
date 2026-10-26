# Beneficiary performance and community impact (#303)

Extends the performance review of an agreement (#145 §7) **in the same screen and the same consent switch**; there is no second console, switch or ledger.
Impact is a review aid: nothing here can block, reduce, release or settle a payment, a due or an agreement.

## What a sponsor can see, and when
| Beneficiary | Read live from | Recorded by the beneficiary |
|---|---|---|
| Athlete | `performances` (as before: metrics, objectives) | milestones, community outcomes, outside results |
| Team | `game_participants`/`games` (finished games), active members | same |
| Event | accepted `event_entries`, games of the competition | same |
| Organisation / group | - | same |

* Consent is the agreement's existing switch (`set_sponsorship_performance_access`), now available to every beneficiary type (team owner, event organiser, organisation representative; for a young athlete only a verified guardian). `official` shares organiser records and official games; `all_evidence` also shares third-party and self-reported figures, always labelled.
* **Revocation** blocks the next read and the next export (403) for every capability below; nothing is deleted, the beneficiary still sees their own data, payments and the agreement are untouched.
* Different sports, metrics and units are never merged into a score: team results are one row per sport and evidence kind; recorded evidence is grouped per kind, metric and unit.
* Every figure states **source, date or period, unit and sample size**. Recorded evidence is entered by the beneficiary and not verified by the platform; the UI and API say so.

## Corrections
Append-only. `correct_sponsorship_impact` (needs the `row_version` seen) inserts a new current row that supersedes the old one (kept, with the reason); `withdraw_sponsorship_impact` marks it withdrawn with a reason. Current views and exports show only current rows, so a correction replaces the figure at once; `history=true` lists the chain. A stale or already-superseded version is a 409; two simultaneous corrections: exactly one wins (row lock plus a unique index on `supersedes_id`). Live team/event results are never copied, so a corrected game changes the view immediately.

## Pre-award evidence (#64)
`share_application_evidence` (applicant only; others get 404) attaches evidence to one submitted application: an athlete picks passport sections (matches, approved results, awards, certificates, career, approved video, references; never contact, health or academic files) and a duration of up to 90 days, which creates an expiring `passport_links` row tied to the application (its secret is never kept; it is visible and revocable among the athlete's passport links). A team/event applicant shares its live results. `get_application_evidence` (brand `evaluation` role of that program; another brand gets 403) returns `shared`, `not_shared`, `revoked` or `closed`; link revocation/expiry, a young person's guardian consent and blind-review anonymity are re-checked on every read; every read is audit-logged.

## Capabilities (REST + OpenAPI + MCP from one definition)
| Capability | Path |
|---|---|
| `record_sponsorship_impact` | `POST /sponsorships/:id/impact` (beneficiary side only) |
| `correct_sponsorship_impact` | `POST /sponsorship-impact/:id/correction` |
| `withdraw_sponsorship_impact` | `POST /sponsorship-impact/:id/withdraw` |
| `list_sponsorship_impact` | `GET /sponsorships/:id/impact` (`history`, paged) |
| `export_sponsorship_impact` | `GET /sponsorships/:id/impact-export` (CSV; sponsor needs `performance` + `export`; notes not exported; audit-logged) |
| `share_application_evidence` | `POST /program-applications/:id/evidence-share` |
| `get_application_evidence` | `GET /program-applications/:id/evidence` |
| `get_sponsorship_performance` (extended) | adds `team_event` for team/event agreements; athlete metrics/objectives only for athlete agreements |
Free-text notes are field-encrypted (`note_enc`); a sponsor's read is audit-logged. Notifications carry no figures.

## Schema (migration `114_sponsorship_impact.sql`, additive)
`sponsorship_impact_records` (constraints: community needs metric, value, unit and sample size; a value needs a unit; a third party needs a source reference; no future dates is enforced by the API), and four columns on `sponsorship_applications` (`evidence_shared`, `evidence_link_id`, `evidence_shared_at`, `evidence_shared_by`, defaults = nothing shared). No existing row changes meaning; nothing is deleted. **Rollback**: deploy the previous code; it ignores the new table and columns. **Dependency order**: migration, API, app.

## App
Sponsor/beneficiary agreement screen -> **Performance, impact & reviews** (loading, empty, denied/not-shared, stale-version reload and retry states; record/correct/withdraw sheets with unit chips, date pickers and a sample-size stepper; CSV export). Program -> application -> **Shared evidence** (reviewer); My applications -> **Share evidence** (applicant). Verified in Chromium at phone, tablet and desktop widths.

## Limits
Native iOS/Android were verified by `expo export` only, not on a device. Recorded evidence is self-declared (labelled); verification by third parties is out of scope. Pre-award evidence is not part of the awards CSV export. The #305 outcomes report is unchanged (athlete objectives only).
