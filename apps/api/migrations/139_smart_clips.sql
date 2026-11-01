-- AI highlights & smart clips (#505): score-synchronised candidate moments, a reviewed clip workflow, player links, event reels with sponsor bumpers,
-- and a usage ledger for the commercial entitlement engine (#504).
-- Additive only: new tables and nullable columns. Nothing is dropped, rewritten or deleted; withdrawal and voiding are status changes.
-- A finished clip is NOT a parallel asset store: it is an mr_assets row (kind 'clip'), so rights, embargo, takedown and youth media consent stay in one place.
-- Rollback note: these tables can be left in place (nothing else depends on them); to roll back the feature, stop calling the smart-clip capabilities.

-- How the time of a source recording maps to the time of play. media_t = anchor_media_s + (play_time - anchor_play_time) * rate.
--   wall_clock: play_time is the wall clock instant an event happened (anchor_at); good for any sport, including heats and fields.
--   game_clock: play_time is the game clock inside one period (anchor_period + anchor_clock_s); only events of that period can be placed.
-- `lag_s` is how many seconds after the action the scorer typically recorded it (events are placed that much earlier on the media).
-- A newer alignment supersedes the old one; the old row stays as history.
CREATE TABLE IF NOT EXISTS clip_alignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events,
  fixture_id       uuid REFERENCES fixtures,
  session_id       uuid REFERENCES event_sessions,
  source_asset_id  uuid NOT NULL REFERENCES mr_assets,
  method           text NOT NULL CHECK (method IN ('wall_clock', 'game_clock')),
  anchor_media_s   numeric(10,2) NOT NULL CHECK (anchor_media_s >= 0),
  anchor_at        timestamptz,
  anchor_period    integer CHECK (anchor_period IS NULL OR anchor_period >= 0),
  anchor_clock_s   integer CHECK (anchor_clock_s IS NULL OR anchor_clock_s >= 0),
  rate             numeric(8,5) NOT NULL DEFAULT 1 CHECK (rate BETWEEN 0.5 AND 2),
  lag_s            numeric(6,2) NOT NULL DEFAULT 0 CHECK (lag_s BETWEEN 0 AND 120),
  note             text CHECK (note IS NULL OR length(note) <= 300),
  created_by       uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  superseded_at    timestamptz,
  CHECK ((fixture_id IS NOT NULL) <> (session_id IS NOT NULL)),
  CHECK ((method = 'wall_clock' AND anchor_at IS NOT NULL) OR (method = 'game_clock' AND anchor_period IS NOT NULL AND anchor_clock_s IS NOT NULL AND fixture_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS clip_alignments_current ON clip_alignments (source_asset_id) WHERE superseded_at IS NULL;

-- A scorer / organiser bookmark: "something worth clipping happened about now". It is a pointer into play, never a scoring fact.
CREATE TABLE IF NOT EXISTS clip_bookmarks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events,
  fixture_id    uuid REFERENCES fixtures,
  session_id    uuid REFERENCES event_sessions,
  period        integer,
  clock_seconds integer CHECK (clock_seconds IS NULL OR clock_seconds >= 0),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  label         text CHECK (label IS NULL OR length(label) <= 120),
  client_key    text,
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  voided_at     timestamptz,
  voided_by     uuid REFERENCES users,
  CHECK ((fixture_id IS NOT NULL) <> (session_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS clip_bookmarks_client_key ON clip_bookmarks (created_by, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS clip_bookmarks_event ON clip_bookmarks (event_id, occurred_at);

-- Per-event policy. 'manual' (default): a person reviews, approves and publishes every clip. 'trusted_auto': clips cut from real scoring
-- events (never AI-only ones) are approved and published automatically in the name of the person who switched it on, still through every rights check.
CREATE TABLE IF NOT EXISTS clip_policies (
  event_id   uuid PRIMARY KEY REFERENCES events,
  mode       text NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'trusted_auto')),
  audience   text NOT NULL DEFAULT 'public' CHECK (audience IN ('licensed', 'public')),
  set_by     uuid NOT NULL REFERENCES users,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A candidate moment and its journey: candidate -> processing -> review -> approved -> published | withdrawn (rejected / failed on the side).
-- Every candidate cites the canonical thing that justifies it (source_kind + source_ref) and where on the recording it sits.
CREATE TABLE IF NOT EXISTS clip_candidates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events,
  fixture_id      uuid REFERENCES fixtures,
  session_id      uuid REFERENCES event_sessions,
  source_asset_id uuid NOT NULL REFERENCES mr_assets,
  alignment_id    uuid NOT NULL REFERENCES clip_alignments,
  source_kind     text NOT NULL CHECK (source_kind IN ('match_event', 'session_event', 'bookmark')),
  source_ref      uuid NOT NULL,
  moment_kind     text NOT NULL CHECK (length(moment_kind) BETWEEN 2 AND 40),
  sport_family    text NOT NULL CHECK (length(sport_family) BETWEEN 2 AND 40),
  origin          text NOT NULL CHECK (origin IN ('rule', 'bookmark', 'ai')),
  priority        integer NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  media_start_s   numeric(10,2) NOT NULL CHECK (media_start_s >= 0),
  media_end_s     numeric(10,2) NOT NULL,
  status          text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'processing', 'review', 'approved', 'published', 'withdrawn', 'rejected', 'failed')),
  title           text CHECK (title IS NULL OR length(title) BETWEEN 2 AND 140),
  caption_facts   jsonb NOT NULL DEFAULT '{}',          -- what the canonical record says (never edited by AI)
  caption_prose   text CHECK (caption_prose IS NULL OR length(caption_prose) <= 500),
  prose_by_ai     boolean NOT NULL DEFAULT false,       -- true while the prose is machine-drafted and not yet edited by a person
  ai_note         text CHECK (ai_note IS NULL OR length(ai_note) <= 300),
  asset_id        uuid REFERENCES mr_assets,            -- the governed clip, created when processing finishes
  reviewed_by     uuid REFERENCES users,
  reviewed_at     timestamptz,
  review_note      text CHECK (review_note IS NULL OR length(review_note) <= 300),
  last_error      text,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1,
  CHECK (media_end_s > media_start_s),
  CHECK ((fixture_id IS NOT NULL) <> (session_id IS NOT NULL)),
  CHECK (status NOT IN ('review', 'approved', 'published', 'withdrawn') OR asset_id IS NOT NULL)
);
-- One candidate per cited moment per recording: running generation twice, or a retried job, can never create a second clip.
CREATE UNIQUE INDEX IF NOT EXISTS clip_candidates_moment ON clip_candidates (source_asset_id, source_kind, source_ref);
CREATE INDEX IF NOT EXISTS clip_candidates_queue ON clip_candidates (event_id, status, priority DESC);
CREATE INDEX IF NOT EXISTS clip_candidates_asset ON clip_candidates (asset_id) WHERE asset_id IS NOT NULL;

-- Tagged people. Mirrored into mr_asset_subjects when the clip asset exists, so guardian media consent applies to the clip itself.
CREATE TABLE IF NOT EXISTS clip_participants (
  candidate_id uuid NOT NULL REFERENCES clip_candidates,
  user_id      uuid NOT NULL REFERENCES users,
  origin       text NOT NULL CHECK (origin IN ('event', 'reviewer')),   -- 'event': named by the scoring record; 'reviewer': added by a person
  added_by     uuid NOT NULL REFERENCES users,
  added_at     timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  PRIMARY KEY (candidate_id, user_id)
);

-- A clip on a player's passport. It points at the governed asset (never a copy) and is shown only while the asset is live and the link is accepted.
CREATE TABLE IF NOT EXISTS clip_player_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid NOT NULL REFERENCES mr_assets,
  candidate_id uuid REFERENCES clip_candidates,
  user_id      uuid NOT NULL REFERENCES users,
  sport_id     uuid REFERENCES sports,
  status       text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'declined', 'withdrawn')),
  proposed_by  uuid NOT NULL REFERENCES users,
  decided_by   uuid REFERENCES users,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS clip_player_links_one ON clip_player_links (asset_id, user_id) WHERE status IN ('proposed', 'accepted');
CREATE INDEX IF NOT EXISTS clip_player_links_user ON clip_player_links (user_id, status);

-- Event / team recap reels: an ordered list of approved clips and fixed cards (intro, outro, scorecard, sponsor bumper).
CREATE TABLE IF NOT EXISTS clip_reels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  fixture_id  uuid REFERENCES fixtures,
  team_id     uuid REFERENCES teams,
  kind        text NOT NULL CHECK (kind IN ('match', 'event', 'team')),
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 140),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'withdrawn')),
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS clip_reels_event ON clip_reels (event_id, status);
CREATE TABLE IF NOT EXISTS clip_reel_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reel_id              uuid NOT NULL REFERENCES clip_reels,
  position             integer NOT NULL CHECK (position >= 0),
  kind                 text NOT NULL CHECK (kind IN ('clip', 'intro', 'outro', 'scorecard', 'sponsor_bumper')),
  candidate_id         uuid REFERENCES clip_candidates,
  inventory_booking_id uuid REFERENCES sponsor_inventory_bookings,
  label                text CHECK (label IS NULL OR length(label) <= 120),
  removed_at           timestamptz,
  CHECK ((kind = 'clip') = (candidate_id IS NOT NULL)),
  CHECK ((kind = 'sponsor_bumper') = (inventory_booking_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS clip_reel_items_reel ON clip_reel_items (reel_id, position) WHERE removed_at IS NULL;

-- Usage ledger: what each step cost, so premium highlight credits can be metered (#504) instead of offering unlimited AI and processing.
-- Written once per idempotency key; a retried job or request never counts twice.
CREATE TABLE IF NOT EXISTS clip_usage (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events,
  candidate_id     uuid REFERENCES clip_candidates,
  kind             text NOT NULL CHECK (kind IN ('generate', 'process', 'ai_caption', 'ai_rank', 'storage')),
  processing_s     numeric(10,2) NOT NULL DEFAULT 0,
  storage_bytes    bigint NOT NULL DEFAULT 0,
  ai_input_tokens  integer NOT NULL DEFAULT 0,
  ai_output_tokens integer NOT NULL DEFAULT 0,
  credits          numeric(10,2) NOT NULL DEFAULT 0,
  idempotency_key  text NOT NULL,
  actor_id         uuid REFERENCES users,
  metered          boolean NOT NULL DEFAULT false,      -- true when a commercial meter counted it
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS clip_usage_event ON clip_usage (event_id, created_at);

-- The token cost of an AI answer was never kept; keep it from now on (nullable, so every earlier row is untouched).
ALTER TABLE ai_outputs ADD COLUMN IF NOT EXISTS input_tokens integer;
ALTER TABLE ai_outputs ADD COLUMN IF NOT EXISTS output_tokens integer;
