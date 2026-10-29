-- Compliance evidence files (#595). Additive only: a file is hidden with removed_at, never deleted (the encrypted bytes stay on disk).
CREATE TABLE IF NOT EXISTS comp_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id     uuid NOT NULL REFERENCES comp_records,
  original_name text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 160),
  content_type  text NOT NULL,
  file_name     text NOT NULL,                          -- the encrypted file on disk
  size_bytes    integer NOT NULL CHECK (size_bytes > 0),
  sha256        text NOT NULL,
  scan          text NOT NULL DEFAULT 'skipped',        -- clean | skipped (no scanner configured)
  uploaded_by   uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  removed_by    uuid REFERENCES users
);
CREATE INDEX IF NOT EXISTS comp_files_record ON comp_files (record_id) WHERE removed_at IS NULL;
