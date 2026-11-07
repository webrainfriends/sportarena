-- Academy OS P2 / Gap 27 (#807): governed academy report packs. A pack is a point-in-time snapshot that goes draft -> in review -> approved -> issued
-- (or revoked) before anyone outside the academy can open it. The PDF itself is still a row of the shared generated_documents table (no second
-- renderer or document table); this table only records the workflow, the frozen figures, the data basis, evidence versions, gaps and audience.
-- Additive only: nothing is dropped or rewritten, rows are never deleted (a refreshed draft is 'superseded', an issued pack can be 'revoked').
CREATE TABLE IF NOT EXISTS academy_report_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  kind            text NOT NULL CHECK (kind IN ('progress','term','management','finance','campus')),
  cadence         text NOT NULL CHECK (cadence IN ('weekly','monthly','quarterly')),
  scope           jsonb NOT NULL DEFAULT '{}',          -- { cohort_id } for athlete reports, { branch_id } for the campus pack
  lookback_days   int  NOT NULL DEFAULT 90 CHECK (lookback_days BETWEEN 7 AND 400),
  template_id     uuid REFERENCES document_templates,
  next_run_on     date NOT NULL,
  last_run_on     date,
  paused_at       timestamptz,
  archived_at     timestamptz,
  created_by      uuid NOT NULL REFERENCES users,       -- drafts are built under this person's live authority
  row_version     int  NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_report_schedules_due ON academy_report_schedules (next_run_on) WHERE archived_at IS NULL AND paused_at IS NULL;

CREATE TABLE IF NOT EXISTS academy_report_packs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  kind            text NOT NULL CHECK (kind IN ('progress','term','management','finance','campus')),
  subject_id      uuid NOT NULL,                        -- athlete (progress, term), branch (campus) or the organisation
  period_from     date NOT NULL,
  period_to       date NOT NULL,
  version         int  NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','issued','revoked','superseded')),
  template_id     uuid REFERENCES document_templates,
  snapshot        jsonb NOT NULL,                       -- exactly what the PDF will say, frozen when the draft was built
  snapshot_sha    text  NOT NULL,
  basis           jsonb NOT NULL DEFAULT '{}',          -- period, as-of, currency basis, issuer
  evidence        jsonb NOT NULL DEFAULT '[]',          -- source, row count, latest record, digest: the evidence versions the figures came from
  gaps            jsonb NOT NULL DEFAULT '[]',          -- what could not be known (printed as "Not available", never zero)
  audience        jsonb NOT NULL DEFAULT '{}',          -- who may read the issued file and what is always left out
  gaps_acknowledged boolean NOT NULL DEFAULT false,
  review_note     text CHECK (review_note IS NULL OR length(review_note) <= 500),
  schedule_id     uuid REFERENCES academy_report_schedules,
  author_id       uuid NOT NULL REFERENCES users,
  submitted_at    timestamptz,
  approved_by     uuid REFERENCES users,
  approved_at     timestamptz,
  issued_by       uuid REFERENCES users,
  issued_at       timestamptz,
  document_id     uuid REFERENCES generated_documents,
  revoked_by      uuid REFERENCES users,
  revoked_at      timestamptz,
  revoke_reason   text CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 5 AND 500),
  supersedes_id   uuid REFERENCES academy_report_packs,
  row_version     int  NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from),
  CHECK (approved_by IS NULL OR approved_by <> author_id)   -- four eyes: the person who drafted a pack cannot approve it
);
CREATE INDEX IF NOT EXISTS academy_report_packs_org ON academy_report_packs (organisation_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS academy_report_packs_subject ON academy_report_packs (organisation_id, kind, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS academy_report_packs_document ON academy_report_packs (document_id) WHERE document_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS academy_report_packs_sched ON academy_report_packs (schedule_id, period_to, subject_id, kind) WHERE schedule_id IS NOT NULL AND version = 1;

-- Frozen content and issued state cannot be rewritten: figures never change after the draft is built (a change is a NEW version), and rows are never deleted.
CREATE OR REPLACE FUNCTION academy_report_packs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'academy report packs are never deleted'; END IF;
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.snapshot_sha <> OLD.snapshot_sha OR NEW.basis IS DISTINCT FROM OLD.basis OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR NEW.gaps IS DISTINCT FROM OLD.gaps OR NEW.kind <> OLD.kind OR NEW.subject_id <> OLD.subject_id OR NEW.period_from <> OLD.period_from OR NEW.period_to <> OLD.period_to OR NEW.author_id <> OLD.author_id THEN
    RAISE EXCEPTION 'a report pack version is immutable: create a new version instead';
  END IF;
  IF OLD.status IN ('issued','revoked','superseded') AND (NEW.status = 'draft' OR NEW.document_id IS DISTINCT FROM OLD.document_id AND OLD.document_id IS NOT NULL) THEN
    RAISE EXCEPTION 'an issued, revoked or superseded report pack cannot be reopened';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS academy_report_packs_guard ON academy_report_packs;
CREATE TRIGGER academy_report_packs_guard BEFORE UPDATE OR DELETE ON academy_report_packs FOR EACH ROW EXECUTE FUNCTION academy_report_packs_guard();

-- Append-only history of every step (drafted, scheduled, submitted, changes requested, approved, issued, delivered, revoked, downloaded by a reviewer).
CREATE TABLE IF NOT EXISTS academy_report_pack_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id    uuid NOT NULL REFERENCES academy_report_packs,
  action     text NOT NULL,
  actor_id   uuid REFERENCES users,                    -- null for the scheduler
  note       text CHECK (note IS NULL OR length(note) <= 500),
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()   -- not now(): steps in one transaction must still sort in the order they happened
);
CREATE INDEX IF NOT EXISTS academy_report_pack_events_pack ON academy_report_pack_events (pack_id, created_at);
CREATE OR REPLACE FUNCTION academy_report_events_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'report pack history is append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS academy_report_events_immutable ON academy_report_pack_events;
CREATE TRIGGER academy_report_events_immutable BEFORE UPDATE OR DELETE ON academy_report_pack_events FOR EACH ROW EXECUTE FUNCTION academy_report_events_append_only();
