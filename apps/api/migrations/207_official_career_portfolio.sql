-- 207: Verified Officiating Career Portfolio (REF-R17, Issue #1009)
-- Additive only: no DROP / TRUNCATE / rewrites.
-- Career portfolio built from accepted official engagements.
-- Four concerns:
--   (a) official_portfolio_settings — per-official visibility preferences
--   (b) official_portfolio_milestones — manually-added career highlights
--   (c) official_portfolio_references — references from organisations/bodies
--   (d) official_portfolio_snapshots — immutable export snapshots

-- (a) Portfolio settings — one active row per official
CREATE TABLE IF NOT EXISTS official_portfolio_settings (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid        NOT NULL REFERENCES users(id),
  visibility                text        NOT NULL DEFAULT 'private'
                              CHECK (visibility IN ('public', 'link_only', 'private')),
  show_grades               bool        NOT NULL DEFAULT true,
  show_milestones           bool        NOT NULL DEFAULT true,
  show_references           bool        NOT NULL DEFAULT true,
  show_activity_chart       bool        NOT NULL DEFAULT true,
  show_match_count          bool        NOT NULL DEFAULT true,
  show_federation_recognition bool      NOT NULL DEFAULT true,
  show_education_cpd        bool        NOT NULL DEFAULT false,
  show_assessments_summary  bool        NOT NULL DEFAULT false,
  public_bio_enc            text,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS ops_user ON official_portfolio_settings(user_id);

-- (b) Portfolio milestones — career highlights; immutable after verified
CREATE TABLE IF NOT EXISTS official_portfolio_milestones (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid        NOT NULL REFERENCES users(id),
  sport_id                  uuid        REFERENCES sports(id),
  role                      text        CHECK (length(role) <= 60),
  title                     text        NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  competition_name          text        CHECK (length(competition_name) <= 200),
  milestone_date            date        NOT NULL,
  is_championship           bool        NOT NULL DEFAULT false,
  description_enc           text,
  verifying_org_id          uuid        REFERENCES organisations(id),
  verification_status       text        NOT NULL DEFAULT 'self_declared'
                              CHECK (verification_status IN ('self_declared','pending','verified','rejected')),
  verified_by               uuid        REFERENCES users(id),
  verified_at               timestamptz,
  verify_note               text        CHECK (length(verify_note) <= 500),
  archived_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opm_user     ON official_portfolio_milestones(user_id, archived_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS opm_sport    ON official_portfolio_milestones(sport_id, archived_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS opm_date     ON official_portfolio_milestones(milestone_date DESC);

-- (c) Portfolio references — request / respond workflow
CREATE TABLE IF NOT EXISTS official_portfolio_references (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid        NOT NULL REFERENCES users(id),
  org_id                    uuid        REFERENCES organisations(id),
  body_id                   uuid        REFERENCES organisations(id),
  sport_id                  uuid        REFERENCES sports(id),
  relationship              text        NOT NULL
                              CHECK (relationship IN ('worked_with','supervised','assessed','appointed')),
  contact_name_enc          text,
  contact_email_enc         text,
  request_note_enc          text,
  response_status           text        NOT NULL DEFAULT 'pending'
                              CHECK (response_status IN ('pending','approved','declined','revoked')),
  public_summary            text        CHECK (length(public_summary) <= 300),
  reference_text_enc        text,
  responded_by              uuid        REFERENCES users(id),
  responded_at              timestamptz,
  revoked_at                timestamptz,
  revoked_by                uuid        REFERENCES users(id),
  revoke_reason             text        CHECK (length(revoke_reason) <= 300),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opr_user   ON official_portfolio_references(user_id, response_status);
CREATE INDEX IF NOT EXISTS opr_org    ON official_portfolio_references(org_id, response_status);

-- (d) Portfolio snapshots — immutable export records
CREATE TABLE IF NOT EXISTS official_portfolio_snapshots (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid        NOT NULL REFERENCES users(id),
  sha256                    text        NOT NULL CHECK (length(sha256) = 64),
  file_name                 text        NOT NULL,
  size_bytes                int         NOT NULL CHECK (size_bytes > 0),
  pages                     int         NOT NULL DEFAULT 1,
  sport_filter              uuid        REFERENCES sports(id),
  counts                    jsonb       NOT NULL DEFAULT '{}',
  client_key                text        UNIQUE,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opss_user ON official_portfolio_snapshots(user_id, created_at DESC);
