-- Insurance marketplace: venues can be insured too, a request can carry a city (insurers see it on the Billboard),
-- and teams / events / venues get a documents folder (approved or paid policies, certificates, receipts).
-- Additive only: constraints are widened, nothing is dropped or rewritten, nothing is deleted.

ALTER TABLE insurance_plans          DROP CONSTRAINT IF EXISTS insurance_plans_cover_for_check;
ALTER TABLE insurance_plans          ADD  CONSTRAINT insurance_plans_cover_for_check CHECK (cover_for IN ('individual','team','event','venue'));
ALTER TABLE insurance_policies       DROP CONSTRAINT IF EXISTS insurance_policies_subject_type_check;
ALTER TABLE insurance_policies       ADD  CONSTRAINT insurance_policies_subject_type_check CHECK (subject_type IN ('individual','team','event','venue'));
ALTER TABLE insurance_quote_requests DROP CONSTRAINT IF EXISTS insurance_quote_requests_cover_for_check;
ALTER TABLE insurance_quote_requests ADD  CONSTRAINT insurance_quote_requests_cover_for_check CHECK (cover_for IN ('individual','team','event','venue'));
ALTER TABLE insurance_quotes         DROP CONSTRAINT IF EXISTS insurance_quotes_cover_for_check;
ALTER TABLE insurance_quotes         ADD  CONSTRAINT insurance_quotes_cover_for_check CHECK (cover_for IN ('individual','team','event','venue'));

ALTER TABLE insurance_quote_requests ADD COLUMN IF NOT EXISTS city text;

-- The open marketplace (the Billboard's Insurance tab) reads open requests newest first.
CREATE INDEX IF NOT EXISTS insurance_quote_requests_open ON insurance_quote_requests (created_at DESC) WHERE insurer_id IS NULL AND status IN ('open','quoted');

-- Documents that belong to a team, event or venue. A row either holds its own encrypted file (file_name) or points at a
-- document an insurer / the holder already stored with a policy (insurance_document_id), so nothing is copied twice.
-- Files are never deleted: removed_at hides a row.
CREATE TABLE IF NOT EXISTS subject_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type          text NOT NULL CHECK (subject_type IN ('team','event','venue')),
  subject_id            uuid NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('policy','certificate','receipt','quote','other')),
  title                 text NOT NULL,
  policy_id             uuid REFERENCES insurance_policies,
  insurance_document_id uuid REFERENCES insurance_documents,
  content_type          text,
  file_name             text,
  size_bytes            bigint,
  sha256                text,
  uploaded_by           uuid NOT NULL REFERENCES users,
  removed_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (file_name IS NOT NULL OR insurance_document_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS subject_documents_subject ON subject_documents (subject_type, subject_id, created_at DESC) WHERE removed_at IS NULL;
