-- Multi-sport events (school sports day, Olympics-style games, club festival).
-- One event gets a "programme": several disciplines (sports), houses/groups, participants who can be nominated
-- into more than one discipline, qualifying rounds -> finals, a conflict-free schedule, officials/medical staff,
-- points ledger (individual / team / house), certificates, trophies and announcements.
-- Additive only: no existing table is altered or dropped, nothing is deleted (rows are voided/withdrawn/cancelled).

INSERT INTO sports (slug, name, emoji, scoring, category, play_type, programmes)
VALUES ('multi-sport', 'Multi-sport games', '🏅', 'points', 'multi', 'team', '{}')
ON CONFLICT (slug) DO NOTHING;

-- Turns an event into a multi-sport programme and holds its rules.
CREATE TABLE event_programmes (
  event_id               uuid PRIMARY KEY REFERENCES events,
  max_individual_entries int  NOT NULL DEFAULT 3 CHECK (max_individual_entries BETWEEN 1 AND 50),   -- per person, across individual disciplines
  max_team_entries       int  NOT NULL DEFAULT 2 CHECK (max_team_entries BETWEEN 1 AND 50),         -- per person, across team disciplines
  rest_gap_min           int  NOT NULL DEFAULT 15 CHECK (rest_gap_min BETWEEN 0 AND 240),          -- minimum rest between two of one person's sessions
  default_points         jsonb NOT NULL DEFAULT '{"1":5,"2":3,"3":1}',                             -- place -> points, unless a discipline overrides
  participation_points   int  NOT NULL DEFAULT 0 CHECK (participation_points BETWEEN 0 AND 100),
  public_names           boolean NOT NULL DEFAULT false,   -- show participant names on public boards (off by default: many are children)
  nominations_open       boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Houses / groups / colours / classes that points roll up to.
CREATE TABLE event_houses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events,
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'house' CHECK (kind IN ('house','group','class','region','club')),
  color           text,
  emoji           text,
  manager_user_id uuid REFERENCES users,       -- house master / group lead: may nominate and build teams for this house
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX event_houses_name ON event_houses (event_id, lower(name)) WHERE archived_at IS NULL;

-- People taking part. They need not have an account (an organiser can register a whole school); link one later.
CREATE TABLE event_participants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events,
  user_id      uuid REFERENCES users,
  full_name    text NOT NULL,
  house_id     uuid REFERENCES event_houses,
  gender       text CHECK (gender IN ('male','female','other')),
  grade        text,                           -- class / age group label, e.g. "7B" or "U14"
  roll_no      text,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  medical_hold boolean NOT NULL DEFAULT false, -- set by a "not cleared" incident; no clinical detail here
  created_by   uuid REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX event_participants_user ON event_participants (event_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX event_participants_roll ON event_participants (event_id, roll_no) WHERE roll_no IS NOT NULL;
CREATE INDEX event_participants_house ON event_participants (event_id, house_id);

-- One sport inside the event (100m sprint, U14 football, relay ...).
CREATE TABLE event_disciplines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events,
  sport_id        uuid NOT NULL REFERENCES sports,
  name            text NOT NULL,
  mode            text NOT NULL DEFAULT 'individual' CHECK (mode IN ('individual','team')),
  gender          text NOT NULL DEFAULT 'any' CHECK (gender IN ('any','male','female')),
  eligible_grades text[],                      -- NULL = every grade
  team_size_min   int  CHECK (team_size_min >= 1),
  team_size_max   int  CHECK (team_size_max >= 1),
  result_type     text NOT NULL DEFAULT 'score' CHECK (result_type IN ('time','distance','score')),
  max_per_house   int  CHECK (max_per_house >= 1),   -- entrants (or teams) each house may field
  points          jsonb,                       -- place -> points override
  officials_required int NOT NULL DEFAULT 1 CHECK (officials_required BETWEEN 0 AND 20),
  venue_id        uuid REFERENCES venues,
  status          text NOT NULL DEFAULT 'nominations' CHECK (status IN ('draft','nominations','scheduled','ongoing','completed','cancelled')),
  finalized_at    timestamptz,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (team_size_max IS NULL OR team_size_min IS NULL OR team_size_max >= team_size_min)
);
CREATE INDEX event_disciplines_event ON event_disciplines (event_id);

CREATE TABLE discipline_teams (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id          uuid NOT NULL REFERENCES event_disciplines,
  house_id               uuid REFERENCES event_houses,
  name                   text NOT NULL,
  captain_participant_id uuid REFERENCES event_participants,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  created_by             uuid REFERENCES users,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX discipline_teams_name ON discipline_teams (discipline_id, lower(name)) WHERE status = 'active';

-- A person nominated into a discipline (and, for team sports, the team they play in).
CREATE TABLE discipline_nominations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discipline_id  uuid NOT NULL REFERENCES event_disciplines,
  participant_id uuid NOT NULL REFERENCES event_participants,
  house_id       uuid REFERENCES event_houses,
  team_id        uuid REFERENCES discipline_teams,
  status         text NOT NULL DEFAULT 'nominated' CHECK (status IN ('nominated','confirmed','withdrawn','rejected')),
  seed           numeric,                      -- personal best / seed used to balance heats
  created_by     uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (discipline_id, participant_id)
);
CREATE INDEX discipline_nominations_participant ON discipline_nominations (participant_id);
CREATE INDEX discipline_nominations_team ON discipline_nominations (team_id);

-- A heat, qualifier, round-robin match, knockout tie or final. Draft = not yet on the timetable.
CREATE TABLE event_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events,
  discipline_id uuid NOT NULL REFERENCES event_disciplines,
  stage         text NOT NULL CHECK (stage IN ('qualifying','heat','round_robin','knockout','quarter_final','semi_final','third_place','final')),
  label         text NOT NULL,
  round         int  NOT NULL DEFAULT 1,
  scheduled_at  timestamptz,
  duration_min  int  NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 5 AND 600),
  venue_id      uuid REFERENCES venues,
  resource_id   uuid REFERENCES resources,
  location      text,                          -- track / field / court name when no bookable resource is linked
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','live','completed','cancelled')),
  completed_at  timestamptz,
  created_by    uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_sessions_event_time ON event_sessions (event_id, scheduled_at);
