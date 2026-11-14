-- Fan & Community Feed — sport challenges (issue #522). Additive only; no data removed.
-- Challenges are organisation/team-driven activities with explicit rules and eligible evidence.
-- Unsafe challenges (overtraining, weight-loss competitions, medical behaviour) are blocked in the capability layer.
-- Sponsored challenges link to the existing commercial/sponsorship infrastructure via sponsor_id.
-- Youth participants require guardian consent (checked in capability via guardian_links).

CREATE TABLE IF NOT EXISTS feed_challenges (
  id               uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id           uuid        NOT NULL REFERENCES organisations,
  created_by       uuid        NOT NULL REFERENCES users,
  title            text        NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description_enc  text,       -- encrypted free text description
  sport_id         uuid        REFERENCES sports,
  kind             text        NOT NULL DEFAULT 'activity' CHECK (kind IN ('participation_streak','activity','skill','community')),
  rules            jsonb       NOT NULL DEFAULT '[]',    -- [{rule, description, metric?, threshold?}]
  eligible_evidence jsonb      NOT NULL DEFAULT '[]',   -- [{kind: 'video'|'photo'|'strava_activity'|'manual', description}]
  start_at         timestamptz NOT NULL,
  end_at           timestamptz NOT NULL,
  is_sponsored     boolean     NOT NULL DEFAULT false,
  sponsor_id       uuid,
  disclosure_text_enc text,    -- encrypted sponsored disclosure copy, e.g. "Paid partnership with Acme Sports"
  quota            int,        -- NULL = unlimited participants
  status           text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed','archived')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS feed_challenges_org    ON feed_challenges (org_id, status, start_at DESC);
CREATE INDEX IF NOT EXISTS feed_challenges_sport  ON feed_challenges (sport_id, status, start_at DESC) WHERE sport_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS feed_challenges_active ON feed_challenges (start_at DESC) WHERE status = 'active' AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS feed_challenge_entries (
  id                uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  challenge_id      uuid        NOT NULL REFERENCES feed_challenges,
  participant_id    uuid        NOT NULL REFERENCES users,
  participant_kind  text        NOT NULL DEFAULT 'athlete' CHECK (participant_kind IN ('athlete','team')),
  evidence_url_enc  text,       -- encrypted URL or reference to uploaded evidence
  evidence_kind     text        CHECK (evidence_kind IN ('video','photo','strava_activity','manual', NULL)),
  submitted_at      timestamptz,
  status            text        NOT NULL DEFAULT 'entered' CHECK (status IN ('entered','submitted','verified','rejected','withdrawn')),
  verified_by       uuid        REFERENCES users,
  verified_at       timestamptz,
  notes_enc         text,       -- encrypted moderator notes
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (challenge_id, participant_id)
);
CREATE INDEX IF NOT EXISTS feed_challenge_entries_challenge  ON feed_challenge_entries (challenge_id, status);
CREATE INDEX IF NOT EXISTS feed_challenge_entries_participant ON feed_challenge_entries (participant_id);

-- Leaderboard: updated by org staff or automated on evidence verification.
CREATE TABLE IF NOT EXISTS feed_challenge_leaderboard (
  challenge_id      uuid        NOT NULL REFERENCES feed_challenges,
  participant_id    uuid        NOT NULL REFERENCES users,
  participant_kind  text        NOT NULL DEFAULT 'athlete' CHECK (participant_kind IN ('athlete','team')),
  rank              int         NOT NULL DEFAULT 0,
  score             numeric     NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, participant_id)
);
CREATE INDEX IF NOT EXISTS feed_challenge_leaderboard_rank ON feed_challenge_leaderboard (challenge_id, rank ASC);
