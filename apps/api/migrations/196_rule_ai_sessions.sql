-- Migration 196: Versioned sport rule AI sessions (#1021)
-- Additive only. No DROP, TRUNCATE or column removal.
-- Adds: rule_ai_sessions, rule_ai_turns, rule_ai_escalations, rule_pack_snapshots.

-- ── rule_ai_sessions ──────────────────────────────────────────────────────────
-- One versioned Q&A conversation per official per fixture. Anchored to the
-- governing rule pack (gov_rule_packs) that was in force when the session
-- was created: pack_id and pack_hash never change even if the season is re-pinned.
-- A previous open session for the same user+fixture is closed when a new one starts.
CREATE TABLE IF NOT EXISTS rule_ai_sessions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id            uuid        NOT NULL REFERENCES fixtures(id),
  user_id               uuid        NOT NULL REFERENCES users(id),
  sport_slug            text        NOT NULL,
  sport_format          text,                             -- NULL = default format
  -- governing pack snapshot (nullable: falls back to static book when no competition pack)
  gov_pack_id           uuid        REFERENCES gov_rule_packs(id),
  gov_pack_version      int,
  gov_pack_name         text,
  -- local rule set snapshot (nullable)
  local_rule_version_id uuid        REFERENCES local_rule_versions(id),
  local_rule_set_name   text,
  effective_date        date,                             -- pack's declared effective date
  pack_hash             text        NOT NULL,             -- standardHash at session start
  -- lifecycle
  status                text        NOT NULL DEFAULT 'open'
                                    CHECK (status IN ('open','closed')),
  turn_count            int         NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz
);

CREATE INDEX IF NOT EXISTS rule_ai_sessions_fixture_user
  ON rule_ai_sessions(fixture_id, user_id);
CREATE INDEX IF NOT EXISTS rule_ai_sessions_user
  ON rule_ai_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rule_ai_sessions_created
  ON rule_ai_sessions(created_at DESC);

-- ── rule_ai_turns ─────────────────────────────────────────────────────────────
-- Fully append-only. Each Q&A exchange in a session. citations_json holds the
-- array of citation objects exactly as resolved (no personal data).
CREATE TABLE IF NOT EXISTS rule_ai_turns (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid        NOT NULL REFERENCES rule_ai_sessions(id),
  turn_no             smallint    NOT NULL,              -- 1-based sequence within session
  question            text        NOT NULL,
  -- response: exactly one of answer/clarifying_question is non-null
  answer              text,
  clarifying_question text,
  declined            boolean     NOT NULL DEFAULT false,
  insufficient        boolean     NOT NULL DEFAULT false,
  -- citations: [{n, no, title, text, source, body, effective_date, local_change, official_url}]
  citations_json      jsonb       NOT NULL DEFAULT '[]',
  ai_used             boolean     NOT NULL DEFAULT false,
  model               text,
  input_tokens        int,
  output_tokens       int,
  rule_hash           text,                              -- standardHash at turn time
  escalated           boolean     NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, turn_no)
);

CREATE INDEX IF NOT EXISTS rule_ai_turns_session
  ON rule_ai_turns(session_id, turn_no);
CREATE INDEX IF NOT EXISTS rule_ai_turns_created
  ON rule_ai_turns(created_at DESC);

-- Append-only: prevent UPDATE and DELETE on turns (full audit trail)
CREATE OR REPLACE RULE rule_ai_turns_no_delete
  AS ON DELETE TO rule_ai_turns DO INSTEAD NOTHING;
CREATE OR REPLACE RULE rule_ai_turns_no_update
  AS ON UPDATE TO rule_ai_turns DO INSTEAD NOTHING;

-- ── rule_ai_escalations ───────────────────────────────────────────────────────
-- An official escalates a turn to a human reviewer (event organiser / assessor body).
-- resolution_note_enc uses field-level encryption (same pattern as official_reports.note).
CREATE TABLE IF NOT EXISTS rule_ai_escalations (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id              uuid        NOT NULL REFERENCES rule_ai_sessions(id),
  turn_id                 uuid        NOT NULL REFERENCES rule_ai_turns(id),
  raised_by               uuid        NOT NULL REFERENCES users(id),
  reason                  text        NOT NULL,
  -- routing: escalation goes to the event organiser by default
  event_id                uuid        NOT NULL REFERENCES events(id),
  -- optionally routed to an assessor/federation body
  routed_to_body_id       uuid        REFERENCES official_bodies(id),
  status                  text        NOT NULL DEFAULT 'open'
                                      CHECK (status IN ('open','resolved','withdrawn')),
  resolved_by             uuid        REFERENCES users(id),
  resolution_note_enc     text,
  resolution_outcome      text        CHECK (resolution_outcome IN
                                        ('confirmed','amended','deferred',NULL)),
  resolved_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rule_ai_esc_event
  ON rule_ai_escalations(event_id, status);
CREATE INDEX IF NOT EXISTS rule_ai_esc_session
  ON rule_ai_escalations(session_id);
CREATE INDEX IF NOT EXISTS rule_ai_esc_raised
  ON rule_ai_escalations(raised_by);
CREATE INDEX IF NOT EXISTS rule_ai_esc_body
  ON rule_ai_escalations(routed_to_body_id)
  WHERE routed_to_body_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS rule_ai_esc_created
  ON rule_ai_escalations(created_at DESC);

-- Prevent deletion; resolution is a targeted UPDATE to status/resolved fields only.
CREATE OR REPLACE RULE rule_ai_esc_no_delete
  AS ON DELETE TO rule_ai_escalations DO INSTEAD NOTHING;

-- ── rule_pack_snapshots ───────────────────────────────────────────────────────
-- Full-text snapshot of a resolved rule pack, cached for offline serving to the
-- mobile client. content_json holds the full resolveBook output (no personal data).
-- expires_at: the signed JWT the app receives is valid until this timestamp;
-- after expiry the app must re-fetch (the content itself is never deleted).
CREATE TABLE IF NOT EXISTS rule_pack_snapshots (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id      uuid        NOT NULL REFERENCES fixtures(id),
  user_id         uuid        NOT NULL REFERENCES users(id),
  gov_pack_id     uuid        REFERENCES gov_rule_packs(id),
  sport_slug      text        NOT NULL,
  sport_format    text,
  content_json    jsonb       NOT NULL,
  pack_hash       text        NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rule_pack_snap_fixture
  ON rule_pack_snapshots(fixture_id, user_id);
CREATE INDEX IF NOT EXISTS rule_pack_snap_expires
  ON rule_pack_snapshots(expires_at);

-- Prevent deletion (snapshots are operational records; expired ones are archived not removed)
CREATE OR REPLACE RULE rule_pack_snap_no_delete
  AS ON DELETE TO rule_pack_snapshots DO INSTEAD NOTHING;
