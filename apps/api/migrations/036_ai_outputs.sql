-- Cache of AI-generated text (recaps, sheet reviews, plans) so the same facts are never paid for twice. Additive; rows are never edited or deleted.
CREATE TABLE IF NOT EXISTS ai_outputs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL,
  subject_id uuid NOT NULL,
  input_hash text NOT NULL,
  model      text NOT NULL,
  output     jsonb NOT NULL,
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, subject_id, input_hash)
);
