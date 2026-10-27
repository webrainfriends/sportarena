-- Federation & Governing Body OS (#475). Additive only: new tables, one widened CHECK on organisations.kind and one on case_links.entity_type
-- (every existing value stays valid). Nothing existing changes meaning and nothing is removed.
--
-- A governing body is a normal organisation (identity, legal details, contact, owners/admins all stay in `organisations`) plus one
-- `governing_bodies` row that carries only what is genuinely different: level, jurisdiction, recognised parent. Clubs, teams, events, people,
-- rule packs, payments and disciplinary cases are NOT copied: affiliations, licences and sanctions REFERENCE the canonical rows.
-- Decisions never delete: every lifecycle step lands in the append-only `fed_events`, and renewals are new rows that point at the one they renew.
-- Rollback = deploy the previous code; it ignores these tables, which can stay in place unused.

ALTER TABLE organisations DROP CONSTRAINT IF EXISTS organisations_kind_check;
ALTER TABLE organisations ADD CONSTRAINT organisations_kind_check
  CHECK (kind IN ('club','academy','school','college','university','company','other','federation'));

CREATE TABLE governing_bodies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL UNIQUE REFERENCES organisations,
  level           text NOT NULL CHECK (level IN ('international','continental','national','regional','state','district','league')),
  abbreviation    text NOT NULL CHECK (abbreviation ~ '^[A-Z0-9]{2,8}$'),
  country         text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  region          text CHECK (region IS NULL OR length(region) BETWEEN 1 AND 80),
  state           text CHECK (state IS NULL OR length(state) BETWEEN 1 AND 80),
  district        text CHECK (district IS NULL OR length(district) BETWEEN 1 AND 80),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  status_reason   text CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  affiliation_seq integer NOT NULL DEFAULT 0,       -- per-body counters for human-readable numbers; bumped inside the issuing transaction
  licence_seq     integer NOT NULL DEFAULT 0,
  sanction_seq    integer NOT NULL DEFAULT 0,
  row_version     integer NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX governing_bodies_abbr ON governing_bodies (abbreviation, coalesce(country, ''), level);
CREATE INDEX governing_bodies_scope ON governing_bodies (level, country, status);

-- Sports and disciplines a body governs. Ending one keeps the row.
CREATE TABLE governing_body_sports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id    uuid NOT NULL REFERENCES governing_bodies,
  sport_id   uuid NOT NULL REFERENCES sports,
  discipline text NOT NULL DEFAULT '' CHECK (length(discipline) <= 60),
  started_on date NOT NULL DEFAULT current_date,
  ended_on   date,
  UNIQUE (body_id, sport_id, discipline)
);
CREATE INDEX governing_body_sports_sport ON governing_body_sports (sport_id) WHERE ended_on IS NULL;

-- Recognition: a body is recognised under one parent at a time. Requests, refusals and ends are kept, so the hierarchy has a history.
CREATE TABLE governing_body_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id      uuid NOT NULL REFERENCES governing_bodies,
  child_id       uuid NOT NULL REFERENCES governing_bodies,
  status         text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','recognised','declined','withdrawn','ended')),
  requested_by   uuid NOT NULL REFERENCES users,
  requested_side text NOT NULL CHECK (requested_side IN ('parent','child')),
  decided_by     uuid REFERENCES users,
  reason         text CHECK (reason IS NULL OR length(reason) <= 500),
  effective_from date,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  CHECK (parent_id <> child_id),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX governing_body_links_one_parent ON governing_body_links (child_id) WHERE status = 'recognised';
CREATE UNIQUE INDEX governing_body_links_one_request ON governing_body_links (parent_id, child_id) WHERE status = 'requested';
CREATE INDEX governing_body_links_parent ON governing_body_links (parent_id, status);

