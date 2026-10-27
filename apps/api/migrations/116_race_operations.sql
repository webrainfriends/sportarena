-- Mass-participation race & meet operations (issue #487): bib/chip, waves, courses/checkpoints, raw timing evidence, reconciliation,
-- governed race status, cutoffs, corrections/protests, classifications, awards and publications.
-- Additive only. A race is an existing multi-sport DISCIPLINE (event_disciplines), its entrants are existing event_participants + discipline_nominations,
-- and the official result is written back to the existing event_sessions / event_session_entries. Nothing here duplicates the event, the athlete or the
-- final result; these tables hold the race-day facts that did not exist before.
-- Nothing is deleted: tags, wave places, versions and publications are closed/superseded, never removed; evidence tables are append-only by trigger.
-- Rollback: stop using the capabilities (revert the code). Dropping tables is a deliberate maintainer decision, never automatic.

CREATE OR REPLACE FUNCTION race_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;

-- ---------------------------------------------------------------- marks a discipline as a race
CREATE TABLE IF NOT EXISTS race_setups (
  discipline_id uuid PRIMARY KEY REFERENCES event_disciplines,
  event_id      uuid NOT NULL REFERENCES events,
  session_id    uuid REFERENCES event_sessions,                 -- the canonical result session the published results are written to
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS race_setups_event ON race_setups (event_id);

-- ---------------------------------------------------------------- pinned, versioned race policy (what a result was computed under)
CREATE TABLE IF NOT EXISTS race_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  version       int  NOT NULL CHECK (version >= 1),
  rules         jsonb NOT NULL,
  note          text CHECK (note IS NULL OR length(note) <= 500),
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (discipline_id, version)
);
DROP TRIGGER IF EXISTS race_policies_append_only ON race_policies;
CREATE TRIGGER race_policies_append_only BEFORE UPDATE OR DELETE ON race_policies FOR EACH ROW EXECUTE FUNCTION race_append_only();

-- ---------------------------------------------------------------- classifications declared by the organiser (never inferred from a name or a photo)
CREATE TABLE IF NOT EXISTS race_categories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id   uuid NOT NULL REFERENCES event_disciplines,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind            text NOT NULL DEFAULT 'age_group' CHECK (kind IN ('age_group','open','para','custom')),
  gender_rule     text NOT NULL DEFAULT 'any' CHECK (gender_rule IN ('any','male','female')),
  eligibility_ref text CHECK (eligibility_ref IS NULL OR length(eligibility_ref) <= 120),   -- the rule/registration the category comes from, e.g. "Masters 40-44 (federation rule 12)"
  award_depth     int  CHECK (award_depth IS NULL OR award_depth BETWEEN 0 AND 50),            -- NULL = policy default
  archived_at     timestamptz,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS race_categories_name ON race_categories (discipline_id, lower(name)) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------- waves / corrals / start groups
CREATE TABLE IF NOT EXISTS race_waves (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  position      int  NOT NULL DEFAULT 1,
  start_at      timestamptz NOT NULL,                              -- scheduled start
  gun_at        timestamptz,                                       -- the gun time actually recorded by an official
  capacity      int  NOT NULL CHECK (capacity BETWEEN 1 AND 100000),
  basis         text NOT NULL DEFAULT 'organiser' CHECK (basis IN ('category','seed','accessibility','team','organiser')),
  basis_note    text CHECK (basis_note IS NULL OR length(basis_note) <= 200),   -- seed/reference basis, e.g. "predicted finish under 45:00 (10 km PB)"
  category_id   uuid REFERENCES race_categories,                   -- wave reserved for one declared category (basis 'category')
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','started','cancelled')),
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS race_waves_name ON race_waves (discipline_id, lower(name)) WHERE status <> 'cancelled';

-- ---------------------------------------------------------------- entrants (extend the canonical nomination; one row per person per race)
CREATE TABLE IF NOT EXISTS race_entrants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  event_id      uuid NOT NULL REFERENCES events,
  participant_id uuid NOT NULL REFERENCES event_participants,
  nomination_id uuid NOT NULL REFERENCES discipline_nominations,
  category_id   uuid REFERENCES race_categories,
  wave_id       uuid REFERENCES race_waves,                        -- current wave (history: race_wave_assignments)
  race_status   text NOT NULL DEFAULT 'registered' CHECK (length(race_status) BETWEEN 1 AND 24),
  status_locked boolean NOT NULL DEFAULT false,                    -- set by a governed decision (dns/dnf/dq/cutoff/...); timing reads never override it
  source        text NOT NULL DEFAULT 'organiser' CHECK (source IN ('organiser','self','import','team','guest')),
  external_ref  text CHECK (external_ref IS NULL OR length(external_ref) BETWEEN 1 AND 60),   -- the registration system's id; makes imports idempotent
  name_public   boolean NOT NULL DEFAULT false,                    -- the entrant (or guardian) agreed to a public name; never true for a young account holder
  created_by    uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (discipline_id, participant_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS race_entrants_ext ON race_entrants (discipline_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS race_entrants_wave ON race_entrants (discipline_id, wave_id);
CREATE INDEX IF NOT EXISTS race_entrants_page ON race_entrants (discipline_id, created_at, id);
CREATE INDEX IF NOT EXISTS race_entrants_status ON race_entrants (discipline_id, race_status);

CREATE TABLE IF NOT EXISTS race_wave_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entrant_id  uuid NOT NULL REFERENCES race_entrants,
  wave_id     uuid NOT NULL REFERENCES race_waves,
  reason      text CHECK (reason IS NULL OR length(reason) <= 200),
  actor_id    uuid REFERENCES users,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  notified_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS race_wave_assignments_open ON race_wave_assignments (entrant_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS race_wave_assignments_wave ON race_wave_assignments (wave_id) WHERE ended_at IS NULL;

-- ---------------------------------------------------------------- bibs and timing chips, with full reissue history
-- scope_key: the discipline (or the whole event, per policy) for bibs; always the event for chips, because a transponder is a physical object.
CREATE TABLE IF NOT EXISTS race_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entrant_id  uuid NOT NULL REFERENCES race_entrants,
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  event_id    uuid NOT NULL REFERENCES events,
  kind        text NOT NULL CHECK (kind IN ('bib','chip')),
  ref         text NOT NULL CHECK (length(ref) BETWEEN 1 AND 40),
  scope_key   uuid NOT NULL,
  state       text NOT NULL DEFAULT 'active' CHECK (state IN ('active','replaced','lost','damaged','released')),
  reason      text CHECK (reason IS NULL OR length(reason) <= 200),
  from_at     timestamptz NOT NULL DEFAULT now(),
  to_at       timestamptz,
  actor_id    uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'active') = (to_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS race_assignments_live_ref ON race_assignments (scope_key, kind, lower(ref)) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS race_assignments_live_entrant ON race_assignments (entrant_id, kind) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS race_assignments_ref ON race_assignments (event_id, kind, lower(ref), from_at);
CREATE INDEX IF NOT EXISTS race_assignments_entrant ON race_assignments (entrant_id, kind, from_at);

-- ---------------------------------------------------------------- course / checkpoint model (versioned competition timing metadata, not navigation)
CREATE TABLE IF NOT EXISTS race_courses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id  uuid NOT NULL REFERENCES event_disciplines,
  version        int  NOT NULL CHECK (version >= 1),
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  unit           text NOT NULL DEFAULT 'km' CHECK (unit IN ('km','mi','m')),
  total_distance_m numeric NOT NULL CHECK (total_distance_m > 0),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  notes          text CHECK (notes IS NULL OR length(notes) <= 500),
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_by   uuid REFERENCES users,
  published_at   timestamptz,
  UNIQUE (discipline_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS race_courses_published ON race_courses (discipline_id) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS race_checkpoints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   uuid NOT NULL REFERENCES race_courses,
  seq         int  NOT NULL CHECK (seq >= 1),
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,16}$'),
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  kind        text NOT NULL CHECK (kind IN ('start','split','lap','finish')),
  distance_m  numeric NOT NULL CHECK (distance_m >= 0),
  read_rule   text NOT NULL DEFAULT 'first' CHECK (read_rule IN ('first','last')),     -- which of several reads inside the duplicate window counts
  cutoff_s    int  CHECK (cutoff_s IS NULL OR cutoff_s > 0),                           -- seconds after the policy cutoff basis (gun or net)
  UNIQUE (course_id, seq),
  UNIQUE (course_id, code)
);
-- a published course and its checkpoints are immutable; only retiring the course is allowed
CREATE OR REPLACE FUNCTION race_course_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'courses are never deleted'; END IF;
  IF OLD.status <> 'draft' AND (NEW.version, NEW.name, NEW.unit, NEW.total_distance_m, NEW.discipline_id) IS DISTINCT FROM (OLD.version, OLD.name, OLD.unit, OLD.total_distance_m, OLD.discipline_id) THEN
    RAISE EXCEPTION 'a published course is immutable; publish a new version';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS race_courses_guard ON race_courses;
CREATE TRIGGER race_courses_guard BEFORE UPDATE OR DELETE ON race_courses FOR EACH ROW EXECUTE FUNCTION race_course_guard();
CREATE OR REPLACE FUNCTION race_checkpoint_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM race_courses WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.course_id ELSE OLD.course_id END;
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'checkpoints are never edited or deleted; create a new course version'; END IF;
  IF st <> 'draft' THEN RAISE EXCEPTION 'checkpoints of a published course are immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS race_checkpoints_guard ON race_checkpoints;
CREATE TRIGGER race_checkpoints_guard BEFORE INSERT OR UPDATE OR DELETE ON race_checkpoints FOR EACH ROW EXECUTE FUNCTION race_checkpoint_guard();

-- ---------------------------------------------------------------- timing sources and raw evidence
CREATE TABLE IF NOT EXISTS race_sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id  uuid NOT NULL REFERENCES event_disciplines,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind           text NOT NULL CHECK (kind IN ('chip_reads','checkpoint_scan','manual_official','batch_file','finish_system')),
  integration    text NOT NULL DEFAULT 'file_import' CHECK (integration IN ('file_import','manual')),   -- only integrations with a tested adapter exist; vendor names are labels
  provider_label text CHECK (provider_label IS NULL OR length(provider_label) <= 80),
  device_ref     text CHECK (device_ref IS NULL OR length(device_ref) <= 80),
  clock_offset_ms int NOT NULL DEFAULT 0 CHECK (clock_offset_ms BETWEEN -3600000 AND 3600000),            -- declared device clock error: added to the observed time when reconciling; the raw record is never changed
  retired_at     timestamptz,
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS race_sources_name ON race_sources (discipline_id, lower(name)) WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS race_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  source_id     uuid NOT NULL REFERENCES race_sources,
  content_hash  text NOT NULL,
  label         text CHECK (label IS NULL OR length(label) <= 120),
  rows_received int NOT NULL,
  rows_accepted int NOT NULL,
  rows_duplicate int NOT NULL,
  rows_rejected int NOT NULL,
  rejects       jsonb NOT NULL DEFAULT '[]',
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, content_hash)
);
DROP TRIGGER IF EXISTS race_imports_append_only ON race_imports;
CREATE TRIGGER race_imports_append_only BEFORE UPDATE OR DELETE ON race_imports FOR EACH ROW EXECUTE FUNCTION race_append_only();

CREATE TABLE IF NOT EXISTS race_reads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  source_id     uuid NOT NULL REFERENCES race_sources,
  import_id     uuid REFERENCES race_imports DEFERRABLE INITIALLY DEFERRED,   -- the import row is written after its reads, in the same transaction
  dedupe_key    text NOT NULL,                                     -- source-supplied reference, or a hash of the record; the same record twice is stored once
  chip_ref      text CHECK (chip_ref IS NULL OR length(chip_ref) <= 40),
  bib_ref       text CHECK (bib_ref IS NULL OR length(bib_ref) <= 40),
  checkpoint_code text NOT NULL CHECK (checkpoint_code ~ '^[A-Z0-9_-]{1,16}$'),
  observed_at   timestamptz NOT NULL,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  sequence      text CHECK (sequence IS NULL OR length(sequence) <= 40),
  device        text CHECK (device IS NULL OR length(device) <= 80),
  origin        text NOT NULL DEFAULT 'import' CHECK (origin IN ('import','manual_official','correction')),
  raw           jsonb NOT NULL DEFAULT '{}',
  entered_by    uuid REFERENCES users,
  CHECK (chip_ref IS NOT NULL OR bib_ref IS NOT NULL),
  UNIQUE (source_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS race_reads_chip ON race_reads (discipline_id, lower(chip_ref));
CREATE INDEX IF NOT EXISTS race_reads_bib ON race_reads (discipline_id, lower(bib_ref));
CREATE INDEX IF NOT EXISTS race_reads_time ON race_reads (discipline_id, observed_at, id);
CREATE INDEX IF NOT EXISTS race_reads_import ON race_reads (import_id);
DROP TRIGGER IF EXISTS race_reads_append_only ON race_reads;
CREATE TRIGGER race_reads_append_only BEFORE UPDATE OR DELETE ON race_reads FOR EACH ROW EXECUTE FUNCTION race_append_only();

-- A read is never edited or deleted. An official can void it, restore it, or link it to an entrant; the latest mark of each kind counts.
CREATE TABLE IF NOT EXISTS race_read_marks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  read_id       uuid NOT NULL REFERENCES race_reads,
  kind          text NOT NULL CHECK (kind IN ('void','restore','link')),
  entrant_id    uuid REFERENCES race_entrants,
  correction_id uuid,
  actor_id      uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'link') = (entrant_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS race_read_marks_read ON race_read_marks (read_id, kind, created_at, id);
CREATE INDEX IF NOT EXISTS race_read_marks_disc ON race_read_marks (discipline_id);
DROP TRIGGER IF EXISTS race_read_marks_append_only ON race_read_marks;
CREATE TRIGGER race_read_marks_append_only BEFORE UPDATE OR DELETE ON race_read_marks FOR EACH ROW EXECUTE FUNCTION race_append_only();

-- ---------------------------------------------------------------- corrections and protests (a protest is a canonical dispute case; this row is the race side of it)
CREATE TABLE IF NOT EXISTS race_protests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  entrant_id    uuid NOT NULL REFERENCES race_entrants,
  case_id       uuid NOT NULL REFERENCES cases,
  filed_by      uuid NOT NULL REFERENCES users,
  result_id     uuid,                                              -- the result version being protested
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','rejected','withdrawn')),
  decided_by    uuid REFERENCES users,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS race_protests_disc ON race_protests (discipline_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS race_protests_case ON race_protests (case_id);

CREATE TABLE IF NOT EXISTS race_corrections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  entrant_id    uuid NOT NULL REFERENCES race_entrants,
  kind          text NOT NULL CHECK (kind IN ('manual_read','void_read','restore_read','link_read','adjustment','use_gun_time','status','recompute')),
  payload       jsonb NOT NULL DEFAULT '{}',
  reason_enc    text NOT NULL,
  evidence_read_ids uuid[] NOT NULL DEFAULT '{}',
  protest_id    uuid REFERENCES race_protests,
  state         text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','approved','rejected','withdrawn')),
  proposed_by   uuid NOT NULL REFERENCES users,
  decided_by    uuid REFERENCES users,
  decided_at    timestamptz,
  decision_enc  text,
  applied_result_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS race_corrections_disc ON race_corrections (discipline_id, state, created_at);
CREATE INDEX IF NOT EXISTS race_corrections_entrant ON race_corrections (entrant_id, created_at);

-- ---------------------------------------------------------------- derived official results (versioned; raw evidence stays in race_reads)
CREATE TABLE IF NOT EXISTS race_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  entrant_id    uuid NOT NULL REFERENCES race_entrants,
  version       int  NOT NULL CHECK (version >= 1),
  race_status   text NOT NULL,
  start_at      timestamptz,                                       -- chip start (net clock)
  finish_at     timestamptz,
  gun_at        timestamptz,
  gun_time_ms   bigint,
  net_time_ms   bigint,
  adjustment_ms bigint NOT NULL DEFAULT 0,
  official_time_ms bigint,
  basis_used    text CHECK (basis_used IN ('gun','net')),
  splits        jsonb NOT NULL DEFAULT '[]',
  flags         text[] NOT NULL DEFAULT '{}',
  read_ids      uuid[] NOT NULL DEFAULT '{}',
  policy_version int NOT NULL,
  course_version int,
  digest        text NOT NULL,
  superseded_at timestamptz,
  created_by    uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entrant_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS race_results_current ON race_results (entrant_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS race_results_rank ON race_results (discipline_id, official_time_ms) WHERE superseded_at IS NULL;
-- only the supersede marker may change
CREATE OR REPLACE FUNCTION race_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'race results are never deleted'; END IF;
  IF OLD.superseded_at IS NOT NULL OR (to_jsonb(NEW) - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at') THEN
    RAISE EXCEPTION 'a race result version is immutable; a correction creates a new version';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS race_results_guard ON race_results;
CREATE TRIGGER race_results_guard BEFORE UPDATE OR DELETE ON race_results FOR EACH ROW EXECUTE FUNCTION race_result_guard();

CREATE TABLE IF NOT EXISTS race_exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  entrant_id    uuid REFERENCES race_entrants,
  read_id       uuid REFERENCES race_reads,
  kind          text NOT NULL CHECK (kind IN ('duplicate_read','multiple_reads','missing_read','out_of_order','unknown_chip','stale_chip','ambiguous_read','no_gun_time','no_start_read','negative_time','status_conflict','needs_review')),
  checkpoint_code text,
  detail        jsonb NOT NULL DEFAULT '{}',
  state         text NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved')),
  resolution    text CHECK (resolution IN ('auto_cleared','reviewed','corrected','accepted')),
  resolved_by   uuid REFERENCES users,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- one open exception per subject: re-running reconciliation refreshes it instead of piling up duplicates
CREATE UNIQUE INDEX IF NOT EXISTS race_exceptions_open_entrant ON race_exceptions (discipline_id, entrant_id, kind, coalesce(checkpoint_code, '')) WHERE state = 'open' AND entrant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS race_exceptions_open_read ON race_exceptions (discipline_id, read_id, kind) WHERE state = 'open' AND entrant_id IS NULL;
CREATE INDEX IF NOT EXISTS race_exceptions_disc ON race_exceptions (discipline_id, state, kind);

-- ---------------------------------------------------------------- governed race status history
CREATE TABLE IF NOT EXISTS race_status_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entrant_id  uuid NOT NULL REFERENCES race_entrants,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  source      text NOT NULL CHECK (source IN ('official','timing','medical','protest','entrant','organiser','system')),
  reason_enc  text,
  evidence    jsonb NOT NULL DEFAULT '{}',
  actor_id    uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS race_status_log_entrant ON race_status_log (entrant_id, created_at, id);
DROP TRIGGER IF EXISTS race_status_log_append_only ON race_status_log;
CREATE TRIGGER race_status_log_append_only BEFORE UPDATE OR DELETE ON race_status_log FOR EACH ROW EXECUTE FUNCTION race_append_only();

-- ---------------------------------------------------------------- cutoffs: missing evidence (no_evidence) is never the same as a confirmed failure (missed)
CREATE TABLE IF NOT EXISTS race_cutoffs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  entrant_id    uuid NOT NULL REFERENCES race_entrants,
  checkpoint_id uuid NOT NULL REFERENCES race_checkpoints,
  course_version int NOT NULL,
  policy_version int NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('passed','missed','no_evidence')),
  elapsed_ms    bigint,
  cutoff_ms     bigint NOT NULL,
  review        text NOT NULL DEFAULT 'none' CHECK (review IN ('none','pending','confirmed','waived')),
  reviewed_by   uuid REFERENCES users,
  reviewed_at   timestamptz,
  note_enc      text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entrant_id, checkpoint_id)
);
CREATE INDEX IF NOT EXISTS race_cutoffs_review ON race_cutoffs (discipline_id, review) WHERE review = 'pending';

-- ---------------------------------------------------------------- reconciliation runs (resumable, idempotent batches)
CREATE TABLE IF NOT EXISTS race_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  entrants      int NOT NULL,
  changed       int NOT NULL,
  exceptions    int NOT NULL,
  policy_version int NOT NULL,
  rules_digest  text,                                              -- digest of the rules that change how times are computed (not of display settings)
  course_version int,
  reads_seen    int NOT NULL,
  started_by    uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS race_runs_disc ON race_runs (discipline_id, created_at DESC);

-- ---------------------------------------------------------------- publications: what the public saw, frozen (provisional -> final -> corrected)
CREATE TABLE IF NOT EXISTS race_publications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  version       int  NOT NULL CHECK (version >= 1),
  label         text NOT NULL CHECK (label IN ('provisional','final','corrected')),
  policy_version int NOT NULL,
  course_version int,
  entrants      int NOT NULL,
  finishers     int NOT NULL,
  provenance    jsonb NOT NULL DEFAULT '{}',
  note          text CHECK (note IS NULL OR length(note) <= 500),
  published_by  uuid NOT NULL REFERENCES users,
  published_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (discipline_id, version)
);
DROP TRIGGER IF EXISTS race_publications_append_only ON race_publications;
CREATE TRIGGER race_publications_append_only BEFORE UPDATE OR DELETE ON race_publications FOR EACH ROW EXECUTE FUNCTION race_append_only();

CREATE TABLE IF NOT EXISTS race_published_results (
  publication_id uuid NOT NULL REFERENCES race_publications,
  entrant_id     uuid NOT NULL REFERENCES race_entrants,
  result_id      uuid NOT NULL REFERENCES race_results,
  bib_no         text,
  race_status    text NOT NULL,
  official_time_ms bigint,
  gun_time_ms    bigint,
  net_time_ms    bigint,
  rank_overall   int,
  rank_gender    int,
  rank_category  int,
  tied           boolean NOT NULL DEFAULT false,
  category_id    uuid REFERENCES race_categories,
  gender         text,
  house_id       uuid,
  splits         jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (publication_id, entrant_id)
);
CREATE INDEX IF NOT EXISTS race_published_rank ON race_published_results (publication_id, rank_overall);
CREATE INDEX IF NOT EXISTS race_published_bib ON race_published_results (publication_id, lower(bib_no));
DROP TRIGGER IF EXISTS race_published_results_append_only ON race_published_results;
CREATE TRIGGER race_published_results_append_only BEFORE UPDATE OR DELETE ON race_published_results FOR EACH ROW EXECUTE FUNCTION race_append_only();

CREATE TABLE IF NOT EXISTS race_awards (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid NOT NULL REFERENCES race_publications,
  classification text NOT NULL,                                    -- overall | gender:male | category:<id> | team
  class_label    text NOT NULL,
  rank           int  NOT NULL,
  entrant_id     uuid REFERENCES race_entrants,
  house_id       uuid REFERENCES event_houses,
  time_ms        bigint,
  tied           boolean NOT NULL DEFAULT false,
  CHECK ((entrant_id IS NULL) <> (house_id IS NULL))
);
CREATE INDEX IF NOT EXISTS race_awards_pub ON race_awards (publication_id, classification, rank);
DROP TRIGGER IF EXISTS race_awards_append_only ON race_awards;
CREATE TRIGGER race_awards_append_only BEFORE UPDATE OR DELETE ON race_awards FOR EACH ROW EXECUTE FUNCTION race_append_only();

-- ---------------------------------------------------------------- one append-only log for the governed changes that have no table of their own
CREATE TABLE IF NOT EXISTS race_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  entrant_id    uuid REFERENCES race_entrants,
  subject       text NOT NULL CHECK (subject IN ('wave','cutoff','entrant','category','course','import','publication','policy')),
  subject_id    uuid,
  action        text NOT NULL,
  before        jsonb,
  after         jsonb,
  actor_id      uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS race_log_disc ON race_log (discipline_id, created_at, id);
CREATE INDEX IF NOT EXISTS race_log_subject ON race_log (subject, subject_id, created_at);
DROP TRIGGER IF EXISTS race_log_append_only ON race_log;
CREATE TRIGGER race_log_append_only BEFORE UPDATE OR DELETE ON race_log FOR EACH ROW EXECUTE FUNCTION race_append_only();
