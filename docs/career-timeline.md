# Career & membership timeline (issue #311)

A player's history of clubs and teams: membership periods with season, position, competition level and verified affiliation evidence. Former memberships and every correction are kept.

## What it reuses (nothing is duplicated)

| Existing | Used for |
|---|---|
| `teams`, `organisations`, `org_seasons`, `sports` | Canonical club/team/season/sport. A listed team or organisation is authoritative; a typed name is only for clubs that are not on the platform (`unlisted`). |
| `team_members` | Still the live roster. Joining/leaving through `add_team_member`, `leave_team`, `associate_person` (team), `respond_to_team_invite` and an accepted billboard recruiting post opens/closes a `roster` stint, so re-joins no longer overwrite history. |
| `sport_profiles.club` | Stays as the legacy display value (untouched). The migration back-fills one unverified stint from it. |
| `youth.js` | Guardian / consent / youth rules. |
| `passport_links` / `buildPassport` | Sharing. The timeline is a new, off-by-default section (`show_career`). No second share-link system. |
| `crypto.js` + `audit_log` | Evidence references are encrypted; reads are audit-logged. |

## Schema (migration `103_career_timeline.sql`, additive)

* `career_memberships` — one stint. `team_id` / `organisation_id` / `club_name` (one of), `org_season_id`, `season_label`, `starts_on`, `ends_on` (NULL = current), `position`, `competition_level`, `jersey_no`, `source` (`self|roster|staff|backfill`), `verification_status` (`unverified|pending|verified|rejected`), `row_version`, `idempotency_key`, `archived_at`. Unique indexes: no duplicate stint, one idempotency key per author, one open roster stint per team.
* `career_membership_revisions` — append-only snapshot per create / correction / verification / archive.
* `career_membership_evidence` — `kind`, `label`, `reference_enc` (AES-GCM via `crypto.js`).
* `passport_links.show_career boolean default false`.
* Back-fill is idempotent and only reads existing rows. Nothing is dropped, rewritten or cascaded. Rollback = stop using the new tables/column; no existing data depends on them.

## Capabilities (REST + OpenAPI + MCP from one definition, tag `Career`)

| Capability | Endpoint | Who |
|---|---|---|
| `list_career` | `GET /me/career` (`user_id` for a guardian, `sport`, `include_archived`, `limit/offset`) | player, verified guardian, admin |
| `add_career_entry` | `POST /me/career` (`idempotency_key` required) | player, guardian |
| `update_career_entry` | `PATCH /me/career/:id` (`row_version`, `reason`) | player, guardian |
| `archive_career_entry` | `POST /me/career/:id/archive` (`archived:false` restores) | player, guardian |
| `list_career_revisions` | `GET /me/career/:id/revisions` | player, guardian, reviewing staff |
| `add_career_evidence` / `list_career_evidence` | `POST|GET /me/career/:id/evidence` | player, guardian; staff may read (audited) |
| `request_career_verification` | `POST /me/career/:id/request-verification` | player, guardian |
| `list_career_review_queue` | `GET /career/review-queue` | team owner/captain/manager, org owner/admin/coach, admin |
| `review_career_entry` | `POST /career/:id/review` (`verify|reject`, `note`, `row_version`) | same staff; never your own entry |
| `export_my_career` | `GET /me/career/export` | player (adult) or guardian; audited; no evidence or notes |

Passport: `create_passport_link` accepts `show_career`; `get_passport` / `get_my_passport` return `memberships` (club, sport, dates, position, level, `verification_status`, never evidence or review notes).

## Rules

* **Ownership / privacy** — a timeline is private to its player. Another adult gets 404 on an entry and 403 when asking for someone else's timeline.
* **Youth** — a young person's writes need a current guardian `participation` consent; a verified guardian can act for them with `user_id`; young people cannot export or share (guardian only); the passport never shows a young person's timeline; staff see their entries only while that consent is live (revoking it hides them from the queue and blocks decisions immediately; existing records are kept).
* **Verification** — only staff of the entry's team/organisation (or the platform team) can verify; unlisted clubs only by the platform team; at least one evidence item is needed to ask. Changing the club, team or dates of a verified/pending entry sends it back to `unverified` (history keeps who verified it); changing position, level etc. does not.
* **Concurrency** — `row_version` on every mutation (`409 stale_version`); `idempotency_key` replays return the original (`replayed:true`); duplicates return `409 duplicate_membership`; the row is locked `FOR UPDATE` per mutation.
* **Deletion** — never. Entries are archived (`archived_at`) and can be restored; revisions and evidence are append-only.
* **Pagination** — `starts_on DESC, id`.

## UI

`CareerTimeline` screen (route registered in `App.js`): opened from a sport profile ("Career"), More → "Career & clubs", and Family → "Career" for guardians. Vertical timeline with verification labels, add/correct form (club search-and-pick, calendar dates, "I am still here" switch, season and level chips), detail sheet (evidence, request verification, history, hide/restore), CSV export, and for club staff a "Membership requests" queue with verify/reject. Loading, empty, error and success (toast) states; stale-version message; phone and web layouts. Passport link form has a "Show clubs & teams timeline" switch and the public passport shows the section.

## Deployment notes

No new configuration. The migration runs with the normal deploy; no data is rewritten.
