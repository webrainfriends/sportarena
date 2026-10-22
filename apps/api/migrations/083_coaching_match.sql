-- Coaching completion, part E (issue #269). Additive only.
-- Match preparation lives beside the session record of a fixture; the fixture, its score and its events stay canonical and are only referenced.
CREATE TABLE coaching_match_prep (
  session_record_id uuid PRIMARY KEY REFERENCES coaching_session_records,
  opponent_notes text CHECK (length(opponent_notes) <= 4000),
  checklist  jsonb NOT NULL DEFAULT '[]',     -- [{id, text, done}]
  objectives jsonb NOT NULL DEFAULT '[]',     -- [{id, text, indicator?: {metric, kind?, comparator, target}}]
  row_version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- A bookmark points at an official match event; it never copies or changes it. Removing a bookmark keeps the row.
CREATE TABLE coaching_event_bookmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_record_id uuid NOT NULL REFERENCES coaching_session_records,
  match_event_id uuid NOT NULL REFERENCES match_events,
  athlete_id uuid REFERENCES users,
  note text CHECK (length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  UNIQUE (session_record_id, match_event_id)
);
-- The copilot gains a "compare metrics" task.
ALTER TABLE coaching_ai_drafts DROP CONSTRAINT coaching_ai_drafts_task_check;
ALTER TABLE coaching_ai_drafts ADD CONSTRAINT coaching_ai_drafts_task_check
  CHECK (task IN ('plan_session','player_focus','summarise_session','player_progress','team_patterns','suggest_actions','match_debrief','ask','compare_metrics'));
