-- PS-13 (#843): para-sport coaching adaptations — guide assignments and para template tagging.
-- Additive only: no existing tables are modified beyond adding a nullable column.

-- Guide / assistant assignments for a session-athlete pair.
-- Only operational data lives here: who is helping, in what role, with a coach note.
-- No diagnosis, impairment code or clinical record is stored.
CREATE TABLE IF NOT EXISTS coaching_session_guides (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_record_id uuid        NOT NULL REFERENCES coaching_session_records(id),
  athlete_id        uuid        NOT NULL REFERENCES users(id),
  guide_user_id     uuid        REFERENCES users(id),          -- NULL = unnamed / external guide
  guide_role        text        NOT NULL
    CHECK (guide_role IN ('support_person', 'sighted_guide', 'tapper', 'personal_assistant')),
  note              text,                                       -- coach operational note; encrypted at application layer
  assigned_at       timestamptz NOT NULL DEFAULT now(),
  removed_at        timestamptz,
  created_by        uuid        NOT NULL REFERENCES users(id),
  UNIQUE NULLS NOT DISTINCT (session_record_id, athlete_id, guide_user_id)
);

CREATE INDEX IF NOT EXISTS coaching_session_guides_session_idx
  ON coaching_session_guides (session_record_id)
  WHERE removed_at IS NULL;

-- Para-sport template tag on existing coach_templates.
-- A template tagged here appears in the para-template picker filtered by sport family.
ALTER TABLE coach_templates
  ADD COLUMN IF NOT EXISTS para_template text
  CHECK (para_template IN (
    'wheelchair_basketball', 'wheelchair_tennis', 'para_swimming', 'para_athletics',
    'para_football', 'goalball_boccia', 'para_cycling', 'sitting_volleyball',
    'para_racket', 'generic'
  ));

CREATE INDEX IF NOT EXISTS coach_templates_para_template_idx
  ON coach_templates (para_template)
  WHERE para_template IS NOT NULL AND archived_at IS NULL;
