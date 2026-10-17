-- Legal Services & Matter Management, phase 1 (issue #231): lawyer role and credentials, jurisdiction-pack approvals, permitted
-- discovery, anonymised public requests, private intake with conflict checks, versioned quotes, engagement and matter activation.
-- Additive only: the `lawyer` verification type only widens a CHECK, every other change is a new table. Nothing is converted, narrowed
-- or deleted, and the new tables refuse DELETE (history tables refuse UPDATE too). The pack catalogue lives in code and ships no rows.
ALTER TABLE verification_cases DROP CONSTRAINT IF EXISTS verification_cases_type_check;
ALTER TABLE verification_cases ADD CONSTRAINT verification_cases_type_check CHECK (type IN ('gamer','coach','physio','doctor','sponsor','event','insurer','lawyer'));

-- Qualified local counsel's sign-off for one country's pack. Append-only: the latest row per country is the state; a later 'withdrawn'
-- row switches the regulated workflows off again without erasing that the approval existed.
CREATE TABLE legal_pack_approvals (
  id            bigserial PRIMARY KEY,
  country       text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  pack_version  int  NOT NULL,
  status        text NOT NULL CHECK (status IN ('approved','withdrawn')),
  features      text[] NOT NULL DEFAULT '{}',
  reviewer_name text NOT NULL,
  reviewer_firm text,
  reviewed_on   date NOT NULL,
  note_enc      text,
  recorded_by   uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legal_pack_approvals_country ON legal_pack_approvals (country, id DESC);

-- What a lawyer says they are admitted for. Counts as verified only while an approved, unexpired `lawyer` verification case exists for
-- the same user and jurisdiction (identity, admission and current right to practise are checked there, by a reviewer).
CREATE TABLE legal_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users,
  jurisdiction   text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  region         text,                                   -- state / province / emirate / legal system, as the regulator names it
  regulator      text NOT NULL,
  register_ref_enc text NOT NULL,                        -- admission / roll number
  title          text NOT NULL,
  practice_areas text[] NOT NULL DEFAULT '{}',
  restrictions_enc text,
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX legal_credentials_one ON legal_credentials (user_id, jurisdiction, coalesce(region, '')) WHERE archived_at IS NULL;

-- Permitted public presence. No ratings, win counts or free-consultation flags exist here by design.
CREATE TABLE legal_profiles (
  user_id        uuid PRIMARY KEY REFERENCES users,
  headline       text,
  bio            text,
  languages      text[] NOT NULL DEFAULT '{}',
  delivery_modes text[] NOT NULL DEFAULT '{remote}',
  fee_models     text[] NOT NULL DEFAULT '{}',
  firm_name      text,                                   -- display only; verified firm membership arrives in a later phase
  listed         boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Minimal public request: category, jurisdiction, timeframe, budget. Never names, evidence, medical detail or strategy.
CREATE TABLE legal_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id     uuid NOT NULL REFERENCES users,
  practice_area text NOT NULL,
  jurisdiction  text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  region        text,
  language      text,
  timeframe     text NOT NULL CHECK (timeframe IN ('urgent','this_month','flexible')),
  budget_cents  int CHECK (budget_cents IS NULL OR budget_cents >= 0),
  currency      text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legal_requests_open ON legal_requests (jurisdiction, practice_area, created_at DESC) WHERE status = 'open';

-- A lawyer's response to a public request is only an availability signal to the client: it is not advice and not an engagement.
CREATE TABLE legal_request_responses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES legal_requests,
  lawyer_id  uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, lawyer_id)
);

-- Private consultation request to one lawyer. Booking or paying never creates a professional relationship; only the matter does.
CREATE TABLE legal_intakes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES users,
  lawyer_id     uuid NOT NULL REFERENCES users,
  request_id    uuid REFERENCES legal_requests,
  practice_area text NOT NULL,
  jurisdiction  text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  acting_as     text NOT NULL DEFAULT 'self' CHECK (acting_as IN ('self','team','organisation','event')),
  acting_for_id uuid,
  payer         text NOT NULL DEFAULT 'client' CHECK (payer IN ('client','third_party')),
  summary_enc   text,
  status        text NOT NULL DEFAULT 'conflict_pending' CHECK (status IN ('conflict_pending','conflict_review','conflict_blocked','ready','declined','withdrawn','engaged')),
  declined_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legal_intakes_lawyer ON legal_intakes (lawyer_id, created_at DESC);
CREATE INDEX legal_intakes_client ON legal_intakes (client_id, created_at DESC);

-- Names kept only to run the conflict check. Stored encrypted with a blind index; never shown to another client.
CREATE TABLE legal_intake_parties (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id  uuid NOT NULL REFERENCES legal_intakes,
  lawyer_id  uuid NOT NULL REFERENCES users,
  role       text NOT NULL CHECK (role IN ('client','counterparty','other')),
  name_enc   text NOT NULL,
  name_idx   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legal_intake_parties_idx ON legal_intake_parties (lawyer_id, name_idx);

-- Conflict decisions. Append-only; the latest row is the state. Matches are review flags, never an automated legal conclusion.
CREATE TABLE legal_conflict_checks (
  id          bigserial PRIMARY KEY,
  intake_id   uuid NOT NULL REFERENCES legal_intakes,
  outcome     text NOT NULL CHECK (outcome IN ('requires_review','clear','blocked','waived')),
  match_count int  NOT NULL DEFAULT 0,
  reviewer_id uuid REFERENCES users,           -- NULL = the automatic name match
  reason_enc  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legal_conflict_checks_intake ON legal_conflict_checks (intake_id, id DESC);

-- A quote is versioned: any change is a new version and needs a new acceptance.
CREATE TABLE legal_quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id     uuid NOT NULL REFERENCES legal_intakes,
  version       int  NOT NULL,
  lawyer_id     uuid NOT NULL REFERENCES users,
  fee_model     text NOT NULL CHECK (fee_model IN ('flat','hourly','capped','milestone','retainer')),
  amount_cents  int  NOT NULL CHECK (amount_cents >= 0),
  is_estimate   boolean NOT NULL,
  currency      text NOT NULL,
  tax_cents     int  NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  disbursements_cents int NOT NULL DEFAULT 0 CHECK (disbursements_cents >= 0),
  scope_enc     text NOT NULL,
  exclusions_enc text,
  expires_at    timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','accepted','superseded','withdrawn','expired')),
  accepted_at   timestamptz,
  accepted_by   uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intake_id, version)
);

-- Signed engagement: who accepted, in what capacity, which exact quote version, and the lawyer's own confirmation.
CREATE TABLE legal_engagements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id     uuid NOT NULL UNIQUE REFERENCES legal_intakes,
  quote_id      uuid NOT NULL REFERENCES legal_quotes,
  quote_version int  NOT NULL,
  terms_version text NOT NULL,
  signer_id     uuid NOT NULL REFERENCES users,
  signer_capacity text NOT NULL,
  signed_at     timestamptz NOT NULL DEFAULT now(),
  lawyer_confirmed_at timestamptz,
  lawyer_confirmed_by uuid REFERENCES users
);

