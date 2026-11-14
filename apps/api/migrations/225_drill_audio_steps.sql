-- Drill step audio instructions, auto-derived duration, and athlete step responses (issue: drill audio + feedback).
-- Additive only: extends drill_media with an audio kind, adds duration to drill steps via the existing JSONB steps
-- column on coach_templates, and introduces drill_step_responses for athlete voice/text replies.

-- 1. Allow audio as a kind in drill_media (existing check only allowed 'photo' | 'video').
ALTER TABLE drill_media
  DROP CONSTRAINT IF EXISTS drill_media_kind_check;
ALTER TABLE drill_media
  ADD CONSTRAINT drill_media_kind_check CHECK (kind IN ('photo','video','audio'));

-- 2. Per-media duration in seconds (populated from ffprobe/metadata for audio and video; null for photos).
ALTER TABLE drill_media
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;

-- 3. Athlete step responses: one row per athlete × session × drill × step index.
CREATE TABLE IF NOT EXISTS drill_step_responses (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_record_id UUID        NOT NULL REFERENCES coaching_session_records(id),
  template_id       UUID        NOT NULL REFERENCES coach_templates(id),
  step_index        SMALLINT    NOT NULL CHECK (step_index >= 0),
  athlete_id        UUID        NOT NULL REFERENCES users(id),
  -- voice response (optional): stored encrypted
  audio_media_id    UUID        REFERENCES drill_media(id),
  -- text response (optional, encrypted): free-form or auto-transcribed from athlete's audio
  response_text_enc TEXT,
  -- coach feedback on this response
  feedback_text_enc TEXT,
  feedback_audio_id UUID        REFERENCES drill_media(id),
  feedback_rating   TEXT        CHECK (feedback_rating IN ('excellent','good','redo','issue')),
  feedback_at       TIMESTAMPTZ,
  -- lifecycle
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON COLUMN drill_step_responses.response_text_enc IS 'Encrypted via src/crypto.js encrypt(). Athlete''s text or transcription of their voice reply.';
COMMENT ON COLUMN drill_step_responses.feedback_text_enc IS 'Encrypted via src/crypto.js encrypt(). Coach''s written feedback on this response.';

CREATE INDEX IF NOT EXISTS drill_step_responses_session_idx ON drill_step_responses(session_record_id);
CREATE INDEX IF NOT EXISTS drill_step_responses_template_idx ON drill_step_responses(template_id);
CREATE INDEX IF NOT EXISTS drill_step_responses_athlete_idx ON drill_step_responses(athlete_id);
CREATE UNIQUE INDEX IF NOT EXISTS drill_step_responses_uniq ON drill_step_responses(session_record_id, template_id, step_index, athlete_id) WHERE archived_at IS NULL;