-- The hierarchy must stay acyclic. The API serialises changes and checks first; this is the backstop for any other writer.
CREATE FUNCTION governing_body_links_acyclic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'recognised' AND EXISTS (
    WITH RECURSIVE up(id) AS (SELECT NEW.parent_id UNION SELECT l.parent_id FROM governing_body_links l JOIN up ON l.child_id = up.id WHERE l.status = 'recognised' AND l.id <> NEW.id)
    SELECT 1 FROM up WHERE id = NEW.child_id) THEN
    RAISE EXCEPTION 'a governing body cannot be recognised under itself or one of its own descendants';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER governing_body_links_acyclic BEFORE INSERT OR UPDATE ON governing_body_links FOR EACH ROW EXECUTE FUNCTION governing_body_links_acyclic();

-- Scoped, least-privilege delegation. Owners/admins of the body's organisation can do everything; these roles can do one job each and never
-- reach a club's finance, coaching or medical data (no federation capability reads them). sport_id NULL = every sport the body governs.
CREATE TABLE governing_body_roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id    uuid NOT NULL REFERENCES governing_bodies,
  user_id    uuid NOT NULL REFERENCES users,
  role       text NOT NULL CHECK (role IN ('registrar','licensing','sanctioner','secretary','compliance','auditor')),
  sport_id   uuid REFERENCES sports,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  granted_by uuid NOT NULL REFERENCES users,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES users,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX governing_body_roles_live ON governing_body_roles (body_id, user_id, role, coalesce(sport_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'active';
CREATE INDEX governing_body_roles_user ON governing_body_roles (user_id, status);

-- Immutable decision history for everything below. Rows are never updated or deleted.
CREATE TABLE fed_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id      uuid NOT NULL REFERENCES governing_bodies,
  subject_type text NOT NULL CHECK (subject_type IN ('body','link','role','affiliation','licence','sanction','policy','date')),
  subject_id   uuid NOT NULL,
  action       text NOT NULL,
  from_status  text,
  to_status    text,
  actor_id     uuid REFERENCES users,
  reason       text,
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX fed_events_subject ON fed_events (subject_type, subject_id, created_at);
CREATE INDEX fed_events_body ON fed_events (body_id, created_at DESC);
CREATE FUNCTION fed_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER fed_events_append_only BEFORE UPDATE OR DELETE ON fed_events FOR EACH ROW EXECUTE FUNCTION fed_events_append_only();

-- Evidence for an application. Only metadata is listed; the reference and file are encrypted and every read by a reviewer is audit-logged.
CREATE TABLE fed_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id       uuid NOT NULL REFERENCES governing_bodies,
  subject_type  text NOT NULL CHECK (subject_type IN ('affiliation','licence','sanction')),
  subject_id    uuid NOT NULL,
  requirement   text NOT NULL CHECK (length(requirement) BETWEEN 1 AND 80),
  reference_enc text,
  file_name     text,
  content_type  text,
  size_bytes    integer,
  sha256        text,
  file_enc      text,
  added_by      uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  CHECK (reference_enc IS NOT NULL OR file_enc IS NOT NULL)
);
CREATE INDEX fed_evidence_subject ON fed_evidence (subject_type, subject_id) WHERE removed_at IS NULL;

-- ------------------------------------------------------------------ affiliation
CREATE TABLE fed_affiliation_categories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id         uuid NOT NULL REFERENCES governing_bodies,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  applicant_kind  text NOT NULL DEFAULT 'club' CHECK (applicant_kind IN ('club','academy','school','league','other')),
  sport_id        uuid REFERENCES sports,
  description     text CHECK (description IS NULL OR length(description) <= 500),
  fee_minor       bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  currency        text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  duration_months integer NOT NULL DEFAULT 12 CHECK (duration_months BETWEEN 1 AND 60),
  archived_at     timestamptz,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fed_affiliation_categories_name ON fed_affiliation_categories (body_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE fed_affiliations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id         uuid NOT NULL REFERENCES governing_bodies,
  organisation_id uuid NOT NULL REFERENCES organisations,
  category_id     uuid NOT NULL REFERENCES fed_affiliation_categories,
  season_year     integer NOT NULL CHECK (season_year BETWEEN 1990 AND 2200),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','under_review','needs_info','approved','rejected','suspended','expired','withdrawn')),
  affiliation_no  text,
  applicant_id    uuid NOT NULL REFERENCES users,
  previous_id     uuid REFERENCES fed_affiliations,
  effective_from  date,
  effective_to    date,
  fee_minor       bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  fee_currency    text NOT NULL DEFAULT 'USD',
  fee_status      text NOT NULL DEFAULT 'none' CHECK (fee_status IN ('none','due','paid','waived')),
  fee_paid_on     date,
  fee_reference_enc text,
  fee_recorded_by uuid REFERENCES users,
  policy_version_id uuid,                              -- the governing requirements the decision was made under (FK added below)
  checks          jsonb NOT NULL DEFAULT '[]',         -- the requirement checks as they stood at the decision, so history is explainable
  override_reason text CHECK (override_reason IS NULL OR length(override_reason) <= 500),
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) <= 500),
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  note            text CHECK (note IS NULL OR length(note) <= 1000),
  row_version     integer NOT NULL DEFAULT 1,
  submitted_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  CHECK (status NOT IN ('approved','suspended','expired') OR (affiliation_no IS NOT NULL AND effective_from IS NOT NULL AND effective_to IS NOT NULL))
);
CREATE UNIQUE INDEX fed_affiliations_no ON fed_affiliations (body_id, affiliation_no) WHERE affiliation_no IS NOT NULL;
CREATE UNIQUE INDEX fed_affiliations_one_live ON fed_affiliations (body_id, organisation_id, season_year) WHERE status IN ('draft','submitted','under_review','needs_info','approved','suspended');
CREATE INDEX fed_affiliations_body ON fed_affiliations (body_id, status, season_year);
CREATE INDEX fed_affiliations_org ON fed_affiliations (organisation_id, status);

