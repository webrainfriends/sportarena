-- Public tournament & spectator experience (#501). The public pages are a PROJECTION of the canonical event / fixture / result / sponsorship / media data:
-- nothing here copies a result or a schedule. This migration only adds (a) the organiser's visibility policy, (b) who follows what, (c) an append-only
-- change log that feeds follower alerts and the "corrected" labels, (d) sponsor placements that point at real sponsorships, and (e) opt-in fan engagement.
-- Additive: no column is dropped or narrowed, no row is deleted; existing events keep today's behaviour (publicly visible once they leave draft).

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS public_visibility     text NOT NULL DEFAULT 'public' CHECK (public_visibility IN ('public', 'unlisted', 'private')),
  ADD COLUMN IF NOT EXISTS public_indexable      boolean NOT NULL DEFAULT false,   -- search engines may index the share page (public events only, never youth events)
  ADD COLUMN IF NOT EXISTS public_reactions      boolean NOT NULL DEFAULT false,   -- fans may react to games
  ADD COLUMN IF NOT EXISTS public_mvp_vote       boolean NOT NULL DEFAULT false,   -- fans may vote for a fan MVP (never an official award)
  ADD COLUMN IF NOT EXISTS public_show_officials boolean NOT NULL DEFAULT false,   -- show accepted match officials on the live centre
  ADD COLUMN IF NOT EXISTS archived_at           timestamptz;                      -- archived events leave discovery but stay reachable by link

CREATE INDEX IF NOT EXISTS events_public_discovery ON events (status, starts_on) WHERE public_visibility = 'public' AND archived_at IS NULL;

-- Who changed the public policy of an event, and how (append-only).
CREATE TABLE IF NOT EXISTS event_public_settings_log (
  id         bigserial PRIMARY KEY,
  event_id   uuid NOT NULL REFERENCES events,
  actor_id   uuid NOT NULL REFERENCES users,
  changes    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_public_settings_log_event ON event_public_settings_log (event_id, created_at DESC);

-- ------------------------------------------------------------------ following (grants no private access: it only subscribes to public alerts)
CREATE TABLE IF NOT EXISTS spectator_follows (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users,
  subject_type text NOT NULL CHECK (subject_type IN ('event', 'team', 'athlete', 'fixture')),
  subject_id   uuid NOT NULL,
  alerts       text[] NOT NULL DEFAULT '{start,result,schedule}' CHECK (alerts <@ ARRAY['start', 'score', 'result', 'schedule']::text[]),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  UNIQUE (user_id, subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS spectator_follows_subject ON spectator_follows (subject_type, subject_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS spectator_follows_user ON spectator_follows (user_id) WHERE removed_at IS NULL;

-- ------------------------------------------------------------------ change log: what changed on a game, as the public sees it (append-only)
-- Written by triggers so every path (organiser edit, referee result, score sheet, live scoring) is covered without touching those capabilities.
-- A correction is a new row; the earlier official state stays in `before`.
CREATE TABLE IF NOT EXISTS fixture_public_changes (
  id           bigserial PRIMARY KEY,
  fixture_id   uuid NOT NULL REFERENCES fixtures,
  event_id     uuid NOT NULL REFERENCES events,
  kind         text NOT NULL CHECK (kind IN ('status', 'schedule', 'result', 'live')),
  was_final    boolean NOT NULL DEFAULT false,           -- the game was already completed (official) when this change was made = a correction
  before       jsonb,
  after        jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz                                 -- follower alerts for this change have been queued
);
CREATE INDEX IF NOT EXISTS fixture_public_changes_pending ON fixture_public_changes (id) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS fixture_public_changes_fixture ON fixture_public_changes (fixture_id, id DESC);

CREATE OR REPLACE FUNCTION fixture_public_changes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fixture_public_changes is append-only'; END IF;
  IF (OLD.id, OLD.fixture_id, OLD.event_id, OLD.kind, OLD.was_final, OLD.before, OLD.after, OLD.created_at) IS DISTINCT FROM (NEW.id, NEW.fixture_id, NEW.event_id, NEW.kind, NEW.was_final, NEW.before, NEW.after, NEW.created_at)
    THEN RAISE EXCEPTION 'fixture_public_changes is append-only'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fixture_public_changes_guard ON fixture_public_changes;
CREATE TRIGGER fixture_public_changes_guard BEFORE UPDATE OR DELETE ON fixture_public_changes FOR EACH ROW EXECUTE FUNCTION fixture_public_changes_guard();

CREATE OR REPLACE FUNCTION fixture_public_log() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE final_before boolean := OLD.status = 'completed';
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO fixture_public_changes(fixture_id, event_id, kind, was_final, before, after)
    VALUES (NEW.id, NEW.event_id, 'status', final_before, jsonb_build_object('status', OLD.status), jsonb_build_object('status', NEW.status));
  END IF;
  IF NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at OR NEW.resource_id IS DISTINCT FROM OLD.resource_id THEN
    INSERT INTO fixture_public_changes(fixture_id, event_id, kind, was_final, before, after)
    VALUES (NEW.id, NEW.event_id, 'schedule', final_before, jsonb_build_object('scheduled_at', OLD.scheduled_at, 'resource_id', OLD.resource_id), jsonb_build_object('scheduled_at', NEW.scheduled_at, 'resource_id', NEW.resource_id));
  END IF;
  IF NEW.home_score IS DISTINCT FROM OLD.home_score OR NEW.away_score IS DISTINCT FROM OLD.away_score OR NEW.winner_team_id IS DISTINCT FROM OLD.winner_team_id THEN
    INSERT INTO fixture_public_changes(fixture_id, event_id, kind, was_final, before, after)
    VALUES (NEW.id, NEW.event_id, 'result', final_before,
            jsonb_build_object('home_score', OLD.home_score, 'away_score', OLD.away_score, 'winner_team_id', OLD.winner_team_id),
            jsonb_build_object('home_score', NEW.home_score, 'away_score', NEW.away_score, 'winner_team_id', NEW.winner_team_id));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fixture_public_log ON fixtures;
CREATE TRIGGER fixture_public_log AFTER UPDATE ON fixtures FOR EACH ROW EXECUTE FUNCTION fixture_public_log();

-- live scoring: any logged or voided match event marks the game "touched"; the alert sweep computes the score at that moment
CREATE OR REPLACE FUNCTION match_event_public_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO fixture_public_changes(fixture_id, event_id, kind, after) VALUES (NEW.fixture_id, NEW.event_id, 'live', jsonb_build_object('seq', NEW.seq));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS match_event_public_log ON match_events;
CREATE TRIGGER match_event_public_log AFTER INSERT OR UPDATE OF voided_at ON match_events FOR EACH ROW EXECUTE FUNCTION match_event_public_log();

-- the last score a follower was told about, so a burst of events sends one alert and a correction that does not change the score sends none
CREATE TABLE IF NOT EXISTS fixture_alert_state (
  fixture_id uuid PRIMARY KEY REFERENCES fixtures,
  last_score jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ sponsor placements: a slot on the public pages given to a REAL active sponsorship of the event
CREATE TABLE IF NOT EXISTS event_sponsor_placements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events,
  sponsorship_id uuid NOT NULL REFERENCES sponsorships,
  slot           text NOT NULL CHECK (slot IN ('title_partner', 'fixture', 'scorecard', 'leaderboard')),
  fixture_id     uuid REFERENCES fixtures,
  cta_label      text CHECK (cta_label IS NULL OR length(cta_label) BETWEEN 2 AND 40),
  cta_url        text CHECK (cta_url IS NULL OR cta_url ~ '^https://'),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  ended_by       uuid REFERENCES users,
  CHECK ((slot = 'fixture') = (fixture_id IS NOT NULL)),
  CHECK ((cta_label IS NULL) = (cta_url IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS event_sponsor_placements_slot ON event_sponsor_placements (event_id, slot, coalesce(fixture_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS event_sponsor_placements_event ON event_sponsor_placements (event_id) WHERE status = 'active';

-- Measured exposure only: a count each time a public response carried the placement, and each time a visitor followed its call to action. No estimates.
CREATE TABLE IF NOT EXISTS placement_daily_counts (
  placement_id uuid NOT NULL REFERENCES event_sponsor_placements,
  day          date NOT NULL,
  impressions  integer NOT NULL DEFAULT 0,
  clicks       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (placement_id, day)
);

-- ------------------------------------------------------------------ fan engagement (only where the organiser switched it on; never an official result or award)
CREATE TABLE IF NOT EXISTS fixture_reactions (
  fixture_id uuid NOT NULL REFERENCES fixtures,
  user_id    uuid NOT NULL REFERENCES users,
  emoji      text NOT NULL CHECK (emoji IN ('fire', 'clap', 'wow', 'strong')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fixture_id, user_id)
);
CREATE TABLE IF NOT EXISTS fixture_mvp_votes (
  fixture_id   uuid NOT NULL REFERENCES fixtures,
  voter_id     uuid NOT NULL REFERENCES users,
  candidate_id uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fixture_id, voter_id)
);
CREATE INDEX IF NOT EXISTS fixture_mvp_votes_candidate ON fixture_mvp_votes (fixture_id, candidate_id);

-- every write a spectator makes counts against a per-person hourly allowance (stops vote stuffing and reaction floods)
CREATE TABLE IF NOT EXISTS spectator_actions (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users,
  kind       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS spectator_actions_user ON spectator_actions (user_id, created_at DESC);
