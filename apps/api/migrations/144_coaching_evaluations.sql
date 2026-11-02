-- Coaching evaluations: a coach's structured assessment of one athlete on an evaluation sheet (a rubric: criteria grouped by pillar, weighted, with
-- behaviour anchors), shared with the athlete (or a young person's guardian), who adds a self-assessment, responds and acknowledges; coach and athlete
-- talk it through in a thread and the coach closes it. Each share freezes an immutable numbered version. Additive only: nothing is dropped or narrowed.
CREATE TABLE IF NOT EXISTS coaching_evaluations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id        uuid NOT NULL REFERENCES users(id),
  athlete_id      uuid NOT NULL REFERENCES users(id),
  sport_id        uuid REFERENCES sports(id),
  rubric_id       uuid NOT NULL REFERENCES coaching_rubrics(id),
  rubric_version  int  NOT NULL,
  context_type    text NOT NULL DEFAULT 'period' CHECK (context_type IN ('class','session','period','match','trial','custom')),
  class_id        uuid REFERENCES coach_classes(id),
  session_record_id uuid REFERENCES coaching_session_records(id),
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  period_from     date,
  period_to       date,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','shared','responded','closed')),
  scores          jsonb NOT NULL DEFAULT '{}',          -- criterion key -> {score, comment, evidence[]}
  narrative       jsonb NOT NULL DEFAULT '{}',          -- strengths, development, cues, next_steps (shared) and private (coach only)
  self_requested  boolean NOT NULL DEFAULT false,
  self_scores     jsonb NOT NULL DEFAULT '{}',          -- the athlete's own score and comment per criterion
  self_submitted_at timestamptz,
  response        jsonb NOT NULL DEFAULT '{}',          -- reactions per criterion (agree/discuss/disagree), overall comment, questions
  responded_at    timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id),
  latest_version  int  NOT NULL DEFAULT 0,
  shared_at       timestamptz,
  closed_at       timestamptz,
  row_version     int  NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (coach_id <> athlete_id),
  CHECK (period_from IS NULL OR period_to IS NULL OR period_to >= period_from)
);
CREATE INDEX IF NOT EXISTS coaching_evaluations_coach ON coaching_evaluations (coach_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS coaching_evaluations_athlete ON coaching_evaluations (athlete_id, status);

CREATE TABLE IF NOT EXISTS coaching_evaluation_versions (
  evaluation_id   uuid NOT NULL REFERENCES coaching_evaluations(id),
  version         int  NOT NULL,
  snapshot        jsonb NOT NULL,
  snapshot_sha256 text NOT NULL,
  published_by    uuid NOT NULL REFERENCES users(id),
  published_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (evaluation_id, version)
);
CREATE TABLE IF NOT EXISTS coaching_evaluation_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id   uuid NOT NULL REFERENCES coaching_evaluations(id),
  author_id       uuid NOT NULL REFERENCES users(id),
  author_role     text NOT NULL CHECK (author_role IN ('coach','athlete','guardian')),
  criterion_key   text,
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coaching_evaluation_messages_eval ON coaching_evaluation_messages (evaluation_id, created_at);

CREATE OR REPLACE FUNCTION coaching_evaluation_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only: add a new row instead', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS coaching_evaluation_versions_append ON coaching_evaluation_versions;
CREATE TRIGGER coaching_evaluation_versions_append BEFORE UPDATE OR DELETE ON coaching_evaluation_versions FOR EACH ROW EXECUTE FUNCTION coaching_evaluation_append_only();
DROP TRIGGER IF EXISTS coaching_evaluation_messages_append ON coaching_evaluation_messages;
CREATE TRIGGER coaching_evaluation_messages_append BEFORE UPDATE OR DELETE ON coaching_evaluation_messages FOR EACH ROW EXECUTE FUNCTION coaching_evaluation_append_only();
