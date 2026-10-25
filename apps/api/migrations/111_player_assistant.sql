-- Source-linked athlete assistant (issue #337). Additive only. An answer is a DRAFT built from records the viewer may already read
-- (schedule, development, progress, opportunities); nothing in it changes anything until the player resolves it. The model call, when
-- one is made, is cached in ai_outputs. Free-text questions are personal data, so they are stored encrypted (question_enc).
CREATE TABLE player_assistant_answers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asked_by     uuid NOT NULL REFERENCES users,
  subject_id   uuid NOT NULL REFERENCES users,          -- whose records were read (the asker, or a young person / athlete they may see)
  viewer       text NOT NULL CHECK (viewer IN ('self','guardian','coach')),
  task         text NOT NULL CHECK (task IN ('overview','week','focus','opportunities','feedback','ask')),
  sport_id     uuid REFERENCES sports,
  window_from  date NOT NULL,
  window_to    date NOT NULL,
  source_kinds text[] NOT NULL,                         -- schedule, development, progress, opportunities
  question_enc text,
  sources      jsonb NOT NULL DEFAULT '[]',             -- [{ref,kind,id,label,at,evidence,link}] every record used, by reference
  limitations  jsonb NOT NULL DEFAULT '[]',
  output       jsonb NOT NULL,                          -- {headline, declined, items:[{id,basis,tone,title,detail,why,source_refs,action?}]}
  ai           boolean NOT NULL DEFAULT false,
  model        text,
  ai_output_id uuid REFERENCES ai_outputs,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','accepted','edited','discarded')),
  resolution   jsonb,
  resolved_at  timestamptz,
  row_version  integer NOT NULL DEFAULT 1,
  client_key   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (window_to >= window_from)
);
CREATE UNIQUE INDEX player_assistant_answers_key ON player_assistant_answers (asked_by, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX player_assistant_answers_asker ON player_assistant_answers (asked_by, created_at DESC, id);
