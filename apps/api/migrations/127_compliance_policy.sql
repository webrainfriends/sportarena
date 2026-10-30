-- Compliance policy layer (#568) on the compliance platform (#595). Additive only: nothing is dropped, rewritten or narrowed.
--
--   comp_requirements  gains the policy facts of a rule: its classification (legal, regulatory, federation mandated, contractual, organisation policy,
--                      recommended standard), a topic (rules of one topic compete: the highest classification and the narrowest jurisdiction win), the
--                      source it comes from, who owns its approval, whether it can be waived, and an approval state (a law or regulation needs a second
--                      platform administrator before it takes effect). Everything that exists today stays approved.
--   comp_obligations   gains WHERE and for WHOM a rule applies beyond roles and sport: country, state or province, municipality, governing bodies,
--                      competitions (events), venues, event types and an age band. A rule that names a dimension the facts cannot answer is "unknown",
--                      never silently "does not apply". The existing starts_on / ends_on are the effective window; a repeal is an end date.
--                      What an unmet obligation blocks is widened with event opening, event start and tender award.
--   comp_decisions     an append-only audit of every decision a gate took (and any evaluation someone asked to keep): the facts and where each came
--                      from, every rule with its version and result, the waivers used, who decided and when. Database triggers refuse edits and deletes.
ALTER TABLE comp_requirements
  ADD COLUMN IF NOT EXISTS classification text NOT NULL DEFAULT 'organisation_policy'
    CHECK (classification IN ('legal_mandatory','regulatory','federation_mandated','contractual','organisation_policy','recommended_standard')),
  ADD COLUMN IF NOT EXISTS topic text CHECK (topic IS NULL OR topic ~ '^[a-z0-9_.]{2,60}$'),
  ADD COLUMN IF NOT EXISTS source_title text CHECK (source_title IS NULL OR length(source_title) <= 200),
  ADD COLUMN IF NOT EXISTS source_url text CHECK (source_url IS NULL OR length(source_url) <= 500),
  ADD COLUMN IF NOT EXISTS approval_owner text CHECK (approval_owner IS NULL OR length(approval_owner) <= 120),
  ADD COLUMN IF NOT EXISTS waivable boolean,                                   -- null = the platform's default (not for background checks or youth safeguarding); false = never
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending_approval','approved','withdrawn')),
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- a governing body's own requirements are federation rules; the meaning of "everything that exists" is kept by backfilling, not by rewriting
UPDATE comp_requirements SET classification = 'federation_mandated' WHERE scope_kind = 'body' AND classification = 'organisation_policy';

ALTER TABLE comp_obligations
  ADD COLUMN IF NOT EXISTS country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  ADD COLUMN IF NOT EXISTS region text CHECK (region IS NULL OR length(region) BETWEEN 1 AND 80),
  ADD COLUMN IF NOT EXISTS municipality text CHECK (municipality IS NULL OR length(municipality) BETWEEN 1 AND 80),
  ADD COLUMN IF NOT EXISTS body_ids uuid[] NOT NULL DEFAULT '{}',              -- limited to these governing bodies (federations)
  ADD COLUMN IF NOT EXISTS competition_ids uuid[] NOT NULL DEFAULT '{}',       -- limited to these competitions (events)
  ADD COLUMN IF NOT EXISTS venue_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS event_types text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS min_age integer CHECK (min_age IS NULL OR min_age BETWEEN 0 AND 120),
  ADD COLUMN IF NOT EXISTS max_age integer CHECK (max_age IS NULL OR max_age BETWEEN 0 AND 120);

-- widen what an unmet obligation can block (a superset of the existing list)
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'comp_obligations'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%youth_contact%' LOOP
    EXECUTE format('ALTER TABLE comp_obligations DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE comp_obligations ADD CONSTRAINT comp_obligations_consequences_check
    CHECK (consequences <@ ARRAY['youth_contact','youth_access','registration','accreditation','event_open','event_start','tender_award']);
END $$;

CREATE INDEX IF NOT EXISTS comp_requirements_topic ON comp_requirements (topic) WHERE topic IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS comp_requirements_pending ON comp_requirements (created_at) WHERE approval_status = 'pending_approval';

CREATE TABLE IF NOT EXISTS comp_decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consequence     text NOT NULL,                                              -- what was being decided: event_open, event_start, tender_award, registration, accreditation, or 'check'
  subject_kind    text NOT NULL CHECK (subject_kind IN ('person','organisation','event')),
  subject_id      uuid NOT NULL,
  context         jsonb NOT NULL DEFAULT '{}',                                -- the event, tender, organisation and bodies the decision was made in
  event_id        uuid,
  trigger         text NOT NULL,
  as_of           date NOT NULL,
  facts           jsonb NOT NULL,                                             -- { values, sources }: never a date of birth, only the age that was used
  results         jsonb NOT NULL,                                             -- every rule with its version, outcome, status and reason
  overall         text NOT NULL,
  blocked         boolean NOT NULL,
  waiver_ids      uuid[] NOT NULL DEFAULT '{}',                               -- the human overrides that let a rule through
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comp_decisions_subject ON comp_decisions (subject_kind, subject_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS comp_decisions_event ON comp_decisions (event_id, decided_at DESC) WHERE event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION comp_decisions_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'compliance decisions are append-only'; END $$;
DROP TRIGGER IF EXISTS comp_decisions_no_change ON comp_decisions;
CREATE TRIGGER comp_decisions_no_change BEFORE UPDATE OR DELETE ON comp_decisions FOR EACH ROW EXECUTE FUNCTION comp_decisions_keep();
DROP TRIGGER IF EXISTS comp_decisions_no_truncate ON comp_decisions;
CREATE TRIGGER comp_decisions_no_truncate BEFORE TRUNCATE ON comp_decisions FOR EACH STATEMENT EXECUTE FUNCTION comp_decisions_keep();
