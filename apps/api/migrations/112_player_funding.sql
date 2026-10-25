-- Player funding workspace (#334). Additive only: four new tables and indexes; no existing table, row or column is touched.
-- A player (or a young player's guardian) records what they need funded, links each need to the applications and agreements that cover it,
-- and can share the workspace with a coach they work with. Money itself is never stored here: amounts shown for applications, awards,
-- dues and payments are read live from the canonical sponsorship tables, so the workspace always reconciles with the agreements.
-- Nothing is deleted: a need is withdrawn, a link is released, a share is revoked, and each keeps its history.
-- Rollback: deploy the previous code; nothing else reads these tables and the data stays.

CREATE TABLE IF NOT EXISTS athlete_funding_needs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  uuid NOT NULL REFERENCES users,
  category    text NOT NULL CHECK (category IN ('equipment','travel','coaching','competition_fees','medical_rehab','education','living_training','other')),
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000000),
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  needed_by   date,
  note_enc    text,                       -- personal free text: field-level encrypted (src/crypto.js), column-bound
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','withdrawn')),   -- "met" is derived from the links, never stored
  rev         integer NOT NULL DEFAULT 1,  -- optimistic version: a stale edit is refused
  client_key  text,                       -- makes a retried create return the same need
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS athlete_funding_needs_key ON athlete_funding_needs (athlete_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS athlete_funding_needs_athlete ON athlete_funding_needs (athlete_id, status, needed_by NULLS LAST, id);

-- which application or agreement covers (part of) a need, and how much of it. At most one of the two targets per row.
CREATE TABLE IF NOT EXISTS athlete_funding_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  need_id        uuid NOT NULL REFERENCES athlete_funding_needs,
  application_id uuid REFERENCES sponsorship_applications,
  sponsorship_id uuid REFERENCES sponsorships,
  allocated_cents bigint NOT NULL CHECK (allocated_cents > 0),
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  released_by    uuid REFERENCES users,
  CHECK ((application_id IS NULL) <> (sponsorship_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS athlete_funding_links_app ON athlete_funding_links (need_id, application_id) WHERE application_id IS NOT NULL AND released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS athlete_funding_links_deal ON athlete_funding_links (need_id, sponsorship_id) WHERE sponsorship_id IS NOT NULL AND released_at IS NULL;
CREATE INDEX IF NOT EXISTS athlete_funding_links_need ON athlete_funding_links (need_id, created_at, id);
CREATE INDEX IF NOT EXISTS athlete_funding_links_target ON athlete_funding_links (sponsorship_id, application_id) WHERE released_at IS NULL;

-- the athlete (or guardian) lets a coach they work with see chosen parts of the workspace, for a purpose, until a date
CREATE TABLE IF NOT EXISTS funding_shares (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   uuid NOT NULL REFERENCES users,
  recipient_id uuid NOT NULL REFERENCES users,
  purpose      text NOT NULL CHECK (purpose IN ('funding_planning','application_support','paperwork')),
  sections     text[] NOT NULL CHECK (cardinality(sections) BETWEEN 1 AND 4 AND sections <@ ARRAY['needs','applications','support','dues']),
  can_export   boolean NOT NULL DEFAULT false,
  expires_at   timestamptz NOT NULL,
  version      integer NOT NULL DEFAULT 1,
  granted_by   uuid NOT NULL REFERENCES users,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (athlete_id <> recipient_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS funding_shares_live ON funding_shares (athlete_id, recipient_id, purpose) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS funding_shares_recipient ON funding_shares (recipient_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS funding_shares_athlete ON funding_shares (athlete_id, created_at DESC);

-- append-only: who was given what, every change, every revoke, every view and export
CREATE TABLE IF NOT EXISTS funding_share_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id     uuid NOT NULL REFERENCES funding_shares,
  athlete_id   uuid NOT NULL REFERENCES users,
  recipient_id uuid NOT NULL REFERENCES users,
  actor_id     uuid REFERENCES users,
  action       text NOT NULL CHECK (action IN ('granted','updated','revoked','expired','viewed','exported')),
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS funding_share_events_share ON funding_share_events (share_id, created_at DESC);
CREATE INDEX IF NOT EXISTS funding_share_events_athlete ON funding_share_events (athlete_id, created_at DESC);
