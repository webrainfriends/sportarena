-- Finer guardian authority (issue #604). Additive and backwards-compatible: every existing link keeps full authority.
-- A link's scopes say which kinds of action the guardian may take for the young person; an organisation may further restrict
-- some scopes to the primary guardian within its own context. Nothing is deleted; a policy is retired, not removed.
ALTER TABLE guardian_links ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT '{pay,register,rsvp,travel_consent,consent,calendar}';
ALTER TABLE guardian_links ADD COLUMN IF NOT EXISTS scopes_updated_by uuid REFERENCES users;
ALTER TABLE guardian_links ADD COLUMN IF NOT EXISTS scopes_updated_at timestamptz;

CREATE TABLE IF NOT EXISTS org_guardian_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES organisations,
  primary_only_scopes text[] NOT NULL DEFAULT '{}',
  note                text,
  version             int  NOT NULL DEFAULT 1,
  created_by          uuid NOT NULL REFERENCES users,
  created_at          timestamptz NOT NULL DEFAULT now(),
  retired_at          timestamptz
);
-- one live policy per organisation; older versions stay as history
CREATE UNIQUE INDEX IF NOT EXISTS org_guardian_policies_live ON org_guardian_policies (organisation_id) WHERE retired_at IS NULL;
