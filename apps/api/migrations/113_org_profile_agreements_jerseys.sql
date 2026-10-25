-- Organisation profile, agreement workflow and per-scope jersey numbers. Additive only: nothing is dropped, rewritten or cascaded.

-- 1. A real organisation profile (legal identity + contact details). The address lives in `addresses` (owner_kind='organisation').
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS legal_name      text CHECK (legal_name IS NULL OR length(legal_name) <= 160),
  ADD COLUMN IF NOT EXISTS registration_no text CHECK (registration_no IS NULL OR length(registration_no) <= 60),
  ADD COLUMN IF NOT EXISTS tax_id          text CHECK (tax_id IS NULL OR length(tax_id) <= 60),
  ADD COLUMN IF NOT EXISTS website         text CHECK (website IS NULL OR length(website) <= 200),
  ADD COLUMN IF NOT EXISTS contact_email   text CHECK (contact_email IS NULL OR length(contact_email) <= 200),
  ADD COLUMN IF NOT EXISTS contact_phone   text CHECK (contact_phone IS NULL OR length(contact_phone) <= 40),
  ADD COLUMN IF NOT EXISTS description     text CHECK (description IS NULL OR length(description) <= 1000),
  ADD COLUMN IF NOT EXISTS founded_on      date;

-- 2. Agreements: drafted from a template (optionally with AI), reviewed, submitted for approval, approved, then signed copies are uploaded.
-- Approval publishes the text as an org policy (versioned) so the existing acknowledgement flow keeps working; the policy rows are untouched.
CREATE TABLE IF NOT EXISTS org_agreements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations,
  kind             text NOT NULL CHECK (kind IN ('participation','code_of_conduct','refund_policy','media_consent','equipment','pickup','programme_declaration','coaching_services','venue_hire','player_registration','event_participation','other')),
  title            text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  template_key     text,
  body             text NOT NULL DEFAULT '' CHECK (length(body) <= 30000),
  counterparty     text CHECK (counterparty IS NULL OR length(counterparty) <= 160),
  effective_from   date,
  effective_to     date,
  auto_renew       boolean NOT NULL DEFAULT false,
  governing_country text CHECK (governing_country IS NULL OR governing_country ~ '^[A-Z]{2}$'),
  brand_kit_id     uuid REFERENCES brand_kits,
  ai_assisted      boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','changes_requested','approved','rejected','signed')),
  submitted_by     uuid REFERENCES users,
  submitted_at     timestamptz,
  decided_by       uuid REFERENCES users,
  decided_at       timestamptz,
  decision_note    text CHECK (decision_note IS NULL OR length(decision_note) <= 1000),
  document_id      uuid REFERENCES generated_documents,           -- the latest overview PDF
  policy_id        uuid REFERENCES org_policies,                  -- set when approval published it
  created_by       uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,
  row_version      int NOT NULL DEFAULT 1,
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS org_agreements_org ON org_agreements (organisation_id, created_at DESC) WHERE archived_at IS NULL;

-- the parties of an agreement (the organisation itself is implied; these are the others and any extra signatories)
CREATE TABLE IF NOT EXISTS org_agreement_parties (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id uuid NOT NULL REFERENCES org_agreements,
  role         text NOT NULL CHECK (length(role) BETWEEN 1 AND 60),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  user_id      uuid REFERENCES users,
  position     int NOT NULL DEFAULT 0,
  removed_at   timestamptz                       -- parties dropped from the working list are kept, not deleted
);
CREATE INDEX IF NOT EXISTS org_agreement_parties_ag ON org_agreement_parties (agreement_id, position);

-- signed copies, letters and supporting files. Bytes are stored encrypted on disk (doc-store); rows are never deleted.
CREATE TABLE IF NOT EXISTS org_agreement_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id uuid NOT NULL REFERENCES org_agreements,
  kind         text NOT NULL CHECK (kind IN ('signed','supporting')),
  label        text CHECK (label IS NULL OR length(label) <= 120),
  content_type text NOT NULL,
  file_name    text NOT NULL,
  size_bytes   int NOT NULL,
  sha256       text NOT NULL,
  uploaded_by  uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  hidden_at    timestamptz
);
CREATE INDEX IF NOT EXISTS org_agreement_files_ag ON org_agreement_files (agreement_id, created_at DESC);

-- 3. Jersey numbers can differ per team, event, game or tournament. The number on a sport profile / team roster stays the default.
CREATE TABLE IF NOT EXISTS jersey_numbers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users,
  scope_kind text NOT NULL CHECK (scope_kind IN ('team','event','game','tournament')),
  scope_id   uuid NOT NULL,
  number     int NOT NULL CHECK (number BETWEEN 0 AND 999),
  set_by     uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope_kind, scope_id)
);
CREATE INDEX IF NOT EXISTS jersey_numbers_scope ON jersey_numbers (scope_kind, scope_id);
