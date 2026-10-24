-- Academy OS 1/3 (#392): programmes, admissions funnel, policies, tuition charges and academy CRM as a vertical
-- extension of organisations. Additive only: nothing is dropped, rewritten or cascaded. Athletes/guardians stay in
-- users + guardian_links + youth_consents, money stays in payments, structure stays in org_seasons/org_cohorts/org_enrolments.

-- 1:1 academy configuration of an organisation (not a new tenant)
CREATE TABLE IF NOT EXISTS academy_profiles (
  organisation_id uuid PRIMARY KEY REFERENCES organisations,
  legal_name      text CHECK (legal_name IS NULL OR length(legal_name) <= 120),
  sports          text[] NOT NULL DEFAULT '{}',
  focus           text NOT NULL DEFAULT 'mixed' CHECK (focus IN ('recreational','development','elite','mixed')),
  age_min         int CHECK (age_min IS NULL OR age_min BETWEEN 0 AND 99),
  age_max         int CHECK (age_max IS NULL OR age_max BETWEEN 0 AND 99),
  timezone        text,
  currency        text NOT NULL DEFAULT 'GBP',
  listed          boolean NOT NULL DEFAULT false,
  policy_url      text,
  contact_channel text CHECK (contact_channel IS NULL OR contact_channel IN ('platform','email','phone')),
  row_version     int NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (age_max IS NULL OR age_min IS NULL OR age_max >= age_min)
);

-- programme catalogue
CREATE TABLE IF NOT EXISTS academy_programmes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  season_id       uuid REFERENCES org_seasons,
  sport           text NOT NULL,
  discipline      text,
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  description     text,
  format          text NOT NULL DEFAULT 'term_course' CHECK (format IN ('term_course','rolling','camp','clinic','trial_programme','one_to_one','squad_pathway','custom')),
  focus           text NOT NULL DEFAULT 'development' CHECK (focus IN ('recreational','development','elite')),
  age_min         int CHECK (age_min IS NULL OR age_min BETWEEN 0 AND 99),
  age_max         int CHECK (age_max IS NULL OR age_max BETWEEN 0 AND 99),
  skill_level     text,
  starts_on       date,
  ends_on         date,
  cadence         text,
  session_minutes int CHECK (session_minutes IS NULL OR session_minutes BETWEEN 5 AND 600),
  sessions_planned int CHECK (sessions_planned IS NULL OR sessions_planned >= 0),
  admission_mode  text NOT NULL DEFAULT 'direct' CHECK (admission_mode IN ('direct','trial_then_enrol','application','invite_only','waitlist_only')),
  capacity        int CHECK (capacity IS NULL OR capacity > 0),
  min_enrol       int CHECK (min_enrol IS NULL OR min_enrol >= 0),
  waitlist_enabled boolean NOT NULL DEFAULT true,
  trial_enabled   boolean NOT NULL DEFAULT false,
  prerequisite_ids uuid[] NOT NULL DEFAULT '{}',
  equipment       text,
  coach_ids       uuid[] NOT NULL DEFAULT '{}',
  venue_ids       uuid[] NOT NULL DEFAULT '{}',
  public          boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed','archived')),
  current_version int NOT NULL DEFAULT 0,
  row_version     int NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  CHECK (age_max IS NULL OR age_min IS NULL OR age_max >= age_min)
);
CREATE INDEX IF NOT EXISTS academy_programmes_org ON academy_programmes (organisation_id, status, title);
CREATE INDEX IF NOT EXISTS academy_programmes_public ON academy_programmes (sport, starts_on) WHERE public AND status = 'published';

-- commercial terms snapshot per published version: accepted enrolments keep the version they accepted
CREATE TABLE IF NOT EXISTS academy_programme_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id     uuid NOT NULL REFERENCES academy_programmes,
  version          int NOT NULL,
  billing_model    text NOT NULL DEFAULT 'one_time' CHECK (billing_model IN ('free','one_time','term','monthly','pack')),
  currency         text NOT NULL,
  fee_minor        bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  registration_fee_minor bigint NOT NULL DEFAULT 0 CHECK (registration_fee_minor >= 0),
  trial_fee_minor  bigint NOT NULL DEFAULT 0 CHECK (trial_fee_minor >= 0),
  deposit_minor    bigint NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),
  instalments      int NOT NULL DEFAULT 1 CHECK (instalments BETWEEN 1 AND 24),
  sessions_in_pack int CHECK (sessions_in_pack IS NULL OR sessions_in_pack > 0),
  sibling_discount_bp int NOT NULL DEFAULT 0 CHECK (sibling_discount_bp BETWEEN 0 AND 10000),
  multi_programme_discount_bp int NOT NULL DEFAULT 0 CHECK (multi_programme_discount_bp BETWEEN 0 AND 10000),
  tax_rate_bp      int NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  renewal_terms    text,
  offer_valid_hours int NOT NULL DEFAULT 72 CHECK (offer_valid_hours BETWEEN 1 AND 2160),
  description      text,
  eligibility      jsonb NOT NULL DEFAULT '{}',
  questions        jsonb NOT NULL DEFAULT '[]',
  policy_version_ids uuid[] NOT NULL DEFAULT '{}',
  created_by       uuid REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (programme_id, version),
  CHECK (deposit_minor <= fee_minor)
);

