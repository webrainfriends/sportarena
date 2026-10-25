# Unified training and match load history (#328)

`session_loads` stays the single source of load (ACWR, readiness and shared workload all read it). Migration `113_load_history.sql` (additive) links a row to the
confirmed completed `training_sessions` row or verified `match_appearances` row it came from, and adds `session_load_revisions` (append-only history, reason encrypted).

## Rules
- Sources: a training session counts once marked `completed`; a match once the athlete has a `started`/`substitute_on` appearance in a finished fixture. Without a load record they are listed as `pending` and never counted.
- Minutes and RPE are the athlete's: a training session needs entered minutes (the plan length is not assumed); a match uses verified clock minutes or the athlete's entry; RPE is required (a session already rated by the athlete keeps that rating).
- One source = one live load (partial unique indexes). Repeating a request returns the existing record; parallel requests make one.
- A manual log on the same day must be linked (`link_session_load` or `link_load_id`) or explicitly kept `separate`, otherwise 409 `possible_duplicate`.
- Corrections need a reason and `expected_version` (409 `stale_version`); linked records keep the source's date and type; a corrected figure is no longer labelled verified. Archive instead of delete; archiving frees the source.
- Youth: sources need live guardian consent (`coaching` for training, `participation` for matches); without it numbers stay but titles/competitions are hidden and new records are refused. Guardians read with `user_id` (audit-logged).
- Staff: only through a wellness share that includes `workload`; entries show source, basis and a corrected flag, never reasons, titles or teams; the CSV export adds `loads_csv`.

## Capabilities (REST + OpenAPI + MCP)
`list_load_history` (`GET /me/load-history`), `record_load_from_source` (`POST /me/load-history/record`), `link_session_load` (`POST /me/loads/:id/link`),
`correct_session_load` (`PATCH /me/loads/:id`), `list_session_load_revisions` (`GET /me/loads/:id/revisions`); `log_session_load` now returns `possible_sources`, `archive_session_load` accepts a reason.
All are in the clinical token scope.

## Rollback
Deploy the previous code: it ignores the new columns and table; data stays.
