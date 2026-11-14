-- Experience Studio: authoring tables for the immutable landing page manifest system (#1213).
-- Additive only. No DROP/TRUNCATE.

CREATE TABLE IF NOT EXISTS lp_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS lp_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES lp_pages(id),
  block_type text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  config jsonb NOT NULL DEFAULT '{}',
  visible boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lp_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid,
  filename text NOT NULL,
  mime_type text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  size_bytes bigint NOT NULL DEFAULT 0,
  alt_text_enc text,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS lp_block_assets (
  block_id uuid NOT NULL REFERENCES lp_blocks(id),
  asset_id uuid NOT NULL REFERENCES lp_assets(id),
  role text NOT NULL DEFAULT 'media',
  PRIMARY KEY (block_id, asset_id, role)
);

CREATE TABLE IF NOT EXISTS lp_news_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES lp_pages(id),
  sport_id uuid,
  category text NOT NULL DEFAULT 'general',
  headline text NOT NULL,
  deck text,
  body_md text,
  hero_asset_id uuid REFERENCES lp_assets(id),
  author_user_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lp_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES lp_pages(id),
  version_number integer NOT NULL,
  manifest_hash text NOT NULL,
  asset_bundle_hash text NOT NULL,
  cdn_manifest_url text NOT NULL,
  cdn_assets_url text NOT NULL,
  published_by uuid NOT NULL REFERENCES users(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz,
  rolled_back_by uuid REFERENCES users(id),
  UNIQUE (page_id, version_number)
);

CREATE TABLE IF NOT EXISTS lp_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid REFERENCES lp_pages(id),
  block_id uuid REFERENCES lp_blocks(id),
  asset_id uuid REFERENCES lp_assets(id),
  version_id uuid REFERENCES lp_versions(id),
  action text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  actor_ip text,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lp_localisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id uuid NOT NULL REFERENCES lp_blocks(id),
  locale text NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  reviewed boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (block_id, locale, key)
);

CREATE TABLE IF NOT EXISTS lp_seo_metadata (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES lp_pages(id) UNIQUE,
  meta_title text,
  meta_description text,
  og_title text,
  og_description text,
  og_image_asset_id uuid REFERENCES lp_assets(id),
  canonical_url text,
  structured_data jsonb,
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lp_blocks_page_position ON lp_blocks(page_id, position);
CREATE INDEX IF NOT EXISTS lp_audit_page ON lp_audit_log(page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lp_versions_page ON lp_versions(page_id, version_number DESC);
CREATE INDEX IF NOT EXISTS lp_news_page_status ON lp_news_items(page_id, status);
CREATE INDEX IF NOT EXISTS lp_localisations_block ON lp_localisations(block_id, locale);
