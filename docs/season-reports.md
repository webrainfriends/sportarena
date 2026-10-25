# Athlete season & career reports (issue #332, migration 112)

A **pack** is a frozen, fingerprinted snapshot of what one person may see about one athlete for a calendar season (UTC year) or the whole career, optionally for one sport. It is built from the canonical records at creation time and exported as CSV or a branded PDF. Capabilities (REST + OpenAPI + MCP, tag *Season reports*) live in `apps/api/src/capabilities/export-packs.js`; the read model in `apps/api/src/export-pack.js`; the PDF in `apps/api/src/documents/season-report.js`.

## Baseline reused (nothing duplicated)
Unified match history (`ACTIVITIES_CTE`: official vs self-reported), `performances` (provenance + approval), `awards`, career timeline (`CAREER_VIEW_SQL`), `player_goals` and goal shares (`player_shares`), published coaching report versions (`CONSENT_OK`), the coaching relationship (`RELATIONSHIP_SQL`) and the wellness-share access rules (`accessBlock`), branded documents (brand kits, templates, `generated_documents`, encrypted PDF store) and `toCsv`.

## What a pack contains
`matches`, `results`, `goals`, `awards`, `career`, `reports`, `evidence`. Every row carries its source and verification (`official_game`/`manual`/`imported`; `approved_competition`/`self_reported`; `athlete_claim`; `organiser_awarded`; career `verified/unverified/pending`; report version + sha256). Result values keep their unit and direction; personal bests use approved competition results only. **Never included** (listed in every pack): private notes, health and wellness data, contact details, date of birth. Evidence files and references are never included, only how many exist. A section that cannot be shown (for example goals for a young person without current coaching consent) is listed under `withheld` with the reason.

## Schema (additive; rollback = deploy the previous code, data stays)
* `export_pack_shares` - athlete, coach recipient, scope (season/career, year, sport), sections, `expires_at`, `version`, `revoked_at`. One live share per athlete and coach (unique partial index).
* `export_packs` - the frozen `snapshot` (jsonb) + `snapshot_sha256`, `created_by`, optional `share_id`, `client_key` (unique per creator = idempotency). **Immutable** (update/delete trigger).
* `export_pack_events` - append-only log: granted, updated, revoked, expired, created, viewed, csv, pdf. Visible to the athlete/guardian.
* New branded-document family `season_report` (header/title/text/footer blocks; `title` required). PDFs are rows in `generated_documents` (`source_type='export_pack'`).

## Capabilities
| Capability | REST | Notes |
|---|---|---|
| `get_export_pack_options` | `GET /me/export-pack-options` | seasons with data, sports, eligible reports, published `season_report` templates, coaches you could share with |
| `preview_export_pack` | `POST /export-packs/preview` | same builder, saves nothing (read scope) |
| `create_export_pack` | `POST /export-packs` | athlete/guardian: scope + sections + chosen `report_ids`; coach: `share_id` only. `client_key` makes retries return the same pack (409 `key_reused` if the key is reused for a different pack) |
| `list_export_packs`, `get_export_pack` | `GET /export-packs`, `/:id` | deterministic order (created_at, id); coach views are logged |
| `export_pack_csv` | `GET /export-packs/:id/csv` | one labelled flat table, formula-injection safe |
| `generate_export_pack_pdf` | `POST /export-packs/:id/pdf` | optional `template_id`; same pack + template returns the PDF you have; download `GET /branded-documents/:id/file` |
| `create/update/revoke_export_pack_share`, `list_export_pack_shares` | `/me/export-pack-shares...` | update needs `version` (409 `stale_version`); revoke idempotent |
| `list_export_pack_shared_with_me` | `GET /export-pack-shared` | coach inbox with live state and why not |

## Permissions (checked live on every read, CSV and PDF download)
* **Athlete** (adult): own packs. **Young person**: cannot arrange exports; a verified **guardian** passes `athlete_id`. Goals and reports are withheld without current `coaching` consent.
* **Coach**: only through a live share, a current coaching relationship and, for a young person, current guardian consent. Gets only the ticked sections; goals only if also shared with that coach via the goal share; reports = their own published reports. Revoking, expiry, leaving the team or withdrawn consent block even packs they already built (403 with the reason). A restored relationship restores a still-live share.
* Everyone else gets `404` (existence is never leaked). Reads by guardians and coaches are audit-logged.
* A build holds `FOR SHARE` on the share row, so a revoke in flight wins.

## UI (`apps/app/src/screens/season-reports.js`, one React Native codebase)
`SeasonReports` (Build / My packs / Coach access), `ChildSeasonReports` (guardian), `SharedSeasonReports` (coach, master-detail on tablet/desktop). Entry points: Passport, Family & guardians, coach athletes and tool grid. Calendar picker for the end date, chips for seasons/sports/sections, entity picker for the coach; loading, empty, error and success states; CSV via download (web) or share sheet (native).

## Verification
`apps/api/test/export-packs.test.js` (PostgreSQL integration): provenance and private-data exclusion, freezing/idempotency/immutability, CSV safety, validation and 404s, reports eligibility, PDF + template + download access, coach share lifecycle (stale versions, duplicates, relationship loss, revoke), youth/guardian/consent, parallel retries and revoke-in-flight, MCP and OpenAPI parity.

Not run on a native device (iOS, iPadOS, Android): the web build was exported and rendered at phone, tablet and desktop widths; native uses the same components with the share-sheet path for downloads.
