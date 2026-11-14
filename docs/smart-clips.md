# AI highlights & smart clips (#505)

A governed, score-synchronised clip pipeline. It is **not** a video editor and not a new media store: a finished clip is an ordinary `mr_assets` row (`kind='clip'`, `parent_asset_id` = the recording), so rights, embargo, expiry, takedown, territory and youth media consent stay in one place (`src/media-rights.js`). Where the event console is the one home for running an event, the clip queue is the **Highlights** sub-tab of **Broadcast** (and of the media partner workspace). Code: `src/smart-clips.js`, `src/capabilities/smart-clips.js`, migration `139_smart_clips.sql`, app `screens/clips.js` and `screens/clip-gallery.js`.

## Overlap / reuse matrix

| Need | Reused (existing) | New (smallest extension) |
|---|---|---|
| Clip asset, publish, withdraw, takedown | `mr_assets`, `set_media_asset_status`, `update_media_asset_rights` | none: the workflow calls them, it does not copy them |
| Rights window, territory, source withdrawn, consent | `assetState`, `evaluateRights`, `recordRightsCheck`, `mr_asset_subjects`, `hasConsent` | none |
| Source recording | `mr_assets` (`kind='video'`, https link), `mr_streams` for live | `clip_alignments` (how video time maps to play time) |
| Scoring facts | `match_events`, `session_events`, `rulesetForEvent`, `computeScore`, `familyOf` | `clip_bookmarks` (scorer pointers, never facts) |
| Sponsor frames | `sponsor_inventory_units` / `_bookings` | a `sponsor_bumper` reel item that must name a confirmed booking |
| Metering | `commercial/engine.js` `consume` / `requireEntitlement` | `clip_usage` ledger + meter key `highlight_credits` |
| Async work | `jobs.js` (dedupe key, backoff, dead letter) | `smart_clip_render` job, `setClipRenderer()` provider hook |
| AI | `ai.js` (`askJsonDetailed` adds token usage), `AI_RULES`, `quoteData` | none |
| Passport | player profile and career surfaces | `clip_player_links` (a link to the governed asset, never a copy) |
| Fan view | `highlightsOf` already lists published highlight clips in the Live Centre | public clip page `?clip=<id>` and `get_public_clip` |

## Flow

`candidate → processing → review → approved → published | withdrawn` (`rejected`, `failed` on the side).

1. **Align** (`set_clip_alignment`): `media_t = anchor_media_s + (event_time − anchor_time − lag_s) × rate` (wall clock), or game-clock inside one period. A moment the alignment cannot place is skipped and reported, never guessed.
2. **Find moments** (`generate_clip_candidates`): deterministic detectors per sport family from the canonical log, plus bookmarks. Every candidate stores the event it cites (`source_kind` + `source_ref`, NOT NULL) and its place on the video. A unique index on (recording, source_kind, source_ref) makes generation and retries idempotent.
3. **AI (optional)**: may re-rank and retitle candidates and nominate extra event ids **from a list we offer it**; every id it returns is checked against the real log and invented ones are dropped (`ai.rejected_ids`). AI never writes a scoring row and never advances a clip. Captions keep `caption_facts` (from the record) apart from `caption_prose` (flagged `prose_by_ai` until a person edits it).
4. **Cut** (`process_clip`): charged once, runs as a retry-safe job, creates the draft `mr_assets` clip and tags the people in it (so guardian media consent applies to the clip itself). Default renderer: the clip is the governed time window of the hosted link (`#t=start,end`); a real transcoder plugs in through `setClipRenderer`.
5. **Review** (`review_clip`): a person approves or rejects.
6. **Publish** (`publish_clip`): requires approval, then goes through the ordinary media-asset publish (consent, source, expiry, owner). Blocks are recorded. Default policy is manual; `set_clip_policy` `trusted_auto` is an explicit organiser choice that auto-approves and publishes only clips cut from real scoring events (never AI-nominated), as the organiser, through the same checks.
7. **Watch** (`get_public_clip`, public): rights window, territory, takedown, source, visibility and every tagged young person's **current** consent are re-read and recorded on every request; failure is a 404. Revocation, takedown or expiry therefore removes access on the very next request.

