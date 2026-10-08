-- Support & dispute cases: ONE canonical case model for platform questions/incidents (kind=support) and transactional
-- conflicts (kind=dispute). A case only REFERENCES existing records (reservation, invoice, payment, event, game ...) through
-- case_links; nothing is copied. The requester-visible thread (case_messages.visibility='public') is kept apart from staff-only
-- notes ('internal'). case_events is the append-only action timeline. Nothing here is ever deleted.
CREATE TABLE cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no       bigint GENERATED ALWAYS AS IDENTITY,
  kind          text NOT NULL CHECK (kind IN ('support','dispute')),
  category      text NOT NULL,
  priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','awaiting_user','escalated','resolved','withdrawn')),
  subject       text NOT NULL,
  requester_id  uuid NOT NULL REFERENCES users,
  assignee_id   uuid REFERENCES users,
  contact_channel text NOT NULL DEFAULT 'in_app' CHECK (contact_channel IN ('in_app','email','push')),
  details       jsonb NOT NULL DEFAULT '{}',                -- structured, non-personal facts (e.g. disputed amount + currency)
  resolution    text,
  resolved_by   uuid REFERENCES users,
  resolved_at   timestamptz,
  escalated_at  timestamptz,
  first_response_due timestamptz NOT NULL,
  resolution_due     timestamptz NOT NULL,
  first_responded_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cases_requester ON cases (requester_id, created_at DESC);
CREATE INDEX cases_queue ON cases (status, priority, created_at);
CREATE INDEX cases_assignee ON cases (assignee_id, status);

-- References to canonical records. entity_id is deliberately not a foreign key: it points into many different tables.
CREATE TABLE case_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES cases,
  entity_type text NOT NULL CHECK (entity_type IN ('reservation','booking','invoice','payment','shop_order','coach_hire','event','game','appointment','insurance_policy','sponsorship')),
  entity_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, entity_type, entity_id)
);
CREATE INDEX case_links_entity ON case_links (entity_type, entity_id);

CREATE TABLE case_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES cases,
  author_id   uuid NOT NULL REFERENCES users,
  visibility  text NOT NULL CHECK (visibility IN ('public','internal')),
  kind        text NOT NULL DEFAULT 'message' CHECK (kind IN ('message','info_request')),
  body_enc    text NOT NULL,                                -- free text can contain personal data
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_messages_case ON case_messages (case_id, created_at);

-- Evidence: only metadata is listable; reference and file are encrypted and each staff read is audit-logged.
CREATE TABLE case_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES cases,
  label         text,
  reference_enc text,
  file_name     text,
  content_type  text,
  size_bytes    int,
  sha256        text,
  file_enc      text,
  added_by      uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (reference_enc IS NOT NULL OR file_enc IS NOT NULL)
);
CREATE INDEX case_evidence_case ON case_evidence (case_id);

-- Append-only timeline of every action on a case: who, what, before/after, why.
CREATE TABLE case_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES cases,
  actor_id    uuid NOT NULL REFERENCES users,
  action      text NOT NULL,
  from_status text,
  to_status   text,
  reason      text,
  data        jsonb NOT NULL DEFAULT '{}',                   -- e.g. the domain action invoked and the reference it returned
  visibility  text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','internal')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_events_case ON case_events (case_id, created_at);