-- ------------------------------------------------------------------ licences
CREATE TABLE fed_licence_types (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id               uuid NOT NULL REFERENCES governing_bodies,
  name                  text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  holder_role           text NOT NULL CHECK (holder_role IN ('athlete','coach','official','administrator','other')),
  sport_id              uuid NOT NULL REFERENCES sports,
  discipline            text NOT NULL DEFAULT '' CHECK (length(discipline) <= 60),
  grade                 text NOT NULL DEFAULT '' CHECK (length(grade) <= 40),
  grade_rank            integer NOT NULL DEFAULT 0 CHECK (grade_rank BETWEEN 0 AND 20),
  duration_months       integer NOT NULL DEFAULT 12 CHECK (duration_months BETWEEN 1 AND 120),
  fee_minor             bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  currency              text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  requires_verification text CHECK (requires_verification IS NULL OR requires_verification IN ('gamer','coach','physio','doctor')),
  requires_affiliation  boolean NOT NULL DEFAULT false,
  window_required       boolean NOT NULL DEFAULT false,
  archived_at           timestamptz,
  created_by            uuid NOT NULL REFERENCES users,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fed_licence_types_name ON fed_licence_types (body_id, sport_id, lower(name), lower(discipline)) WHERE archived_at IS NULL;

CREATE TABLE fed_licences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id         uuid NOT NULL REFERENCES governing_bodies,
  type_id         uuid NOT NULL REFERENCES fed_licence_types,
  holder_id       uuid NOT NULL REFERENCES users,
  applicant_id    uuid NOT NULL REFERENCES users,       -- the holder, or their verified guardian
  affiliation_id  uuid REFERENCES fed_affiliations,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','under_review','needs_info','active','rejected','suspended','expired','revoked','withdrawn')),
  licence_no      text,
  public_code     text UNIQUE,
  grade           text NOT NULL DEFAULT '',             -- copied at issue: a later change to the type never rewrites a licence already held
  issued_on       date,
  expires_on      date,
  previous_id     uuid REFERENCES fed_licences,
  fee_minor       bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  fee_currency    text NOT NULL DEFAULT 'USD',
  fee_status      text NOT NULL DEFAULT 'none' CHECK (fee_status IN ('none','due','paid','waived')),
  fee_paid_on     date,
  fee_reference_enc text,
  fee_recorded_by uuid REFERENCES users,
  policy_version_id uuid,
  checks          jsonb NOT NULL DEFAULT '[]',
  override_reason text CHECK (override_reason IS NULL OR length(override_reason) <= 500),
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) <= 500),
  suspended_until date,
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  note            text CHECK (note IS NULL OR length(note) <= 1000),
  row_version     integer NOT NULL DEFAULT 1,
  submitted_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on),
  CHECK (status NOT IN ('active','suspended','expired','revoked') OR (licence_no IS NOT NULL AND issued_on IS NOT NULL AND expires_on IS NOT NULL))
);
CREATE UNIQUE INDEX fed_licences_no ON fed_licences (body_id, licence_no) WHERE licence_no IS NOT NULL;
-- one live licence of a type per person; a renewal is a new row that points at the one it renews, so it may start while the old one is still running
CREATE UNIQUE INDEX fed_licences_one_live ON fed_licences (body_id, type_id, holder_id) WHERE previous_id IS NULL AND status IN ('draft','submitted','under_review','needs_info','active','suspended');
CREATE UNIQUE INDEX fed_licences_one_renewal ON fed_licences (previous_id) WHERE previous_id IS NOT NULL AND status IN ('draft','submitted','under_review','needs_info','active','suspended');
CREATE INDEX fed_licences_body ON fed_licences (body_id, status, expires_on);
CREATE INDEX fed_licences_holder ON fed_licences (holder_id, status);

