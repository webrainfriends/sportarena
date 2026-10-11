-- Worker health (#61). Additive: one row per worker process, updated on every beat. Rows are kept (status flips to 'stopped').
CREATE TABLE worker_heartbeats (
  worker_id     text PRIMARY KEY,                     -- <pid>-<random>, unique per process start
  mode          text NOT NULL CHECK (mode IN ('inprocess','external')),
  host          text,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running','stopping','stopped')),
  interval_seconds int NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  last_beat_at  timestamptz NOT NULL DEFAULT now(),
  last_cycle_at timestamptz,
  last_cycle_ms int,
  cycles        bigint NOT NULL DEFAULT 0,
  failed_cycles bigint NOT NULL DEFAULT 0,
  last_error    text,
  stats         jsonb NOT NULL DEFAULT '{}'           -- per-category last run, attempts and failures (no payloads)
);
CREATE INDEX worker_heartbeats_beat ON worker_heartbeats (last_beat_at DESC);
