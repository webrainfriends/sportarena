-- Team management: player availability, per-member rates, event/match squads (who plays, in what role),
-- coach/player recruiting, and a settlement ledger. Additive only: no data is dropped or rewritten
-- (one CHECK is widened to allow the new 'coach_wanted' billboard kind).

ALTER TABLE teams ADD COLUMN currency text NOT NULL DEFAULT 'INR';

ALTER TABLE team_members
  ADD COLUMN availability      text NOT NULL DEFAULT 'available' CHECK (availability IN ('available','tentative','unavailable','injured')),
  ADD COLUMN availability_note text,
  ADD COLUMN availability_set_at timestamptz,
  ADD COLUMN position          text,
  ADD COLUMN notes             text,                 -- manager-only
  ADD COLUMN rate_cents        bigint CHECK (rate_cents >= 0),   -- agreed fee, in the team's currency; manager + the member only
  ADD COLUMN rate_unit         text NOT NULL DEFAULT 'match' CHECK (rate_unit IN ('match','hour','month','season')),
  ADD COLUMN invited_by        uuid REFERENCES users;

-- Who is selected for which event / match, in which role.
CREATE TABLE team_squads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES teams,
  event_id    uuid REFERENCES events,
  fixture_id  uuid REFERENCES fixtures,            -- set => a single match (event_id is then that fixture's event)
  user_id     uuid NOT NULL REFERENCES users,
  role        text NOT NULL DEFAULT 'player' CHECK (role IN ('player','captain','vice_captain','substitute','coach','manager','physio')),
  position    text,
  status      text NOT NULL DEFAULT 'selected' CHECK (status IN ('selected','confirmed','declined','dropped')),
  selected_by uuid REFERENCES users,
  responded_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (event_id IS NOT NULL OR fixture_id IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (team_id, event_id, fixture_id, user_id)
);
CREATE INDEX team_squads_user ON team_squads (user_id, status);
CREATE INDEX team_squads_scope ON team_squads (team_id, event_id, fixture_id);

-- Settlement ledger: what the team owes its players / coaches / staff, and what has been paid.
CREATE TABLE team_payouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES teams,
  user_id     uuid NOT NULL REFERENCES users,
  squad_id    uuid REFERENCES team_squads,
  event_id    uuid REFERENCES events,
  fixture_id  uuid REFERENCES fixtures,
  kind        text NOT NULL DEFAULT 'match_fee' CHECK (kind IN ('match_fee','coach_fee','session_fee','bonus','expense','other')),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency    text NOT NULL,
  status      text NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','cancelled')),
  note        text,
  due_on      date,
  created_by  uuid NOT NULL REFERENCES users,
  paid_by     uuid REFERENCES users,
  paid_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX team_payouts_team ON team_payouts (team_id, status);
CREATE INDEX team_payouts_user ON team_payouts (user_id, status);
-- one automatic fee per squad slot, so "generate fees" can be re-run safely
CREATE UNIQUE INDEX team_payouts_squad_fee ON team_payouts (squad_id, kind) WHERE squad_id IS NOT NULL AND status <> 'cancelled';

-- Recruiting: teams can advertise for a coach too, and say what they pay.
ALTER TABLE billboard_posts DROP CONSTRAINT billboard_posts_kind_check;
ALTER TABLE billboard_posts ADD CONSTRAINT billboard_posts_kind_check
  CHECK (kind IN ('match_players','team_recruiting','coach_wanted','sponsorship_wanted','sponsor_call'));
ALTER TABLE billboard_posts ADD COLUMN rate_unit text CHECK (rate_unit IN ('match','hour','month','season'));
