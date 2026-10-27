# Live scoring engine (#500)

Real-time, sport-specific scoring for the people running a game or a heat, and a spectator-safe read of the same thing. It **extends** the
existing scoring stack and does not replace any of it: `match_events` and `session_events` are append-only logs, the official result still
goes through the score-sheet workflow (games) or `record_session_results` (heats), and the sport rules are the pinned, governed ruleset.
Everything is one capability set (`capabilities/live-scoring.js` plus the hardened `log_match_event` / `void_match_event`), so REST, OpenAPI
and MCP expose the same operations with the same permission rules, and the same Expo app runs it on iOS, iPadOS, Android and the web.

## Reuse / gap matrix

| Sport | Existing live capability | Rule / event model before | Verified gap | Extension (this change) |
|---|---|---|---|---|
| Cricket | `log_match_event` accepted ball entries; scorebook in Tools | `cricket` ruleset kind, `scoring/cricket.js` | no target / required rate / partnerships / powerplay in live state; batting slots not tied to players; Match Centre only linked out to Tools | current and required run rate, target, partnerships, pinned powerplay windows (`cricket.powerplays`, none assumed); a `lineup` entry (batting order) so scorecards attribute to verified players; the existing `CricketScorer` now runs inside Match Centre |
| Football, futsal and other team games | `log_match_event`, periods, cards, substitutions in appearances | `points_events` | no extra time, shoot-out, two-yellows-is-red, lineup validation | `extra_time{}` and `shootout{}` on the ruleset (only in knockout games, only when level); sent-off tracking; players and assists must be in the declared lineup; assist attribution |
| Badminton, table tennis, squash, volleyball … | rally points as a `sets` ruleset | `sets` | no server tracking | `racket.serve` (`rally_winner`, `alternate`) derives the server; first server is an event |
| Tennis, padel | game scores entered as "points" | `sets` | no points → games → sets, no deuce / no-ad, tie-break, match tie-break, server, retirement | `racket.scoring = 'games'`: point-by-point scoring in `scoring/racket.js`, deuce or no-ad, tie-break, super tie-break, serve rotation, retirement and walkover |
| Athletics, swimming | results recorded after the fact (`record_session_results`) | `event_sessions` / `event_session_entries` | no live status, lanes, splits, attempts, provisional places, progression | `session_events` log, `scoring/session.js` projection, `log_session_event`, `get_live_session`, `finalize_session_live` (calls `record_session_results`), `set_discipline_progression` |
| All | SSE for fixtures, `client_key`, `seq` | in-process bus, no cursor, no auth on the stream | stale-state detection, correction provenance, scorer conflicts, bounded history, live revocation | below |

## Coverage by sport

`test/live-scoring.test.js` walks the whole catalogue (219 sports) and checks that each one resolves to a defined model that satisfies the plugin
contract, and that every sport with a running score accepts a real scoring event. Nothing is left on a silent generic default: where a sport has no
ruleset of its own the fallback is labelled in its name.

| Model | Sports | What the scorer gets |
|---|---|---|
| Points / goals (`points_events`) | 80: football, futsal, handball, hockey, ice hockey, basketball (3x3, wheelchair), rugby, kabaddi, American football, Australian rules, Gaelic football, hurling, baseball, softball, karate … plus **generic points** for every other team ball sport and **games won** for board, card and mind games and esports | periods, scoring events, cards and fouls, extra time and shoot-out where pinned, lineup and player attribution |
| Rally sets (`sets`) | 12: badminton, volleyball, beach volleyball, table tennis, squash, pickleball, sepak takraw, soft tennis … | set and point scoring, derived server |
| Games in sets (`racket`) | tennis, padel | points, games, sets, deuce or no-ad, tie-breaks, match tie-break, server, retirement, walkover |
| Innings (`cricket`) | cricket (T10, T20, ODI, Test) | ball by ball, run rates, target, partnerships, batting order |
| Timed and measured sessions | 55 sports scored by time or distance (running, swimming, cycling, winter sports, jumps and throws …) | live heats, finals and field flights in the Games screen (a multi-sport programme): call room, splits, finishes, attempts, provisional places, Q / q, official result |
| Totals or judges (`manual`) | the rest (judged, bout, weight-class and precision sports, other individual aggregate scoring) | the match clock, tracked warnings and notes; the result is entered on the score sheet. Boxing 10-point-must cards and weightlifting attempts stay in the Tools tracker |

Judged panels (gymnastics, diving, figure skating) and bout-by-bout combat scoring have no live model yet: they are the honest gap in "every sport".
The fallback ruleset for a sport is only a default: an organiser can pin a template or a governed format that gives it the right values.

## The sport plugin contract (`scoring/plugins/index.js`)

Each plugin serves one ruleset kind and separates what differs between sports so nothing is forced into home/away totals:

| Part | Function |
|---|---|
| Rules / event validation | `validate(rs, live, next, ctx)` |
| Score state | `state(rs, live)` (pure, from the ordered, non-voided stream) |
| Clock / period / set / innings | `phase(rs, live, state)` |
| Participant attribution | `attribution(rs, live, ctx)` |
| Live stats | `liveStats(rs, live, state)` (only what was captured; nothing is estimated) |
| Public projection | `publicView(state)` |
| Result conversion | `toResult(state)` (a starting point for a sheet; never published by itself) |

