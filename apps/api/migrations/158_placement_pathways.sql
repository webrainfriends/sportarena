-- Academy OS P2 / Gap 21 (#801): Scholarship, University & College Placement Pathways
-- Advisor-managed placement funnel, revocable evidence sharing with named institutions,
-- reference request workflow, action queues and scholarship fund attribution.
-- Additive only: no DROP, TRUNCATE or CASCADE on user data.

-- ── Placement opportunities ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS placement_opportunities (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid        NOT NULL REFERENCES organisations,
  athlete_id       uuid        NOT NULL REFERENCES users,
  advisor_id       uuid        NOT NULL REFERENCES users,
  kind             text        NOT NULL DEFAULT 'university_place'
                               CHECK (kind IN ('university_place','scholarship','grant','professional_contract')),
  sport            text,
  title            text        NOT NULL,
  institution_id   uuid,       -- optional reference into education catalogue
  institution_name text,       -- free-text when not in catalogue
  amount_minor     bigint      CHECK (amount_minor >= 0),
  currency         char(3),
  intake_year      int,
  intake_term      text,
  status           text        NOT NULL DEFAULT 'identified'
                               CHECK (status IN ('identified','eligibility_check','evidence_gathering','applied','offer_received','outcome')),
  deadline         date,
  offer_at         date,
  offer_expires_at timestamptz,
  offer_accepted_at timestamptz,
  offer_declined_at timestamptz,
  offer_deferred_at timestamptz,
  outcome          text        CHECK (outcome IN ('accepted','declined','deferred','withdrawn','lapsed')),
  outcome_note_enc text,       -- encrypted free text
  conditions_enc   text,       -- encrypted offer conditions
  row_version      int         NOT NULL DEFAULT 1,
  created_by       uuid        NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_org    ON placement_opportunities(organisation_id);
CREATE INDEX IF NOT EXISTS idx_po_athlete ON placement_opportunities(athlete_id);
CREATE INDEX IF NOT EXISTS idx_po_advisor ON placement_opportunities(advisor_id);
CREATE INDEX IF NOT EXISTS idx_po_status  ON placement_opportunities(status) WHERE outcome IS NULL;

-- ── Evidence checklist items ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS placement_evidence_items (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id   uuid        NOT NULL REFERENCES placement_opportunities ON DELETE RESTRICT,
  position         int         NOT NULL DEFAULT 1,
  kind             text        NOT NULL
                               CHECK (kind IN ('academic_transcript','sport_cv','performance_video',
                                               'reference_letter','passport','ranking_cert',
                                               'medical_clearance','other')),
  label            text        NOT NULL,
  note             text,
  required         boolean     NOT NULL DEFAULT true,
  status           text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','requested','uploaded','verified','waived')),
  document_id      uuid,
  uploaded_at      timestamptz,
  verified_at      timestamptz,
  verified_by      uuid        REFERENCES users,
  requested_at     timestamptz,
  created_by       uuid        NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pei_opp ON placement_evidence_items(opportunity_id);

-- ── Reference requests ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS placement_reference_requests (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id   uuid        NOT NULL REFERENCES placement_opportunities ON DELETE RESTRICT,
  referee_id       uuid        NOT NULL REFERENCES users,
  referee_role     text        CHECK (referee_role IN ('coach','academic','advisor','personal','other')),
  purpose          text        NOT NULL,
  instructions_enc text,
  status           text        NOT NULL DEFAULT 'requested'
                               CHECK (status IN ('requested','reminded','submitted','declined')),
  due_on           date,
  submitted_at     timestamptz,
  document_id      uuid,
  row_version      int         NOT NULL DEFAULT 1,
  created_by       uuid        NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prr_opp      ON placement_reference_requests(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_prr_referee  ON placement_reference_requests(referee_id);

-- ── Revocable institution sharing ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS placement_institution_shares (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id         uuid        NOT NULL REFERENCES placement_opportunities ON DELETE RESTRICT,
  athlete_id             uuid        NOT NULL REFERENCES users,
  institution_id         uuid,
  institution_name       text        NOT NULL,
  granted_by             uuid        NOT NULL REFERENCES users,
  guardian_approved_by   uuid        REFERENCES users,
  guardian_approved_at   timestamptz,
  fields                 jsonb       NOT NULL DEFAULT '{"sport_performance":false,"academic":false,"dev_plan":false,"health_summary":false,"contact":false}',
  revoked_at             timestamptz,
  revoked_by             uuid        REFERENCES users,
  expires_at             timestamptz,
  row_version            int         NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Only one live share per opportunity per institution at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_pis_live
  ON placement_institution_shares(opportunity_id, institution_name)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pis_athlete ON placement_institution_shares(athlete_id);
CREATE INDEX IF NOT EXISTS idx_pis_opp     ON placement_institution_shares(opportunity_id);

-- ── Append-only event log ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS placement_opportunity_events (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id   uuid        NOT NULL REFERENCES placement_opportunities ON DELETE RESTRICT,
  athlete_id       uuid        NOT NULL REFERENCES users,
  kind             text        NOT NULL,
  from_status      text,
  to_status        text,
  detail           jsonb,
  actor_id         uuid        NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_poe_opp     ON placement_opportunity_events(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_poe_athlete ON placement_opportunity_events(athlete_id, created_at DESC);

-- Guard: prevent UPDATE/DELETE on event log
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'placement_events_append_only'
  ) THEN
    CREATE OR REPLACE FUNCTION placement_events_guard() RETURNS trigger LANGUAGE plpgsql AS
    $fn$ BEGIN RAISE EXCEPTION 'placement_opportunity_events is append-only'; END; $fn$;

    CREATE TRIGGER placement_events_append_only
      BEFORE UPDATE OR DELETE ON placement_opportunity_events
      FOR EACH ROW EXECUTE FUNCTION placement_events_guard();
  END IF;
END $$;

-- ── Scholarship fund attribution: link to sponsorship awards ─────────────────
ALTER TABLE sponsorship_awards
  ADD COLUMN IF NOT EXISTS placement_opportunity_id uuid REFERENCES placement_opportunities;

CREATE INDEX IF NOT EXISTS idx_sa_placement
  ON sponsorship_awards(placement_opportunity_id)
  WHERE placement_opportunity_id IS NOT NULL;

-- ── Organisation member placement permission ─────────────────────────────────
-- Existing org_members table has a permissions text[] column; we extend the enum.
-- If the column doesn't exist yet we still proceed (old migration idempotent).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organisation_members' AND column_name = 'permissions'
  ) THEN
    -- 'placement' is a new valid permission value; no schema change needed as it's freeform text[].
    -- No default backfill; advisors are granted this explicitly by owners/admins.
    NULL;
  END IF;
END $$;
