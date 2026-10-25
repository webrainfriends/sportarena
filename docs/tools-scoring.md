# Tools: Scoring & Game Tracking (#416)

Tools is a module on the More swivel for utilities that are useful to everyone, whatever their role. It holds the **Document Designer** (the existing branded-documents screen, #249, unchanged) and **Scoring & Game Tracking**.

> Anyone can score or track. Only governed, authorised review turns tracking into an official SportArena result.

## What was reused, what was added

| Need | Canonical source (reused) | Added |
|---|---|---|
| Scoring rules, score, validation | `scoring/rulesets.js`, `scoring/engine.js` (`computeScore`, `rejectReason`) | nothing: the tracker and upload checks call the engine |
| Event scoring rules | `set_event_scoring_template` / `get_scoring_ruleset` | a screen in Tools (there was none) |
| Live match log | `match_events`, `log_match_event` | nothing: linked sheets never write to it |
| Official result lifecycle | `score_sheets` (draft, submit, sign-offs, approve, publish, revise) | an approved proposal opens a draft score sheet (or a revision) and the existing lifecycle takes over |
| Roles | `fixtureContext` (organiser, accepted official, team managers) | reviewers are resolved from it on every call |
| PDF, brand kits, files | `documents/render.js`, brand kits, `doc-store.js` | `renderTrackingSheet`, the encrypted `tracking` evidence folder |
| AI | `ai.js` (`ask`, `askJson`) with deterministic fallbacks | layout arrangement and sheet reading, both reviewed by a person |
| Notifications, audit | `notify()`, `audit()` | nothing |
| Proposal and review | none existed | `result_proposals`, `result_proposal_reviews` |

No second scoring engine, result workflow, match log, PDF engine or review model was created. `score_sheets.status`, `fixtures` and standings are only ever changed by the existing score-sheet capabilities.

## Data model (migration `104_tracking_sheets.sql`, additive)

`tracking_sheet_templates` + immutable `tracking_sheet_template_versions` (a trigger refuses UPDATE/DELETE), `tracking_sheets`, append-only-by-convention `tracking_sheet_entries` (undo voids an entry and keeps it), `tracking_sheet_imports` (uploaded sheet, extraction, confidence, warnings), `result_proposals`, append-only `result_proposal_reviews` (trigger), and `events.result_approval_policy`.

Rollback: the migration only adds objects. Reverting the code leaves the tables unused; no existing data is touched.

## Flow

1. **Standalone**: pick sport, format and template, track live (or print the PDF and upload it later). Always labelled *Unofficial / standalone*. Nothing here reaches standings, rankings, athlete history or leaderboards.
2. **Upload**: PDF/JPEG/PNG (magic bytes, 10 MB, no scripts or embedded files in PDFs). The reader (AI vision, when configured) proposes values with per-field confidence; the user corrects and confirms. The original is kept encrypted as evidence. A repeat upload of the same file returns the same import.
3. **Link to a game**: `submit_result_proposal` re-checks everything on the server (sport, rules compatibility, event visibility, game state, who may propose). The result is computed from the sheet, not from client totals. One live proposal per sheet and game.
4. **Review**: the event's policy (own, or the default for its kind) lists the required steps and roles; sequential or parallel, optional quorum, optional organiser override with a reason, no self-approval. Decisions are append-only; a negative decision blocks until the submitter resubmits (new round).
5. **Apply**: organiser or match official only. Re-checks the official record (stale proposals are refused), refuses while a score sheet is open, and needs the organiser plus a reason to supersede a published result or disagree with the live match log. Idempotent. The draft score sheet then needs the normal sign-offs, approval and publication.

## Sport-specific printed sheets (forms)

The PDF is the sheet a scorer fills in **while the game is played**, not a summary. `apps/api/src/tracking/forms.js` (`formFor`) picks a *form* for every sport in the catalogue, by the sport's own slug first, then its ruleset kind, scoring family and play type. A form is plain data (sections such as running-score boxes, line-ups, timed event logs, round cards, judging panels, attempt grids, ladders, heat tables, hole/frame/end grids, move logs) drawn by `apps/api/src/documents/sheet-forms.js`.

| Family | Printed sheet |
|---|---|
| Cricket (T10 / T20 / ODI) | Landscape scorebook: toss and umpires, ball-by-ball over grid, batting and bowling cards, extras, fall of wickets, both innings |
| Football-style and other period team sports | Line-ups, period scores, timeouts / fouls / substitutions boxes, timed scoring log with running score |
| Basketball family | Running-score boxes (1-160), player fouls 1-5, team fouls per period, timeouts |
| Baseball / softball / rounders | Line score (R/H/E), batting order, pitchers |
| Rally sports (volleyball, badminton, table tennis, tennis ...) | Per-set running points to strike through, players (singles / doubles), timeouts and substitutions |
| Combat | Boxing / kickboxing / MMA round cards (10-point must), judo / karate / taekwondo / wrestling scoring actions and penalties, fencing touches, method of victory |
| Judged | Judges panel J1-J7 with D / E / deductions, element log |
| Weightlifting / powerlifting | Attempt card with good / no-lift marks and weight changes |
| Athletics and racing | Heat / race sheet (lane, splits, wind), six-attempt field sheet, height ladder |
| Archery, golf, bowling, darts, snooker, curling and similar | Ends, holes, frames, leg tracker, frame breaks |
| Board and card games, esports | Game / move log with clocks, map and round grid with K/D/A |
| Everything else | Multi-event score sheet |

Rules: a form only controls what is printed. Scoring, validation, the live tracker, uploads and result proposals still use the ruleset and `scoring/engine.js`; `trackingMode` is unchanged. Every form ends with a boxed final result so a completed sheet can still be read back. Layout v2 carries the form; sheets pinned earlier (v1, no form) are immutable and still print the original layout. Customisation (hidden / renamed stats, notes fields, paper, orientation, signatures) keeps working. Sheets print blank: no names or numbers are pre-filled.

## Printed sheet code

Each PDF carries a reference (`TS-XXXXXXXX`) and a signed code (HMAC of the reference and template version) in text and QR. It locates the user's own sheet on upload; it is never accepted as authority, and a code copied by someone else binds nothing.

## Residual limitations

- No malware scanner exists on the platform. Uploads are restricted by type, size and active-content checks only.
- Reading a scan needs `ANTHROPIC_API_KEY`; without it the user types the values from the sheet.
- Linking is for games with two sides. Individual events (athletics, swimming heats) can be tracked and printed as a results table but are not linked to a canonical heat record.
- Offline: failed taps are kept in memory and retried with the same key; they do not survive closing the app.
- PDFs open in the web app; the native app shows a hint (the same convention as the other documents).
- Template sharing is personal and organisation; team and event-specific templates are not offered yet.
