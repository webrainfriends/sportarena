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

Native moment detection from the scoring record: **cricket** (wicket, six, boundary), **goal games** (goal, and any points event), **racket and set sports** (set won, match won), **timed/measured sports run as sessions** (win, finish). Sports scored as plain totals, judged sports and others without a citable scoring log are **bookmarks-only** and say so in the API (`notes`, `native_model`) and the screen; they are never given a silent default. Current split of the 219-sport catalogue: ~54 sports auto-detect moments, the rest are bookmarks-only; 128 sports use the labelled generic family fallback.

## Honest limits

- Video stays where it is hosted: there is no transcoding unless a renderer is configured, and the clip sheet opens the link rather than embedding a player. Trimming is ±1 second steppers, not a scrubber.
- Field-event attempts, set/match *point* (as opposed to the point that wins the set/match) and judged-sport moments are not auto-detected yet; use bookmarks.
- Sponsor bumpers are validated cards in the reel order; no frame is rendered by this module.
- Web build verified at phone, tablet and desktop widths and the iOS and Android bundles export; no native device run.
- Translations are machine-drafted and `reviewed: false` until a native speaker signs them off.
