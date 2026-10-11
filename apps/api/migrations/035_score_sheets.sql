-- Score sheets: the referee submits, both team managers sign (or dispute), the organiser approves, and only publishing writes the result
-- that standings use. Corrections after publishing are new versions. Additive; nothing is deleted, every step is in score_sheet_log.

CREATE TABLE IF NOT EXISTS score_sheets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id     uuid NOT NULL REFERENCES fixtures,
  event_id       uuid NOT NULL REFERENCES events,
  version        int  NOT NULL DEFAULT 1,
  round          int  NOT NULL DEFAULT 1,              -- bumps each time a rejected sheet is submitted again; sign-offs belong to a round
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','published','superseded')),
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('match_log','manual','revision')),
  home_score     int CHECK (home_score IS NULL OR home_score >= 0),
  away_score     int CHECK (away_score IS NULL OR away_score >= 0),
  winner_team_id uuid REFERENCES teams,
  totals         jsonb NOT NULL DEFAULT '{}',          -- sets, periods and tracked parameters, as computed from the match log or entered
  adjusted_reason text,                                -- why the sheet differs from what the match log computed
  notes          text,
  anomalies      jsonb NOT NULL DEFAULT '[]',          -- deterministic checks run at submission
  waived_reason  text,                                 -- organiser approved without every sign-off
  rejected_reason text,
  revises_id     uuid REFERENCES score_sheets,
  revision_reason text,
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  submitted_by   uuid REFERENCES users, submitted_at timestamptz,
  approved_by    uuid REFERENCES users, approved_at  timestamptz,
  rejected_by    uuid REFERENCES users, rejected_at  timestamptz,
  published_by   uuid REFERENCES users, published_at timestamptz,
  UNIQUE (fixture_id, version)
);
-- at most one sheet is being worked on per game; published ones stay as the record
CREATE UNIQUE INDEX IF NOT EXISTS score_sheets_open ON score_sheets (fixture_id) WHERE status IN ('draft','submitted','approved','rejected');
CREATE UNIQUE INDEX IF NOT EXISTS score_sheets_published ON score_sheets (fixture_id) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS score_sheets_event ON score_sheets (event_id, status);

CREATE TABLE IF NOT EXISTS score_sheet_signoffs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id   uuid NOT NULL REFERENCES score_sheets,
  round      int  NOT NULL,
  role       text NOT NULL CHECK (role IN ('referee','home_manager','away_manager')),
  user_id    uuid NOT NULL REFERENCES users,
  decision   text NOT NULL CHECK (decision IN ('signed','disputed')),
  comment    text,
  at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sheet_id, round, role)
);

CREATE TABLE IF NOT EXISTS score_sheet_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id    uuid NOT NULL REFERENCES score_sheets,
  actor_id    uuid NOT NULL REFERENCES users,
  action      text NOT NULL,
  from_status text,
  to_status   text,
  note        text,
  snapshot    jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS score_sheet_log_sheet ON score_sheet_log (sheet_id, at);
