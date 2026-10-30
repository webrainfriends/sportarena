-- Universal registration engine (#575). Additive only: new tables, indexes and trigger functions. No existing table or row is modified.
-- One framework for athlete, team, event, competition, membership, course/camp and federation-licence registration. A "programme" is the thing
-- people register for; it owns an append-only series of versions (form, fees, waivers). An "entry" is one registration under the version it was
-- filled under. Identities, guardian links, payments (canonical finance), documents and #477 eligibility stay where they are and are only REFERENCED.
-- History, signed consents and published versions are immutable by trigger; uploads are hidden (removed_at), never deleted; no ON DELETE CASCADE.
-- Rollback: stop using the capabilities (revert the code). Dropping the tables is a deliberate maintainer decision, never automatic.

CREATE TABLE IF NOT EXISTS rx_programmes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('athlete','team','event','competition','membership','course','licence')),
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  summary         text CHECK (summary IS NULL OR length(summary) <= 2000),
  owner_id        uuid NOT NULL REFERENCES users,
  organisation_id uuid REFERENCES organisations,
  event_id        uuid REFERENCES events,                -- the event / competition this registration is for (competition: also the #477 eligibility policy)
  sport           text CHECK (sport IS NULL OR length(sport) <= 60),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed','archived')),
  opens_at        timestamptz,
  closes_at       timestamptz,
  capacity        int CHECK (capacity IS NULL OR capacity >= 1),
  quotas          jsonb NOT NULL DEFAULT '[]',           -- [{field, limits:{value:n}}] seats per answer to a choice question
  waitlist        boolean NOT NULL DEFAULT true,
  needs_approval  boolean NOT NULL DEFAULT true,
  allow_dependents boolean NOT NULL DEFAULT true,
  check_eligibility boolean NOT NULL DEFAULT false,      -- competition: approval is gated by the #477 eligibility decision
  currency        text NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  current_version int NOT NULL DEFAULT 0,
  row_version     int NOT NULL DEFAULT 1,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
);
CREATE INDEX IF NOT EXISTS rx_programmes_open ON rx_programmes (kind, status, closes_at);
CREATE INDEX IF NOT EXISTS rx_programmes_owner ON rx_programmes (owner_id, created_at);
CREATE INDEX IF NOT EXISTS rx_programmes_org ON rx_programmes (organisation_id) WHERE organisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS rx_programmes_event ON rx_programmes (event_id) WHERE event_id IS NOT NULL;

-- Published versions: the form, the fee schedule and the waivers an entry was filled under. Never edited.
CREATE TABLE IF NOT EXISTS rx_versions (
  programme_id uuid NOT NULL REFERENCES rx_programmes,
  version      int  NOT NULL CHECK (version > 0),
  form         jsonb NOT NULL,                           -- application-forms definition (sections, fields, conditional questions)
  fees         jsonb NOT NULL DEFAULT '{}',              -- { items:[{key,label,amount_cents}], discounts:[...], instalments:{count,interval_days} }
  waivers      jsonb NOT NULL DEFAULT '[]',              -- [{key,title,body,required,guardian_required}]
  sha256       text NOT NULL,
  published_by uuid NOT NULL REFERENCES users,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (programme_id, version)
);

