-- Permissioned athlete support-team collaboration (#330). Additive only: two new tables, no existing row or column is touched.
-- An athlete chooses a recipient (a coach they work with, or a physio/doctor they already gave a medical grant), a purpose, which wellness
-- fields are visible, how far back, and an end date. Access is re-derived on every read (share + coaching relationship / medical grant +
-- clinical credential + guardian consent), so revocation applies at once. Private notes are never shareable.
-- Rollback = deploy the previous code: nothing reads these tables, and the data stays.
CREATE TABLE IF NOT EXISTS wellness_shares (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     uuid NOT NULL REFERENCES users,
  recipient_id   uuid NOT NULL REFERENCES users,
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('coach','provider')),
  purpose        text NOT NULL CHECK (purpose IN ('training_load','injury_prevention','return_to_play','performance_review')),
  fields         text[] NOT NULL CHECK (cardinality(fields) BETWEEN 1 AND 7 AND fields <@ ARRAY['sleep','soreness','mood','hydration','readiness','workload','body_map']),
  history_days   integer NOT NULL CHECK (history_days BETWEEN 1 AND 365),
  expires_at     timestamptz NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (athlete_id <> recipient_id)
);
-- one live share per athlete, recipient and purpose: a repeated create can never fork the permissions
CREATE UNIQUE INDEX IF NOT EXISTS wellness_shares_live ON wellness_shares (athlete_id, recipient_id, purpose) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS wellness_shares_recipient ON wellness_shares (recipient_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS wellness_shares_athlete ON wellness_shares (athlete_id, created_at DESC);

-- append-only history the athlete (and guardian) can read: who was given what, every edit, every revoke, every view and export
CREATE TABLE IF NOT EXISTS wellness_share_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id     uuid NOT NULL REFERENCES wellness_shares,
  athlete_id   uuid NOT NULL REFERENCES users,
  recipient_id uuid NOT NULL REFERENCES users,
  actor_id     uuid REFERENCES users,
  action       text NOT NULL CHECK (action IN ('granted','updated','revoked','expired','viewed','exported')),
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wellness_share_events_share ON wellness_share_events (share_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wellness_share_events_athlete ON wellness_share_events (athlete_id, created_at DESC);
