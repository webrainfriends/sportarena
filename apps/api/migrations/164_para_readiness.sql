-- PS-10 (#840): Accessible tournament operational-readiness gate
-- Extends event_ops_requirements with para-sport dimensions; adds exception, signoff and notification tables.
-- Additive only: no drops, no truncates, no data changes.

ALTER TABLE event_ops_requirements
  ADD COLUMN IF NOT EXISTS para_category text,
  ADD COLUMN IF NOT EXISTS is_safety_critical boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS evidence_ref text,
  ADD COLUMN IF NOT EXISTS signoff_at timestamptz,
  ADD COLUMN IF NOT EXISTS signoff_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS changed_since_signoff boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN event_ops_requirements.para_category IS
  'accessible_facilities|classification|support_roles|medical|equipment|incident_response|transport_access|communication — NULL for non-para items';
COMMENT ON COLUMN event_ops_requirements.is_safety_critical IS
  'True for items that block event opening when unmet and have no approved exception';

CREATE TABLE IF NOT EXISTS para_readiness_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id),
  requirement_id uuid NOT NULL REFERENCES event_ops_requirements(id),
  justification_enc text NOT NULL,
  evidence_ref text,
  second_officer_id uuid REFERENCES users(id),
  second_officer_approved_at timestamptz,
  second_officer_note_enc text,
  approved_by uuid NOT NULL REFERENCES users(id),
  valid_until date,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS para_readiness_exceptions_event_idx ON para_readiness_exceptions(event_id);
CREATE INDEX IF NOT EXISTS para_readiness_exceptions_req_idx ON para_readiness_exceptions(requirement_id);
CREATE INDEX IF NOT EXISTS para_readiness_exceptions_status_idx ON para_readiness_exceptions(status) WHERE status IN ('pending','approved');

CREATE TABLE IF NOT EXISTS para_readiness_signoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id),
  requirement_id uuid NOT NULL REFERENCES event_ops_requirements(id),
  signed_by uuid NOT NULL REFERENCES users(id),
  evidence_ref text NOT NULL,
  note_enc text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS para_readiness_signoffs_event_idx ON para_readiness_signoffs(event_id);
CREATE INDEX IF NOT EXISTS para_readiness_signoffs_req_idx ON para_readiness_signoffs(requirement_id);

CREATE TABLE IF NOT EXISTS para_readiness_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id),
  role text NOT NULL CHECK (role IN ('organiser','venue','official','athlete')),
  message text NOT NULL,
  contingency_plan text,
  recipient_ids uuid[] NOT NULL DEFAULT '{}',
  sent_by uuid NOT NULL REFERENCES users(id),
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS para_readiness_notifications_event_idx ON para_readiness_notifications(event_id);
