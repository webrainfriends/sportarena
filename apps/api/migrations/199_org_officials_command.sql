-- Federation & Assignor Organisation Command Center (REF-R12, Issue #1004).
-- Adds the org-level referee workforce pool and delegated assignor grants.
-- Additive only: no existing column, table or constraint is dropped or narrowed.

-- ── 1. Official roster: an organisation's named panel of officials ────────────
CREATE TABLE IF NOT EXISTS org_official_rosters (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid        NOT NULL REFERENCES organisations(id),
  user_id          uuid        NOT NULL REFERENCES users(id),
  sport_id         uuid        REFERENCES sports(id),          -- NULL = all sports in this org
  status           text        NOT NULL DEFAULT 'invited'
                               CHECK (status IN ('invited','active','suspended','removed')),
  invited_by       uuid        NOT NULL REFERENCES users(id),
  responded_at     timestamptz,
  suspended_at     timestamptz,
  suspended_by     uuid        REFERENCES users(id),
  removed_at       timestamptz,
  removed_by       uuid        REFERENCES users(id),
  removal_reason   text        CHECK (removal_reason IS NULL OR length(removal_reason) <= 500),
  notes_enc        text,                                        -- field-level encrypted; never projected publicly
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, user_id, COALESCE(sport_id, '00000000-0000-0000-0000-000000000000'::uuid))
);
CREATE INDEX IF NOT EXISTS org_official_rosters_org_status ON org_official_rosters(organisation_id, status);
CREATE INDEX IF NOT EXISTS org_official_rosters_user       ON org_official_rosters(user_id);

-- ── 2. Roster audit log ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_official_roster_history (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  roster_id       uuid        NOT NULL REFERENCES org_official_rosters(id),
  actor_id        uuid        NOT NULL REFERENCES users(id),
  from_status     text        NOT NULL,
  to_status       text        NOT NULL,
  reason_enc      text,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_official_roster_history_roster ON org_official_roster_history(roster_id, at DESC);

-- ── 3. Assignor grants: who in the org may assign officials ───────────────────
CREATE TABLE IF NOT EXISTS org_assignor_grants (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid        NOT NULL REFERENCES organisations(id),
  granted_to      uuid        NOT NULL REFERENCES users(id),
  granted_by      uuid        NOT NULL REFERENCES users(id),
  sport_id        uuid        REFERENCES sports(id),           -- NULL = all sports
  jurisdiction    text        CHECK (jurisdiction IS NULL OR length(jurisdiction) <= 120),
  can_invite      boolean     NOT NULL DEFAULT true,
  can_assign      boolean     NOT NULL DEFAULT true,
  can_release     boolean     NOT NULL DEFAULT false,
  status          text        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','revoked')),
  revoked_at      timestamptz,
  revoked_by      uuid        REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, granted_to, COALESCE(sport_id, '00000000-0000-0000-0000-000000000000'::uuid))
);
CREATE INDEX IF NOT EXISTS org_assignor_grants_org_status    ON org_assignor_grants(organisation_id, status);
CREATE INDEX IF NOT EXISTS org_assignor_grants_grantee       ON org_assignor_grants(granted_to, status);

-- ── 4. Org official messages: broadcast comms history ────────────────────────
CREATE TABLE IF NOT EXISTS org_official_messages (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid        NOT NULL REFERENCES organisations(id),
  sent_by          uuid        NOT NULL REFERENCES users(id),
  subject          text        NOT NULL CHECK (length(subject) BETWEEN 2 AND 200),
  body_enc         text        NOT NULL,
  sport_id         uuid        REFERENCES sports(id),          -- NULL = all sports
  recipient_filter jsonb       NOT NULL DEFAULT '{}',
  recipient_count  int         NOT NULL DEFAULT 0,
  sent_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_official_messages_org ON org_official_messages(organisation_id, sent_at DESC);
