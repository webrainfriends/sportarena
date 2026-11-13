-- Official Credential Verification Hub (#993 REF-R02). Additive only.
-- Extends fed_licences with scope, disciplines, region, encrypted private proof and profile badge flag.
-- Adds official_cred_reviews for the federation reviewer workflow.
-- Extends official_profile_credentials with encrypted private proof.

ALTER TABLE fed_licences ADD COLUMN IF NOT EXISTS scope           varchar(32)  NOT NULL DEFAULT 'national' CHECK (scope IN ('international','national','regional','district','club'));
ALTER TABLE fed_licences ADD COLUMN IF NOT EXISTS disciplines     text[]       NOT NULL DEFAULT '{}';
ALTER TABLE fed_licences ADD COLUMN IF NOT EXISTS region          text         CHECK (region IS NULL OR length(region) BETWEEN 1 AND 120);
ALTER TABLE fed_licences ADD COLUMN IF NOT EXISTS private_proof_enc text;
ALTER TABLE fed_licences ADD COLUMN IF NOT EXISTS badge_on_profile boolean      NOT NULL DEFAULT false;

ALTER TABLE official_profile_credentials ADD COLUMN IF NOT EXISTS private_proof_enc text;
ALTER TABLE official_profile_credentials ADD COLUMN IF NOT EXISTS fed_licence_id uuid REFERENCES fed_licences(id);
ALTER TABLE official_profile_credentials ADD COLUMN IF NOT EXISTS badge_on_profile boolean NOT NULL DEFAULT false;
ALTER TABLE official_profile_credentials ADD COLUMN IF NOT EXISTS scope varchar(32) DEFAULT 'national';

-- Reviewer workflow for federation-issued credentials
CREATE TABLE IF NOT EXISTS official_cred_reviews (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fed_licence_id   uuid        NOT NULL REFERENCES fed_licences(id),
  reviewer_user_id uuid        REFERENCES users(id),
  reviewer_org_id  uuid        REFERENCES organisations(id),
  status           varchar(32) NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','under_review','info_requested','approved','rejected','withdrawn')),
  checklist        jsonb       NOT NULL DEFAULT '{}',
  reviewer_notes_enc text,
  decision_at      timestamptz,
  request_no       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS official_cred_reviews_licence_idx  ON official_cred_reviews(fed_licence_id);
CREATE INDEX IF NOT EXISTS official_cred_reviews_reviewer_idx ON official_cred_reviews(reviewer_org_id, status);
CREATE INDEX IF NOT EXISTS official_cred_reviews_status_idx   ON official_cred_reviews(status, created_at) WHERE status IN ('pending','under_review','info_requested');