## Reels and sponsors

`create_reel` / `update_reel` / `set_reel_status`: approved clips in order plus intro, outro, scorecard cards and sponsor bumpers. A bumper is accepted only if it names a **confirmed** inventory booking of the event (overlay, replay or scorecard unit) that is running today, behind an active sponsorship. `get_public_reel` re-checks every clip and every booking per view; failures drop out and are counted in `hidden`.

## Player passport

`propose_clip_player_link` (person must be tagged) → `respond_clip_player_link` (the player accepts or declines; a young player needs current guardian media consent). `get_person_clips` shows only accepted links whose clip is live and public, re-checked now; the player also sees pending offers and why one is hidden.

## Metering (#504)

Every step writes `clip_usage` (processing seconds, storage bytes, AI tokens, credits) once per idempotency key. When a commercial meter `highlight_credits` exists, credits are counted there too; a plan limit stops the step with `402 limit_reached` before any cost is kept. `get_clip_usage` reports per-event usage. With no meter defined the ledger still records usage and `metered` is false (nothing is invented).

## Sports coverage (walked by a test over the whole catalogue)

Native moment detection from the scoring record:

| Family | Detected moments | Example sports |
|---|---|---|
| **cricket** | wicket, six, boundary | cricket |
| **goal_game** | goal, any points event | football, basketball, hockey |
| **racket** | set won, match won | tennis, badminton, squash |
| **measured** | win, finish (session events) | athletics running/swimming/rowing |
| **track_field** | `attempt_valid` (priority 55), `personal_best` (priority 90) | long jump, shot put, discus, javelin, high jump, pole vault |
| **judged** | `score_announced` (priority 72), `routine_complete` (priority 48) | gymnastics, diving, figure skating |
| **generic** | bookmarks only (labelled fallback) | ~128 sports with no citable scoring log |

Sports in **track_field** and **judged** auto-detect moments from canonical `session_events` rows — valid attempts, personal-best flags, panel scores and routine-end markers. No data is fabricated; if no matching events exist the session produces zero candidates and `notes` explains the gap. Sports outside any native family are **bookmarks-only** and say so via `native_model: false`.

## In-app video preview and trim scrubber

`VideoScrubber` (`apps/app/src/components/VideoScrubber.js`) provides an inline preview and draggable in/out trim handles on iOS, iPadOS, Android and web. It uses `UrlPlayer` from `video-player.js` for playback and `PanResponder` for cross-platform drag handles. Media-fragment URLs (`video.mp4#t=15,45`) play inline via UrlPlayer. When no URI is available, the component shows time labels and fallback controls without crashing.

## Scorecard and sponsor bumper frames

`renderScorecardFrame(pool, eventId)` queries the canonical event result (teams, scores, sport) and returns an 800×200 SVG data-URI in the Dusk palette. `renderBumperFrame(pool, eventId, bookingId)` validates the sponsor booking via `bumperBookingOk`, queries `sponsor_identities` for the logo URL, and returns an 800×120 SVG data-URI. Both renderers are swappable with `setScorecardRenderer(fn)` / `setBumperRenderer(fn)`. REST: `POST /reels/:id/scorecard-frame`, `POST /reels/:id/items/:itemId/bumper-frame`, `GET /reels/:id/frames`.

## Honest limits

- Video stays where it is hosted: there is no transcoding unless a clip renderer is configured.
- Set/match *point* (as opposed to the point that wins the set/match) is not auto-detected; use bookmarks.
- Web build verified at phone, tablet and desktop widths and the iOS and Android bundles export; no native device run documented.
- Translations are machine-drafted and `reviewed: false` until a native speaker signs them off.
