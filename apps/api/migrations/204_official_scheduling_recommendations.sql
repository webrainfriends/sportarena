-- Official Scheduling Recommendations — Issue #1022 (REF-R24)
-- Additive only: new tables, one new column on official_suggestion_log.
-- No DROP / TRUNCATE / data deletion.

-- Per-event scoring weight config and organizer rules
CREATE TABLE IF NOT EXISTS official_scheduling_policies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id),
  created_by       uuid NOT NULL REFERENCES users(id),
  version          int NOT NULL DEFAULT 1,
  effective_from   timestamptz NOT NULL DEFAULT now(),
  -- weight overrides (NULL = use built-in default)
  w_grade          smallint CHECK (w_grade  BETWEEN 0 AND 100),
  w_travel         smallint CHECK (w_travel BETWEEN 0 AND 100),
  w_neutral        smallint CHECK (w_neutral BETWEEN 0 AND 100),
  w_rotation       smallint CHECK (w_rotation BETWEEN 0 AND 100),
  w_cost           smallint CHECK (w_cost   BETWEEN 0 AND 100),
  w_avail          smallint CHECK (w_avail  BETWEEN 0 AND 100),
  -- organizer rules
  require_neutral          bool    NOT NULL DEFAULT false,
  max_per_official_per_day smallint,
  travel_budget_km         int,
  min_grade_rank           smallint,
  preferred_user_ids       uuid[]  NOT NULL DEFAULT '{}',
  blocked_user_ids         uuid[]  NOT NULL DEFAULT '{}',
  auto_suggest_on_publish  bool    NOT NULL DEFAULT false,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id)
);
CREATE INDEX IF NOT EXISTS idx_osp_event ON official_scheduling_policies(event_id);

-- Immutable override audit: records every time an organizer selects a lower-ranked official
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'override_category') THEN
    CREATE TYPE override_category AS ENUM (
      'local_preference',
      'budget_constraint',
      'rotation_policy',
      'special_skills',
      'other'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS official_suggestion_overrides (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_log_id   uuid NOT NULL REFERENCES official_suggestion_log(id),
  selected_user_id    uuid NOT NULL REFERENCES users(id),
  original_rank       smallint NOT NULL,
  override_category   override_category NOT NULL,
  override_reason     text NOT NULL CHECK (char_length(override_reason) >= 20),
  actor_id            uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oso_log ON official_suggestion_overrides(suggestion_log_id);
CREATE INDEX IF NOT EXISTS idx_oso_actor ON official_suggestion_overrides(actor_id);

-- Additive column: snapshot of the policy weights in effect at suggestion time
ALTER TABLE official_suggestion_log
  ADD COLUMN IF NOT EXISTS policy_snapshot jsonb;
