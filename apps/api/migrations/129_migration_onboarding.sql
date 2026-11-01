-- Migration & guided onboarding (#514). Purely additive: new tables only, nothing existing is altered, nothing is deleted.
-- A migration project moves a spreadsheet or an export from another product (TeamSnap, SportsEngine, Excel/CSV) into an organisation through
-- one shared path: map -> validate (dry run) -> approve -> import in resumable batches -> reconcile -> (governed) rollback.
-- Row contents are personal data, so each row is stored as one encrypted blob (data_enc); only the matching keys are indexed.
-- No ON DELETE CASCADE anywhere: a rolled-back migration marks rows and links, it never removes them.
CREATE TABLE migration_projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  domain          text NOT NULL CHECK (domain IN ('roster')),
  source          text NOT NULL CHECK (source IN ('teamsnap','sportsengine','excel','csv')),
  status          text NOT NULL DEFAULT 'mapping' CHECK (status IN ('draft','mapping','validation','dry_run','approved','importing','reconciliation','completed','rolled_back_partially','cancelled')),
  file_name       text,
  sport_id        uuid REFERENCES sports,
  mapping         jsonb NOT NULL DEFAULT '{}',          -- canonical field -> source column header
  options         jsonb NOT NULL DEFAULT '{}',          -- date_format, default_role, default_team_id
  mapping_version int NOT NULL DEFAULT 1,
  source_rows     int NOT NULL DEFAULT 0,
  created_by      uuid NOT NULL REFERENCES users,
  approved_by     uuid REFERENCES users,
  approved_at     timestamptz,
  started_at      timestamptz,
  completed_at    timestamptz,
  rolled_back_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX migration_projects_org ON migration_projects (organisation_id, created_at DESC);

CREATE TABLE migration_rows (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES migration_projects,
  row_no        int NOT NULL,                            -- the line in the file the person sees (header is line 1)
  raw_enc       text NOT NULL,                           -- the source row as uploaded (encrypted JSON)
  data_enc      text,                                    -- the canonical row after mapping (encrypted JSON)
  email_idx     text,                                    -- blind index of the email: the only identifier a person is matched on
  key_hash      text,                                    -- idempotency key (team + person); never derived from a name alone
  check_status  text NOT NULL DEFAULT 'pending' CHECK (check_status IN ('pending','valid','warning','rejected','duplicate','conflict','skipped')),
  reasons       jsonb NOT NULL DEFAULT '[]',
  review        text CHECK (review IN ('confirmed','skipped')),   -- an identity conflict is only ever settled by a person
  reviewed_by   uuid REFERENCES users,
  commit_status text CHECK (commit_status IN ('invited','awaiting_signup','awaiting_consent','already_member','failed','rolled_back')),
  team_id       uuid REFERENCES teams,
  user_id       uuid REFERENCES users,
  committed_at  timestamptz,
  UNIQUE (project_id, row_no)
);
CREATE INDEX migration_rows_project_status ON migration_rows (project_id, check_status);
-- people who are not on the platform yet: the invitation is created when they register with the same email
CREATE INDEX migration_rows_waiting ON migration_rows (email_idx) WHERE commit_status IN ('awaiting_signup','awaiting_consent');

-- Idempotency across uploads and projects: one live link per organisation, domain and key, so a repeated upload never creates a second invitation.
CREATE TABLE migration_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  domain          text NOT NULL,
  key_hash        text NOT NULL,
  project_id      uuid NOT NULL REFERENCES migration_projects,
  row_id          uuid NOT NULL REFERENCES migration_rows,
  created_at      timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz
);
CREATE UNIQUE INDEX migration_links_live ON migration_links (organisation_id, domain, key_hash) WHERE released_at IS NULL;

-- What a project created (teams), so a rollback can archive exactly that and nothing else.
CREATE TABLE migration_created (
  project_id  uuid NOT NULL REFERENCES migration_projects,
  entity_kind text NOT NULL CHECK (entity_kind IN ('team')),
  entity_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, entity_kind, entity_id)
);

-- Guided setup: the persona a person picked for their launch checklist. Progress itself is never stored: every step is derived from real data.
CREATE TABLE setup_preferences (
  user_id      uuid PRIMARY KEY REFERENCES users,
  persona      text CHECK (persona IN ('academy','club','school','venue','organiser','coach')),
  dismissed_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
