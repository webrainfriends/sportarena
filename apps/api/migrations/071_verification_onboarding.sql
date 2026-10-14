-- Onboarding timeline for physios, doctors, insurers and sponsors: adds the `insurer` verification type (additive: the CHECK is only
-- widened, every existing case is kept) and per-document sharing. Evidence stays AES-GCM encrypted; the uploader (owner) can always
-- read it, and anyone else only through an active, revocable, expiring share the owner created. Nothing is deleted: shares are
-- revoked by setting revoked_at.
ALTER TABLE verification_cases DROP CONSTRAINT IF EXISTS verification_cases_type_check;
ALTER TABLE verification_cases ADD CONSTRAINT verification_cases_type_check CHECK (type IN ('gamer','coach','physio','doctor','sponsor','event','insurer'));

CREATE TABLE verification_shares (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES verification_cases,
  evidence_id uuid REFERENCES verification_evidence,   -- NULL = every document on the case at the time of reading
  grantee_id  uuid NOT NULL REFERENCES users,
  granted_by  uuid NOT NULL REFERENCES users,
  purpose     text,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_shares_case ON verification_shares (case_id);
CREATE INDEX verification_shares_grantee ON verification_shares (grantee_id) WHERE revoked_at IS NULL;
