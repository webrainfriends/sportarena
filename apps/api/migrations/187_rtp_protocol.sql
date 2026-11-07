-- Return-to-Play protocol milestones and formal approval records (issue #584).
-- Additive only. Rollback: deploy previous build.

-- RTP stage milestones per episode
CREATE TABLE IF NOT EXISTS injury_rtp_milestones (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id       uuid NOT NULL REFERENCES injury_episodes(id),
  stage_order      int  NOT NULL CHECK (stage_order BETWEEN 1 AND 20),
  stage_name       text NOT NULL CHECK (length(stage_name) BETWEEN 1 AND 150),
  criteria_enc     text NOT NULL,
  target_date      date,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','in_progress','achieved','failed','skipped')),
  achieved_on      date,
  assessed_by      uuid REFERENCES users(id),
  evidence_enc     text,
  linked_encounter_id uuid,
  overdue_alert_sent_at timestamptz,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS injury_rtp_milestones_ep ON injury_rtp_milestones (episode_id, stage_order);

-- Formal return-to-train and return-to-play approvals
CREATE TABLE IF NOT EXISTS injury_rtp_approvals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id           uuid NOT NULL REFERENCES injury_episodes(id),
  approval_type        text NOT NULL CHECK (approval_type IN ('return_to_train','return_to_play')),
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','conditional','deferred')),
  approved_on          date,
  approved_by          uuid REFERENCES users(id),
  valid_until          date,
  load_restrictions_enc text,
  internal_assessment_enc text,
  evidence_refs_enc    text,
  conditions_enc       text,
  linked_clearance_id  uuid,
  revoked_at           timestamptz,
  revoked_reason_enc   text,
  revoked_by           uuid REFERENCES users(id),
  row_version          int NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS injury_rtp_approvals_live ON injury_rtp_approvals
  (episode_id, approval_type) WHERE revoked_at IS NULL AND status <> 'deferred';
CREATE INDEX IF NOT EXISTS injury_rtp_approvals_ep ON injury_rtp_approvals (episode_id);