Registered kinds: `points_events`, `sets`, `racket` (the game-in-set refinement of `sets`), `cricket`, `manual`, plus `sessionPlugin` for timed and
measured sessions. `engine.js` only dispatches; `registerSportPlugin()` adds a kind without touching it. Rulesets stay governed and pinned
(`ruleset_versions`, `fixtures.ruleset_version_id`); every new ruleset field is optional, so published versions still parse.

## Authority, concurrency and corrections

* **Who may write**: the organiser, an accepted referee / umpire / scorer, or an admin (`fixtureContext`); for sessions the organiser or an
  official on an accepted shift (`canScoreSession`). It is resolved on every call, so release, reassignment and org revocation apply on the next
  write. Everyone else, including team managers, gets 403 on every mutation over REST and MCP.
* **Ordering**: writers to one game queue in memory (`serialize.js`) and then take the database row lock, so a burst of retries cannot starve the
  connection pool and two officials never share or skip a `seq`.
* **Idempotency**: `client_key` replays return the stored event (`duplicate: true`) before any state check.
* **Stale writers**: `expected_seq` (the `last_seq` the caller saw) is refused with `409` `stale_state` and the current state when the game has
  moved on. The app holds the tap and asks; it never adds it blindly.
* **Corrections** (`correct_match_event`): the original is voided and a replacement takes its place in play order (`position_seq`), with a
  `match_event_revisions` row (who, in what capacity, why, before and after). The whole stream is replayed under the pinned rules first; a
  correction that would make a later event illegal is refused and names that event. The database refuses edits and deletes of recorded events
  and of their revisions.
* **Scorer lease** (`claim_scorer_lease`): an advisory "who is scoring" hint with a 90 second expiry; only the organiser can take over.

## Real time

| | Spectators | Officials |
|---|---|---|
| Stream | `GET /live/fixtures/:id`, `GET /live/sessions/:id` (public, read-only) | `GET /live/fixtures/:id/scorer`, `GET /live/sessions/:id/scorer` (signed in; 404 to anyone else) |
| Contents | spectator-safe state; no void reasons, no entry capacity, young people only with current guardian consent | also voided events and the scorer lease |
| Resume | frame ids `<last_seq>:<version>`; `Last-Event-ID` / `?cursor=` returns the missed events; `version` also moves on a void or correction | same, and authority is re-checked on every update and every 10 seconds: `revoked` frame, then close |
| Fallback | React Native has no `EventSource`: the app polls `get_live_fixture` / `get_live_session` with `since_seq` | same |

Streams are capped (2,000 overall, 25 per address). With several API processes set `LIVE_BRIDGE=pg`: each publish also issues `pg_notify` and the
other processes refresh their own streams from the database.

## Public state

`live.state` is `scheduled`, `live`, `provisional` (full time, sheet not published), `final` (published) or `corrected` (a published result was
revised); a live game with corrections shows `corrected: true`. Sessions use the same words: they are provisional until
`record_session_results` runs, final once it has, and corrected (`event_sessions.corrected_at`) when the result of a completed session is recorded again.

## The scorer screens (`apps/app`)

* **Match Centre** is still the one home for a game. It gained: the offline-safe queue (`scorer/queue.js`, shared with the Tools tracker and the
  session pad), a sport-aware pad (cricket scorebook, tennis / padel pad, football extra time and shoot-out, rally server), quick player
  picks from the declared lineup, Undo and Correct, a conflict sheet, and a phone / tablet / desktop layout (pad beside timeline from 768 px).
* **Games > session sheet** is the one home for a heat: call room, start, splits, finishes, attempts, DNS / DNF / DQ, provisional places, Q / q
  from pinned progression, Undo, and "Finalise result". Marks are built from steppers, not typed.
* Taps are saved on the device first and survive closing the app; "N not sent yet" and Retry are always visible.

## Limits worth knowing

* Q / q and field cuts show only from `set_discipline_progression`; with nothing pinned none are shown. Rest-of-field rules beyond that are not
  guessed.
* Wind, reaction times and photo-finish imports are stored if sent but are not interpreted.
* Possession and similar telemetry appear only if a scorer records them as events; nothing is derived or invented.
* The scorer lease is a hint, not a lock; the server remains the only authority on order and legality.
* Passport and leaderboard feeds still run from the published result and the existing verified-appearance path, not directly from live events.
* On native, live updates are polling (about every 4 seconds); the web build streams.
* The app is locked to portrait in `app.json`; a landscape tablet scorer would need that changed deliberately.

## Verification

`apps/api/test/live-scoring-engine.test.js` (pure plugin tests), `apps/api/test/live-scoring.test.js` (concurrency, replay, stale state,
corrections and provenance, tennis, cricket, football cup tie, lineup, permissions over REST and MCP, lease, streams and live revocation,
sessions, public lifecycle, youth consent) and `scripts/e2e/live-scoring-journey.mjs` (the real web app on a phone, tablet and desktop,
including going offline and the conflict sheet). Native devices were not available in this environment: the iOS and Android bundles compile
(`expo export`), but nothing was run on a physical iPhone, iPad or Android device.
