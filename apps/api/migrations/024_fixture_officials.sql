-- Official assignment lifecycle for fixtures (issue #88). Additive only.
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS duration_min int NOT NULL DEFAULT 90 CHECK (duration_min BETWEEN 10 AND 600);

CREATE TABLE IF NOT EXISTS fixture_officials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id   uuid NOT NULL REFERENCES fixtures(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  role         text NOT NULL CHECK (role IN ('referee','umpire','linesman','scorer')),
  status       text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','accepted','declined','withdrawn','released','cancelled','completed')),
  needs_ack    boolean NOT NULL DEFAULT false,
  reason       text,
  requested_by uuid REFERENCES users(id),
  responded_at timestamptz,
  ended_at     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fixture_officials_one_open ON fixture_officials(fixture_id, user_id, role) WHERE status IN ('invited','accepted');
CREATE INDEX IF NOT EXISTS fixture_officials_user ON fixture_officials(user_id, status);

-- Append-only: who was originally assigned and every transition is preserved.
CREATE TABLE IF NOT EXISTS fixture_official_history (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_official_id uuid NOT NULL REFERENCES fixture_officials(id),
  actor_id            uuid REFERENCES users(id),
  from_status         text,
  to_status           text NOT NULL,
  reason              text,
  at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixture_official_history_fo ON fixture_official_history(fixture_official_id, at);

-- Backfill: existing fixture referees become accepted assignments (no data lost, same meaning).
INSERT INTO fixture_officials(fixture_id, user_id, role, status, responded_at)
SELECT f.id, f.referee_id, 'referee', CASE WHEN f.status='completed' THEN 'completed' WHEN f.status='cancelled' THEN 'cancelled' ELSE 'accepted' END, now()
  FROM fixtures f WHERE f.referee_id IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO fixture_official_history(fixture_official_id, to_status, reason)
SELECT id, status, 'backfilled from fixtures.referee_id' FROM fixture_officials fo
 WHERE NOT EXISTS (SELECT 1 FROM fixture_official_history h WHERE h.fixture_official_id=fo.id);
