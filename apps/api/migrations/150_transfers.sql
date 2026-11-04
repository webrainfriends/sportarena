-- Player transfer, loan, release & clearance (#478 / #563). Additive only. A transfer is a governed REQUEST that, once every required party has approved
-- its current version, moves the player through the canonical team membership, competition registration and career timeline exactly once.
-- Contracts are never edited here; money state is separate from sporting state; history is append-only.

CREATE TABLE IF NOT EXISTS tr_transfers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('permanent','loan','loan_extension','loan_recall','release','dual_registration','international')),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','completed','rejected','withdrawn','cancelled')),
  version          int  NOT NULL DEFAULT 1 CHECK (version >= 1),
  player_id        uuid NOT NULL REFERENCES users,
  sport_id         uuid NOT NULL REFERENCES sports,
  from_team_id     uuid REFERENCES teams,
  to_team_id       uuid REFERENCES teams,
  season_id        uuid REFERENCES comp_seasons,                   -- competition / season context (drives window, authority and registration handoff)
  parent_id        uuid REFERENCES tr_transfers,                   -- the loan an extension or recall refers to
  effective_on     date NOT NULL,
  loan_ends_on     date,
  loan_state       text CHECK (loan_state IS NULL OR loan_state IN ('active','extended','recalled','returned','expired')),
  term             jsonb NOT NULL DEFAULT '{}'::jsonb,             -- proposed term: recall clause, appearance caps, purchase option ...
  reason_enc       text,                                           -- initiator's reason, field-level encrypted
  reference        text CHECK (reference IS NULL OR length(reference) <= 120),
  clearance_status text NOT NULL DEFAULT 'not_required' CHECK (clearance_status IN ('not_required','requested','received','refused')),
  clearance_ref    text CHECK (clearance_ref IS NULL OR length(clearance_ref) <= 120),         -- external federation reference, recorded as supplied
  clearance_source text CHECK (clearance_source IS NULL OR length(clearance_source) <= 160),
  clearance_verified boolean NOT NULL DEFAULT false,                -- uploaded or typed evidence never becomes verified automatically
  fee_minor        bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  fee_currency     text NOT NULL DEFAULT 'USD' CHECK (fee_currency ~ '^[A-Z]{3}$'),
  fee_state        text NOT NULL DEFAULT 'none' CHECK (fee_state IN ('none','agreed','invoiced','paid','cleared')),
  fee_invoice_ref  text CHECK (fee_invoice_ref IS NULL OR length(fee_invoice_ref) <= 120),    -- reference into canonical invoicing, never a copy
  window_exception_enc text,                                       -- reason an authority let the movement happen outside the window
  window_exception_by  uuid REFERENCES users,
  initiated_by     uuid NOT NULL REFERENCES users,
  idempotency_key  text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80),
  completed_by     uuid REFERENCES users,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (from_team_id IS NOT NULL OR to_team_id IS NOT NULL),
  CHECK (kind <> 'release' OR (from_team_id IS NOT NULL AND to_team_id IS NULL)),
  CHECK (kind IN ('release') OR to_team_id IS NOT NULL),
  CHECK (from_team_id IS NULL OR to_team_id IS NULL OR from_team_id <> to_team_id),
  CHECK (loan_ends_on IS NULL OR loan_ends_on >= effective_on),
  CHECK (kind NOT IN ('loan_extension','loan_recall') OR parent_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS tr_transfers_idem ON tr_transfers (initiated_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- the database, not the client, stops two live movements for one player in one sport
CREATE UNIQUE INDEX IF NOT EXISTS tr_transfers_one_open ON tr_transfers (player_id, sport_id) WHERE status IN ('draft','submitted','approved');
CREATE INDEX IF NOT EXISTS tr_transfers_player ON tr_transfers (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tr_transfers_from ON tr_transfers (from_team_id, status);
CREATE INDEX IF NOT EXISTS tr_transfers_to ON tr_transfers (to_team_id, status);
CREATE INDEX IF NOT EXISTS tr_transfers_season ON tr_transfers (season_id);

-- One decision per party per VERSION: amending the transfer bumps its version, so an old approval can never complete a changed transfer.
CREATE TABLE IF NOT EXISTS tr_approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES tr_transfers,
  version     int  NOT NULL,
  party       text NOT NULL CHECK (party IN ('player','guardian','source_club','destination_club','authority')),
  decision    text NOT NULL CHECK (decision IN ('approved','rejected')),
  decided_by  uuid NOT NULL REFERENCES users,
  note_enc    text,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, version, party)
);

CREATE TABLE IF NOT EXISTS tr_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES tr_transfers,
  version     int  NOT NULL,
  action      text NOT NULL CHECK (action IN ('requested','amended','submitted','approved_by','rejected_by','approved','withdrawn','cancelled','completed','clearance','fee','window_exception','loan_closed')),
  from_status text,
  to_status   text,
  actor_id    uuid REFERENCES users,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tr_events_transfer ON tr_events (transfer_id, created_at, id);

DROP TRIGGER IF EXISTS tr_approvals_immutable ON tr_approvals;
CREATE TRIGGER tr_approvals_immutable BEFORE UPDATE OR DELETE ON tr_approvals FOR EACH ROW EXECUTE FUNCTION gov_immutable();
DROP TRIGGER IF EXISTS tr_events_immutable ON tr_events;
CREATE TRIGGER tr_events_immutable BEFORE UPDATE OR DELETE ON tr_events FOR EACH ROW EXECUTE FUNCTION gov_immutable();

-- a transfer row itself is never deleted, and a completed one never changes its movement
CREATE OR REPLACE FUNCTION tr_transfers_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'transfers are never deleted' USING ERRCODE = '23514'; END IF;
  IF OLD.status = 'completed' AND (NEW.player_id, NEW.from_team_id, NEW.to_team_id, NEW.effective_on, NEW.kind) IS DISTINCT FROM (OLD.player_id, OLD.from_team_id, OLD.to_team_id, OLD.effective_on, OLD.kind) THEN
    RAISE EXCEPTION 'a completed transfer cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tr_transfers_guard ON tr_transfers;
CREATE TRIGGER tr_transfers_guard BEFORE UPDATE OR DELETE ON tr_transfers FOR EACH ROW EXECUTE FUNCTION tr_transfers_guard();
