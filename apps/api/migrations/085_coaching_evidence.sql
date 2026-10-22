-- Coaching completion, part G (issue #269). Additive only: photo / video / document evidence attached to a coaching observation.
-- Files are encrypted on disk (never in the table) and are never deleted: removing evidence only hides the row.
CREATE TABLE coaching_evidence (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL REFERENCES coaching_observations,
  uploaded_by    uuid NOT NULL REFERENCES users,
  kind           text NOT NULL CHECK (kind IN ('photo','video','document')),
  content_type   text NOT NULL,
  file_name      text NOT NULL,
  title          text CHECK (length(title) <= 120),
  size_bytes     int  NOT NULL,
  sha256         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz
);
CREATE INDEX coaching_evidence_observation ON coaching_evidence (observation_id) WHERE removed_at IS NULL;
