-- Team / batch performance reports. A coaching report can now be about a whole team or an academy batch (cohort), carry the new kind 'team_performance',
-- and be addressed to an organisation (an academy, club or sponsor) as an AGGREGATE-ONLY audience: no athlete names, no individual scores, no notes.
-- A published version is handed to an organisation through a share that has an expiry and can be revoked; every read is audited.
-- Additive only: every old kind and audience is still allowed, no row is changed or removed.
ALTER TABLE coaching_reports ADD COLUMN IF NOT EXISTS cohort_id uuid REFERENCES org_cohorts(id);
ALTER TABLE coaching_reports ADD COLUMN IF NOT EXISTS rubric_id uuid REFERENCES coaching_rubrics(id);
ALTER TABLE coaching_reports DROP CONSTRAINT IF EXISTS coaching_reports_kind_check;
ALTER TABLE coaching_reports ADD CONSTRAINT coaching_reports_kind_check
  CHECK (kind IN ('session','athlete_progress','goal_review','team_training','match_debrief','period_review','action_summary','team_performance'));
ALTER TABLE coaching_reports DROP CONSTRAINT IF EXISTS coaching_reports_audience_check;
ALTER TABLE coaching_reports ADD CONSTRAINT coaching_reports_audience_check
  CHECK (audience IN ('coach_private','athlete','guardian','team_staff','organisation'));
-- "an athlete or a team" becomes "an athlete, a team or a batch" (the old unnamed check is found by what it says, never by a guessed name)
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='coaching_reports'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%athlete_id IS NOT NULL) OR (team_id IS NOT NULL%' LOOP
    EXECUTE format('ALTER TABLE coaching_reports DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE coaching_reports ADD CONSTRAINT coaching_reports_subject_check CHECK (athlete_id IS NOT NULL OR team_id IS NOT NULL OR cohort_id IS NOT NULL);
ALTER TABLE coaching_reports ADD CONSTRAINT coaching_reports_org_audience_check CHECK (audience <> 'organisation' OR (kind = 'team_performance' AND athlete_id IS NULL));
CREATE INDEX IF NOT EXISTS coaching_reports_cohort ON coaching_reports (cohort_id) WHERE cohort_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS coaching_report_shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       uuid NOT NULL,
  version         int  NOT NULL,
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  shared_by       uuid NOT NULL REFERENCES users(id),
  note            text CHECK (length(note) <= 500),
  expires_on      date NOT NULL,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (report_id, version) REFERENCES coaching_report_versions(report_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS coaching_report_shares_live ON coaching_report_shares (report_id, version, organisation_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS coaching_report_shares_org ON coaching_report_shares (organisation_id, created_at DESC);
