# Advanced competition formats (#490)

One engine: formats extend the canonical `event_stages` / `fixtures` / results (no second bracket product). Generation and every change go through
the capabilities in `apps/api/src/capabilities/bracket-stages.js` and `event-schedule.js` (REST + OpenAPI + MCP from one definition); the UI only calls them.

## What already existed, and the smallest extensions
- Existing: heats, round robin, seeded knockout, byes, semi/final, third place (`tournament/bracket.js`, `event-schedule.js`).
- Added in migration 126 (additive): stage `published_at/revision/algorithm/draw_seed/parent_stage_id`; fixture side/round/pool/tie/leg columns;
  `bracket_ties`, `bracket_revisions` (append-only audit), `bracket_conflicts`.
- Added for #490 completion: `redraw_event_stage` accepts `format_config` / `third_place` (a recorded `format_revision`, reason required once published,
  refused once a game has started), an organiser "Change format" sheet, a concurrent-advancement test.

## Requirement → evidence
| # | Requirement | Implementation | Evidence (test) |
|---|---|---|---|
| 1 | Versioned format config, no silent rewrite | `get_bracket_formats`, stage `algorithm`/`revision`, `redraw_event_stage` (`format_revision`) | bracket-formats: "format revision", "redraw" |
| 2 | Swiss: named policy, rounds, no rematch, byes, floats, home/away, tie-breaks, explanation | `formats/swiss.js`, `generate_swiss_round` | unit "swiss" ×3; integration "swiss" |
| 3 | Double elimination: byes, loser routing, finals, optional reset, placements | `formats/double-elim.js` | unit "double elimination" ×3 (sizes 3..20); integration ×2 |
| 4 | Repechage from versioned templates | `formats/repechage.js`, `generate_repechage` | unit "repechage"; integration "repechage" |
| 5 | Pools → knockout, wildcards, tie-breaks, same-pool avoidance | `formats/pools.js`, `advance_pools_stage` | unit "pools"; integration "pools → knockout" |
| 6 | Multi-leg aggregate; away goals only when enabled | `formats/series.js` (`aggregateState`) | unit "series and aggregate ties"; integration "best-of series and two-leg ties" |
| 7 | Best-of-N, early completion, unused games `not_required` kept | `seriesState`, `advance.js` | same tests |
| 8 | Reseed / redraw, protected seeds, persisted draw seed, manual draw, governed | `redraw_event_stage`, `formats/rng.js` | integration "redraw"; unit "rng" |
| 9 | Placement / consolation | `formats/graph.js`, `repechage.js` | unit "placement and consolation"; integration "repechage … placement" |
| 10 | Correction propagation: preview, unstarted re-fill, played → conflict, keep/replay | `preview_result_correction`, `resolve_bracket_conflict`, `formats/propagation.js` | integration "corrections"; unit "correction impact" |
| 11 | Scheduling integration | `planStage` through the existing scheduler; `check_stage_schedule` | integration "schedule check …" |
| 12 | Responsive, accessible views (list/table alternatives) | `bracket-board.js`, `bracket-studio.js` | `scripts/e2e/bracket-journey.mjs` (phone/tablet/desktop), `docs/ux/advanced-formats/*.png` |
| 13 | Determinism and audit | `bracket_revisions` inputs/snapshot, `draw_seed`, `get_stage_audit` | unit swiss/rng; integration "swiss … draw is reproducible" |
| – | Concurrent advancement | row locks in `tournament/advance.js` | integration "concurrent advancement" |
| – | Every sport | `coverageOf`, labelled fallback | integration "every scoring family … coverage" |

## Platform coverage
Shared Expo / React Native components only. Web verified in a browser at phone, tablet and desktop widths; `expo export` succeeds for web, iOS and
Android. Not run on a physical iOS/iPadOS/Android device.