CREATE INDEX event_sessions_discipline ON event_sessions (discipline_id);

CREATE TABLE event_session_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL REFERENCES event_sessions,
  participant_id uuid REFERENCES event_participants,
  team_id        uuid REFERENCES discipline_teams,
  house_id       uuid REFERENCES event_houses,
  lane           int,
  result_value   numeric,                      -- seconds / metres / points
  score          int,                          -- match score
  position       int,                          -- rank inside the session (ties share a rank)
  result_status  text NOT NULL DEFAULT 'registered' CHECK (result_status IN ('registered','finished','dns','dnf','dq','scratched')),
  qualified      boolean NOT NULL DEFAULT false,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((participant_id IS NULL) <> (team_id IS NULL))
);
CREATE UNIQUE INDEX event_session_entries_p ON event_session_entries (session_id, participant_id) WHERE participant_id IS NOT NULL;
CREATE UNIQUE INDEX event_session_entries_t ON event_session_entries (session_id, team_id) WHERE team_id IS NOT NULL;
CREATE INDEX event_session_entries_participant ON event_session_entries (participant_id);
CREATE INDEX event_session_entries_team ON event_session_entries (team_id);

-- Hired / invited crew: referees, judges, physios, doctors, first aiders, volunteers.
CREATE TABLE event_staff (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events,
  user_id      uuid NOT NULL REFERENCES users,
  role         text NOT NULL CHECK (role IN ('referee','umpire','judge','starter','timekeeper','scorer','physio','doctor','first_aider','volunteer')),
  sport_id     uuid REFERENCES sports,
  status       text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','accepted','declined','released')),
  rate_cents   int  NOT NULL DEFAULT 0 CHECK (rate_cents >= 0),
  currency     text NOT NULL DEFAULT 'INR',
  paid_cents   int  NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  paid_at      timestamptz,
  notes        text,
  invited_by   uuid REFERENCES users,
  responded_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX event_staff_open ON event_staff (event_id, user_id, role) WHERE status IN ('invited','accepted');
CREATE INDEX event_staff_user ON event_staff (user_id);

-- Where and when a crew member works: officiating a session, medical cover for a venue window, or general duty.
CREATE TABLE event_shifts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events,
  staff_id   uuid NOT NULL REFERENCES event_staff,
  session_id uuid REFERENCES event_sessions,
  kind       text NOT NULL CHECK (kind IN ('officiating','medical_cover','duty')),
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  location   text,
  status     text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','cancelled')),
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX event_shifts_staff ON event_shifts (staff_id, starts_at) WHERE status = 'assigned';
CREATE INDEX event_shifts_session ON event_shifts (session_id) WHERE status = 'assigned';

-- On-site medical log. Clinical text is encrypted (*_enc) and every decrypting read is audit-logged.
CREATE TABLE event_medical_incidents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events,
  session_id     uuid REFERENCES event_sessions,
  participant_id uuid REFERENCES event_participants,
  reporter_id    uuid NOT NULL REFERENCES users,
  severity       text NOT NULL CHECK (severity IN ('minor','moderate','serious','emergency')),
  outcome        text NOT NULL CHECK (outcome IN ('treated_on_site','referred','ambulance','hospital')),
  return_to_play text CHECK (return_to_play IN ('cleared','restricted','not_cleared')),
  summary_enc    text NOT NULL,
  details_enc    text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_medical_incidents_event ON event_medical_incidents (event_id, occurred_at);

-- Points ledger: individual, team and house points all come from here. Corrections void rows, they never delete them.
CREATE TABLE event_points (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events,
  discipline_id  uuid REFERENCES event_disciplines,
  house_id       uuid REFERENCES event_houses,
  participant_id uuid REFERENCES event_participants,
  team_id        uuid REFERENCES discipline_teams,
  kind           text NOT NULL CHECK (kind IN ('placement','participation','bonus','penalty','manual')),
  rank           int,
  points         int NOT NULL,
  reason         text,
  created_by     uuid REFERENCES users,
  voided_at      timestamptz,
  voided_by      uuid REFERENCES users,
  void_reason    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (house_id IS NOT NULL OR participant_id IS NOT NULL OR team_id IS NOT NULL)
);
CREATE INDEX event_points_event ON event_points (event_id) WHERE voided_at IS NULL;
CREATE INDEX event_points_discipline ON event_points (discipline_id) WHERE voided_at IS NULL;

CREATE TABLE event_certificates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events,
  discipline_id  uuid REFERENCES event_disciplines,
  kind           text NOT NULL CHECK (kind IN ('winner','runner_up','third','finalist','participation','mvp','house_champion','custom')),
  title          text NOT NULL,
  citation       text,
  recipient_name text NOT NULL,
  participant_id uuid REFERENCES event_participants,
  team_id        uuid REFERENCES discipline_teams,
  house_id       uuid REFERENCES event_houses,
  rank           int,
  code           text NOT NULL UNIQUE,         -- short random verification code printed on the certificate
  issued_by      uuid REFERENCES users,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  revoked_reason text,
  CHECK (participant_id IS NOT NULL OR team_id IS NOT NULL OR house_id IS NOT NULL)
);
CREATE UNIQUE INDEX event_certificates_once ON event_certificates (event_id, discipline_id, kind, title, participant_id, team_id, house_id) NULLS NOT DISTINCT WHERE revoked_at IS NULL;