CREATE TABLE legal_matters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id     uuid NOT NULL UNIQUE REFERENCES legal_intakes,
  engagement_id uuid NOT NULL REFERENCES legal_engagements,
  client_id     uuid NOT NULL REFERENCES users,
  lawyer_id     uuid NOT NULL REFERENCES users,
  title         text NOT NULL,
  jurisdiction  text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_hold','closed','transferred')),
  activated_at  timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legal_matters_lawyer ON legal_matters (lawyer_id, activated_at DESC);
CREATE INDEX legal_matters_client ON legal_matters (client_id, activated_at DESC);

CREATE OR REPLACE FUNCTION legal_no_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'legal records are never deleted' USING ERRCODE = 'check_violation'; END
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION legal_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'legal history is append-only' USING ERRCODE = 'check_violation'; END
$$ LANGUAGE plpgsql;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['legal_credentials','legal_profiles','legal_requests','legal_request_responses','legal_intakes','legal_intake_parties','legal_quotes','legal_engagements','legal_matters'] LOOP
    EXECUTE format('CREATE TRIGGER %I_no_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION legal_no_delete()', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['legal_pack_approvals','legal_conflict_checks'] LOOP
    EXECUTE format('CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION legal_append_only()', t, t);
  END LOOP;
END $$;
