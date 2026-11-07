-- Branded documents phase 2 (issue #249): sharing, render jobs, access log, brand asset kinds, kit identity fields.
-- All additions are strictly additive (no DROP / no data touched).

-- Secure, scoped, expiring document share links
CREATE TABLE IF NOT EXISTS document_shares (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES generated_documents(id),
  token        text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'base64url'),
  shared_by    uuid NOT NULL REFERENCES users(id),
  shared_with_email text,          -- null = open link; non-null = specific recipient
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  accessed_count int NOT NULL DEFAULT 0,
  max_accesses   int,              -- null = unlimited
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_shares_doc_idx ON document_shares(document_id);
CREATE INDEX IF NOT EXISTS document_shares_token_idx ON document_shares(token) WHERE revoked_at IS NULL;

-- Async render jobs (large docs, batch, regenerate)
CREATE TABLE IF NOT EXISTS render_jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status               text NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','running','done','failed','cancelled')),
  family               text NOT NULL,
  source_type          text,
  source_id            uuid,
  template_version_id  uuid REFERENCES document_template_versions(id),
  brand_kit_id         uuid REFERENCES brand_kits(id),
  actor_id             uuid NOT NULL REFERENCES users(id),
  idempotency_key      text UNIQUE,
  document_id          uuid REFERENCES generated_documents(id),  -- set when done
  error_message        text,
  pages                int,
  queued_at            timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  finished_at          timestamptz
);
CREATE INDEX IF NOT EXISTS render_jobs_actor_idx ON render_jobs(actor_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS render_jobs_status_idx ON render_jobs(status) WHERE status IN ('queued','running');

-- Immutable document access audit log (every generate / download / share / revoke)
CREATE TABLE IF NOT EXISTS document_access_log (
  id          bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES generated_documents(id),
  actor_id    uuid,                 -- null for anonymous token access
  share_token text,
  action      text NOT NULL,        -- 'generate' | 'download' | 'share' | 'revoke' | 'preview'
  ip_hash     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dal_doc_idx ON document_access_log(document_id, created_at DESC);

-- Richer brand identity on kits (tagline, preferred PDF font family)
ALTER TABLE brand_kits
  ADD COLUMN IF NOT EXISTS tagline    text,
  ADD COLUMN IF NOT EXISTS font_family text
    CHECK (font_family IS NULL OR font_family IN ('helvetica','times','courier'));

-- Additional asset kinds (stamp image, handwritten signature, co-brand partner logo)
ALTER TABLE brand_assets
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'logo'
    CHECK (kind IN ('logo','stamp','signature','co_brand'));
