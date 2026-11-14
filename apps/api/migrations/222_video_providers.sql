-- Issue #565: Provider-neutral adapters for external video/camera/performance systems
-- and AI intelligence suggestion log.

-- External provider video source records
CREATE TABLE IF NOT EXISTS video_provider_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations,
  provider text NOT NULL CHECK (provider IN ('hudl','veo','catapult','statsperform','youtube','vimeo','sportstec','dartfish','custom')),
  external_id text NOT NULL,              -- the provider's own video/clip ID
  external_url text,
  title text,
  metadata_enc text,                      -- provider metadata JSON, encrypted
  passport_video_id uuid REFERENCES passport_videos,  -- linked local copy, nullable until imported
  sync_state text NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending','syncing','synced','error','stale')),
  last_synced_at timestamptz,
  sync_error text,
  created_by uuid NOT NULL REFERENCES users,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vps_org_provider_ext ON video_provider_sources (org_id, provider, external_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS vps_org ON video_provider_sources (org_id, provider) WHERE archived_at IS NULL;

-- Encrypted OAuth tokens for provider integrations (never returned via API)
CREATE TABLE IF NOT EXISTS video_provider_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations,
  provider text NOT NULL,
  token_enc text NOT NULL,                -- encrypted access + refresh token bundle
  expiry timestamptz,
  scope text,
  connected_by uuid NOT NULL REFERENCES users,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vpt_org_provider ON video_provider_tokens (org_id, provider) WHERE revoked_at IS NULL;

-- AI suggestion log — inference clearly separated from verified match data
CREATE TABLE IF NOT EXISTS video_ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES passport_videos,
  suggestion_type text NOT NULL CHECK (suggestion_type IN ('tag','highlight','summary','caption','opponent_note')),
  payload_enc text NOT NULL,              -- suggested content, encrypted
  confidence numeric(4,3),               -- 0.000–1.000
  model_version text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','modified')),
  accepted_as uuid,                       -- FK to the entity created from this suggestion
  reviewed_by uuid REFERENCES users,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vai_video ON video_ai_suggestions (video_id, status);

-- AI processing run log
CREATE TABLE IF NOT EXISTS video_ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES passport_videos,
  trigger text NOT NULL CHECK (trigger IN ('manual','upload','schedule','match_link')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  suggestions_created int NOT NULL DEFAULT 0,
  tokens_used int,
  error text,
  initiated_by uuid NOT NULL REFERENCES users
);
CREATE INDEX IF NOT EXISTS var_video ON video_ai_runs (video_id);
