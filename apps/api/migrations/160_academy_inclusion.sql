-- Academy OS P2 / Gap 28 (#808): inclusive & adaptive academy programmes.
-- Additive and backwards-compatible. Nothing is dropped, rewritten or narrowed and no row is seeded. Athletes, guardians, programmes, cohorts, sessions, staff,
-- venues, para classification (#488), pathways and assessments (#103) and the health domain stay where they are; this migration adds only what did not exist:
--   1. a programme's inclusion profile (eligibility mode, offered adjustments, resource requirements) - no diagnosis field anywhere,
--   2. structured venue access features (the venue only had an "accessibility" licence kind),
--   3. accommodation shares: the athlete's (or guardian's) own, minimal, operational flags with an audience, an expiry and immediate revocation,
--   4. an append-only inclusion log (every grant, revoke and every time staff opened a share is recorded),
--   5. adapted, coach-led assessments with descriptor levels (never a numeric score) and a second-assessor sign-off.
-- Clinical detail has NO column here by design: it stays in the Health workflow. Rollback: every statement is idempotent; deploy the previous build (it ignores
-- the new tables). No data has to be removed.

-- 1. Programme inclusion profile (one live row per programme; every change bumps the version, the previous values are in the log).
CREATE TABLE IF NOT EXISTS academy_programme_inclusion (
  programme_id     uuid PRIMARY KEY REFERENCES academy_programmes,
  organisation_id  uuid NOT NULL REFERENCES organisations,
  eligibility_mode text NOT NULL DEFAULT 'open' CHECK (eligibility_mode IN ('open','class_optional','class_required','mixed_ability')),
  class_schemes    text[] NOT NULL DEFAULT '{}',
  sport_templates  text[] NOT NULL DEFAULT '{}',
  offered_needs    text[] NOT NULL DEFAULT '{}',
  requirements     jsonb  NOT NULL DEFAULT '{}',   -- { venue_features[], staff_credential, support_ratio, duty_cover[] }
  pathway_variants text[] NOT NULL DEFAULT '{standard}',
  version          int    NOT NULL DEFAULT 1,
  row_version      int    NOT NULL DEFAULT 1,
  updated_by       uuid NOT NULL REFERENCES users,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_programme_inclusion_org ON academy_programme_inclusion (organisation_id);

-- 2. Venue access features, verified by the venue's own manager. Retired, never deleted.
CREATE TABLE IF NOT EXISTS academy_venue_access_features (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    uuid NOT NULL REFERENCES venues,
  feature     text NOT NULL,
  verified_by uuid NOT NULL REFERENCES users,
  verified_at timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_venue_access_live ON academy_venue_access_features (venue_id, feature) WHERE retired_at IS NULL;

-- 3. Accommodation shares. need_keys come from the fixed catalogue (src/inclusion.js); the optional note is screened and encrypted.
CREATE TABLE IF NOT EXISTS academy_accommodation_shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  athlete_id      uuid NOT NULL REFERENCES users,
  need_keys       text[] NOT NULL CHECK (cardinality(need_keys) BETWEEN 1 AND 12),
  note_enc        text,
  audience_users  uuid[] NOT NULL DEFAULT '{}',
  audience_roles  text[] NOT NULL DEFAULT '{}' CHECK (audience_roles <@ ARRAY['coach','venue']),
  granted_by      uuid NOT NULL REFERENCES users,
  granted_as      text NOT NULL CHECK (granted_as IN ('self','guardian')),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(audience_users) + cardinality(audience_roles) > 0)
);
CREATE INDEX IF NOT EXISTS academy_accommodation_shares_athlete ON academy_accommodation_shares (organisation_id, athlete_id) WHERE revoked_at IS NULL;

-- 4. Append-only inclusion log. Contains ids and codes only, never a note.
CREATE TABLE IF NOT EXISTS academy_inclusion_events (
  id              bigserial PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations,
  athlete_id      uuid REFERENCES users,
  kind            text NOT NULL,
  actor_id        uuid REFERENCES users,
  ref_type        text,
  ref_id          uuid,
  detail          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_inclusion_events_athlete ON academy_inclusion_events (organisation_id, athlete_id, created_at DESC);

-- 5. Adapted, coach-led assessment layered on the canonical academy_assessments row (outcome, review and appeal stay there).
CREATE TABLE IF NOT EXISTS academy_adapted_assessments (
  assessment_id   uuid PRIMARY KEY REFERENCES academy_assessments,
  organisation_id uuid NOT NULL REFERENCES organisations,
  athlete_id      uuid NOT NULL REFERENCES users,
  pathway_variant text NOT NULL DEFAULT 'adapted' CHECK (pathway_variant IN ('standard','adapted','age_flexible')),
  descriptors     jsonb NOT NULL,                  -- [{ dimension_key, label, level: emerging|developing|secure|exceeding, evidence_ref? }]
  note_enc        text,
  adapted_by      uuid NOT NULL REFERENCES users,
  signed_off_by   uuid REFERENCES users,
  signed_off_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (signed_off_by IS NULL OR signed_off_by <> adapted_by)
);
