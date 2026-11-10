-- Official eligibility policy, overrides and conflict-of-interest declarations (issue #1000, REF-R09).
-- Additive only: new columns on events, two new tables. No existing data is changed or removed.

-- Event-level eligibility policy fields (all nullable / defaulted so existing rows are unaffected)
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS official_min_age              INT          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS official_training_required    TEXT[]       NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS official_safeguarding_required BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS official_neutrality_required  BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS official_conflict_declaration_required BOOLEAN NOT NULL DEFAULT FALSE;

-- Discretionary eligibility overrides (organiser bypasses a non-suspension blocking factor)
CREATE TABLE IF NOT EXISTS official_eligibility_overrides (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_official_id  UUID         NOT NULL REFERENCES fixture_officials(id) ON DELETE RESTRICT,
  factor_key           TEXT         NOT NULL,
  reason               TEXT         NOT NULL,
  granted_by           UUID         NOT NULL REFERENCES users(id),
  override_expires_at  TIMESTAMPTZ  NOT NULL,
  revoked_at           TIMESTAMPTZ  DEFAULT NULL,
  revoked_by           UUID         REFERENCES users(id),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT oeo_factor_no_suspension CHECK (factor_key <> 'suspension')
);
CREATE INDEX IF NOT EXISTS oeo_foi_idx ON official_eligibility_overrides(fixture_official_id);

-- Official conflict-of-interest declarations for a specific assignment
CREATE TABLE IF NOT EXISTS official_conflicts (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_official_id  UUID         NOT NULL REFERENCES fixture_officials(id) ON DELETE RESTRICT,
  kind                 TEXT         NOT NULL
                         CHECK (kind IN ('team_relationship','family_member','club_membership','financial_interest','association_connection','previous_involvement','other')),
  serious              BOOLEAN      NOT NULL DEFAULT FALSE,
  counterparty         TEXT,
  detail_enc           TEXT,
  status               TEXT         NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','waived','reassigned','escalated','withdrawn')),
  raised_by            UUID         NOT NULL REFERENCES users(id),
  raised_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  decided_by           UUID         REFERENCES users(id),
  decided_at           TIMESTAMPTZ,
  decision_note_enc    TEXT,
  version              INT          NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS oc_foi_idx  ON official_conflicts(fixture_official_id);
CREATE INDEX IF NOT EXISTS oc_status   ON official_conflicts(status);

CREATE SEQUENCE IF NOT EXISTS oeo_seq;
