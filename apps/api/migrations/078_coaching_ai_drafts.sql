-- AI coaching copilot drafts (issue #269, slice 3). Additive only. A draft is a suggestion: nothing in it becomes a plan, note, action or
-- report until the coach resolves it, and every resolution is recorded here. The model call itself is cached in ai_outputs.
CREATE TABLE coaching_ai_drafts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id     uuid NOT NULL REFERENCES users,
  task         text NOT NULL CHECK (task IN ('plan_session','player_focus','summarise_session','player_progress','team_patterns','suggest_actions','match_debrief','ask')),
  athlete_id   uuid REFERENCES users,
  team_id      uuid REFERENCES teams,
  session_record_id uuid REFERENCES coaching_session_records,
  window_from  date NOT NULL,
  window_to    date NOT NULL,
  options      jsonb NOT NULL DEFAULT '{}',   -- what the coach allowed (e.g. private summaries); never the notes themselves
  sources      jsonb NOT NULL DEFAULT '[]',   -- [{ref,type,id,at,label}] every record the model was shown, by reference
  limitations  jsonb NOT NULL DEFAULT '[]',
  output       jsonb NOT NULL,                -- {headline, items:[{id,basis,title,detail,why,source_refs,block?,action?}]}
  ai           boolean NOT NULL,              -- false = deterministic summary, no model was used
  model        text,
  ai_output_id uuid REFERENCES ai_outputs,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','accepted','edited','discarded')),
  resolution   jsonb,                         -- what was written, and what the coach changed
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (athlete_id IS NOT NULL OR team_id IS NOT NULL OR session_record_id IS NOT NULL)
);
CREATE INDEX coaching_ai_drafts_coach ON coaching_ai_drafts (coach_id, created_at DESC);