-- versioned policies / waivers; a published version is never edited, a new one supersedes it
CREATE TABLE IF NOT EXISTS org_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  kind            text NOT NULL CHECK (kind IN ('participation','code_of_conduct','refund_policy','media_consent','equipment','pickup','programme_declaration','other')),
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  consent_purpose text CHECK (consent_purpose IS NULL OR consent_purpose IN ('participation','media','contact')),
  current_version int NOT NULL DEFAULT 0,
  archived_at     timestamptz,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_policies_org ON org_policies (organisation_id) WHERE archived_at IS NULL;
CREATE TABLE IF NOT EXISTS org_policy_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id  uuid NOT NULL REFERENCES org_policies,
  version    int NOT NULL,
  body       text NOT NULL CHECK (length(body) BETWEEN 10 AND 20000),
  body_sha256 text NOT NULL,
  requires_reconsent boolean NOT NULL DEFAULT false,
  published_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, version)
);
-- internal acknowledgement record (who, for whom, when, which version). Not a legal e-signature.
CREATE TABLE IF NOT EXISTS org_acknowledgements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version_id uuid NOT NULL REFERENCES org_policy_versions,
  subject_id     uuid NOT NULL REFERENCES users,      -- the athlete the agreement is about
  acknowledged_by uuid NOT NULL REFERENCES users,     -- the adult athlete or the verified guardian
  as_guardian    boolean NOT NULL DEFAULT false,
  body_sha256    text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_version_id, subject_id)
);

CREATE SEQUENCE IF NOT EXISTS academy_waitlist_seq;

-- the admissions funnel: enquiry -> trial -> application -> offer -> enrolled
CREATE TABLE IF NOT EXISTS academy_applications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  programme_id    uuid NOT NULL REFERENCES academy_programmes,
  version_id      uuid REFERENCES academy_programme_versions,
  athlete_id      uuid NOT NULL REFERENCES users,
  applicant_id    uuid NOT NULL REFERENCES users,      -- the athlete or the guardian acting for them
  cohort_id       uuid REFERENCES org_cohorts,
  stage           text NOT NULL DEFAULT 'enquiry' CHECK (stage IN ('enquiry','trial_requested','trial_booked','trial_completed','application_draft','submitted','under_review','offered','waitlisted','declined','offer_accepted','enrolled','withdrawn','expired','cancelled')),
  answers_enc     text,                                  -- application answers, encrypted (field-level)
  waitlist_seq    bigint,
  offer_expires_at timestamptz,
  assignee_id     uuid REFERENCES users,
  next_action_on  date,
  next_action     text,
  tags            text[] NOT NULL DEFAULT '{}',
  decision_reason text,
  idempotency_key text,
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- one live application per athlete and programme; closed stages free the slot
CREATE UNIQUE INDEX IF NOT EXISTS academy_applications_live ON academy_applications (programme_id, athlete_id)
  WHERE stage NOT IN ('declined','withdrawn','expired','cancelled');
