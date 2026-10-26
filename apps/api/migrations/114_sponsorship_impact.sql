-- Beneficiary performance and community impact (#303). Additive only: new tables and new columns with safe defaults ("nothing shared"); no existing row
-- changes meaning and nothing is removed. Team/event participation and results are NOT stored here: they are read live from the canonical games and
-- event entries, so a corrected game shows up at once. This table holds only what the platform cannot know: development milestones, community
-- outcomes and results from outside the platform, each with its source, date, unit and sample size. A correction never overwrites: it adds a new
-- current row that supersedes the old one (kept, with its reason). Sharing with the sponsor reuses the agreement's performance switch
-- (sponsorships.performance_access); nothing here can change a payment, an obligation or an agreement status.
-- Rollback = deploy the previous code; it ignores the new table and columns, which can stay in place unused.
CREATE TABLE sponsorship_impact_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id   uuid NOT NULL REFERENCES sponsorships,
  kind             text NOT NULL CHECK (kind IN ('result','milestone','community')),
  title            text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  metric           text CHECK (metric IS NULL OR length(metric) BETWEEN 1 AND 60),
  value            numeric,
  unit             text CHECK (unit IS NULL OR length(unit) BETWEEN 1 AND 30),
  sample_size      integer CHECK (sample_size IS NULL OR sample_size >= 1),
  source           text NOT NULL CHECK (source IN ('organiser_record','third_party','self_reported')),
  source_ref       text CHECK (source_ref IS NULL OR length(source_ref) <= 200),
  occurred_on      date NOT NULL,
  period_end       date,
  note_enc         text,                                   -- free text, field-encrypted (may mention people); audit-logged when a sponsor reads it
  status           text NOT NULL DEFAULT 'current' CHECK (status IN ('current','superseded','withdrawn')),
  supersedes_id    uuid REFERENCES sponsorship_impact_records,
  correction_reason text CHECK (correction_reason IS NULL OR length(correction_reason) <= 500),
  recorded_by      uuid NOT NULL REFERENCES users,
  row_version      integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end IS NULL OR period_end >= occurred_on),
  CHECK (value IS NULL OR unit IS NOT NULL),
  CHECK (kind <> 'community' OR (metric IS NOT NULL AND value IS NOT NULL AND sample_size IS NOT NULL)),
  CHECK (source <> 'third_party' OR source_ref IS NOT NULL)
);
CREATE UNIQUE INDEX sponsorship_impact_one_correction ON sponsorship_impact_records (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX sponsorship_impact_deal ON sponsorship_impact_records (sponsorship_id, status, occurred_on DESC, id);

-- Pre-award evidence (#64): an applicant attaches a passport share link (their own, chosen sections, expiring, revocable) to one application.
-- Revoking either the application share or the passport link ends every later read. Team and event applicants share live team/event results instead.
ALTER TABLE sponsorship_applications
  ADD COLUMN evidence_shared    boolean NOT NULL DEFAULT false,
  ADD COLUMN evidence_link_id   uuid REFERENCES passport_links,
  ADD COLUMN evidence_shared_at timestamptz,
  ADD COLUMN evidence_shared_by uuid REFERENCES users;
