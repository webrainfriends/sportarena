-- Venue compliance register (command centre): licences, certificates and permits with an expiry date, so the venue home can warn
-- before anything lapses. Additive only: nothing existing is dropped or rewritten. Insurance and contracts stay where they are
-- (insurance_policies, venue_contracts) and are read by the command centre; this table covers what had no home (fire, pool, food,
-- safety, accessibility, tax registration, event permits). Items are archived, never deleted. The reference/licence number is
-- personal-grade free text and is stored encrypted (reference_enc).
CREATE TABLE IF NOT EXISTS venue_compliance_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      uuid NOT NULL REFERENCES venues,
  kind          text NOT NULL CHECK (kind IN ('licence','fire','safety','pool','food','accessibility','tax','permit','other')),
  title         text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  reference_enc text,
  issued_on     date,
  expires_on    date,
  document_id   uuid REFERENCES subject_documents,
  reminded_at   timestamptz,
  archived_at   timestamptz,
  created_by    uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX IF NOT EXISTS venue_compliance_items_venue ON venue_compliance_items (venue_id, expires_on) WHERE archived_at IS NULL;
