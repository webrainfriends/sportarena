-- Sport/game module on an ontology (IPTC Sport Schema): games (sport:Event), competitor participations,
-- person associations (sport:Membership / Participation: player, coach, referee… -> game/team/event/venue),
-- in-game actions, and user-defined field definitions that extend the built-in per-sport templates.

CREATE TABLE games (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id       uuid NOT NULL REFERENCES sports,
  created_by     uuid NOT NULL REFERENCES users,
  title          text NOT NULL,
  status         text NOT NULL DEFAULT 'pre-event' CHECK (status IN ('pre-event','mid-event','post-event','postponed','suspended','halted','forfeited','rescheduled','delayed','canceled','intermission','if-necessary','discarded')),
  competition_id uuid REFERENCES events ON DELETE SET NULL,
  fixture_id     uuid UNIQUE REFERENCES fixtures ON DELETE SET NULL,
  venue_id       uuid REFERENCES venues,
  resource_id    uuid REFERENCES resources,
  location       text,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz,
  attributes     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX games_sport_time ON games (sport_id, starts_at DESC);
CREATE INDEX games_competition ON games (competition_id);
CREATE INDEX games_creator ON games (created_by);

-- sport:CompetitorParticipation — a team or an individual competing in a game, with its result
CREATE TABLE game_participants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id      uuid NOT NULL REFERENCES games ON DELETE CASCADE,
  team_id      uuid REFERENCES teams,
  user_id      uuid REFERENCES users,
  side         text CHECK (side IN ('home','away','neutral')),
  outcome      text CHECK (outcome IN ('win','loss','tie','undecided','show','place')),
  outcome_type text CHECK (outcome_type IN ('regular','overtime','shootout','extra-time','random','authority-decision','decision-unanimous')),
  score        numeric,
  score_units  text CHECK (score_units IN ('time-absolute','time-relative','against-par')),
  rank         int CHECK (rank >= 1),
  stats        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((team_id IS NULL) <> (user_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT (game_id, team_id, user_id)
);

-- sport:Membership / sport:Participation — a person's role towards a game, event, venue
-- (team rosters stay in team_members; see view person_associations)
CREATE TABLE associations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role          text NOT NULL,
  target_type   text NOT NULL CHECK (target_type IN ('game','event','venue')),
  target_id     uuid NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','requested','active','declined','ended')),
  position      text,
  uniform_no    int CHECK (uniform_no BETWEEN 0 AND 999),
  player_status text CHECK (player_status IN ('starter','bench','scratched','injured','suspended','sidelined')),
  attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,
  invited_by    uuid REFERENCES users,
  started_at    timestamptz,
  ended_at      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX associations_one_open ON associations (user_id, role, target_type, target_id) WHERE status IN ('invited','requested','active');
CREATE INDEX associations_target ON associations (target_type, target_id, status);
CREATE INDEX associations_user ON associations (user_id, status);

-- one read model over everything a person is associated with: games/events/venues + team rosters
CREATE VIEW person_associations AS
  SELECT a.id, a.user_id, a.role, a.target_type, a.target_id, a.status, a.position, a.uniform_no, a.player_status,
         a.attributes, a.started_at, a.ended_at, a.created_at
    FROM associations a
  UNION ALL
  SELECT NULL::uuid, m.user_id, m.role, 'team', m.team_id,
         CASE m.status WHEN 'left' THEN 'ended' ELSE m.status END,
         NULL, m.jersey_no, NULL, '{}'::jsonb, m.joined_at, NULL, m.joined_at
    FROM team_members m;

-- sport:Action — things that happen inside a game
CREATE TABLE game_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id      uuid NOT NULL REFERENCES games ON DELETE CASCADE,
  action_class text NOT NULL CHECK (action_class IN ('play','score','substitution','timeout','penalty','infraction','injury')),
  action_type  text NOT NULL,
  minute       numeric CHECK (minute >= 0),
  period       int CHECK (period >= 0),
  user_id      uuid REFERENCES users,
  team_id      uuid REFERENCES teams,
  attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_by  uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX game_actions_game ON game_actions (game_id, minute NULLS LAST, created_at);

-- fields added on top of the built-in per-sport templates (sport_id NULL = every sport)
CREATE TABLE field_definitions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id   uuid REFERENCES sports,
  scope      text NOT NULL CHECK (scope IN ('game','participant','association')),
  key        text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label      text NOT NULL,
  datatype   text NOT NULL CHECK (datatype IN ('text','integer','number','boolean','enum','datetime')),
  options    jsonb,
  required   boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (datatype <> 'enum' OR jsonb_typeof(options) = 'array')
);
CREATE UNIQUE INDEX field_definitions_key ON field_definitions (coalesce(sport_id, '00000000-0000-0000-0000-000000000000'::uuid), scope, key);
