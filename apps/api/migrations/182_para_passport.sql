-- PS-12: Para-athlete passport — additive columns on passport_links and guide in passport query
-- Adds three athlete-controlled flags (default FALSE = opt-in) and an evidence filter.
-- Fully additive, backward-compatible.

ALTER TABLE passport_links
  ADD COLUMN IF NOT EXISTS show_para_class         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS show_para_guide         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS show_para_class_history  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS para_evidence_filter    TEXT    NOT NULL DEFAULT 'all'
    CHECK (para_evidence_filter IN ('all','official'));
