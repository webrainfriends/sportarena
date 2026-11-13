-- Academy OS P1 / Gap 16 (#796): Structured Guardian Conferences & Academy Reviews.
-- Additive only. All tables use IF NOT EXISTS. No data is deleted.
BEGIN;

CREATE TABLE IF NOT EXISTS academy_conferences (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organisations(id),
  plan_id          uuid REFERENCES academy_dev_plans(id),
  title            text NOT NULL,
  kind             text NOT NULL CHECK (kind IN (
    'annual_review','termly','progress_check','welfare','emergency','guardian_request','other'
  )),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','scheduled','confirmed','in_progress','completed','cancelled','rescheduled'
  )),
  scheduled_at     timestamptz,
  duration_minutes integer NOT NULL DEFAULT 60,
  location_type    text NOT NULL DEFAULT 'video' CHECK (location_type IN (
    'in_person','video','phone','hybrid'
  )),
  location_detail_enc text,          -- AES-256-GCM, AAD='academy_conferences.location_detail'
  initiated_by     uuid NOT NULL REFERENCES users(id),
  agenda_enc       text,             -- AES-256-GCM, AAD='academy_conferences.agenda'
  staff_notes_enc  text,             -- AES-256-GCM, AAD='academy_conferences.staff_notes'; NEVER shown to guardians
  family_visible   boolean NOT NULL DEFAULT false,
  outcome_summary_enc text,          -- AES-256-GCM, AAD='academy_conferences.outcome_summary'
  row_version      integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS academy_conference_attendees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id   uuid NOT NULL REFERENCES academy_conferences(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  role            text NOT NULL CHECK (role IN ('lead_coach','coach','guardian','admin','athlete','external')),
  status          text NOT NULL DEFAULT 'invited' CHECK (status IN (
    'invited','confirmed','declined','attended','no_show'
  )),
  invite_sent_at  timestamptz,
  responded_at    timestamptz,
  notes_enc       text,              -- AES-256-GCM, AAD='academy_conference_attendees.notes'
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conference_id, user_id)
);

CREATE TABLE IF NOT EXISTS academy_conference_evidence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id   uuid NOT NULL REFERENCES academy_conferences(id),
  source_kind     text NOT NULL CHECK (source_kind IN (
    'dev_review','objective','intervention','assessment','external','media'
  )),
  source_id       uuid,
  label           text NOT NULL,
  visible_to_roles text[] NOT NULL DEFAULT ARRAY['coach','admin'],
  added_by        uuid NOT NULL REFERENCES users(id),
  added_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS academy_conference_agenda_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id   uuid NOT NULL REFERENCES academy_conferences(id),
  seq             integer NOT NULL DEFAULT 0,
  title           text NOT NULL,
  description_enc text,              -- AES-256-GCM, AAD='academy_conference_agenda_items.description'
  kind            text NOT NULL DEFAULT 'general' CHECK (kind IN (
    'review_domain','objective_progress','welfare','guardian_concern','admin','aob','general'
  )),
  time_minutes    integer,
  owner_user_id   uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS academy_conference_decisions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id        uuid NOT NULL REFERENCES academy_conferences(id),
  agenda_item_id       uuid REFERENCES academy_conference_agenda_items(id),
  kind                 text NOT NULL CHECK (kind IN (
    'decision','action','recommendation','follow_up','concern_noted'
  )),
  body_enc             text NOT NULL,  -- AES-256-GCM, AAD='academy_conference_decisions.body'
  responsible_user_id  uuid REFERENCES users(id),
  deadline_on          date,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open','in_progress','done','deferred','cancelled'
  )),
  source_link          text,
  visible_to_guardian  boolean NOT NULL DEFAULT false,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz,
  resolved_by          uuid REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS academy_conference_acknowledgements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id   uuid NOT NULL REFERENCES academy_conferences(id),
  guardian_id     uuid NOT NULL REFERENCES users(id),
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  method          text NOT NULL DEFAULT 'app_tap' CHECK (method IN ('app_tap','e_signature')),
  ip_hash         text,
  outcome_pdf_id  uuid,
  UNIQUE (conference_id, guardian_id)
);

CREATE TABLE IF NOT EXISTS academy_conference_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id   uuid NOT NULL REFERENCES academy_conferences(id),
  actor_id        uuid REFERENCES users(id),
  action          text NOT NULL,
  detail_json     jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conf_org        ON academy_conferences(org_id);
CREATE INDEX IF NOT EXISTS idx_conf_plan       ON academy_conferences(plan_id);
CREATE INDEX IF NOT EXISTS idx_conf_status     ON academy_conferences(status);
CREATE INDEX IF NOT EXISTS idx_conf_scheduled  ON academy_conferences(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_conf_att_user   ON academy_conference_attendees(user_id, conference_id);
CREATE INDEX IF NOT EXISTS idx_conf_dec_conference  ON academy_conference_decisions(conference_id);
CREATE INDEX IF NOT EXISTS idx_conf_dec_responsible ON academy_conference_decisions(responsible_user_id);

COMMIT;