CREATE TABLE event_trophies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events,
  name          text NOT NULL,
  description   text,
  scope         text NOT NULL CHECK (scope IN ('house','individual','team')),
  discipline_id uuid REFERENCES event_disciplines,   -- NULL = overall champion
  created_by    uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE event_trophy_awards (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trophy_id      uuid NOT NULL REFERENCES event_trophies,
  house_id       uuid REFERENCES event_houses,
  participant_id uuid REFERENCES event_participants,
  team_id        uuid REFERENCES discipline_teams,
  note           text,
  awarded_by     uuid REFERENCES users,
  awarded_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (house_id IS NOT NULL OR participant_id IS NOT NULL OR team_id IS NOT NULL)
);
CREATE INDEX event_trophy_awards_trophy ON event_trophy_awards (trophy_id, awarded_at DESC);

CREATE TABLE event_announcements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events,
  audience      text NOT NULL CHECK (audience IN ('all','house','discipline','session','staff')),
  house_id      uuid REFERENCES event_houses,
  discipline_id uuid REFERENCES event_disciplines,
  session_id    uuid REFERENCES event_sessions,
  title         text NOT NULL,
  body          text NOT NULL,
  urgent        boolean NOT NULL DEFAULT false,
  recipients    int NOT NULL DEFAULT 0,
  sent_by       uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_announcements_event ON event_announcements (event_id, created_at DESC);
