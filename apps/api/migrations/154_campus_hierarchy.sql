-- Academy OS P0 / Gap 01: multi-campus & academy hierarchy (#781).
-- Additive only: no existing table is altered, nothing is dropped, truncated or cascaded. A single-campus academy that never opens the
-- Campuses tab has no rows here and behaves exactly as before.
--
--   academy group (an organisation; child academies keep using organisations.parent_organisation_id)
--     -> region / country -> campus / branch -> sport department        (org_units: one tree, immutable ids, effective dates)
--        -> programme / cohort / venue / team / coach / athlete          (org_unit_links: effective-dated pointers; the objects are never copied)
--
-- Ids are never reused or rewritten. A move ends one link and opens another, so history, identity and contracts stay where they were.

CREATE TABLE IF NOT EXISTS org_units (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,          -- the academy group (or the stand-alone academy) that owns the tree
  parent_id       uuid REFERENCES org_units,
  kind            text NOT NULL CHECK (kind IN ('region','campus','department')),
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  code            text CHECK (code IS NULL OR code ~ '^[A-Za-z0-9_-]{2,16}$'),
  country         text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  city            text CHECK (city IS NULL OR length(city) <= 80),
  timezone        text CHECK (timezone IS NULL OR length(timezone) <= 60),
  sport           text CHECK (sport IS NULL OR length(sport) <= 40),   -- departments: the sport they run
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  valid_from      date NOT NULL DEFAULT CURRENT_DATE,
  valid_to        date,
  is_default      boolean NOT NULL DEFAULT false,                   -- created by "set up campuses" for an existing single-campus academy
  row_version     int NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX IF NOT EXISTS org_units_org ON org_units (organisation_id, kind, status);
CREATE INDEX IF NOT EXISTS org_units_parent ON org_units (parent_id) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS org_units_code ON org_units (organisation_id, lower(code)) WHERE code IS NOT NULL AND archived_at IS NULL;

-- A change set: one adoption, transfer or bulk assignment. Every link it opened or closed carries its id, so it can be rolled back as a unit.
CREATE TABLE IF NOT EXISTS org_unit_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  kind            text NOT NULL CHECK (kind IN ('adopt','assign','transfer')),
  reason          text CHECK (reason IS NULL OR length(reason) <= 500),
  effective_on    date NOT NULL,
  summary         jsonb NOT NULL DEFAULT '{}',
  performed_by    uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  rolled_back_at  timestamptz,
  rolled_back_by  uuid REFERENCES users,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80)
);
CREATE INDEX IF NOT EXISTS org_unit_changes_org ON org_unit_changes (organisation_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS org_unit_changes_idem ON org_unit_changes (organisation_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Pointer from an existing object to a unit. object_id is the canonical id of the venue / team / cohort / programme / enrolment / staff user /
-- supplier / child academy; the object itself stays where it is. effective_to is exclusive (the day the next link takes over).
CREATE TABLE IF NOT EXISTS org_unit_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id        uuid NOT NULL REFERENCES org_units,
  unit_kind      text NOT NULL CHECK (unit_kind IN ('region','campus','department')),
  object_type    text NOT NULL CHECK (object_type IN ('venue','team','cohort','programme','enrolment','staff','supplier','organisation')),
  object_id      uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  change_id      uuid REFERENCES org_unit_changes,
  closed_by_change_id uuid REFERENCES org_unit_changes,
  linked_by      uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
-- an object sits in one unit of each kind at a time (one campus, one department): the open link
CREATE UNIQUE INDEX IF NOT EXISTS org_unit_links_open ON org_unit_links (object_type, object_id, unit_kind) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS org_unit_links_unit ON org_unit_links (unit_id, object_type) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS org_unit_links_object ON org_unit_links (object_type, object_id, effective_from);

-- Branch-scoped roles. They add to (never replace) the organisation membership: the person must already be an active member.
CREATE TABLE IF NOT EXISTS org_unit_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     uuid NOT NULL REFERENCES org_units,
  user_id     uuid NOT NULL REFERENCES users,
  role        text NOT NULL CHECK (role IN ('director','sports_lead','coach','operations','finance','auditor')),
  inherit     boolean NOT NULL DEFAULT true,                         -- also applies to the units below this one
  valid_from  date NOT NULL DEFAULT CURRENT_DATE,
  valid_to    date,
  granted_by  uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  ended_by    uuid REFERENCES users,
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS org_unit_roles_live ON org_unit_roles (unit_id, user_id, role) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS org_unit_roles_user ON org_unit_roles (user_id) WHERE ended_at IS NULL;

-- Policy settings: set on a unit, inherited by everything below it, overridden further down. Resolved in the capability (nearest wins).
CREATE TABLE IF NOT EXISTS org_unit_policies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id    uuid NOT NULL REFERENCES org_units,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  set_by     uuid REFERENCES users,
  set_at     timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  cleared_by uuid REFERENCES users
);
CREATE UNIQUE INDEX IF NOT EXISTS org_unit_policies_live ON org_unit_policies (unit_id, key) WHERE cleared_at IS NULL;

-- Per-campus audit trail: who did what to which unit or object, and when (the global audit_log row is written as well).
CREATE TABLE IF NOT EXISTS org_unit_events (
  id              bigserial PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations,
  unit_id         uuid REFERENCES org_units,
  actor_id        uuid REFERENCES users,
  action          text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}',
  change_id       uuid REFERENCES org_unit_changes,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_unit_events_unit ON org_unit_events (unit_id, at DESC);
CREATE INDEX IF NOT EXISTS org_unit_events_org ON org_unit_events (organisation_id, at DESC);

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- Transfer workflow. A transfer of something already placed on a campus is a request that runs the academy's own configured process
-- (approvals, finance clearance, athlete/guardian acknowledgement, handover checklist) and only then moves the pointer. Nothing is deleted.

-- The process an academy configures, one live definition per object type; each save is a new version, requests keep the version they started on.
CREATE TABLE IF NOT EXISTS org_transfer_flows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  object_type     text NOT NULL CHECK (object_type IN ('venue','team','cohort','programme','enrolment','staff','supplier','organisation')),
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  steps           jsonb NOT NULL DEFAULT '[]',
  min_notice_days int NOT NULL DEFAULT 0 CHECK (min_notice_days BETWEEN 0 AND 120),
  allow_backdate  boolean NOT NULL DEFAULT false,
  version         int NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS org_transfer_flows_live ON org_transfer_flows (organisation_id, object_type) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS org_transfers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  object_type     text NOT NULL CHECK (object_type IN ('venue','team','cohort','programme','enrolment','staff','supplier','organisation')),
  object_ids      uuid[] NOT NULL CHECK (cardinality(object_ids) BETWEEN 1 AND 50),
  from_unit_id    uuid NOT NULL REFERENCES org_units,
  to_unit_id      uuid NOT NULL REFERENCES org_units,
  effective_on    date NOT NULL,
  reason_code     text NOT NULL CHECK (reason_code IN ('relocation','pathway_progression','reorganisation','capacity','performance','family_request','data_correction','other')),
  note_enc        text,                                                  -- free text about people: encrypted, read only by the people running the transfer
  status          text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','scheduled','completed','rejected','cancelled','failed')),
  flow_id         uuid REFERENCES org_transfer_flows,
  flow_version    int,
  allow_backdate  boolean NOT NULL DEFAULT false,
  requested_by    uuid NOT NULL REFERENCES users,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  closed_by       uuid REFERENCES users,
  change_id       uuid REFERENCES org_unit_changes,
  failure         text,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80),
  CHECK (from_unit_id <> to_unit_id)
);
CREATE INDEX IF NOT EXISTS org_transfers_org ON org_transfers (organisation_id, status, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS org_transfers_idem ON org_transfers (organisation_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS org_transfer_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES org_transfers,
  seq         int NOT NULL,
  stage       int NOT NULL DEFAULT 1,                                    -- steps in one stage run in parallel; a stage opens when the one before is complete
  key         text NOT NULL,
  label       text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('approval','checklist','acknowledge')),
  role        text NOT NULL CHECK (role IN ('source_director','destination_director','sports_lead','finance','admin','person')),
  required    boolean NOT NULL DEFAULT true,
  target_user_id uuid REFERENCES users,                                  -- acknowledgements: the athlete or staff member the step is about (their guardian answers for a minor)
  due_on      date,
  items       jsonb NOT NULL DEFAULT '[]',                               -- checklist: [{label, done, done_by, done_at}]
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','done','rejected','declined','skipped')),
  decided_by  uuid REFERENCES users,
  decided_at  timestamptz,
  override    boolean NOT NULL DEFAULT false,                            -- an owner/admin decided on behalf of the role
  note        text,
  UNIQUE (transfer_id, seq)
);
CREATE INDEX IF NOT EXISTS org_transfer_steps_open ON org_transfer_steps (transfer_id) WHERE status = 'pending';

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- A branch IS a campus. Main added academy_branches (a flat grouping of programmes and venues for the P&L); the campus tree supersedes it as the
-- place structure lives, and the two are kept in step so nothing is duplicated and nothing breaks: every branch has exactly one campus unit
-- (org_units.legacy_branch_id / academy_branches.unit_id), the branch endpoints keep working and keep writing the same rows, and programme-by-branch
-- reporting keeps reading academy_programmes.branch_id. Additive: no column is dropped or narrowed.
ALTER TABLE org_units ADD COLUMN IF NOT EXISTS legacy_branch_id uuid REFERENCES academy_branches(id);
CREATE UNIQUE INDEX IF NOT EXISTS org_units_legacy_branch ON org_units (legacy_branch_id) WHERE legacy_branch_id IS NOT NULL;
ALTER TABLE academy_branches ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES org_units(id);
CREATE UNIQUE INDEX IF NOT EXISTS academy_branches_unit ON academy_branches (unit_id) WHERE unit_id IS NOT NULL;
