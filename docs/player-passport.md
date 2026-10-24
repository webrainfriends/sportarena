# Player passport (migrations 041, 061, 103)

A read-only athlete CV an athlete can share with a coach or scout through a link or QR code. Capabilities (REST + OpenAPI + MCP, tag *Passport*) in `apps/api/src/capabilities/passport.js`.

| Capability | What it does |
|---|---|
| `create_passport_link` | Makes a link. The athlete picks what it shows (match history by season, approved results, awards) and when it expires (1-90 days, default 30). The secret is returned once. Not available to young people. |
| `list_passport_links` | Their links with status (`active`, `expired`, `revoked`), what each shows and how many times it was opened. Never the secret. |
| `revoke_passport_link` | Turns a link off at once; the record is kept. |
| `get_my_passport` | Preview of the passport exactly as a link shows it. |
| `get_passport` (public, `GET /passport/:token`) | The passport for a valid, unexpired, unrevoked link. A wrong, expired or revoked link all return the same 404. Each open is counted; nothing about the viewer is stored. |

## What is in it
Name, handle, avatar and bio (as on the public profile); sport cards (role, level, position, jersey, club, years playing); career and season-by-season match counts with W-D-L and how many were **official** (played in Gotmygame events) versus logged by the athlete; **approved competition results only**; awards. It is built at read time from existing records, so it is never out of date and nothing is copied.

## What is never in it
Email, phone, date of birth, national ID, address, private match notes or ratings, award notes, hourly rates, licence numbers, practice and imported figures, health and wellness data. Tests assert this against a payload seeded with such values.

## Security notes
The secret is `sa_` + 32 random bytes; only its SHA-256 is stored (like API tokens). It is shown once at creation, in a QR code and as a link. Links expire and can be revoked; revoking is immediate. Young people (`isYouth`) cannot arrange sharing alone: a verified guardian creates the link (`athlete_id`) and it works only while the guardian's `recruitment_sharing` consent is in force.

## App
**Me -> Player passport & QR**: create a link (label, expiry chips, switches for what to show), see its QR code and copy or share it, list links with status and views, turn one off, and preview the passport. Opening a link on the web (`/?passport=<secret>`) shows the passport without signing in. The QR is drawn client-side with `qrcode-generator` (pure JavaScript, no network).

Biometrics (height, weight) are not collected anywhere in Gotmygame today, so the passport does not show them; add them as an athlete-controlled opt-in field when they exist.


## Recruitment passport (issue #312, migration 103)
Extends the same link; nothing is rebuilt. Each link now has nine section switches (`show_matches/results/awards/credentials` plus `show_video`, `show_references`, `show_preferences`, `show_availability`, `show_academic`; the new ones default off), an optional `recipient_id` and a `version`.

**Schema (additive, no drops; rollback = stop using the new columns/tables):** `passport_links` + columns; `passport_link_views`; `passport_videos`; `passport_references`; `recruitment_preferences`; `recruitment_availability`; `academic_evidence` (summary encrypted as `summary_enc`, files encrypted on disk); `youth_consents` purpose list widened with `recruitment_sharing`. Duplicate protection by partial unique indexes; removal is always a soft `removed_at`.

| Capability / route | What it does |
|---|---|
| `create_passport_link` (+`recipient_id`, `athlete_id`, new `show_*`) | Person-addressed links; a guardian creates links for a young person (needs `recruitment_sharing` consent). |
| `update_passport_link` (`PATCH /me/passport-links/:id`) | Change sections, label, recipient, expiry; `version` required, stale = 409; refused once revoked/expired. |
| `revoke_passport_link`, `list_passport_links` | Owner or the young person's guardian; list shows recipient. |
| `get_passport`, `export_passport` (`GET /passport/:token[/export]`) | One atomic gate: unrevoked, unexpired, recipient match (signed-in viewer), guardian consent live. Anything else is the same 404. Person-addressed opens are recorded in `passport_link_views`. |
| `GET /passport/:token/video/:id`, `/academic/:id` | Files through the same gate and only if the section is on. |
| Videos: `list_my_passport_videos`, `add_passport_video_link` (YouTube/Vimeo only), `PUT /me/passport-videos/upload`, `remove_passport_video`, `list_passport_video_reviews`, `review_passport_video` | Pending until a coach who coaches the athlete approves; only approved clips are ever shared. Upload MP4/MOV/WebM (type decided from the bytes) up to 50 MB; longer clips go in as a link. Links are limited to YouTube and Vimeo; the server derives the `embed_url` (youtube-nocookie / player.vimeo.com) and the app plays both link and uploaded videos inside the page. |
| References: `write_passport_reference`, `list_my_passport_references`, `decide_passport_reference`, `withdraw_passport_reference` | Coach writes, athlete approves, either can withdraw. |
| `get/set_my_recruitment_preferences`, `list/add/remove_recruitment_availability` | Versioned preferences; validated availability windows (past ones are not shown). |
| `list/add/remove_my_academic_evidence`, `PUT /me/academic-evidence/:id/file` | Always labelled `self_reported`; reads by anyone but the owner are audit-logged. |

**Not included:** a verified-recruiter workspace (#313); institution-issued academic provenance (the column exists, nothing sets it yet).

Screens: `docs/ux/passport-recruitment-*.png`, produced by `scripts/e2e/passport-recruitment-journey.mjs` (see the header of that script to run it).
