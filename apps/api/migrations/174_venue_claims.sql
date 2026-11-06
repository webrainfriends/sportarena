-- Venue claim flow (#697): a verified owner claims an existing listing.
-- Additive only. Soft statuses. No personal data deleted. Two concurrent claimants are handled safely via
-- conflict_with_id and the unique partial index that prevents a user from having two active claims for the same venue.

CREATE TABLE venue_claims (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_no          text NOT NULL UNIQUE,              -- human reference, e.g. CLM-000001
  venue_id          uuid NOT NULL REFERENCES venues,
  claimant_id       uuid NOT NULL REFERENCES users,
  role              text NOT NULL CHECK (role IN ('owner','manager','authorized_agent')),
  status            text NOT NULL DEFAULT 'submitted'
                       CHECK (status IN ('submitted','under_review','additional_docs_requested',
                                        'approved','rejected','disputed','withdrawn')),
  statement_enc     text,                              -- claimant's written statement: field-level encrypted, audit-logged on read
  reviewer_id       uuid REFERENCES users,
  reviewed_at       timestamptz,
  decision_note     text,                              -- permanent audit record (required on approve/reject)
  conflict_with_id  uuid REFERENCES venue_claims,     -- set when two active claimants exist for same venue
  dispute_reason    text,
  dispute_at        timestamptz,
  withdrawn_at      timestamptz,
  submitted_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- A user can hold at most one active claim per venue (rejected/withdrawn are archived and do not block re-claims).
CREATE UNIQUE INDEX venue_claims_one_active_per_claimant
  ON venue_claims (venue_id, claimant_id)
  WHERE status NOT IN ('rejected','withdrawn');

CREATE INDEX venue_claims_venue ON venue_claims (venue_id, submitted_at DESC);
CREATE INDEX venue_claims_status ON venue_claims (status, submitted_at DESC) WHERE status NOT IN ('approved','rejected','withdrawn');
CREATE SEQUENCE claim_no_seq;

-- ---------------------------------------------------------------- documents

CREATE TABLE venue_claim_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id    uuid NOT NULL REFERENCES venue_claims ON DELETE RESTRICT,
  kind        text NOT NULL CHECK (kind IN ('title_deed','lease_agreement','trade_licence',
                                            'tax_registration','id_proof','authorisation_letter','other')),
  label       text,
  file_key    text NOT NULL,                           -- storage key; not a public URL; PII access goes via signed-URL generation
  mime_type   text,
  size_bytes  bigint,
  verified    boolean NOT NULL DEFAULT false,
  verified_by uuid REFERENCES users,
  verified_at timestamptz,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claim_docs_claim ON venue_claim_documents (claim_id);

-- ---------------------------------------------------------------- immutable event timeline

CREATE TABLE venue_claim_events (
  id         bigserial PRIMARY KEY,
  claim_id   uuid NOT NULL REFERENCES venue_claims,
  actor_id   uuid REFERENCES users,
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claim_events_claim ON venue_claim_events (claim_id, id DESC);

-- ---------------------------------------------------------------- venue listing safety columns

ALTER TABLE venues ADD COLUMN IF NOT EXISTS claim_status text NOT NULL DEFAULT 'unclaimed'
  CHECK (claim_status IN ('unclaimed','pending','claimed'));
ALTER TABLE venues ADD COLUMN IF NOT EXISTS claimed_by  uuid REFERENCES users;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS claimed_at  timestamptz;

-- Partial index — the platform query for unclaimed/pending listings stays fast; claimed venues drop out automatically.
CREATE INDEX venues_claim_status ON venues (claim_status) WHERE claim_status <> 'claimed';
