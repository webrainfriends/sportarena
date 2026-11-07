-- PS-21: Para-sport coach, official and classifier learning credentials.
-- Additive only. No existing tables are dropped, truncated, narrowed or rewritten.
-- Rollback = deploy the previous code: it ignores these tables and the new column.

-- ------------------------------------------------------------------ track catalogue
-- A para_staff_track defines one professional development track for a staff role
-- (adaptive coach, para referee, technical official, guide/support, classifier candidate).
-- Authority to issue credentials for a track belongs to its publisher body/org only.
-- course completion NEVER grants classifier privilege; that sole arbiter is para-governance (#488).
CREATE TABLE IF NOT EXISTS para_staff_tracks (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id          UUID        REFERENCES sports(id),
  discipline        TEXT        NOT NULL DEFAULT '',
  role_category     TEXT        NOT NULL
                                CHECK (role_category IN (
                                  'adaptive_coach','para_referee','technical_official',
                                  'guide_support','classifier_candidate')),
  title             TEXT        NOT NULL,
  summary           TEXT,
  level_key         TEXT        CHECK (level_key IN ('foundation','intermediate','advanced')),
  credential_kind   TEXT        NOT NULL DEFAULT 'certificate'
                                CHECK (credential_kind IN ('certificate','badge','diploma','course')),
  renewal_months    INT         CHECK (renewal_months IS NULL OR renewal_months > 0),
  publisher_body_id UUID        REFERENCES governing_bodies(id),
  publisher_org_id  UUID        REFERENCES organisations(id),
  scope_countries   TEXT[]      NOT NULL DEFAULT '{}',
  status            TEXT        NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft','published','retired')),
  published_at      TIMESTAMPTZ,
  retired_at        TIMESTAMPTZ,
  created_by        UUID        NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT publisher_required
    CHECK (publisher_body_id IS NOT NULL OR publisher_org_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS para_staff_tracks_sport
  ON para_staff_tracks(sport_id, role_category, status);
CREATE INDEX IF NOT EXISTS para_staff_tracks_body
  ON para_staff_tracks(publisher_body_id, status)
  WHERE publisher_body_id IS NOT NULL;
COMMENT ON TABLE para_staff_tracks IS
  'PS-21: catalogue of governed professional development tracks for para-sport staff roles. '
  'completion of a track issues a learning credential only — never a governing-body role. '
  'Classifier privilege stays in para-governance / para-cases (#488) exclusively.';

-- ------------------------------------------------------------------ prerequisites
CREATE TABLE IF NOT EXISTS para_staff_track_prerequisites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id   UUID NOT NULL REFERENCES para_staff_tracks(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL
             CHECK (kind IN ('track','credential_kind','min_experience_months','role')),
  value      TEXT NOT NULL,
  label      TEXT NOT NULL,
  sort_order INT  NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS para_staff_track_prereqs_track
  ON para_staff_track_prerequisites(track_id, sort_order);
COMMENT ON TABLE para_staff_track_prerequisites IS
  'PS-21: prerequisites for a para_staff_track. '
  'kind=track: prior track id required; kind=credential_kind: any credential of this kind; '
  'kind=min_experience_months: minimum months in the role; kind=role: system role name required.';

-- ------------------------------------------------------------------ link issued credential -> track
-- Extends the existing credentials table (additive ALTER; backward-compatible).
-- A NULL para_track_id means a non-para-staff credential (all existing rows stay valid).
ALTER TABLE credentials
  ADD COLUMN IF NOT EXISTS para_track_id UUID
  REFERENCES para_staff_tracks(id);
CREATE INDEX IF NOT EXISTS credentials_para_track
  ON credentials(para_track_id, user_id)
  WHERE para_track_id IS NOT NULL;
COMMENT ON COLUMN credentials.para_track_id IS
  'PS-21: the para_staff_track this credential was issued against. NULL = not a para-staff credential. '
  'classifier_candidate credentials have classification_candidate_only=true in their metadata column.';

-- metadata column for classifier-candidate flag and renewal info
ALTER TABLE credentials
  ADD COLUMN IF NOT EXISTS para_meta JSONB;
COMMENT ON COLUMN credentials.para_meta IS
  'PS-21: { classification_candidate_only: bool, role_category: str, renewal_months: int, '
  'scope_countries: str[], track_title: str, publisher: str }. NULL for non-para-staff credentials.';

-- ------------------------------------------------------------------ renewal reminder acknowledgements
CREATE TABLE IF NOT EXISTS para_staff_cred_reminders (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id UUID        NOT NULL REFERENCES credentials(id),
  user_id       UUID        NOT NULL REFERENCES users(id),
  acknowledged  BOOLEAN     NOT NULL DEFAULT FALSE,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ack_at        TIMESTAMPTZ,
  UNIQUE (credential_id, sent_at)
);
CREATE INDEX IF NOT EXISTS para_staff_cred_reminders_user
  ON para_staff_cred_reminders(user_id, acknowledged)
  WHERE NOT acknowledged;
COMMENT ON TABLE para_staff_cred_reminders IS
  'PS-21: tracks expiry reminder notifications for para_staff credentials. '
  'acknowledged=false means the person has been notified but not acknowledged.';