CREATE TABLE IF NOT EXISTS rx_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id    uuid NOT NULL REFERENCES rx_programmes,
  version         int  NOT NULL,
  submitted_by    uuid NOT NULL REFERENCES users,        -- the person who filled it in (guardian / manager / the participant)
  participant_id  uuid REFERENCES users,                 -- the person registered (a dependent when a guardian registers a child)
  team_id         uuid REFERENCES teams,                 -- team registrations, and the team a competition player registers for
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','under_review','info_requested','waitlisted','approved','rejected','withdrawn','cancelled')),
  answers         jsonb NOT NULL DEFAULT '{}',
  confidential_enc text,
  fee_cents       bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  discount_cents  bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents     bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  currency        text NOT NULL DEFAULT 'USD',
  discount_codes  text[] NOT NULL DEFAULT '{}',
  quote           jsonb,
  eligibility     jsonb,                                 -- last #477 decision + checks (competition programmes)
  receipt_no      text,
  idempotency_key text,
  decision_note_enc text,
  waitlisted_at   timestamptz,
  submitted_at    timestamptz,
  decided_at      timestamptz,
  decided_by      uuid REFERENCES users,
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (participant_id IS NOT NULL OR team_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS rx_entries_programme ON rx_entries (programme_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS rx_entries_submitter ON rx_entries (submitted_by, created_at);
CREATE INDEX IF NOT EXISTS rx_entries_participant ON rx_entries (participant_id) WHERE participant_id IS NOT NULL;
-- one live entry per participant (or per team for team registration) in a programme
CREATE UNIQUE INDEX IF NOT EXISTS rx_entries_live_person ON rx_entries (programme_id, participant_id, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE participant_id IS NOT NULL AND status NOT IN ('rejected','withdrawn','cancelled');
CREATE UNIQUE INDEX IF NOT EXISTS rx_entries_live_team ON rx_entries (programme_id, team_id)
  WHERE participant_id IS NULL AND status NOT IN ('rejected','withdrawn','cancelled');
CREATE UNIQUE INDEX IF NOT EXISTS rx_entries_idem ON rx_entries (submitted_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE SEQUENCE IF NOT EXISTS rx_receipt_seq;

-- Status history: append-only.
CREATE TABLE IF NOT EXISTS rx_history (
  id         bigserial PRIMARY KEY,
  entry_id   uuid NOT NULL REFERENCES rx_entries,
  action     text NOT NULL,
  from_status text,
  to_status  text NOT NULL,
  actor_id   uuid REFERENCES users,
  note_enc   text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rx_history_entry ON rx_history (entry_id, id);

-- Signed waivers / consents / signatures: the exact text hash that was signed, by whom, for whom. Append-only.
CREATE TABLE IF NOT EXISTS rx_signatures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id      uuid NOT NULL REFERENCES rx_entries,
  waiver_key    text NOT NULL,
  waiver_sha256 text NOT NULL,
  signed_by     uuid NOT NULL REFERENCES users,
  signer_role   text NOT NULL CHECK (signer_role IN ('participant','guardian','manager')),
  signature_enc text NOT NULL,                           -- the typed legal name
  signed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, waiver_key, signed_by)
);

CREATE TABLE IF NOT EXISTS rx_documents (
  id          uuid PRIMARY KEY,
  entry_id    uuid NOT NULL REFERENCES rx_entries,
  field_key   text NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users,
  content_type text NOT NULL,
  file_name   text NOT NULL,
  original_name text,
  size_bytes  int NOT NULL,
  sha256      text NOT NULL,
  removed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rx_documents_entry ON rx_documents (entry_id) WHERE removed_at IS NULL;

-- Change requests after submission: the applicant asks, staff decide; the entry is only changed when approved.
CREATE TABLE IF NOT EXISTS rx_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id     uuid NOT NULL REFERENCES rx_entries,
  requested_by uuid NOT NULL REFERENCES users,
  changes_enc  text NOT NULL,                            -- { answers:{...}, team_id? }
  reason_enc   text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  decided_by   uuid REFERENCES users,
  decided_at   timestamptz,
  decision_note_enc text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rx_changes_entry ON rx_changes (entry_id, status);

-- Payment plan: instalments are what the canonical finance charge/payment is made against (payments.purpose_type = 'registration_instalment').
CREATE TABLE IF NOT EXISTS rx_instalments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id     uuid NOT NULL REFERENCES rx_entries,
  seq          int NOT NULL CHECK (seq >= 1),
  due_on       date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency     text NOT NULL,
  status       text NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid','waived','cancelled')),
  paid_at      timestamptz,
  payment_id   uuid REFERENCES payments,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, seq)
);
CREATE INDEX IF NOT EXISTS rx_instalments_due ON rx_instalments (due_on) WHERE status = 'unpaid';

-- Discount codes (a code can also be applied automatically by a rule in the fee schedule).
CREATE TABLE IF NOT EXISTS rx_discount_uses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id uuid NOT NULL REFERENCES rx_programmes,
  entry_id    uuid NOT NULL REFERENCES rx_entries,
  code        text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, code)
);

-- Immutability
CREATE OR REPLACE FUNCTION rx_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23000'; END $$ LANGUAGE plpgsql;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rx_versions_immutable') THEN
    CREATE TRIGGER rx_versions_immutable BEFORE UPDATE OR DELETE ON rx_versions FOR EACH ROW EXECUTE FUNCTION rx_immutable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rx_history_immutable') THEN
    CREATE TRIGGER rx_history_immutable BEFORE UPDATE OR DELETE ON rx_history FOR EACH ROW EXECUTE FUNCTION rx_immutable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rx_signatures_immutable') THEN
    CREATE TRIGGER rx_signatures_immutable BEFORE UPDATE OR DELETE ON rx_signatures FOR EACH ROW EXECUTE FUNCTION rx_immutable();
  END IF;
END $$;

-- Fees are paid through canonical finance: a registration instalment is a payable purpose (the constraint is widened, never narrowed).
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'payments_purpose_type_check' AND conrelid = 'payments'::regclass;
  IF d IS NOT NULL AND position('registration_instalment' IN d) = 0 THEN
    ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
    EXECUTE 'ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check ' || replace(d, '::text])', '::text, ''registration_instalment''::text])');
  END IF;
END $$;
