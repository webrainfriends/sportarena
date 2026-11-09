-- Migration 194: Official rate agreements (Issue #1016 / R35)
-- Custom per-event / academy / season / club negotiated rates with full precedence stack,
-- approval workflow, immutable booked snapshots, multi-currency and audit trail.
-- All additive; no existing data dropped or narrowed.

-- ------------------------------------------------------------------ main agreement table
CREATE TABLE IF NOT EXISTS official_rate_agreements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- parties
  official_id     uuid NOT NULL REFERENCES users(id),
  counterpart_id  uuid NOT NULL REFERENCES users(id),         -- academy owner, club admin, event organiser
  counterpart_org_id uuid REFERENCES organisations(id),        -- org the counterpart represents (may be NULL)

  -- context
  context_type    text NOT NULL CHECK (context_type IN ('event_override','academy_contract','season_series','club_org','retainer')),
  event_id        uuid REFERENCES events(id),                  -- for event_override
  season_id       uuid REFERENCES seasons(id),                 -- for season_series (nullable until seasons table)
  sport_id        uuid REFERENCES sports(id),
  official_role   text NOT NULL,                               -- matches OFFICIAL_ROLES

  -- rate structure
  rate_type       text NOT NULL CHECK (rate_type IN ('fixed_match','per_hour','per_day','volume_tiers','retainer','bundle','negotiated')),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  base_fee_minor  bigint,                                       -- for flat types; null when volume_tiers
  retainer_minor  bigint,                                       -- monthly retainer (retainer type)
  travel_minor    bigint,                                       -- per game/day travel allowance
  overtime_minor  bigint,                                       -- per hour overtime
  accom_minor     bigint,                                       -- per night accommodation
  bundle_minor    bigint,                                       -- bundle total fee
  bundle_desc     text,                                         -- what the bundle includes

  -- status lifecycle: draft -> proposed -> countered -> accepted -> active -> superseded -> cancelled
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','proposed','countered','accepted','active','superseded','cancelled')),
  proposed_by     uuid REFERENCES users(id),                   -- who sent the first proposal
  proposed_at     timestamptz,
  accepted_by     uuid REFERENCES users(id),
  accepted_at     timestamptz,
  cancelled_by    uuid REFERENCES users(id),
  cancelled_at    timestamptz,
  cancel_reason   text,
  superseded_by   uuid REFERENCES official_rate_agreements(id),-- newer agreement that replaced this one

  -- validity
  effective_from  date NOT NULL,
  effective_until date,                                         -- null = open-ended / event-scoped
  auto_renew      text CHECK (auto_renew IN ('none','notify_30','notify_60','auto')),

  -- cancellation terms
  notice_days     int,                                          -- days written notice required
  cancel_fee_pct  numeric(5,2),                                -- % of remaining season value
  payment_trigger text CHECK (payment_trigger IN ('per_game','weekly','monthly','on_completion')),
  payment_net_days int,                                        -- days from invoice to due date

  -- overlap check: at most one active agreement per (official, counterpart_org/counterpart, context_type, sport) at a time
  -- enforced via unique partial index below

  -- notes (private to agreement parties)
  official_note   text,
  counterpart_note text,

  -- audit
  row_version     int NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);

CREATE INDEX IF NOT EXISTS ora_official   ON official_rate_agreements(official_id, status);
CREATE INDEX IF NOT EXISTS ora_cpart      ON official_rate_agreements(counterpart_id, status);
CREATE INDEX IF NOT EXISTS ora_cpart_org  ON official_rate_agreements(counterpart_org_id, status) WHERE counterpart_org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ora_event      ON official_rate_agreements(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ora_sport      ON official_rate_agreements(sport_id) WHERE sport_id IS NOT NULL;

-- prevent two active/accepted agreements for the same official+org+context+sport
CREATE UNIQUE INDEX IF NOT EXISTS ora_no_overlap_org
  ON official_rate_agreements(official_id, counterpart_org_id, context_type, sport_id)
  WHERE counterpart_org_id IS NOT NULL
    AND status IN ('accepted','active')
    AND sport_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ora_no_overlap_event
  ON official_rate_agreements(official_id, event_id)
  WHERE event_id IS NOT NULL
    AND status IN ('accepted','active');

-- ------------------------------------------------------------------ volume tiers (child rows; at most 20 per agreement)
CREATE TABLE IF NOT EXISTS official_rate_tiers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id   uuid NOT NULL REFERENCES official_rate_agreements(id) ON DELETE CASCADE,
  tier_order     int NOT NULL,          -- 1-based display order
  games_from     int NOT NULL,          -- inclusive lower bound
  games_to       int,                   -- inclusive upper bound; null = unbounded (last tier)
  fee_minor      bigint NOT NULL,       -- fee per game at this tier
  travel_minor   bigint,               -- optional per-game travel override for this tier
  UNIQUE (agreement_id, tier_order),
  CHECK (games_from >= 1),
  CHECK (games_to IS NULL OR games_to > games_from)
);

-- ------------------------------------------------------------------ version history (immutable; every propose/counter creates a row)
CREATE TABLE IF NOT EXISTS official_rate_agreement_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id   uuid NOT NULL REFERENCES official_rate_agreements(id),
  version        int NOT NULL,
  event_kind     text NOT NULL CHECK (event_kind IN ('created','proposed','countered','accepted','cancelled','superseded','note_added')),
  actor_id       uuid NOT NULL REFERENCES users(id),
  snapshot       jsonb NOT NULL,        -- full agreement + tiers JSON at this point in time
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orav_agreement ON official_rate_agreement_versions(agreement_id, version);

-- ------------------------------------------------------------------ booked snapshots (one row per fixture_official once agreed fee is frozen)
-- Links to fixture_officials.id; replaces the ad-hoc fee_minor/fee_currency approach for
-- assignments that fall under a rate agreement. The existing fee columns remain for ad-hoc fees.
CREATE TABLE IF NOT EXISTS official_rate_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_official_id uuid NOT NULL REFERENCES fixture_officials(id),
  agreement_id    uuid REFERENCES official_rate_agreements(id),  -- null = profile default or ad-hoc
  resolution_level text NOT NULL CHECK (resolution_level IN ('booked_snapshot','agreement','customer','segment','profile_default')),
  rate_type       text NOT NULL,
  currency        text NOT NULL,
  base_fee_minor  bigint NOT NULL,
  travel_minor    bigint NOT NULL DEFAULT 0,
  overtime_minor  bigint,              -- rate; null = not in agreement
  total_fee_minor bigint NOT NULL,     -- base + travel at snapshot time
  tier_applied    int,                 -- tier_order that fired (volume_tiers only)
  games_at_snapshot int,              -- running game count at snapshot time (for tier calc)
  snapshot_data   jsonb NOT NULL,      -- full snapshot for immutability proof
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fixture_official_id)
);
CREATE INDEX IF NOT EXISTS ors_agreement ON official_rate_snapshots(agreement_id) WHERE agreement_id IS NOT NULL;

-- ------------------------------------------------------------------ add column to fixture_officials to reference an agreement
-- (nullable; existing rows stay valid)
ALTER TABLE fixture_officials
  ADD COLUMN IF NOT EXISTS rate_agreement_id uuid REFERENCES official_rate_agreements(id),
  ADD COLUMN IF NOT EXISTS rate_snapshot_id  uuid REFERENCES official_rate_snapshots(id);
