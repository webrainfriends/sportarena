-- EVENT-EXT-02: Externally created events managed in GotMyGame (#1135)
-- Additive only. No existing tables altered destructively.

-- ── Core link table ────────────────────────────────────────────────────────────
CREATE TABLE event_external_links (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                uuid NOT NULL REFERENCES events(id),

  -- Provider / source identity
  provider_key            text NOT NULL,            -- registry key: event_source_generic_url | event_source_bookmyshow_in | ...
  integration_install_id  uuid REFERENCES integration_installs(id),   -- non-null only for read_sync / two_way_sync

  -- External identity
  external_event_id       text CHECK (char_length(external_event_id) <= 300),
  external_url_enc        text,                     -- HTTPS URL, encrypted at rest
  canonical_url           text,                     -- normalised, used for dedup (not encrypted)
  source_owner_entity_id  text CHECK (char_length(source_owner_entity_id) <= 300),

  -- Link mode and authority
  link_mode               text NOT NULL CHECK (link_mode IN ('reference_only','read_sync','two_way_sync','file_import')),
  authority_type          text NOT NULL CHECK (authority_type IN ('organiser_attested','verified_source','reference_only')),
  authority_evidence_ref  text CHECK (char_length(authority_evidence_ref) <= 1000),
  authority_checked_at    timestamptz,

  -- Sync policy and field ownership (JSONB — flexible per provider)
  sync_policy             jsonb NOT NULL DEFAULT '{}',
  field_ownership_map     jsonb NOT NULL DEFAULT '{}',   -- { field: 'external_master'|'gotmygame_managed'|'shared_governed' }

  -- Cached source fields (from last pull / manual entry)
  source_title            text CHECK (char_length(source_title) <= 300),
  source_starts_on        date,
  source_ends_on          date,
  source_venue_name       text CHECK (char_length(source_venue_name) <= 300),
  source_organiser_name   text CHECK (char_length(source_organiser_name) <= 300),
  source_sport_slug       text CHECK (char_length(source_sport_slug) <= 100),
  source_registration_url_enc text,                 -- encrypted
  source_etag             text CHECK (char_length(source_etag) <= 500),
  source_revision         text CHECK (char_length(source_revision) <= 500),
  source_fetched_at       timestamptz,
  source_data             jsonb,                    -- sanitised allowed-fields snapshot (no PII)

  -- Sync health
  last_sync_at            timestamptz,
  last_sync_status        text CHECK (last_sync_status IN ('ok','failed','stale','no_api')),
  last_error              text CHECK (char_length(last_error) <= 2000),

  -- Status and trust
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','unlinked','archived')),
  trust_level             text NOT NULL DEFAULT 'reference_only' CHECK (trust_level IN ('reference_only','organiser_attested','verified')),
  origin_label            text CHECK (char_length(origin_label) <= 200),   -- human-readable display name for the source

  -- Audit fields
  linked_by               uuid NOT NULL REFERENCES users(id),
  linked_at               timestamptz NOT NULL DEFAULT now(),
  unlinked_by             uuid REFERENCES users(id),
  unlinked_at             timestamptz,
  archived_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- Dedup: at most one active link per (event, provider, external_event_id) and per (event, canonical_url)
  CONSTRAINT uq_ext_link_provider_id UNIQUE NULLS NOT DISTINCT (event_id, provider_key, external_event_id),
  CONSTRAINT chk_ext_link_unlink CHECK (unlinked_at IS NULL OR unlinked_by IS NOT NULL)
);

-- Partial index for active-link canonical-URL dedup
CREATE UNIQUE INDEX uq_ext_link_canonical_url
  ON event_external_links (event_id, canonical_url)
  WHERE archived_at IS NULL AND canonical_url IS NOT NULL;

CREATE INDEX idx_ext_link_event     ON event_external_links (event_id);
CREATE INDEX idx_ext_link_provider  ON event_external_links (provider_key);
CREATE INDEX idx_ext_link_status    ON event_external_links (status) WHERE archived_at IS NULL;
CREATE INDEX idx_ext_link_install   ON event_external_links (integration_install_id) WHERE integration_install_id IS NOT NULL;

-- ── Immutable sync / change audit log ─────────────────────────────────────────
CREATE TABLE event_external_sync_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id),
  link_id          uuid NOT NULL REFERENCES event_external_links(id),
  sync_type        text NOT NULL,              -- 'manual_pull'|'scheduled_pull'|'webhook_push'|'ack'|'unlink'|'link'
  fields_changed   jsonb,
  previous_values  jsonb,
  new_values       jsonb,
  ack_required     boolean NOT NULL DEFAULT false,
  acked_by         uuid REFERENCES users(id),
  acked_at         timestamptz,
  rejected_by      uuid REFERENCES users(id),
  rejected_at      timestamptz,
  change_summary   text CHECK (char_length(change_summary) <= 1000),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ext_sync_log_link    ON event_external_sync_log (link_id);
CREATE INDEX idx_ext_sync_log_event   ON event_external_sync_log (event_id);
CREATE INDEX idx_ext_sync_log_pending ON event_external_sync_log (link_id) WHERE ack_required AND acked_at IS NULL AND rejected_at IS NULL;

-- ── Add origin columns to events ──────────────────────────────────────────────
-- origin_type is immutable after initial creation (enforced in app layer).
-- external_link_id is the primary active link (soft pointer; the link table is authoritative).
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS origin_type     text NOT NULL DEFAULT 'native' CHECK (origin_type IN ('native','external_reference','external_integrated')),
  ADD COLUMN IF NOT EXISTS external_link_id uuid REFERENCES event_external_links(id);

CREATE INDEX idx_events_origin_type ON events (origin_type) WHERE origin_type <> 'native';
