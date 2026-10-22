-- Corporate sponsor workspaces (#283). Purely additive and backwards-compatible: a sponsor brand can be linked to an
-- organisation, whose staff then hold sponsor roles; nothing is dropped, rewritten or deleted. Brands without an
-- organisation keep working exactly as before (the brand owner is always the manager). No ON DELETE CASCADE.

-- Brand -> canonical organisation (nullable; existing brands stay owner-only).
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations;
CREATE INDEX IF NOT EXISTS sponsors_organisation ON sponsors (organisation_id) WHERE organisation_id IS NOT NULL;

-- New staff roles on the existing membership table (widening only: every existing role stays valid).
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'organisation_members'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%role%' LOOP
    EXECUTE format('ALTER TABLE organisation_members DROP CONSTRAINT %I', c);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'organisations'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%' LOOP
    EXECUTE format('ALTER TABLE organisations DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE organisation_members ADD CONSTRAINT organisation_members_role_check
  CHECK (role IN ('owner','admin','coach','finance','manager','evaluator','legal','approver','auditor'));
ALTER TABLE organisations ADD CONSTRAINT organisations_kind_check
  CHECK (kind IN ('club','academy','school','college','university','company','other'));

-- Departments of an organisation (generic, reusable by other modules). Archived, never deleted.
CREATE TABLE IF NOT EXISTS org_departments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS org_departments_live ON org_departments (organisation_id, lower(name)) WHERE archived_at IS NULL;

-- Department scope: NULL = every department, so existing members and deals keep their current meaning.
ALTER TABLE organisation_members ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES org_departments;
ALTER TABLE sponsorships         ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES org_departments;
CREATE INDEX IF NOT EXISTS sponsorships_department ON sponsorships (department_id) WHERE department_id IS NOT NULL;
