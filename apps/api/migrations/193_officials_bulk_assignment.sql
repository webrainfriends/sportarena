-- Migration 193: Bulk assignment board, shortlists, suggestion log, swap history (Issue #1005 / R13)
-- All additive; no existing data dropped or narrowed.

-- Pool of officials shortlisted for a fixture-role but not yet formally invited.
CREATE TABLE IF NOT EXISTS official_shortlists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id      uuid NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  role            text NOT NULL,
  shortlisted_by  uuid NOT NULL REFERENCES users(id),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  UNIQUE (fixture_id, user_id, role)
);
CREATE INDEX IF NOT EXISTS official_shortlists_fixture ON official_shortlists(fixture_id);
CREATE INDEX IF NOT EXISTS official_shortlists_user   ON official_shortlists(user_id);

-- Immutable log of every AI/rule suggestion with its score breakdown.
CREATE TABLE IF NOT EXISTS official_suggestion_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid REFERENCES events(id),
  fixture_id     uuid REFERENCES fixtures(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  role           text NOT NULL,
  score          int NOT NULL,
  score_grade    int NOT NULL DEFAULT 0,
  score_travel   int NOT NULL DEFAULT 0,
  score_neutral  int NOT NULL DEFAULT 0,
  score_rotation int NOT NULL DEFAULT 0,
  score_cost     int NOT NULL DEFAULT 0,
  score_avail    int NOT NULL DEFAULT 0,
  reasons        jsonb NOT NULL DEFAULT '{}',
  queried_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS official_suggestion_log_fixture ON official_suggestion_log(fixture_id);
CREATE INDEX IF NOT EXISTS official_suggestion_log_event   ON official_suggestion_log(event_id);

-- Swap history: every drag-swap or manual reassignment across fixtures.
CREATE TABLE IF NOT EXISTS official_swap_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_fo_id      uuid REFERENCES fixture_officials(id),
  to_fo_id        uuid REFERENCES fixture_officials(id),
  user_id         uuid NOT NULL REFERENCES users(id),  -- the official being moved
  actor_id        uuid NOT NULL REFERENCES users(id),  -- organiser who performed the swap
  from_fixture_id uuid REFERENCES fixtures(id),
  to_fixture_id   uuid REFERENCES fixtures(id),
  role            text,
  override_reason text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Bulk invite batch header: groups individual fixture_officials rows sent in one operation.
CREATE TABLE IF NOT EXISTS official_bulk_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id),
  role         text NOT NULL,
  message      text,
  fee_minor    int,
  fee_currency char(3),
  sent_by      uuid NOT NULL REFERENCES users(id),
  fixture_ids  uuid[] NOT NULL,
  user_ids     uuid[] NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  invite_count int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS official_bulk_batches_event ON official_bulk_batches(event_id);

-- Link individual fixture_officials to the batch that created them.
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS bulk_batch_id uuid REFERENCES official_bulk_batches(id);
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS shortlist_id  uuid REFERENCES official_shortlists(id);
