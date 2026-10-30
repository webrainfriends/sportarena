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
| Athletics, swimming | results recorded after the fact (`record_session_results`) | `event_sessions` / `event_session_entries` | no live status, lanes, splits, attempts, provisional places, progression | `session_events` log, `scoring/session.js` projection, `log_session_event`, `get_live_session`, `finalize_session_live` (calls `record_session_results`), `set_discipline_live_rules` |
| All | SSE for fixtures, `client_key`, `seq` | in-process bus, no cursor, no auth on the stream | stale-state detection, correction provenance, scorer conflicts, bounded history, live revocation | below |

## Coverage by sport

`test/live-scoring.test.js` walks the whole catalogue (219 sports) and checks that each one resolves to a defined model that satisfies the plugin
contract, and that every sport with a running score accepts a real scoring event. Nothing is left on a silent generic default: where a sport has no
ruleset of its own the fallback is labelled in its name.

| Model | Sports | What the scorer gets |
|---|---|---|
| Points / goals (`points_events`) | 39: football, futsal, handball, hockey, ice hockey, basketball (3x3, wheelchair), rugby, kabaddi, American football, Australian rules, Gaelic football, hurling, baseball, softball … plus a **labelled generic points** fallback for every other team ball and winter team sport | periods, scoring events, cards and fouls, extra time and shoot-out where pinned, announced added time, lineup and player attribution |
| Rally sets (`sets`) | 12: badminton, volleyball, beach volleyball, table tennis, squash, pickleball, sepak takraw, soft tennis … | set and point scoring, derived server |
| Games in sets (`racket`) | tennis, padel | points, games, sets, deuce or no-ad, tie-breaks, match tie-break, server, retirement, walkover |
| Innings (`cricket`) | cricket (T10, T20, ODI, Test) | ball by ball, run rates, target, partnerships, batting order |
| Round cards (`cards`) | 4: boxing, MMA, Muay Thai, kickboxing | each judge's 10-point-must card per round, the decision derived from the cards, warnings and knockdowns tracked |
| Result only (`outcome`) | 55 sports decided by a result and not a running score (chess and other mind games, esports, judo, wrestling, fencing and other bout sports …) | the match clock and a live `result` (winner or draw, optional method); the score sheet is still entered by the official at full time |
| Timed, measured and judged sessions | 106: running, swimming, cycling, winter sports, jumps and throws, plus judged disciplines (gymnastics, diving, figure skating …) | live heats, finals and field flights in the Games screen: call room, splits, finishes, attempts, provisional places, Q / q; each discipline has an aggregate: **best** attempt, **sum** of attempts, or a judges' **panel** (mean of the marks with optional dropped extremes and a difficulty multiplier); lower-is-better (golf, timed events) is a setting |

Counts are the output of `liveModelOf()` over the whole catalogue (39 + 12 + 2 + 1 + 4 + 55 + 106 = 219). The only labelled fallback is generic
points for team ball and winter team sports. A fallback ruleset is only a default: an organiser can pin a template or a governed format that gives
it the right values.

**Honest gaps**: judging panels need at least five judges before extremes can be dropped; combat sports beyond the four carded ones record a
result, not round scores; per-sport telemetry (possession, wind, reaction times) is stored when sent but never derived.

### Sport rules for basketball, kabaddi, volleyball and badminton

Optional ruleset blocks (`basketball{}`, `kabaddi{}` on `points_events`; `rally{}` on `sets`) add the sport's own rules on top of plain scoring. Everything is
derived from the taps in `match_events` (`scoring/rules/*`), appears under `score.rules` for officials and spectators, and every threshold is a ruleset
field a template or governed format can change. Old pinned versions without the blocks behave as before.

| Sport | Derived state | Refused (unambiguous breaches only) | Advisory prompts |
|---|---|---|---|
| Basketball, wheelchair | team fouls per period, bonus, personal fouls, fouled-out players, timeouts left per half / overtime | an event for a fouled-out player; a timeout when none is left | bonus |
| 3x3 basketball | bonus at 7 team fouls, game decided at 21 | scoring after the target is reached | |
| Kabaddi | players on the mat (out on raid / tackle points, revived one per point), empty raids, super-tackle window | none | do-or-die, all-out due |
| Volleyball | rotation per side, timeouts and substitutions left per set | a timeout or substitution over the limit | technical timeouts at 8 and 16, change of ends in the deciding set |
| Beach volleyball | timeouts left | a timeout over the limit | change ends every 7 points (5 in the decider) |
| Badminton | service court from the server's own score, server named per set | none | interval at 11, change of ends in the decider |

Honest gaps: libero and exact court positions in volleyball, doubles partner identity in badminton and the individual raider in kabaddi need a lineup with
positions and are not guessed; kabaddi's revival rule is the standard one (touch, tackle and bonus points revive one player, an all-out revives all), which a
league with different rules would need to change in code.

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

Registered kinds: `points_events`, `sets`, `racket` (the game-in-set refinement of `sets`), `cricket`, `manual` (with `cards` for round-scored bouts and a live `result` for outcome sports), plus `sessionPlugin` for timed and
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
  from the discipline's live rules, Undo, and "Finalise result". Marks are built from steppers, not typed.
* Taps are saved on the device first and survive closing the app; "N not sent yet" and Retry are always visible.

## Offline scoring and the referee's match-day pack (#7)

The live scoring engine above already queued every tap on the device. What was missing for a referee with no signal at the ground: the game
could not be **opened** offline, **kick-off, pause, resume and full time** went straight to the server (so they failed, and a kick-off sent
late was stamped late), and the score on screen did not move until the server answered. This change closes those gaps **inside the same
Match Centre and the same capabilities**; there is no second scorer.

