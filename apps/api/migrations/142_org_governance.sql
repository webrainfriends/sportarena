-- Organisation governance: academies sit under a parent (umbrella) organisation that holds the plan, and every new
-- organisation is reviewed by the platform team before it can operate or be listed publicly.
-- Additive only: existing organisations are backfilled as 'approved' by the column default, nothing is dropped or narrowed.

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS parent_organisation_id uuid REFERENCES organisations(id);
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved';
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS approval_decided_by uuid REFERENCES users(id);
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS approval_decided_at timestamptz;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS approval_note text;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS approval_requested_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organisations_approval_status_check') THEN
    ALTER TABLE organisations ADD CONSTRAINT organisations_approval_status_check CHECK (approval_status IN ('pending','approved','rejected','suspended'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organisations_parent_not_self') THEN
    ALTER TABLE organisations ADD CONSTRAINT organisations_parent_not_self CHECK (parent_organisation_id IS NULL OR parent_organisation_id <> id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS organisations_parent ON organisations (parent_organisation_id) WHERE parent_organisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS organisations_review_queue ON organisations (approval_status, approval_requested_at) WHERE approval_status <> 'approved';

-- The meter that counts academies under an umbrella organisation (a live gauge, like teams and staff seats).
INSERT INTO commercial_meters (key, name, unit, mode, period) VALUES
  ('academies', 'Academies', 'academy', 'gauge', 'lifetime')
ON CONFLICT DO NOTHING;
