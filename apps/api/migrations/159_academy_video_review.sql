-- Academy OS P1 / Gap 13 (#793): video review & coach feedback inside the academy. ADDITIVE ONLY: nothing is dropped, rewritten or narrowed.
-- There is no video store here. The clip stays the athlete's own library item (passport_videos, #317/#565 lineage); this table is only a governed
-- REFERENCE that ties that clip to an academy session, a curriculum objective, a coach observation, an assessment and a shared development action.
-- Revoking or expiring a link, withdrawing guardian media consent, or the athlete unsharing the clip stops academy viewing on the very next request
-- (the gate is evaluated live on every read; no state here caches consent). Rollback: see the DOWN note at the bottom (no data is ever removed).
CREATE TABLE IF NOT EXISTS academy_clip_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations,
  athlete_id       uuid NOT NULL REFERENCES users,
  video_id         uuid NOT NULL REFERENCES passport_videos,
  session_id       uuid REFERENCES academy_sessions,
  objective_key    text,                                    -- the curriculum objective mapped to the session (academy_session_objectives.objective_key)
  dev_objective_id uuid REFERENCES academy_dev_objectives,  -- the season development objective (#785)
  observation_id   uuid REFERENCES coaching_observations,   -- the coach observation this clip evidences
  assessment_ref   text CHECK (assessment_ref IS NULL OR length(assessment_ref) <= 120),
  intervention_id  uuid REFERENCES academy_dev_interventions, -- the shared development action (kind video_review)
  start_ms         int CHECK (start_ms IS NULL OR start_ms >= 0),
  end_ms           int CHECK (end_ms IS NULL OR end_ms >= 0),
  coach_note_enc   text,
  athlete_visible  boolean NOT NULL DEFAULT true,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  expires_at       timestamptz,
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES users,
  revoke_reason    text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 300),
  review_state     text NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending','understood','need_help','question')),
  review_note_enc  text,
  reviewed_by      uuid REFERENCES users,
  reviewed_at      timestamptz,
  first_viewed_at  timestamptz,
  row_version      int NOT NULL DEFAULT 1,
  created_by       uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_ms IS NULL OR start_ms IS NULL OR end_ms > start_ms)
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_clip_links_once ON academy_clip_links (session_id, video_id) WHERE status = 'active' AND session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS academy_clip_links_session ON academy_clip_links (session_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS academy_clip_links_athlete ON academy_clip_links (athlete_id, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS academy_clip_links_org ON academy_clip_links (organisation_id, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS academy_clip_links_video ON academy_clip_links (video_id);

-- Time-stamped coach annotations. Soft-removed only.
CREATE TABLE IF NOT EXISTS academy_clip_annotations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id    uuid NOT NULL REFERENCES academy_clip_links,
  at_ms      int NOT NULL CHECK (at_ms >= 0),
  kind       text NOT NULL DEFAULT 'note' CHECK (kind IN ('note','praise','fix')),
  note_enc   text NOT NULL,
  author_id  uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE INDEX IF NOT EXISTS academy_clip_annotations_link ON academy_clip_annotations (link_id, at_ms, id) WHERE removed_at IS NULL;

-- DOWN (manual, never automatic): the feature is inert without these tables. To roll back, deploy the previous build; the two tables hold only
-- references and can stay in place (no data is deleted). Do not DROP them in production.
