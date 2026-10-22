-- Public sponsorship calls and private invitations (#285). Extends the programs/rounds of #284; purely additive and
-- backwards-compatible. Nothing is dropped, rewritten or deleted; no ON DELETE CASCADE. Rollback = deploy the previous code
-- (the new columns have defaults and the new tables are simply unused; every existing program stays public and every
-- existing round keeps its date-based window because closes_at/opens_at are backfilled from opens_on/closes_on).

-- Who can see a call: 'public' (searchable by anyone) or 'invitation_only' (never listed; reachable only by invitees and brand staff).
ALTER TABLE sponsorship_programs ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public';
DO $$ BEGIN
  ALTER TABLE sponsorship_programs ADD CONSTRAINT sponsorship_programs_visibility_chk CHECK (visibility IN ('public','invitation_only'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Deadlines are instants in an IANA timezone: opens_on 00:00 local .. closes_on at closes_time (default: end of that day) local.
ALTER TABLE sponsorship_rounds ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';
ALTER TABLE sponsorship_rounds ADD COLUMN IF NOT EXISTS closes_time time;
ALTER TABLE sponsorship_rounds ADD COLUMN IF NOT EXISTS opens_at timestamptz;
ALTER TABLE sponsorship_rounds ADD COLUMN IF NOT EXISTS closes_at timestamptz;
-- Backfill with exactly the behaviour rounds had before: open from the start of opens_on until the end of closes_on (UTC).
UPDATE sponsorship_rounds SET opens_at = opens_on::timestamp AT TIME ZONE 'UTC' WHERE opens_at IS NULL;
UPDATE sponsorship_rounds SET closes_at = (closes_on + 1)::timestamp AT TIME ZONE 'UTC' WHERE closes_at IS NULL;
CREATE INDEX IF NOT EXISTS sponsorship_rounds_closing ON sponsorship_rounds (closes_at) WHERE status = 'open';

-- Frequently asked questions of a program, shown on its public page. Archived, never deleted.
CREATE TABLE IF NOT EXISTS sponsorship_program_faqs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id  uuid NOT NULL REFERENCES sponsorship_programs,
  position    int  NOT NULL DEFAULT 0,
  question    text NOT NULL CHECK (length(question) BETWEEN 1 AND 300),
  answer      text NOT NULL CHECK (length(answer) BETWEEN 1 AND 2000),
  row_version int  NOT NULL DEFAULT 1,
  created_by  uuid REFERENCES users,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsorship_program_faqs_program ON sponsorship_program_faqs (program_id, position, id) WHERE archived_at IS NULL;

-- A brand invites a specific athlete, team or event to a program. The invitee is the person who owns/organises the target.
CREATE TABLE IF NOT EXISTS sponsorship_invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id      uuid NOT NULL REFERENCES sponsorship_programs,
  target_type     text NOT NULL CHECK (target_type IN ('event','team','athlete')),
  target_id       uuid NOT NULL,
  invitee_user_id uuid NOT NULL REFERENCES users,
  invited_by      uuid NOT NULL REFERENCES users,
  message         text CHECK (message IS NULL OR length(message) <= 1000),
  status          text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','viewed','applied','declined','revoked')),
  viewed_at       timestamptz,
  responded_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- one live invitation per program and target; a revoked or declined one stays on record and can be replaced by a new invitation
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_invitations_live ON sponsorship_invitations (program_id, target_type, target_id) WHERE status IN ('invited','viewed','applied');
CREATE INDEX IF NOT EXISTS sponsorship_invitations_program ON sponsorship_invitations (program_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS sponsorship_invitations_invitee ON sponsorship_invitations (invitee_user_id, created_at DESC, id);

-- An application made through an invitation keeps the link.
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS invitation_id uuid REFERENCES sponsorship_invitations;
