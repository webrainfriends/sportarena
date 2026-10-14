-- Insurance panel doctors/physios (issue: panel providers). Additive only; rows are ended with a status, never deleted.
-- An insurer and a provider agree to be linked (either side proposes, the other accepts), so nobody is listed as "on a panel" without consent.
CREATE TABLE insurer_panel_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  insurer_id   uuid NOT NULL REFERENCES insurers,
  provider_id  uuid NOT NULL REFERENCES users,
  status       text NOT NULL CHECK (status IN ('invited','requested','active','declined','ended')),
  proposed_by  text NOT NULL CHECK (proposed_by IN ('insurer','provider')),
  cashless     boolean NOT NULL DEFAULT false,                 -- the insurer states treatment can be billed to it directly (information only)
  network_ref  text,                                           -- the provider's empanelment id with this insurer
  cover_types  text[] NOT NULL DEFAULT '{}' CHECK (cover_types <@ ARRAY['individual','team','group','organisation','event']::text[]),  -- empty = all kinds
  plan_ids     uuid[] NOT NULL DEFAULT '{}',                   -- empty = every plan of the insurer
  valid_from   date,
  valid_to     date,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  ended_by     uuid REFERENCES users
);
-- one live link per insurer and provider; ended/declined history rows stay
CREATE UNIQUE INDEX insurer_panel_live ON insurer_panel_members (insurer_id, provider_id) WHERE status IN ('invited','requested','active');
CREATE INDEX insurer_panel_provider ON insurer_panel_members (provider_id, status);

CREATE TABLE insurer_panel_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   uuid NOT NULL REFERENCES insurer_panel_members,
  actor_id    uuid NOT NULL REFERENCES users,
  action      text NOT NULL,
  from_status text,
  to_status   text,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