-- ------------------------------------------------------------------ sanctioning (references the canonical event; never creates one)
CREATE TABLE fed_sanctions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id            uuid NOT NULL REFERENCES governing_bodies,
  event_id           uuid NOT NULL REFERENCES events,
  applicant_id       uuid NOT NULL REFERENCES users,
  status             text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','under_review','needs_info','approved','rejected','suspended','revoked','withdrawn')),
  sanction_no        text,
  categories         text[] NOT NULL DEFAULT '{}',        -- the competition scope asked for (age groups, divisions…)
  approved_categories text[],
  requested_starts_on date NOT NULL,
  requested_ends_on  date NOT NULL,
  approved_starts_on date,
  approved_ends_on   date,
  ruleset_version_id uuid REFERENCES ruleset_versions,   -- the governed #68 rule version the competition runs under
  conditions         text[] NOT NULL DEFAULT '{}',
  policy_version_id  uuid,
  checks             jsonb NOT NULL DEFAULT '[]',
  override_reason    text CHECK (override_reason IS NULL OR length(override_reason) <= 500),
  decision_reason    text CHECK (decision_reason IS NULL OR length(decision_reason) <= 500),
  decided_by         uuid REFERENCES users,
  decided_at         timestamptz,
  note               text CHECK (note IS NULL OR length(note) <= 1000),
  row_version        integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_ends_on >= requested_starts_on),
  CHECK (approved_ends_on IS NULL OR approved_starts_on IS NULL OR approved_ends_on >= approved_starts_on),
  CHECK (status NOT IN ('approved','suspended','revoked') OR (sanction_no IS NOT NULL AND approved_starts_on IS NOT NULL AND approved_ends_on IS NOT NULL))
);
CREATE UNIQUE INDEX fed_sanctions_no ON fed_sanctions (body_id, sanction_no) WHERE sanction_no IS NOT NULL;
CREATE UNIQUE INDEX fed_sanctions_one_live ON fed_sanctions (body_id, event_id) WHERE status IN ('requested','under_review','needs_info','approved','suspended');
CREATE INDEX fed_sanctions_body ON fed_sanctions (body_id, status);
CREATE INDEX fed_sanctions_event ON fed_sanctions (event_id, status);

