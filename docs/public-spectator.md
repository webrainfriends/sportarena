# Public tournament & spectator experience (#501)

The public page of an event is a **projection** of the canonical event, fixture, scoring, standings, sponsorship and media data. Nothing is copied into a
separate tournament CMS: change a result or a schedule and the public page follows, with corrections labelled and the earlier official state kept.

Code: `apps/api/src/spectator.js` (projection rules), `capabilities/spectator.js` (public reads, follow, engagement), `capabilities/spectator-admin.js`
(policy and sponsor placements), `share-cards.js` + `public-web.js` (share cards and pages), migration `118_public_spectator.sql`.
App: `screens/spectate.js` (event page body, live centre, follow, share, Following), `screens/event-public.js` (console tab), `screens/play.js` (the one Event screen).

## Requirement → canonical source → visibility rule → verified gap → extension

| Public requirement | Canonical source (reused) | Visibility rule | Gap found on `main` | Extension |
|---|---|---|---|---|
| Event identity, organiser, sport(s), dates, venue, format | `events`, `event_stages`, `event_disciplines`, `organisations`, `venues` | drafts organiser-only; `private` = organiser + participants; `unlisted` = link only | no public/private policy; `get_event` ignored visibility | `events.public_visibility`; `get_public_event`; private guard on `get_event`, standings, bracket, fixtures, live |
| Live / upcoming / completed state | `events.status`, `fixtures.status` | same | state was implicit | `eventState()` → upcoming · live · in progress · paused · completed · cancelled |
| Schedule / fixtures | `fixtures` (+ venue time zone) | same | list showed no correction/reschedule marks | `list_public_fixtures` with labels, `corrected`, `rescheduled` |
| Standings, brackets, heats | `standings()`, `get_event_bracket`, race publications | table is **provisional** until the event is completed; a result is **provisional** at full time and **final** when the score sheet is approved | no provisional/final label; bracket only as a drawing | `get_public_standings`, `get_public_bracket` (drawing **and** a plain list); races link to the existing public race page |
| Official results & awards | `fixtures`, `awards` | young people never named; awards flagged `official` | none | in `get_public_event` |
| Sponsor placements | `sponsorships` (active only) + new slots | CTA hidden on youth events; ended/paused sponsorship disappears at once | no placement or measurement | `event_sponsor_placements`, `placement_daily_counts` (measured served + clicks only), `save/end/list_sponsor_placements`, `record_placement_click` |
| Approved media | `mr_assets` + `assetState()` (rights, embargo, takedown, **live guardian media consent**) | only `audience=public`, published, worldwide, state `live` | none | `publicMedia()` |
| Stream reference | `mr_streams` (public access policy) | public only | none | shown on the live centre |
| Follow event / team / athlete / game | none | adults only for athletes; following grants nothing private | no follow model | `spectator_follows`, `follow_subject`, `unfollow_subject`, `list_my_follows` |
| Alerts: start, score, result, schedule change | `notifications` (+ push/email prefs) | alerts stop when the event turns private; youth events never feed athlete alerts | none | append-only `fixture_public_changes` (DB triggers) + worker sweep `sendFollowerAlerts()` |
| Live centre | `liveState()` scoring engine, `/live/fixtures` stream | no void events, notes, free-text payloads; players only if adult and not a youth event | raw live feed exposed player ids | `get_public_fixture`, public-safe stream `/live/public/fixtures/:id` |
| Share cards and links | none | built anonymously: private, draft, youth or unfinished → 404 / 409 | none | `get_share_card`, `/api/v1/share/...` pages and SVG cards |
| Discovery | `search_events` | public, non-archived only | no live/upcoming filter, no level/region | `phase`, `level`, `region`, `include_archived`, `live_now`, `next_fixture_at` |
| SEO | none | indexable only if public + organiser opt-in + not youth + not archived | none | `X-Robots-Tag`, meta robots, JSON-LD only when indexable, `sitemap.xml` |
| Reactions, fan MVP | none | organiser opt-in; never youth; one per person; hourly allowance; labelled **fan vote**, never an award | none | `react_to_fixture`, `vote_fixture_mvp` |
| Tickets | none | — | there is **no ticketing module** | the page links to registration and says `tickets: null`; nothing is invented |

## What is public

Only allow-listed fields. Never: contact data, dates of birth, rosters, health, finance, youth identities, internal notes, void events, score-sheet
details, other people's follows. REST, OpenAPI and MCP expose the same capabilities (one definition), so they expose the same fields.

## Provisional vs final

* Game: `live` → full time = `provisional` (status `finished`, awaiting the score sheet) → `final` (`completed`).
* Table: `provisional` until the event is completed; `games_to_finalise` says how many group games are not yet official.
* A change to a completed game is a **correction**: the public view shows the corrected result with a *Result corrected* label, followers are told, and
  `fixture_public_changes` keeps the earlier official score (append-only; a trigger refuses edits and deletes).

## Privacy and youth

* Youth event = maximum age under 18. Players are not named, no stats pages, no athlete alerts, no fan reactions or MVP vote, sponsor links hidden, never indexed.
* A young person cannot be followed; an award to a young person never becomes a share card or appears on the public page.
* `private` events answer 404 to outsiders on every read path, the share page, the card, the sitemap and the live stream; alerts stop for non-participants.

## Alerts

`follow_subject` takes `start`, `score`, `result`, `schedule`. Triggers on `fixtures` / `match_events` write the change log; the worker's maintenance
cycle (`NOTIFY_INTERVAL_SECONDS`, default 60 s) turns it into notifications (idempotent, deduplicated, one score alert per burst). Delivery uses the
person's notification preferences (in-app, push, email).

## Sharing and SEO

`/api/v1/share/events/:id`, `/fixtures/:id`, `/awards/:id` are server-rendered pages with Open Graph / Twitter metadata; `/api/v1/share/cards/:type/:id.svg` is the card image
(SVG; platforms that need a PNG preview rasterise it on their side). `/api/v1/share/sitemap.xml` lists indexable events only. In the app a shared link opens `?event=<id>[&fixture=<id>]`,
which works signed out.

## Measured sponsor exposure

`impressions_served` counts public responses that carried the placement (polling reads are not counted); `clicks` counts follows of the call to action.
Unique reach and return on investment are **not** measured and never shown.

## Not built / limits (stated plainly)

* No ticketing module exists; the page links to registration only.
* Share cards are SVG; no server-side PNG rasteriser is bundled.
* Score alerts arrive within one maintenance cycle (default 60 s), not instantly.
* Native iOS / iPadOS / Android could not be run in this environment; the shared React Native code was compiled for web and verified at phone, tablet and desktop widths.
