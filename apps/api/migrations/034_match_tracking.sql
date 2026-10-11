-- Live match tracking: an append-only log of what happened in a game, scored by the sport's ruleset, plus per-event rulesets.
-- Additive. Match events are voided, never deleted. 'finished' = full time, waiting for the score sheet to be approved and published.

ALTER TABLE fixtures DROP CONSTRAINT IF EXISTS fixtures_status_check;
ALTER TABLE fixtures ADD CONSTRAINT fixtures_status_check
  CHECK (status IN ('scheduled','live','paused','finished','completed','cancelled','postponed','abandoned'));
ALTER TABLE fixtures
  ADD COLUMN IF NOT EXISTS started_at  timestamptz,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz;

CREATE TABLE IF NOT EXISTS match_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id     uuid NOT NULL REFERENCES fixtures,
  event_id       uuid NOT NULL REFERENCES events,
  seq            int  NOT NULL,                      -- order within the game, assigned by the server
  client_key     text,                               -- lets a flaky connection resend safely
  kind           text NOT NULL,                      -- goal, point, foul, period_start …
  side           text CHECK (side IN ('home','away')),
  team_id        uuid REFERENCES teams,
  player_id      uuid REFERENCES users,
  period         int,
  clock_seconds  int CHECK (clock_seconds IS NULL OR clock_seconds >= 0),
  payload        jsonb NOT NULL DEFAULT '{}',
  recorded_by    uuid NOT NULL REFERENCES users,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  voided_at      timestamptz,
  voided_by      uuid REFERENCES users,
  void_reason    text,
  UNIQUE (fixture_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS match_events_client_key ON match_events (fixture_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS match_events_event ON match_events (event_id);

-- An organiser can replace the built-in rules for their event; the old template is archived, never deleted.
CREATE TABLE IF NOT EXISTS scoring_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  ruleset     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS scoring_templates_active ON scoring_templates (event_id) WHERE status = 'active';
