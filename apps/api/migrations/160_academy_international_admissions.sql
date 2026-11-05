-- International admissions & relocation readiness (#799). Additive extension of Academy applications (#392): nothing here changes or removes existing data.
--   * Checklist templates are DATA (per programme and/or origin country), versioned append-only; no country rules are hard-coded.
--   * A case holds one application's checklist, pinned to the template version it was created from.
--   * Passport / visa numbers live ONLY in academy_intl_documents, encrypted, revealed to the holder or a verified guardian (audited). Staff see status + expiry.
--   * Guardian legal permissions and other evidence are linked BY REFERENCE to the compliance engine (comp_records); nothing is copied.
--   * Every decision lands in the append-only academy_intl_events trail.
-- Rollback: these objects are standalone. To switch the feature off, stop calling the capabilities (the enrol gate only acts when a case exists); data is kept.

CREATE TABLE IF NOT EXISTS academy_residences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  kind            text NOT NULL DEFAULT 'residence_hall' CHECK (kind IN ('residence_hall','host_family','apartment','partner_hotel','other')),
  capacity        int CHECK (capacity IS NULL OR capacity BETWEEN 0 AND 5000),
  address_enc     text,
  contact_enc     text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_residences_org ON academy_residences (organisation_id, status);

CREATE TABLE IF NOT EXISTS academy_intl_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  programme_id    uuid REFERENCES academy_programmes,            -- null = every programme
  countries       text[] NOT NULL DEFAULT '{}',                   -- origin countries (ISO-2); empty = any
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  current_version int NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_intl_templates_org ON academy_intl_templates (organisation_id, status);

CREATE TABLE IF NOT EXISTS academy_intl_template_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     uuid NOT NULL REFERENCES academy_intl_templates,
  version         int NOT NULL,
  items           jsonb NOT NULL,                                 -- [{key,kind,label,mandatory,lead_days,expiry_months,link_kind}]
  note            text,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

CREATE TABLE IF NOT EXISTS academy_intl_cases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations,
  application_id   uuid NOT NULL UNIQUE REFERENCES academy_applications,
  athlete_id       uuid NOT NULL REFERENCES users,
  template_id      uuid NOT NULL REFERENCES academy_intl_templates,
  template_version int NOT NULL,
  origin_country   text NOT NULL CHECK (origin_country ~ '^[A-Z]{2}$'),
  arrival_on       date,
  school_org_id    uuid REFERENCES organisations,                 -- an ordinary school organisation; the academic link is made after enrolment
  residence_id     uuid REFERENCES academy_residences,
  reviewer_id      uuid REFERENCES users,                         -- responsible reviewer for this case
  row_version      int NOT NULL DEFAULT 1,
  created_by       uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_intl_cases_org ON academy_intl_cases (organisation_id, arrival_on);
CREATE INDEX IF NOT EXISTS academy_intl_cases_athlete ON academy_intl_cases (athlete_id);

CREATE TABLE IF NOT EXISTS academy_intl_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid NOT NULL REFERENCES academy_intl_cases,
  key             text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('eligibility','guardian_permission','travel_document','school','residence','transport','medical','custom')),
  label           text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 200),
  mandatory       boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','verified','rejected','waived')),
  due_on          date,
  expires_on      date,
  comp_record_id  uuid REFERENCES comp_records,                   -- evidence kept in the compliance engine, linked by reference
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  decision_note_enc text,
  row_version     int NOT NULL DEFAULT 1,
  UNIQUE (case_id, key)
);

-- Passport / visa vault: same shape as trip_documents (#485), scoped to a case. Never listed, never in a notification, document or ordinary Academy view.
CREATE TABLE IF NOT EXISTS academy_intl_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          uuid NOT NULL REFERENCES academy_intl_cases,
  kind             text NOT NULL CHECK (kind IN ('passport','visa')),
  status           text NOT NULL,
  expires_on       date,
  number_enc       text,
  evidence_ref_enc text,
  updated_by       uuid NOT NULL REFERENCES users,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, kind)
);

CREATE TABLE IF NOT EXISTS academy_offer_conditions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid NOT NULL REFERENCES academy_intl_cases,
  organisation_id uuid NOT NULL REFERENCES organisations,
  item_key        text,                                           -- optional link to a checklist item
  text            text NOT NULL CHECK (char_length(text) BETWEEN 3 AND 300),
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','met','withdrawn')),
  proposed_by     uuid NOT NULL REFERENCES users,
  approved_by     uuid REFERENCES users,                          -- must be an owner
  approved_at     timestamptz,
  met_by          uuid REFERENCES users,
  met_at          timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_offer_conditions_case ON academy_offer_conditions (case_id, status);

CREATE TABLE IF NOT EXISTS academy_arrival_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid NOT NULL REFERENCES academy_intl_cases,
  organisation_id uuid NOT NULL REFERENCES organisations,
  item_key        text,
  title           text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 200),
  due_on          date,
  owner_id        uuid REFERENCES users,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  done_by         uuid REFERENCES users,
  done_at         timestamptz,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_arrival_tasks_case ON academy_arrival_tasks (case_id, status, due_on);
CREATE INDEX IF NOT EXISTS academy_arrival_tasks_org ON academy_arrival_tasks (organisation_id, status, due_on);

-- The decision trail: append-only, never carries a document number.
CREATE TABLE IF NOT EXISTS academy_intl_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  case_id         uuid REFERENCES academy_intl_cases,
  kind            text NOT NULL,
  actor_id        uuid REFERENCES users,
  data            jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_intl_events_case ON academy_intl_events (case_id, created_at DESC);

CREATE OR REPLACE FUNCTION academy_intl_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
DROP TRIGGER IF EXISTS academy_intl_events_ao ON academy_intl_events;
CREATE TRIGGER academy_intl_events_ao BEFORE UPDATE OR DELETE ON academy_intl_events FOR EACH ROW EXECUTE FUNCTION academy_intl_append_only();
DROP TRIGGER IF EXISTS academy_intl_template_versions_ao ON academy_intl_template_versions;
CREATE TRIGGER academy_intl_template_versions_ao BEFORE UPDATE OR DELETE ON academy_intl_template_versions FOR EACH ROW EXECUTE FUNCTION academy_intl_append_only();
