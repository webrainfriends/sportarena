# Player passport (migration 041)

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
The secret is `sa_` + 32 random bytes; only its SHA-256 is stored (like API tokens). It is shown once at creation, in a QR code and as a link. Links expire and can be revoked; revoking is immediate. Young people (`isYouth`) cannot create links until a guardian flow exists.

## App
**Me -> Player passport & QR**: create a link (label, expiry chips, switches for what to show), see its QR code and copy or share it, list links with status and views, turn one off, and preview the passport. Opening a link on the web (`/?passport=<secret>`) shows the passport without signing in. The QR is drawn client-side with `qrcode-generator` (pure JavaScript, no network).

Biometrics (height, weight) are not collected anywhere in Gotmygame today, so the passport does not show them; add them as an athlete-controlled opt-in field when they exist.