CREATE UNIQUE INDEX IF NOT EXISTS academy_applications_idem ON academy_applications (applicant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS academy_applications_org_stage ON academy_applications (organisation_id, stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS academy_applications_waitlist ON academy_applications (programme_id, waitlist_seq) WHERE stage = 'waitlisted';
CREATE INDEX IF NOT EXISTS academy_applications_offers ON academy_applications (offer_expires_at) WHERE stage = 'offered';

CREATE TABLE IF NOT EXISTS academy_application_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES academy_applications,
  from_stage     text,
  to_stage       text NOT NULL,
  actor_id       uuid REFERENCES users,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp()   -- several moves in one transaction keep their order
);
CREATE INDEX IF NOT EXISTS academy_application_events_app ON academy_application_events (application_id, created_at);

-- internal staff notes, never shown to the athlete or guardian
CREATE TABLE IF NOT EXISTS academy_notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  application_id uuid NOT NULL REFERENCES academy_applications,
  author_id      uuid NOT NULL REFERENCES users,
  body_enc       text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_notes_app ON academy_notes (application_id, created_at);

-- what an enrolment costs: price/discount/tax snapshotted at enrolment, one row per instalment
CREATE TABLE IF NOT EXISTS academy_charges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id  uuid REFERENCES org_enrolments,
  application_id uuid REFERENCES academy_applications,   -- a trial fee is raised before any enrolment exists
  organisation_id uuid NOT NULL REFERENCES organisations,
  payer_id      uuid NOT NULL REFERENCES users,
  seq           int NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('registration','deposit','tuition','instalment','trial','pack')),
  due_on        date NOT NULL,
  currency      text NOT NULL,
  gross_minor   bigint NOT NULL CHECK (gross_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  funded_minor  bigint NOT NULL DEFAULT 0 CHECK (funded_minor >= 0),    -- scholarship / bursary / sponsor-funded part, an explicit source
  funding_source text CHECK (funding_source IS NULL OR funding_source IN ('scholarship','bursary','sponsor')),
  funding_ref   text,
  tax_minor     bigint NOT NULL DEFAULT 0,
  amount_minor  bigint NOT NULL CHECK (amount_minor >= 0),               -- what the payer owes
  terms         jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','paid','cancelled','waived','refunded')),
  paid_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (enrolment_id IS NOT NULL OR application_id IS NOT NULL),
  CHECK (funded_minor + discount_minor <= gross_minor)
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_charges_enrolment_seq ON academy_charges (enrolment_id, seq) WHERE enrolment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS academy_charges_trial ON academy_charges (application_id, kind) WHERE enrolment_id IS NULL;
CREATE INDEX IF NOT EXISTS academy_charges_due ON academy_charges (organisation_id, status, due_on);
CREATE INDEX IF NOT EXISTS academy_charges_payer ON academy_charges (payer_id, status, due_on);

-- what was announced, to whom, and how many people it reached (delivery itself goes through the shared jobs/notification outbox)
CREATE TABLE IF NOT EXISTS academy_announcements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  programme_id    uuid REFERENCES academy_programmes,
  stages          text[] NOT NULL,
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 100),
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  audience        int NOT NULL,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_announcements_org ON academy_announcements (organisation_id, created_at DESC);

-- reuse the existing structure
ALTER TABLE org_cohorts ADD COLUMN IF NOT EXISTS programme_id uuid REFERENCES academy_programmes;
ALTER TABLE org_cohorts ADD COLUMN IF NOT EXISTS capacity int CHECK (capacity IS NULL OR capacity > 0);
ALTER TABLE org_enrolments ADD COLUMN IF NOT EXISTS programme_id uuid REFERENCES academy_programmes;
ALTER TABLE org_enrolments ADD COLUMN IF NOT EXISTS version_id uuid REFERENCES academy_programme_versions;
ALTER TABLE org_enrolments ADD COLUMN IF NOT EXISTS application_id uuid REFERENCES academy_applications;
ALTER TABLE org_enrolments ADD COLUMN IF NOT EXISTS ended_reason text;
ALTER TABLE org_enrolments ADD COLUMN IF NOT EXISTS sessions_left int;
ALTER TABLE org_enrolments ADD COLUMN IF NOT EXISTS renewed_from uuid REFERENCES org_enrolments;
CREATE INDEX IF NOT EXISTS org_enrolments_programme ON org_enrolments (programme_id) WHERE programme_id IS NOT NULL;

-- widen enrolment statuses (paused is a non-clinical hold)
DO $$ DECLARE n text; BEGIN
  SELECT conname INTO n FROM pg_constraint WHERE conrelid = 'org_enrolments'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%withdrawn%';
  IF n IS NOT NULL THEN EXECUTE format('ALTER TABLE org_enrolments DROP CONSTRAINT %I', n); END IF;
END $$;
ALTER TABLE org_enrolments ADD CONSTRAINT org_enrolments_status_check CHECK (status IN ('enrolled','withdrawn','paused','completed','graduated','transferred'));

-- tuition is a payable thing
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_purpose_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check CHECK (purpose_type IN ('shop_order','coach_hire','insurance_policy','venue_invoice','wallet_topup','gift_card','venue_plan','appointment','shop_checkout','physio_package','sponsorship_payment','academy_charge'));

-- history is append-only; policy versions and acknowledgements are never edited
CREATE OR REPLACE FUNCTION academy_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS academy_application_events_ao ON academy_application_events;
CREATE TRIGGER academy_application_events_ao BEFORE UPDATE OR DELETE ON academy_application_events FOR EACH ROW EXECUTE FUNCTION academy_append_only();
DROP TRIGGER IF EXISTS academy_programme_versions_ao ON academy_programme_versions;
CREATE TRIGGER academy_programme_versions_ao BEFORE UPDATE OR DELETE ON academy_programme_versions FOR EACH ROW EXECUTE FUNCTION academy_append_only();
DROP TRIGGER IF EXISTS org_policy_versions_ao ON org_policy_versions;
CREATE TRIGGER org_policy_versions_ao BEFORE UPDATE OR DELETE ON org_policy_versions FOR EACH ROW EXECUTE FUNCTION academy_append_only();
DROP TRIGGER IF EXISTS org_acknowledgements_ao ON org_acknowledgements;
CREATE TRIGGER org_acknowledgements_ao BEFORE UPDATE OR DELETE ON org_acknowledgements FOR EACH ROW EXECUTE FUNCTION academy_append_only();
