-- Sports opportunity marketplace (issue #67). Extends billboard_posts / billboard_responses (the Billboard and its recruitment pipeline)
-- instead of adding a parallel opportunity model. Additive only: new nullable/defaulted columns, new CHECKs that existing rows already satisfy,
-- widened (never narrowed) CHECK lists, idempotent backfills. Nothing is dropped, deleted or rewritten.
-- Rollback: stop using the new columns; every old query and screen keeps working because nothing was removed or renamed.

-- a non-player role post (scorer, official, photographer, volunteer ...) is a new kind next to the existing ones
ALTER TABLE billboard_posts DROP CONSTRAINT IF EXISTS billboard_posts_kind_check;
ALTER TABLE billboard_posts ADD CONSTRAINT billboard_posts_kind_check
  CHECK (kind IN ('match_players','team_recruiting','coach_wanted','assignment','sponsorship_wanted','sponsor_call'));

ALTER TABLE billboard_posts
  ADD COLUMN IF NOT EXISTS opportunity_type         text CHECK (opportunity_type IS NULL OR opportunity_type IN ('trial','paid_assignment','volunteering','sponsorship','team_role')),
  ADD COLUMN IF NOT EXISTS compensation             text CHECK (compensation IS NULL OR compensation IN ('paid','unpaid','expenses','in_kind')),  -- NULL = not stated
  ADD COLUMN IF NOT EXISTS currency                 text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),                                   -- currency of budget_cents
  ADD COLUMN IF NOT EXISTS closes_at                timestamptz,                                                                                 -- applications stop here
  ADD COLUMN IF NOT EXISTS ends_at                  timestamptz,
  ADD COLUMN IF NOT EXISTS target_type              text CHECK (target_type IS NULL OR target_type IN ('event','game')),                        -- the canonical record the engagement attaches to
  ADD COLUMN IF NOT EXISTS target_id                uuid,
  ADD COLUMN IF NOT EXISTS target_role              text,                                                                                        -- an ontology role (volunteer, referee, scorer ...)
  ADD COLUMN IF NOT EXISTS required_sections        text[] NOT NULL DEFAULT '{}',                                                                -- passport sections an applicant must share
  ADD COLUMN IF NOT EXISTS verified_applicants_only boolean NOT NULL DEFAULT false;
ALTER TABLE billboard_posts DROP CONSTRAINT IF EXISTS billboard_posts_window_check;
ALTER TABLE billboard_posts ADD CONSTRAINT billboard_posts_window_check CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at);
ALTER TABLE billboard_posts DROP CONSTRAINT IF EXISTS billboard_posts_target_check;
ALTER TABLE billboard_posts ADD CONSTRAINT billboard_posts_target_check CHECK ((target_type IS NULL) = (target_id IS NULL));
CREATE INDEX IF NOT EXISTS billboard_posts_type ON billboard_posts (opportunity_type, status, created_at DESC);

-- backfill the meaning of what was already stored (idempotent: only rows still unset are touched)
UPDATE billboard_posts SET opportunity_type = 'sponsorship' WHERE opportunity_type IS NULL AND kind IN ('sponsorship_wanted','sponsor_call');
UPDATE billboard_posts SET opportunity_type = 'team_role' WHERE opportunity_type IS NULL AND kind IN ('team_recruiting','coach_wanted');
-- budgets were always shown and paid in the platform's original currency; make that explicit now that posts carry a currency
UPDATE billboard_posts SET currency = 'INR' WHERE currency IS NULL AND budget_cents IS NOT NULL;
UPDATE billboard_posts SET compensation = 'paid' WHERE compensation IS NULL AND budget_cents > 0 AND kind IN ('team_recruiting','coach_wanted','match_players');

-- what the applicant allows the selectors to see, and the engagement an acceptance created
ALTER TABLE billboard_responses
  ADD COLUMN IF NOT EXISTS shared_sections text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS engagement_type text CHECK (engagement_type IS NULL OR engagement_type IN ('team_member','association')),
  ADD COLUMN IF NOT EXISTS engagement_id   uuid,   -- team_member: the team (the member is the applicant); association: the associations row
  ADD COLUMN IF NOT EXISTS payout_id       uuid REFERENCES team_payouts;
CREATE UNIQUE INDEX IF NOT EXISTS billboard_responses_payout ON billboard_responses (payout_id) WHERE payout_id IS NOT NULL;

ALTER TABLE recruitment_events DROP CONSTRAINT IF EXISTS recruitment_events_kind_check;
ALTER TABLE recruitment_events ADD CONSTRAINT recruitment_events_kind_check
  CHECK (kind IN ('applied','stage','trial','evaluation','offer','offer_response','offer_expired','withdrawn','legacy_decision','evidence','engagement'));

-- fraud / misleading-post reports are ordinary support cases (cases.js) linked to the post
ALTER TABLE case_links DROP CONSTRAINT IF EXISTS case_links_entity_type_check;
ALTER TABLE case_links ADD CONSTRAINT case_links_entity_type_check CHECK (entity_type IN ('reservation','booking','invoice','payment','shop_order','coach_hire','event','game','fixture','appointment','insurance_policy','sponsorship',
  'sponsorship_obligation','sponsorship_payment','sponsorship_delivery','sponsorship_submission','billboard_post'));
