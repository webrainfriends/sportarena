-- Role-based command centres: one row of personal workspace preferences per person (additive; nothing is rewritten or removed).
-- Roles themselves are never stored here: they are derived live from the canonical memberships (users.roles, team_members,
-- organisation_members, venue_staff, guardian_links, ...) so revoking a membership removes the role at once.
CREATE TABLE IF NOT EXISTS workspace_prefs (
  user_id         uuid PRIMARY KEY REFERENCES users,
  active_role     text,
  active_scope_id uuid,
  default_org_id  uuid REFERENCES organisations,
  pins            jsonb NOT NULL DEFAULT '[]'::jsonb,     -- [{type:'team'|'event'|'venue'|'org', id}]
  saved_filters   jsonb NOT NULL DEFAULT '[]'::jsonb,     -- [{id, name, role, section, kinds?, unread?}]
  version         integer NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_prefs_pins_array CHECK (jsonb_typeof(pins) = 'array' AND jsonb_array_length(pins) <= 24),
  CONSTRAINT workspace_prefs_filters_array CHECK (jsonb_typeof(saved_filters) = 'array' AND jsonb_array_length(saved_filters) <= 24)
);
