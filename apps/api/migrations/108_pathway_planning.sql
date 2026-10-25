-- Academic and sporting pathway planning (issue #335). Additive only: new tables, new nullable/defaulted columns, widened CHECK lists.
-- Nothing is dropped, rewritten or narrowed. Rollback: stop using the new tables/columns (the app ignores them); no data is removed.
-- Reuses the study bucket list (study_bucket) as the list of targets, trial bookings (events/event_entries), academic evidence, credentials,
-- passport references/videos, approved performances, enquiries and guardian consent. Free text the athlete types is encrypted (*_enc).

-- ---------------------------------------------------------------------------------------------- targets: the existing bucket list, widened
ALTER TABLE study_bucket DROP CONSTRAINT IF EXISTS study_bucket_target_type_check;
ALTER TABLE study_bucket ADD CONSTRAINT study_bucket_target_type_check
  CHECK (target_type IN ('institution','programme','study_institution','study_programme','team'));
ALTER TABLE study_bucket DROP CONSTRAINT IF EXISTS study_bucket_status_check;
ALTER TABLE study_bucket ADD CONSTRAINT study_bucket_status_check
  CHECK (status IN ('saved','shortlisted','applying','applied','offered','accepted','enrolled','declined','not_for_me'));
ALTER TABLE study_bucket ADD COLUMN IF NOT EXISTS row_version int NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------------------------- sport + academic goals
CREATE TABLE IF NOT EXISTS pathway_goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users,
  kind         text NOT NULL CHECK (kind IN ('sporting','academic')),
  sport_id     uuid REFERENCES sports,
  bucket_id    uuid REFERENCES study_bucket,
  title        text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  metric_key   text CHECK (metric_key IS NULL OR metric_key ~ '^[a-z0-9_]{1,60}$'),   -- a sport metric picked from the catalogue
  evidence     text CHECK (evidence IS NULL OR evidence IN ('approved_competition','self_reported','imported','official')),
  academic_measure text CHECK (academic_measure IS NULL OR academic_measure IN ('gpa_4','gpa_10','percentage','sat','act','ielts','toefl','credits')),
  measure      text NOT NULL DEFAULT 'number' CHECK (measure IN ('number','yes_no')),
  unit         text CHECK (unit IS NULL OR length(unit) <= 30),
  baseline     numeric,
  target       numeric,
  current      numeric,
  target_date  date,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','paused','dropped')),
  notes_enc    text,
  achieved_at  timestamptz,
  row_version  int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  CHECK (measure = 'yes_no' OR target IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS pathway_goals_user ON pathway_goals (user_id, created_at, id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pathway_goals_once ON pathway_goals (user_id, kind, lower(btrim(title)), coalesce(sport_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------------------------------- deadlines (own); trials/offer replies are read live from their source
CREATE TABLE IF NOT EXISTS pathway_deadlines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users,
  bucket_id    uuid REFERENCES study_bucket,
  kind         text NOT NULL CHECK (kind IN ('application','trial','scholarship','documents','other')),
  title        text CHECK (title IS NULL OR length(title) BETWEEN 2 AND 120),
  due_on       date NOT NULL,
  remind_days  int NOT NULL DEFAULT 7 CHECK (remind_days BETWEEN 0 AND 60),
  reminded_at  timestamptz,
  done_at      timestamptz,
  row_version  int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  CHECK (kind <> 'other' OR title IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS pathway_deadlines_user ON pathway_deadlines (user_id, due_on, id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS pathway_deadlines_remind ON pathway_deadlines (due_on) WHERE removed_at IS NULL AND done_at IS NULL AND reminded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pathway_deadlines_once ON pathway_deadlines (user_id, kind, due_on, coalesce(bucket_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(lower(btrim(title)), '')) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------------------------------- scholarships and the evidence they need
CREATE TABLE IF NOT EXISTS pathway_scholarships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users,
  bucket_id    uuid NOT NULL REFERENCES study_bucket,
  name         text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency     text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  period       text NOT NULL DEFAULT 'per_year' CHECK (period IN ('per_year','total')),
  status       text NOT NULL DEFAULT 'exploring' CHECK (status IN ('exploring','applied','awarded','declined','withdrawn')),
  due_on       date,
  notes_enc    text,
  row_version  int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  CHECK ((amount_minor IS NULL) = (currency IS NULL))
);
CREATE INDEX IF NOT EXISTS pathway_scholarships_user ON pathway_scholarships (user_id, created_at, id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pathway_scholarships_once ON pathway_scholarships (bucket_id, lower(btrim(name))) WHERE removed_at IS NULL;

-- One row per requirement; source_* is empty until the athlete attaches evidence. The evidence itself stays where it lives (never copied).
CREATE TABLE IF NOT EXISTS pathway_scholarship_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scholarship_id uuid NOT NULL REFERENCES pathway_scholarships,
  requirement    text NOT NULL CHECK (length(requirement) BETWEEN 2 AND 120),
  source_type    text CHECK (source_type IN ('academic_evidence','credential','passport_reference','passport_video','performance')),
  source_id      uuid,
  attached_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz,
  CHECK ((source_type IS NULL) = (source_id IS NULL))
);
CREATE INDEX IF NOT EXISTS pathway_scholarship_items_s ON pathway_scholarship_items (scholarship_id, created_at, id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pathway_scholarship_items_once ON pathway_scholarship_items (scholarship_id, lower(btrim(requirement))) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------------------------------- offers and the decision on them
CREATE TABLE IF NOT EXISTS pathway_offers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users,
  bucket_id      uuid NOT NULL REFERENCES study_bucket,
  scholarship_id uuid REFERENCES pathway_scholarships,
  title          text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  tuition_minor  bigint NOT NULL DEFAULT 0 CHECK (tuition_minor >= 0),
  other_minor    bigint NOT NULL DEFAULT 0 CHECK (other_minor >= 0),
  scholarship_minor bigint NOT NULL DEFAULT 0 CHECK (scholarship_minor >= 0),
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  period         text NOT NULL DEFAULT 'per_year' CHECK (period IN ('per_year','total')),
  reply_by       date,
  starts_on      date,
  conditions_enc text,
  source         text NOT NULL DEFAULT 'self_entered' CHECK (source IN ('self_entered')),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','declined','deferred')),
  decided_by     uuid REFERENCES users,
  decided_at     timestamptz,
  decision_note_enc text,
  row_version    int NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS pathway_offers_user ON pathway_offers (user_id, created_at, id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pathway_offers_once ON pathway_offers (bucket_id, lower(btrim(title))) WHERE removed_at IS NULL;
-- at most one accepted offer per target
CREATE UNIQUE INDEX IF NOT EXISTS pathway_offers_one_accepted ON pathway_offers (bucket_id) WHERE status = 'accepted' AND removed_at IS NULL;

-- ---------------------------------------------------------------------------------------------- outcome history (append-only)
CREATE TABLE IF NOT EXISTS pathway_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users,
  bucket_id  uuid REFERENCES study_bucket,
  kind       text NOT NULL CHECK (kind IN ('stage','offer_added','offer_decided','scholarship','goal')),
  from_value text,
  to_value   text,
  detail     text CHECK (detail IS NULL OR length(detail) <= 200),
  actor_id   uuid REFERENCES users,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pathway_events_user ON pathway_events (user_id, at DESC, id);
DROP TRIGGER IF EXISTS pathway_events_ao ON pathway_events;
CREATE TRIGGER pathway_events_ao BEFORE UPDATE OR DELETE ON pathway_events FOR EACH ROW EXECUTE FUNCTION academy_append_only();

-- ---------------------------------------------------------------------------------------------- who the athlete shares the plan with (live-checked on every read)
CREATE TABLE IF NOT EXISTS pathway_shares (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   uuid NOT NULL REFERENCES users,
  recipient_id uuid NOT NULL REFERENCES users,
  scopes       text[] NOT NULL CHECK (cardinality(scopes) >= 1 AND scopes <@ ARRAY['targets','goals','deadlines','scholarships','offers','outcomes']),
  created_by   uuid NOT NULL REFERENCES users,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users,
  row_version  int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (athlete_id <> recipient_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS pathway_shares_active ON pathway_shares (athlete_id, recipient_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS pathway_shares_recipient ON pathway_shares (recipient_id, created_at, id) WHERE revoked_at IS NULL;
