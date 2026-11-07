-- PS-27: Privacy-preserving para-sport sponsorship outcomes and impact.
-- Additive only. No existing tables are dropped, truncated, narrowed or rewritten.
-- Rollback = deploy the previous code: it ignores these tables and columns.

-- ------------------------------------------------------------------ cohort k-min on programmes
ALTER TABLE sponsorship_programs
  ADD COLUMN IF NOT EXISTS cohort_k_min INT NOT NULL DEFAULT 5
    CONSTRAINT cohort_k_min_range CHECK (cohort_k_min >= 2 AND cohort_k_min <= 100);
COMMENT ON COLUMN sponsorship_programs.cohort_k_min IS
  'PS-27: minimum cohort size for k-anonymity enforcement on programme impact snapshots. '
  'Any metric based on fewer than this many athletes is suppressed in sponsor-visible output.';

-- ------------------------------------------------------------------ provenance links
-- Connects confirmed para delivery evidence to training, competition or milestone records.
-- Never exposed to sponsors directly; feeds programme snapshot aggregation only.
CREATE TABLE IF NOT EXISTS para_provenance_links (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id   UUID NOT NULL REFERENCES sponsorships(id),
  evidence_id      UUID NOT NULL REFERENCES para_sport_delivery_evidence(id),
  athlete_id       UUID NOT NULL REFERENCES users(id),
  linked_type      TEXT NOT NULL CHECK (linked_type IN (
                     'training_attendance', 'competition_result', 'development_milestone')),
  linked_id        UUID NOT NULL,
  note_enc         TEXT,
  created_by       UUID NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (evidence_id, linked_type, linked_id)
);
CREATE INDEX IF NOT EXISTS para_provenance_links_sponsorship
  ON para_provenance_links(sponsorship_id, athlete_id);
CREATE INDEX IF NOT EXISTS para_provenance_links_evidence
  ON para_provenance_links(evidence_id);
COMMENT ON TABLE para_provenance_links IS
  'PS-27: connects confirmed para delivery evidence to training/competition/milestone records. '
  'athlete_id is never exposed to sponsors; feeds aggregated programme snapshots only.';

-- ------------------------------------------------------------------ athlete story consents
CREATE TABLE IF NOT EXISTS para_story_consents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id     UUID NOT NULL REFERENCES sponsorship_programs(id),
  sponsorship_id   UUID REFERENCES sponsorships(id),
  athlete_id       UUID NOT NULL REFERENCES users(id),
  title            TEXT NOT NULL,
  version          INT NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'withdrawn')),
  expires_on       DATE,
  withdrawn_at     TIMESTAMPTZ,
  withdrawal_reason_enc TEXT,
  audience_note_enc TEXT,
  created_by       UUID NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS para_story_consents_athlete
  ON para_story_consents(athlete_id, status);
CREATE INDEX IF NOT EXISTS para_story_consents_programme
  ON para_story_consents(programme_id, status);
COMMENT ON TABLE para_story_consents IS
  'PS-27: athlete-consented narrative stories for sponsor-facing impact reporting. '
  'status=withdrawn revokes access immediately. Versioned: each update increments version; '
  'prior version rows are kept for audit. Sections stored in para_story_sections. '
  'Sponsors read only approved sections of active, unexpired stories.';

-- Prevent changing identity columns after creation
CREATE OR REPLACE FUNCTION para_story_consents_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.athlete_id    <> NEW.athlete_id    OR
     OLD.programme_id  <> NEW.programme_id  OR
     OLD.created_at    <> NEW.created_at    OR
     OLD.created_by    <> NEW.created_by    THEN
    RAISE EXCEPTION 'para_story_consents: identity fields are immutable after creation (PS-27).';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS para_story_consents_immutable_identity ON para_story_consents;
CREATE TRIGGER para_story_consents_immutable_identity
  BEFORE UPDATE ON para_story_consents
  FOR EACH ROW EXECUTE FUNCTION para_story_consents_guard();

-- ------------------------------------------------------------------ story sections
CREATE TABLE IF NOT EXISTS para_story_sections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id         UUID NOT NULL REFERENCES para_story_consents(id),
  section_key      TEXT NOT NULL,
  heading          TEXT NOT NULL,
  body_enc         TEXT NOT NULL,
  approved         BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order       INT NOT NULL DEFAULT 0,
  superseded_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS para_story_sections_story
  ON para_story_sections(story_id, superseded_at)
  WHERE superseded_at IS NULL;
COMMENT ON TABLE para_story_sections IS
  'PS-27: individual sections of a para athlete story. body_enc is field-level encrypted. '
  'Only approved=true sections are shown to sponsors. superseded_at set when story version updates.';

-- ------------------------------------------------------------------ immutable impact reports
CREATE TABLE IF NOT EXISTS para_sponsor_impact_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id     UUID NOT NULL REFERENCES sponsorship_programs(id),
  sponsor_id       UUID NOT NULL REFERENCES sponsors(id),
  sponsorship_ids  UUID[] NOT NULL,
  period_from      DATE NOT NULL,
  period_to        DATE NOT NULL,
  snapshot         JSONB NOT NULL,
  content_sha256   TEXT NOT NULL,
  issued_by        UUID NOT NULL REFERENCES users(id),
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  -- No updated_at: immutable after insert
);
CREATE INDEX IF NOT EXISTS para_impact_reports_programme
  ON para_sponsor_impact_reports(programme_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS para_impact_reports_sponsor
  ON para_sponsor_impact_reports(sponsor_id, issued_at DESC);
COMMENT ON TABLE para_sponsor_impact_reports IS
  'PS-27: immutable para sponsor impact reports. Never deleteable (see triggers below). '
  'SHA-256 tamper-evident: sha256(snapshot) == content_sha256. '
  'Sections: delivery_evidence, athletic_outcomes, development_milestones, valuation_estimates. '
  'Exclusion manifest lists 7 categories screened out before compilation.';

CREATE OR REPLACE FUNCTION para_impact_report_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'para_sponsor_impact_reports is immutable: rows may never be updated or deleted (PS-27).';
END;
$$;
DROP TRIGGER IF EXISTS para_impact_reports_no_update ON para_sponsor_impact_reports;
CREATE TRIGGER para_impact_reports_no_update
  BEFORE UPDATE ON para_sponsor_impact_reports
  FOR EACH ROW EXECUTE FUNCTION para_impact_report_immutable();
DROP TRIGGER IF EXISTS para_impact_reports_no_delete ON para_sponsor_impact_reports;
CREATE TRIGGER para_impact_reports_no_delete
  BEFORE DELETE ON para_sponsor_impact_reports
  FOR EACH ROW EXECUTE FUNCTION para_impact_report_immutable();

-- ------------------------------------------------------------------ audit log for sponsor reads
CREATE TABLE IF NOT EXISTS para_sponsor_outcome_audit (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  sponsor_id   UUID REFERENCES sponsors(id),
  action       TEXT NOT NULL,
  resource_id  UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS para_outcome_audit_sponsor
  ON para_sponsor_outcome_audit(sponsor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS para_outcome_audit_user
  ON para_sponsor_outcome_audit(user_id, created_at DESC);
COMMENT ON TABLE para_sponsor_outcome_audit IS
  'PS-27: audit log for all sponsor reads of para athlete outcome data (stories, snapshots, reports). '
  'Append-only by convention; no delete trigger needed as records are small and legally required.';
