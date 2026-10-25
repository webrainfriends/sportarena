# Tools: Scoring & Game Tracking (#416) and Rules & rulebook

Tools is a module on the More swivel for utilities that are useful to everyone, whatever their role. It holds the **Document Designer** (the existing branded-documents screen, #249, unchanged), **Scoring & Game Tracking** and **Rules & rulebook**.

> Anyone can score or track. Only governed, authorised review turns tracking into an official SportArena result.

## What was reused, what was added

| Need | Canonical source (reused) | Added |
|---|---|---|
| Scoring rules, score, validation | `scoring/rulesets.js`, `scoring/engine.js` (`computeScore`, `rejectReason`) | a `cricket` ruleset kind and `scoring/cricket.js` (ball-by-ball); `scoring/scorecards.js` (boxing 10-point must, weightlifting attempts). The tracker and uploads call the engine; nothing is computed in the app |
| Event scoring rules | `set_event_scoring_template` / `get_scoring_ruleset` | a screen in Tools (there was none); a cricket branch in its editor |
| Live match log | `match_events`, `log_match_event` | nothing: linked sheets never write to it (the cricket kinds also validate through the same engine) |
| Official result lifecycle | `score_sheets` (draft, submit, sign-offs, approve, publish, revise) | an approved proposal opens a draft score sheet (or a revision) and the existing lifecycle takes over |
| Heat, race and field results | `event_sessions`, `event_session_entries`, `record_session_results` | an approved heat proposal is applied through `recordSessionResults` (the endpoint's own code, now exported) |
| Roles | `fixtureContext` (organiser, accepted official, team managers); `eventAccess` + assigned shifts for sessions | reviewers are resolved from them on every call |
| PDF, brand kits, files | `documents/render.js`, brand kits, `doc-store.js` | `renderTrackingSheet`, `renderRulebook`, the encrypted `tracking` evidence folder |
| Rules of a sport | `list_sport_rules` (platform-team sections, scoring explanation) | the written rulebook (`rulebook/catalog.js`) is returned by the same endpoint (`rulebook`), so Learn & study and Tools show one set of rules |
| AI | `ai.js` (`ask`, `askJson`) with deterministic fallbacks | layout arrangement and sheet reading, both reviewed by a person |
| Notifications, audit | `notify()`, `audit()` | nothing |
| Proposal and review | none existed | `result_proposals` (now fixture **or** session), `result_proposal_reviews` |

No second scoring engine, result workflow, match log, PDF engine or review model was created. `score_sheets.status`, `fixtures`, session results and standings are only ever changed by the existing capabilities.

## Rules & rulebook

`apps/api/src/rulebook/catalog.js` holds a written rulebook for each first-release sport: football, cricket (T20, ODI, Test), athletics, table tennis, hockey, chess (classical, rapid, blitz), ice hockey, baseball, American football, rugby (union, sevens), pickleball, futsal, racquetball, squash, boxing (elite, youth, professional), judo, karate (kumite, kata), weightlifting and badminton. Each rule is a card (`no`, `title`, `body`), the governing body and a link to its **official book**. The text is a plain-language summary written for SportArena; it says so on every book, and the official book decides any dispute.

A card may carry **settings**: the few things a competition may change (half length, overs per innings, points to win a game, rounds, timeouts...). They are typed (a stepper, chips or a switch), range-checked on the server, and per format. Everything else is the standard and is never edited.

**Local rules** (`local_rule_sets` + immutable `local_rule_versions`, migration `109`): a named set of the settings a person, organisation, team or event changes, kept as versions. Only values that differ from the standard are stored. Who may publish is resolved from real membership (organisation owner/admin/coach, team captain/coach/manager/owner, the event organiser). A sheet started under a local rule set pins that version; its PDF prints a "Local rules in force" box; settings that change scoring (best-of, points to win, tiebreak, innings, quarters, overs, bowler limit...) reach the sheet's ruleset. A linked sheet always keeps the event's pinned ruleset (the event's own local rules are shown beside it, and a clash is printed).

`GET /rulebook`, `GET /rulebook/:sport`, `GET /rulebook/:sport/pdf` (the booklet, with local changes marked), `GET/POST /local-rules`, `GET /local-rules/:id`, `POST /local-rules/:id/retire`. The same capabilities are available over MCP.

## Data model (migrations `104`, `109`, `110`, additive)

`tracking_sheet_templates` (scopes: personal, organisation, team, event) + immutable `tracking_sheet_template_versions` (a trigger refuses UPDATE/DELETE), `tracking_sheets` (`details`: header fields, team lists, officials, boxing cards, chess moves, judo tally; `session_id`; `local_rule_version_id`), append-only-by-convention `tracking_sheet_entries` (undo voids an entry and keeps it), `tracking_sheet_imports` (uploaded sheet, extraction, confidence, warnings, `scan_status`), `result_proposals` (target is a fixture or a session), append-only `result_proposal_reviews` (trigger), `events.result_approval_policy`, `local_rule_sets` and `local_rule_versions`.

Rollback: the migrations only add objects, relax a few constraints (a proposal may target a session; a template may be team or event scoped) and widen none of the stored data. Reverting the code leaves the tables unused; no existing data is touched.

## Flow

1. **Standalone**: pick sport, format, rules (standard or local) and template, track live (or print the PDF and upload it later). Always labelled *Unofficial / standalone*. Nothing here reaches standings, rankings, athlete history or leaderboards.
2. **Upload**: PDF/JPEG/PNG (magic bytes, 10 MB, no scripts or embedded files in PDFs, plus a virus scan when a scanner is configured). The reader (AI vision, when configured) proposes values with per-field confidence; the user corrects and confirms. The original is kept encrypted as evidence. A repeat upload of the same file returns the same import.
3. **Link**: a two-sided sheet is linked to a game (`submit_result_proposal`); a heat, field or race sheet to a session (`submit_session_result_proposal`, each row matched to an entry, lanes matched for you). The server re-checks everything (sport, rules compatibility, unit, event visibility, state, who may propose) and computes the result from the sheet, not from client totals. One live proposal per sheet and target.
4. **Review**: the event's policy (own, or the default for its kind) lists the required steps and roles; sequential or parallel, optional quorum, optional organiser override with a reason, no self-approval. A session has only an organiser and its assigned officials, so the policy is limited to those roles (falling back on official then organiser). Decisions are append-only; a negative decision blocks until the submitter resubmits (new round). The policy editor in Tools builds custom steps and quorum.
5. **Apply**: organiser or match official only. Re-checks the official record (stale proposals are refused), refuses while a score sheet is open, and needs the organiser plus a reason to supersede a published result or disagree with the live match log. Idempotent. A game proposal opens a draft score sheet that then needs the normal sign-offs, approval and publication. A session proposal records the results through the normal session results path.

## Scorer-grade sheets

The PDF is the sheet a scorer fills in **while the game is played**, not a summary. `tracking/forms.js` (`formFor`) picks a *form* by the sport's own slug first, then its ruleset kind, scoring family and play type. Forms are plain data drawn by `documents/sheet-forms.js`; the sport-specific ones live in `tracking/pro-forms.js`.

| Sport | Printed sheet | On screen |
|---|---|---|
| Football | FIFA-style match report: line-ups with captain and goalkeeper, goals, cautions and send-offs, substitutions, period times, extra time and shoot-out, VAR and officials, referee report | match log with scorer and minute, goal type (open play, penalty, free kick, own goal), cards, substitutions picked from the team list |
| Futsal, hockey, ice hockey, rugby (union, sevens), American football, baseball | the governing body's game sheet (accumulated fouls, penalty corners and cards, IIHF scoring and penalty summary, World Rugby report, NFL scoring summary, baseball scorebook) | the same match log |
| Cricket T10 / T20 / ODI / Test | ICC scorebook: toss, umpires, daily record (Test), ball-by-ball grid, batting and bowling cards, extras, fall of wickets, four innings for a Test | ball-by-ball scorer: runs, extras, wicket with how out, strike and over change, bowler limits, free hit, powerplay and DRS settings, declaration, follow-on, result |
| Athletics | Olympic-style track heat sheet (lanes, reaction, splits, Q/q, false start), field attempts, height ladder | heat or field table: places, Q/q and a false-start warning come from the server |
| Badminton, table tennis, pickleball, racquetball, squash | per-game running points to strike through, with the sport's own boxes | rally-by-rally tracker under the sport's scoring |
| Boxing | 10-point-must scorecard per judge | a card per judge, round by round; the decision (unanimous, split, majority, draw) is worked out on the server |
| Weightlifting | IWF competition card | attempts per lifter; bests, totals, bomb-outs and places on the server |
| Karate | WKF kumite sheet and kata judging sheet | kumite scored with yuko, waza-ari and ippon; kata as a results table |
| Judo, chess | IJF contest sheet; FIDE scoresheet (120 moves) | result, method, score tally, and the move list |

Rules: a form only controls what is printed. Scoring and validation come from the ruleset and engine. Layout v2 carries the form; sheets pinned earlier are immutable and still print the original layout. Sheets print blank: no names or numbers are pre-filled.

## Printed sheet code

Each PDF carries a reference (`TS-XXXXXXXX`) and a signed code (HMAC of the reference and template version) in text and QR. It locates the user's own sheet on upload; it is never accepted as authority, and a code copied by someone else binds nothing.

## Upload scanning

`malware-scan.js` streams an upload to ClamAV's `clamd` (INSTREAM) when `CLAMD_HOST` (+ `CLAMD_PORT`) or `CLAMD_SOCKET` is set. An infected file is always refused. `UPLOAD_SCAN=required` also refuses uploads while the scanner cannot be reached; `optional` (the default once a scanner is configured) accepts them and records `scan_status = unavailable`; with no scanner nothing is scanned and `scan_status = not_scanned`. Running `clamd` is an infrastructure task.

## Offline

Taps that cannot reach the server are queued in the app, kept on the device across restarts and retried (every few seconds and when the connection returns) under the same `client_key`, so a retry never records twice. PDFs open in a tab on the web and through the share sheet in the native apps.

## Residual limitations

- Reading a photo or scan needs `ANTHROPIC_API_KEY`; without it the user types the values from the sheet. Reading of rotated or photographed sheets is only as good as that reader and has been tested here with a stubbed reader.
- Virus scanning needs a `clamd` the operator runs; none ships with the platform.
- A heat proposal records results for the session's existing entries; it does not create entries or heats. Lifting sheets can be proposed as scores.
- Live cricket scoring through Match Centre points to the Tools scorebook; the canonical `log_match_event` accepts the same cricket entries.
- The rulebook text is a SportArena summary; the official books are linked, not reproduced.
