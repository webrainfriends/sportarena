# Verified appearances, substitutions and minutes (#322)

Squad selection (`team_squads`) says who was **picked**; `match_appearances` says who **played**.

## Schema (migration `107_appearances.sql`, additive)
- `match_appearances` — one row per fixture + player: `status` (started / substitute_on / unused_sub / dnp), `on_clock_seconds`, `off_clock_seconds`,
  `minutes_played` (NULL = not verifiable, never a guessed 0), `minutes_basis` (match_clock / scheduled_duration / staff_entry / official_sheet),
  `source`, `authority`, `row_version`, `verified_by/at`, `archived_at`.
- `match_appearance_revisions` — every lineup, substitution, computation, correction and verification with actor and reason.
- `match_substitutions` — append-only substitution log (void with a reason), idempotent on `(fixture_id, client_key)`.

## Capabilities (REST + OpenAPI + MCP)
`set_match_lineup`, `record_substitution`, `void_substitution`, `finalize_appearances`, `correct_appearance`, `list_fixture_appearances`,
`list_appearance_revisions`, `get_player_appearances` (`GET /me/appearances`).

## Rules
- Authority: official sheet 40 > organiser/officials 30 > team manager 20 > backfill 10. A lower rank can never overwrite a higher one (409 `lower_authority`).
  Publishing a score sheet verifies the appearances (rank 40); a later organiser correction clears the verification until the next publish.
- Minutes come from the game clock (which stops with the game). No `period_end` clock falls back to the scheduled duration, labelled as such and **excluded
  from per-minute rates**. Manual and official values are never recomputed.
- Per-90 rates use only games with verified minutes; the response reports how many games were left out.
- Youth: naming or subbing on a young player needs current guardian participation consent; staff views show a hidden placeholder without consent; a young
  person reading their own record needs consent (live revocation); guardians read with an audit row.
- Corrections require `row_version` (409 `stale_version`) and a reason.
- Athlete history: a named starter/sub who came on counts; a named unused sub or DNP never does; fixtures without an appearance record keep the old inference.
- Lineups are set before kick-off; during play use substitutions; after play use `correct_appearance`.
