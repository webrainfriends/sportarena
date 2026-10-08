-- Verification service: a cross-domain case workflow attached to the canonical user / sponsor / event rows (no entity is cloned).
-- A person raises a case with evidence; the platform team reviews it against a checklist and decides. The public badge is
-- derived from an approved, unexpired, unrevoked case — never from a self-declared role. Cases and history are never deleted.
CREATE TABLE verification_cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no       bigint GENERATED ALWAYS AS IDENTITY,
  type          text NOT NULL CHECK (type IN ('gamer','coach','physio','doctor','sponsor','event')),
  subject_type  text NOT NULL CHECK (subject_type IN ('user','sponsor','event')),
  subject_id    uuid NOT NULL,
  sport_id      uuid REFERENCES sports,
  requested_by  uuid NOT NULL REFERENCES users,
  status        text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','in_review','needs_info','approved','rejected','revoked','withdrawn')),
  claim_note    text,
  rules_version int  NOT NULL,
  checklist     jsonb NOT NULL DEFAULT '[]',          -- reviewer's answers, one per rule item: [{key, ok, note}]
  reviewer_id   uuid REFERENCES users,
  decision_reason text,
  decided_at    timestamptz,
  expires_at    timestamptz,
  previous_case_id uuid REFERENCES verification_cases, -- set when this case renews / re-submits an earlier one
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- at most one open case per subject and type
CREATE UNIQUE INDEX verification_one_open ON verification_cases (type, subject_id) WHERE status IN ('submitted','in_review','needs_info');
CREATE INDEX verification_subject ON verification_cases (subject_type, subject_id, status);
CREATE INDEX verification_queue ON verification_cases (status, submitted_at);

-- Evidence: only metadata is listable; the reference and file contents are encrypted and every reviewer read is audit-logged.
CREATE TABLE verification_evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES verification_cases,
  kind         text NOT NULL,
  label        text,
  reference_enc text,                                  -- licence / registration number, URL …
  file_name    text,
  content_type text,
  size_bytes   int,
  sha256       text,
  file_enc     text,                                   -- base64 file, encrypted
  added_by     uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (reference_enc IS NOT NULL OR file_enc IS NOT NULL)
);
CREATE INDEX verification_evidence_case ON verification_evidence (case_id);

-- Append-only history: who did what, why, and the before/after status.
CREATE TABLE verification_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES verification_cases,
  actor_id    uuid NOT NULL REFERENCES users,
  action      text NOT NULL,
  from_status text,
  to_status   text,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_events_case ON verification_events (case_id, created_at);