| Piece | Where | What it does |
|---|---|---|
| `get_scorer_pack` (`GET /me/scorer-pack`, MCP tool of the same name) | `capabilities/scorer-pack.js` | The games the caller may score in the next hours (organiser, or an accepted referee / umpire / scorer; `fixture_id` refreshes one), each with the **whole** event log, pinned ruleset, viewer and declared lineup. Authority is resolved per game with `fixtureContext`, the lineup is the existing `list_fixture_appearances` (a young person without current guardian consent is hidden), team managers and strangers get nothing, and each download is audited. |
| `client_key` + `occurred_at` on `start_match`, `pause_match`, `resume_match`, `end_match` | `capabilities/match-tracking.js`, `score-sheets.js`, migration `129_scorer_offline.sql` (`fixture_control_ops`, additive) | A retry after a lost reply returns the current state and changes nothing (`end_match` returns the same sheet). `occurred_at` is when the official pressed it on the device; the server clamps it to the last 24 hours and never the future, so kick-off is recorded when it happened. |
| Device projection | `apps/app/src/scorer/local.js` | Runs the server's own **pure** engine (`apps/api/src/scoring/engine.js`, no database or clock) over the saved log plus the taps still waiting, so score, period and what may be tapped next are right offline. Refuses the unambiguous breaches at once (not live, paused, period not open, the sport's own rules); the server replays everything under the pinned rules again on arrival and stays the only authority. What is shown offline is labelled **provisional**. |
| Encrypted pack store | `apps/app/src/scorer/pack.js`, `offline-store.js` (`packStore`) | Web: IndexedDB with a non-extractable AES-GCM key. iOS, iPadOS, Android: the platform keychain. Never plain storage. Kept current while online (merged from the feed, or downloaded again when the feed cannot join it), only ever for the signed-in account, and **removed at sign-out**. |
| Queue | `apps/app/src/scorer/queue.js` | Carries controls (`op`) in order with the taps; holds up to 800 (a whole innings) and rewrites only the pieces that changed; each tap is stamped with its account so taps made by another account on the same device are **kept, never sent and never deleted**; an unsent tap can be taken back. |
| Screens | Match Centre (`screens/match-centre.js`), Officials home "Match-day pack" (`screens/match-day-pack.js`) | Save the day's games from Officials home; opening a game as a scorer saves it too. Offline banner with when the copy was saved, "N not sent yet", full time queued after the taps, Appearances and AI recap hidden offline (they need the server). |

### Sports covered

`test/scorer-pack.test.js` walks the whole catalogue (219 sports). Every head-to-head sport is scored on the device by the same engine as the
server; the test checks that kick-off works, a first event is accepted offline, nothing can be scored before kick-off and the device score
equals the engine's score for the same log.

| Model | Sports | Offline |
|---|---|---|
| Points / goals (`points_events`) | 39 (football, handball, hockey, basketball, rugby, kabaddi … and the labelled generic points fallback) | native |
| Rally sets (`sets`) | 12 | native |
| Games in sets (`racket`) | tennis, padel | native |
| Innings (`cricket`) | cricket | native |
| Round cards (`cards`) | 4 combat sports | native |
| Result only (`outcome`) | 55 | native |
| Timed, measured and judged sessions | 106 | **gap**: the heat / field-flight session pad keeps its queue (taps survive no signal and are sent later, as before) but is not in the pack and does not project a provisional result on the device |

### Honest limits

* Undo of a tap that was already **sent** and Correct need a connection (they change the server's log); undo of a tap still waiting just takes it back.
* A game must have been saved once while online (Officials home, or opening it as a scorer). A game not saved cannot be scored offline, and the screen says so.
* Offline, another official's taps are not seen. If someone scored meanwhile, the existing `409 stale_state` conflict sheet appears on reconnect; nothing is added blindly.
* The scorer queue itself (not the pack) is on the same storage as before: the keychain on native, `localStorage` on the web. It holds scoring facts and player ids, no names.
* Not run on a physical iPhone, iPad or Android device here; the iOS and Android bundles compile with `expo export`.

## Limits worth knowing

* Aggregate, direction, dropped extremes, Q / q, wildcards and field cuts come from the discipline's live rules (`set_discipline_live_rules`, edited under Games > Live scoring rules); with nothing set the sport's default applies and no cut is shown. Rest-of-field rules beyond that are not
  guessed.
* Wind, reaction times and photo-finish imports are stored if sent but are not interpreted.
* Possession and similar telemetry appear only if a scorer records them as events; nothing is derived or invented.
* The scorer lease is a hint, not a lock; the server remains the only authority on order and legality.
* Passport and leaderboard feeds still run from the published result and the existing verified-appearance path, not directly from live events.
* On native, live updates are polling (about every 4 seconds); the web build streams.
* The app is locked to portrait in `app.json`; a landscape tablet scorer would need that changed deliberately.

## Verification

`apps/api/test/scorer-pack.test.js` (the pack, offline-safe controls, device projection, catalogue walk), `scripts/e2e/offline-referee-journey.mjs` (real web app: save the pack, go offline, score, full time, reconnect; phone, tablet, desktop), `apps/api/test/live-scoring-engine.test.js` (pure plugin tests), `apps/api/test/live-scoring.test.js` (concurrency, replay, stale state,
corrections and provenance, tennis, cricket, football cup tie, lineup, permissions over REST and MCP, lease, streams and live revocation,
sessions, public lifecycle, youth consent) and `scripts/e2e/live-scoring-journey.mjs` (the real web app on a phone, tablet and desktop,
including going offline and the conflict sheet). Native devices were not available in this environment: the iOS and Android bundles compile
(`expo export`), but nothing was run on a physical iPhone, iPad or Android device.