-- ------------------------------------------------------------------ governed requirements (administrative policy; playing/scoring rules stay in #68)
CREATE TABLE fed_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id     uuid NOT NULL REFERENCES governing_bodies,
  kind        text NOT NULL CHECK (kind IN ('affiliation','licence','sanction','eligibility','roster','competition_entry','official_grade','registration','transfer','discipline','para_classification')),
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  sport_id    uuid REFERENCES sports,
  category    text NOT NULL DEFAULT '' CHECK (length(category) <= 60),
  season_year integer CHECK (season_year IS NULL OR season_year BETWEEN 1990 AND 2200),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fed_policies_scope ON fed_policies (body_id, kind, coalesce(sport_id, '00000000-0000-0000-0000-000000000000'::uuid), category, coalesce(season_year, 0)) WHERE status = 'active';

CREATE TABLE fed_policy_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id      uuid NOT NULL REFERENCES fed_policies,
  version        integer NOT NULL CHECK (version >= 1),
  effective_from date NOT NULL,
  summary        text CHECK (summary IS NULL OR length(summary) <= 1000),
  params         jsonb NOT NULL DEFAULT '{}',
  published_by   uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, version),
  UNIQUE (policy_id, effective_from)
);
CREATE FUNCTION fed_policy_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'published policy versions are immutable; publish a new version'; END $$;
CREATE TRIGGER fed_policy_versions_immutable BEFORE UPDATE OR DELETE ON fed_policy_versions FOR EACH ROW EXECUTE FUNCTION fed_policy_versions_immutable();

ALTER TABLE fed_affiliations ADD CONSTRAINT fed_affiliations_policy_fk FOREIGN KEY (policy_version_id) REFERENCES fed_policy_versions;
ALTER TABLE fed_licences     ADD CONSTRAINT fed_licences_policy_fk     FOREIGN KEY (policy_version_id) REFERENCES fed_policy_versions;
ALTER TABLE fed_sanctions    ADD CONSTRAINT fed_sanctions_policy_fk    FOREIGN KEY (policy_version_id) REFERENCES fed_policy_versions;

-- ------------------------------------------------------------------ the federation's own dates (everything else on the calendar is read live from its source)
CREATE TABLE fed_dates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id          uuid NOT NULL REFERENCES governing_bodies,
  kind             text NOT NULL CHECK (kind IN ('registration_window','transfer_window','congress','administrative','official_development','assessment','deadline')),
  title            text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  starts_on        date NOT NULL,
  ends_on          date NOT NULL,
  sport_id         uuid REFERENCES sports,
  note             text CHECK (note IS NULL OR length(note) <= 500),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancelled_reason text CHECK (cancelled_reason IS NULL OR length(cancelled_reason) <= 300),
  created_by       uuid NOT NULL REFERENCES users,
  row_version      integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX fed_dates_body ON fed_dates (body_id, starts_on) WHERE status = 'active';

-- Every export is logged: who, what, as of when, how many rows, and a hash of the exact bytes.
CREATE TABLE fed_exports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id     uuid NOT NULL REFERENCES governing_bodies,
  report      text NOT NULL,
  filters     jsonb NOT NULL DEFAULT '{}',
  as_of       date NOT NULL,
  row_count   integer NOT NULL,
  sha256      text NOT NULL,
  exported_by uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fed_exports_append_only BEFORE UPDATE OR DELETE ON fed_exports FOR EACH ROW EXECUTE FUNCTION fed_events_append_only();

-- An appeal or dispute can reference the federation record it is about (the person's own licence, a club's own affiliation, an organiser's own sanction).
ALTER TABLE case_links DROP CONSTRAINT IF EXISTS case_links_entity_type_check;
ALTER TABLE case_links ADD CONSTRAINT case_links_entity_type_check CHECK (entity_type IN ('reservation','booking','invoice','payment','shop_order','coach_hire','event','game','fixture','appointment','insurance_policy','sponsorship',
  'sponsorship_obligation','sponsorship_payment','sponsorship_delivery','sponsorship_submission','billboard_post','federation_licence','federation_affiliation','federation_sanction'));
