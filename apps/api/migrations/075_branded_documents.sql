-- Branded documents & PDF template designer, phase 1 (issue #249): brand kits and logo assets, versioned document templates,
-- and immutable generated PDFs. Additive only: new tables, no existing row is touched. Nothing here is ever deleted - kits and
-- templates are archived, assets/template versions/generated documents are append-only (a trigger refuses UPDATE of their content and DELETE).
-- A kit belongs either to one user (personal) or to one organisation; the CHECK enforces exactly one.
CREATE TABLE brand_kits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid REFERENCES users,
  organisation_id uuid REFERENCES organisations,
  name            text NOT NULL,
  display_name    text NOT NULL,
  legal_name      text,
  address         text,
  contact_email   text,
  phone           text,
  website         text,
  tax_id          text,
  primary_color   text NOT NULL DEFAULT '#0F6E56' CHECK (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_color text NOT NULL DEFAULT '#444441' CHECK (secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
  footer_text     text,
  logo_asset_id   uuid,
  row_version     int  NOT NULL DEFAULT 1,
  archived_at     timestamptz,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_user_id IS NULL) <> (organisation_id IS NULL))
);
CREATE INDEX brand_kits_user ON brand_kits (owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX brand_kits_org  ON brand_kits (organisation_id) WHERE organisation_id IS NOT NULL;

-- Uploaded logo bytes are immutable; replacing a logo adds a row and moves brand_kits.logo_asset_id, so issued documents keep theirs.
CREATE TABLE brand_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kit_id       uuid NOT NULL REFERENCES brand_kits,
  kind         text NOT NULL DEFAULT 'logo' CHECK (kind IN ('logo')),
  content_type text NOT NULL CHECK (content_type IN ('image/png','image/jpeg')),
  file_name    text NOT NULL,
  size_bytes   int  NOT NULL,
  width_px     int  NOT NULL,
  height_px    int  NOT NULL,
  sha256       text NOT NULL,
  uploaded_by  uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brand_assets_kit ON brand_assets (kit_id, created_at DESC);
ALTER TABLE brand_kits ADD CONSTRAINT brand_kits_logo_fk FOREIGN KEY (logo_asset_id) REFERENCES brand_assets;

CREATE TABLE document_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid REFERENCES users,
  organisation_id uuid REFERENCES organisations,
  family          text NOT NULL,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  kit_id          uuid REFERENCES brand_kits,
  draft           jsonb NOT NULL,                       -- the editable layout (same shape as a version's layout)
  row_version     int  NOT NULL DEFAULT 1,
  archived_at     timestamptz,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_user_id IS NULL) <> (organisation_id IS NULL))
);
CREATE INDEX document_templates_user ON document_templates (owner_user_id, family) WHERE owner_user_id IS NOT NULL;
CREATE INDEX document_templates_org  ON document_templates (organisation_id, family) WHERE organisation_id IS NOT NULL;

-- A published version freezes the layout, the kit's text/colours and the logo asset it used.
CREATE TABLE document_template_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   uuid NOT NULL REFERENCES document_templates,
  version       int  NOT NULL,
  layout        jsonb NOT NULL,
  kit_snapshot  jsonb,
  logo_asset_id uuid REFERENCES brand_assets,
  published_by  uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

-- The issued bytes. One row per generation (regeneration = a new row); the PDF is stored encrypted on disk, never in the table.
CREATE TABLE generated_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family              text NOT NULL,
  source_type         text NOT NULL,
  source_id           uuid NOT NULL,
  template_version_id uuid REFERENCES document_template_versions,   -- NULL = the built-in classic layout
  logo_asset_id       uuid REFERENCES brand_assets,
  file_name           text NOT NULL,
  size_bytes          int  NOT NULL,
  sha256              text NOT NULL,
  pages               int  NOT NULL,
  generated_by        uuid NOT NULL REFERENCES users,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX generated_documents_source ON generated_documents (source_type, source_id, created_at DESC);
CREATE INDEX generated_documents_actor  ON generated_documents (generated_by, created_at DESC);

CREATE FUNCTION bd_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
CREATE TRIGGER brand_assets_append_only BEFORE UPDATE OR DELETE ON brand_assets FOR EACH ROW EXECUTE FUNCTION bd_append_only();
CREATE TRIGGER document_template_versions_append_only BEFORE UPDATE OR DELETE ON document_template_versions FOR EACH ROW EXECUTE FUNCTION bd_append_only();
CREATE TRIGGER generated_documents_append_only BEFORE UPDATE OR DELETE ON generated_documents FOR EACH ROW EXECUTE FUNCTION bd_append_only();
CREATE FUNCTION bd_no_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% rows are archived, never deleted', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
CREATE TRIGGER brand_kits_no_delete BEFORE DELETE ON brand_kits FOR EACH ROW EXECUTE FUNCTION bd_no_delete();
CREATE TRIGGER document_templates_no_delete BEFORE DELETE ON document_templates FOR EACH ROW EXECUTE FUNCTION bd_no_delete();
