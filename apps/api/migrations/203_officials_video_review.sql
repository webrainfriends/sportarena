-- Authorised video & incident review workspace (#1023). ADDITIVE ONLY.
-- Match footage with timestamps, multi-angle markers, human-authorised review sessions and controlled exports.
BEGIN;

CREATE TABLE IF NOT EXISTS official_match_videos (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id              uuid        NOT NULL REFERENCES fixtures(id),
  game_id                 uuid        REFERENCES games(id),
  angle_label             text        NOT NULL DEFAULT 'main',
  purpose                 text        NOT NULL DEFAULT 'match_record',
    CONSTRAINT omv_purpose CHECK (purpose IN ('match_record','incident_evidence','dispute_evidence','assessment_footage','federation_inquiry')),
  sport                   text        NOT NULL,
  federation_code         text,
  duration_ms             bigint,
  file_key                text        NOT NULL,
  file_size_bytes         bigint,
  mime_type               text        NOT NULL DEFAULT 'video/mp4',
  thumbnail_key           text,
  uploaded_by             uuid        NOT NULL REFERENCES users(id),
  media_rights_clearance  boolean     NOT NULL DEFAULT false,
  youth_consent_required  boolean     NOT NULL DEFAULT false,
  youth_consent_ref       uuid,
  retention_days          int         NOT NULL DEFAULT 365,
  archived_at             timestamptz,
  row_version             int         NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS omv_fixture_idx  ON official_match_videos(fixture_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS omv_game_idx     ON official_match_videos(game_id) WHERE game_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS omv_uploader_idx ON official_match_videos(uploaded_by);

CREATE TABLE IF NOT EXISTS official_video_access_grants (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id         uuid        NOT NULL REFERENCES official_match_videos(id),
  grantee_id       uuid        NOT NULL REFERENCES users(id),
  granted_by       uuid        NOT NULL REFERENCES users(id),
  access_role      text        NOT NULL,
    CONSTRAINT ovag_role CHECK (access_role IN ('assessor','federation','legal','external_body','independent_witness')),
  grant_reason_enc text,
  expires_at       timestamptz,
  revoked_at       timestamptz,
  revoked_by       uuid        REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (video_id, grantee_id)
);

CREATE INDEX IF NOT EXISTS ovag_video_idx   ON official_video_access_grants(video_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS ovag_grantee_idx ON official_video_access_grants(grantee_id);

CREATE TABLE IF NOT EXISTS official_video_incident_markers (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id         uuid        NOT NULL REFERENCES official_match_videos(id),
  game_action_id   uuid        REFERENCES game_actions(id),
  timestamp_ms     bigint      NOT NULL CHECK (timestamp_ms >= 0),
  end_timestamp_ms bigint,
  marker_type      text        NOT NULL,
    CONSTRAINT ovim_type CHECK (marker_type IN ('incident','warning','decision','disputed','evidence','performance','advantage')),
  sport_event_code text,
  angle_ref        text,
  severity         text        NOT NULL DEFAULT 'medium',
    CONSTRAINT ovim_severity CHECK (severity IN ('low','medium','high','critical')),
  note_enc         text,
  created_by       uuid        NOT NULL REFERENCES users(id),
  resolved_at      timestamptz,
  resolved_by      uuid        REFERENCES users(id),
  archived_at      timestamptz,
  row_version      int         NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ovim_video_idx  ON official_video_incident_markers(video_id, timestamp_ms) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS ovim_action_idx ON official_video_incident_markers(game_action_id) WHERE game_action_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ovim_creator_idx ON official_video_incident_markers(created_by);

CREATE TABLE IF NOT EXISTS official_video_review_sessions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id       uuid        NOT NULL REFERENCES fixtures(id),
  game_id          uuid        REFERENCES games(id),
  initiated_by     uuid        NOT NULL REFERENCES users(id),
  review_type      text        NOT NULL,
    CONSTRAINT ovrs_type CHECK (review_type IN ('incident_review','performance_review','dispute_review','federation_inquiry','appeal_review')),
  sport            text        NOT NULL,
  federation_ref   text,
  status           text        NOT NULL DEFAULT 'open',
    CONSTRAINT ovrs_status CHECK (status IN ('open','in_progress','pending_evidence','concluded','appealed','closed')),
  outcome_enc      text,
  outcome_category text,
    CONSTRAINT ovrs_outcome CHECK (outcome_category IS NULL OR outcome_category IN ('upheld','dismissed','inconclusive','deferred','referred_to_federation')),
  concluded_at     timestamptz,
  concluded_by     uuid        REFERENCES users(id),
  appeal_deadline  timestamptz,
  appeal_at        timestamptz,
  row_version      int         NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ovrs_fixture_idx ON official_video_review_sessions(fixture_id);
CREATE INDEX IF NOT EXISTS ovrs_status_idx  ON official_video_review_sessions(status) WHERE status NOT IN ('concluded','closed');

CREATE TABLE IF NOT EXISTS official_video_review_participants (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid        NOT NULL REFERENCES official_video_review_sessions(id),
  user_id     uuid        NOT NULL REFERENCES users(id),
  role        text        NOT NULL,
    CONSTRAINT ovrp_role CHECK (role IN ('chair','referee','umpire','organiser','assessor','federation','observer','legal')),
  added_by    uuid        NOT NULL REFERENCES users(id),
  joined_at   timestamptz,
  last_seen_at timestamptz,
  removed_at  timestamptz,
  UNIQUE (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS ovrp_session_idx ON official_video_review_participants(session_id) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS official_video_review_videos (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid        NOT NULL REFERENCES official_video_review_sessions(id),
  video_id   uuid        NOT NULL REFERENCES official_match_videos(id),
  added_by   uuid        NOT NULL REFERENCES users(id),
  note_enc   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, video_id)
);

CREATE INDEX IF NOT EXISTS ovrv_session_idx ON official_video_review_videos(session_id);

CREATE TABLE IF NOT EXISTS official_video_export_requests (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id           uuid        REFERENCES official_match_videos(id),
  session_id         uuid        REFERENCES official_video_review_sessions(id),
  requested_by       uuid        NOT NULL REFERENCES users(id),
  purpose_enc        text        NOT NULL,
  recipient_org      text,
  recipient_name_enc text,
  status             text        NOT NULL DEFAULT 'pending',
    CONSTRAINT over_status CHECK (status IN ('pending','approved','rejected','delivered','expired','revoked')),
  approved_by        uuid        REFERENCES users(id),
  rejected_by        uuid        REFERENCES users(id),
  reject_reason_enc  text,
  watermark_text     text,
  download_token     text        UNIQUE,
  expires_at         timestamptz,
  download_count     int         NOT NULL DEFAULT 0,
  max_downloads      int         NOT NULL DEFAULT 1,
  delivered_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT over_target CHECK (video_id IS NOT NULL OR session_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS over_video_idx   ON official_video_export_requests(video_id);
CREATE INDEX IF NOT EXISTS over_session_idx ON official_video_export_requests(session_id);
CREATE INDEX IF NOT EXISTS over_requester_idx ON official_video_export_requests(requested_by);
CREATE INDEX IF NOT EXISTS over_pending_idx ON official_video_export_requests(status) WHERE status = 'pending';

-- Append-only SHA-256 chained audit log
CREATE TABLE IF NOT EXISTS official_video_audit (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id   uuid        REFERENCES official_match_videos(id),
  session_id uuid        REFERENCES official_video_review_sessions(id),
  actor_id   uuid        NOT NULL REFERENCES users(id),
  action     text        NOT NULL,
  reason_enc text,
  metadata   jsonb,
  prev_hash  text,
  hash       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ova_video_idx   ON official_video_audit(video_id, created_at);
CREATE INDEX IF NOT EXISTS ova_session_idx ON official_video_audit(session_id, created_at);
CREATE INDEX IF NOT EXISTS ova_actor_idx   ON official_video_audit(actor_id);

COMMIT;
