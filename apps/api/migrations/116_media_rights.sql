-- Sports Media, Broadcast & Rights Management (#482). Additive only: new tables, nothing existing changes meaning and nothing is removed.
--
-- This is a rights-and-operations layer over canonical rows. A media partner IS an organisation (identity, members and legal details stay in `organisations`),
-- plus one `media_partners` row for what is different. Events, fixtures, teams, users, venues, sponsorships, org agreements, invoices and the youth consent
-- records are REFERENCED, never copied. Results and scores are never copied either: data feeds read the canonical fixtures / score sheets live.
-- Nothing is deleted: packages, licences, assets and grants are closed by status; the history table is append-only by trigger.
-- Rollback = deploy the previous code; it ignores these tables, which can stay in place unused.

CREATE TABLE media_partners (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL UNIQUE REFERENCES organisations,
  kind            text NOT NULL CHECK (kind IN ('broadcaster','streaming_platform','radio','press','photo_agency','production_company','data_licensee','digital_platform','other')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  licence_seq     integer NOT NULL DEFAULT 0,
  registered_by   uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- A named set of governed assets that a package can be scoped to ("approved content collection").
CREATE TABLE mr_collections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  description text CHECK (description IS NULL OR length(description) <= 500),
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (event_id, name)
);

-- Rights inventory: what the organiser can license, scoped to a competition (the event), one fixture, or a collection.
CREATE TABLE mr_packages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events,
  scope_kind     text NOT NULL CHECK (scope_kind IN ('event','fixture','collection')),
  fixture_id     uuid REFERENCES fixtures,
  collection_id  uuid REFERENCES mr_collections,
  name           text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  rights         text[] NOT NULL CHECK (cardinality(rights) BETWEEN 1 AND 12),
  territory_mode text NOT NULL DEFAULT 'worldwide' CHECK (territory_mode IN ('worldwide','include','exclude')),
  countries      text[] NOT NULL DEFAULT '{}',
  platforms      text[] NOT NULL DEFAULT '{}',
  languages      text[] NOT NULL DEFAULT '{}',
  exclusivity    text NOT NULL DEFAULT 'non_exclusive' CHECK (exclusivity IN ('exclusive','non_exclusive')),
  valid_from     timestamptz NOT NULL,
  valid_to       timestamptz NOT NULL,
  content_scope  text CHECK (content_scope IS NULL OR length(content_scope) <= 1000),
  embargo_minutes integer NOT NULL DEFAULT 0 CHECK (embargo_minutes BETWEEN 0 AND 525600),   -- how long after a game ends before delayed content may be published
  sublicensing   text NOT NULL DEFAULT 'none' CHECK (sublicensing IN ('none','with_approval','allowed')),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed','withdrawn')),
  created_by     uuid NOT NULL REFERENCES users,
  row_version    integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to > valid_from),
  CHECK ((scope_kind = 'fixture') = (fixture_id IS NOT NULL)),
  CHECK ((scope_kind = 'collection') = (collection_id IS NOT NULL)),
  CHECK (territory_mode = 'worldwide' OR cardinality(countries) > 0)
);
CREATE INDEX mr_packages_event ON mr_packages (event_id, status);

-- The licensee relationship. The executed legal terms stay in org_agreements (`agreement_id`); this keeps the operational projection that access is enforced from.
-- The fee is the contracted amount only: canonical finance has no rights-fee invoice source yet, so nothing here claims it was invoiced or collected.
CREATE TABLE mr_licences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id      uuid NOT NULL REFERENCES mr_packages,
  partner_id      uuid NOT NULL REFERENCES media_partners,
  licence_no      text NOT NULL UNIQUE,
  stage           text NOT NULL DEFAULT 'proposed' CHECK (stage IN ('proposed','negotiating','active','suspended','terminated','expired','declined')),
  proposed_by_side text NOT NULL CHECK (proposed_by_side IN ('organiser','partner')),   -- the side that made the latest offer; the OTHER side accepts it
  approved_rights text[] NOT NULL CHECK (cardinality(approved_rights) BETWEEN 1 AND 12),
  approved_platforms text[] NOT NULL DEFAULT '{}',
  territory_mode  text NOT NULL DEFAULT 'worldwide' CHECK (territory_mode IN ('worldwide','include','exclude')),
  countries       text[] NOT NULL DEFAULT '{}',
  effective_from  timestamptz NOT NULL,
  effective_to    timestamptz NOT NULL,
  fee_minor       bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  currency        text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  negotiation_ref text CHECK (negotiation_ref IS NULL OR length(negotiation_ref) <= 120),
  contract_ref    text CHECK (contract_ref IS NULL OR length(contract_ref) <= 120),
  agreement_id    uuid REFERENCES org_agreements,
  note            text CHECK (note IS NULL OR length(note) <= 1000),
  decision_note   text CHECK (decision_note IS NULL OR length(decision_note) <= 1000),
  renewal_of      uuid REFERENCES mr_licences,
  proposed_by     uuid NOT NULL REFERENCES users,
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  ended_at        timestamptz,
  row_version     integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to > effective_from),
  CHECK (territory_mode = 'worldwide' OR cardinality(countries) > 0)
);
CREATE INDEX mr_licences_package ON mr_licences (package_id, stage);
CREATE INDEX mr_licences_partner ON mr_licences (partner_id, stage);
CREATE UNIQUE INDEX mr_licences_one_open ON mr_licences (package_id, partner_id) WHERE stage IN ('proposed','negotiating');   -- one offer at a time; overlapping ACTIVE windows are refused when an offer is accepted

-- Production crew. The person is the canonical user; the badge is read live from the event department member (the accreditation that exists today).
CREATE TABLE mr_crew (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events,
  fixture_id      uuid REFERENCES fixtures,
  licence_id      uuid REFERENCES mr_licences,
  user_id         uuid NOT NULL REFERENCES users,
  role            text NOT NULL CHECK (role IN ('producer','director','camera_operator','commentator','analyst','photographer','audio_engineer','technical_crew','reporter','other')),
  zones           text[] NOT NULL DEFAULT '{media_centre,mixed_zone}',
  restricted_approved_by uuid REFERENCES users,
  department_member_id uuid REFERENCES event_department_members,
  call_time       timestamptz,
  camera_position text CHECK (camera_position IS NULL OR length(camera_position) <= 60),
  booth_ref       text CHECK (booth_ref IS NULL OR length(booth_ref) <= 60),
  technical_provider text CHECK (technical_provider IS NULL OR length(technical_provider) <= 120),
  notes           text CHECK (notes IS NULL OR length(notes) <= 500),
  status          text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','acknowledged','declined','released')),
  acknowledged_at timestamptz,
  assigned_by     uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mr_crew_open ON mr_crew (event_id, coalesce(fixture_id, '00000000-0000-0000-0000-000000000000'::uuid), user_id, role) WHERE status IN ('assigned','acknowledged');
CREATE INDEX mr_crew_user ON mr_crew (user_id, status);

-- Run sheet: setup / rehearsal / live / teardown windows with their place.
CREATE TABLE mr_run_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events,
  fixture_id uuid REFERENCES fixtures,
  phase      text NOT NULL CHECK (phase IN ('setup','rehearsal','live','teardown')),
  title      text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  venue_id   uuid REFERENCES venues,
  resource_id uuid REFERENCES resources,
  location   text CHECK (location IS NULL OR length(location) <= 120),
  status     text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','cancelled')),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX mr_run_items_event ON mr_run_items (event_id, starts_at);

CREATE TABLE mr_incidents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  fixture_id  uuid REFERENCES fixtures,
  kind        text NOT NULL CHECK (kind IN ('incident','change')),
  severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','minor','major','critical')),
  summary     text NOT NULL CHECK (length(summary) BETWEEN 3 AND 200),
  detail      text CHECK (detail IS NULL OR length(detail) <= 2000),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  reported_by uuid NOT NULL REFERENCES users,
  resolved_by uuid REFERENCES users,
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mr_incidents_event ON mr_incidents (event_id, status, created_at DESC);

-- Streams: a reference to an EXTERNAL stream. Credentials never live here; state is organiser-reported unless a provider adapter is configured on the server.
CREATE TABLE mr_streams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events,
  fixture_id      uuid REFERENCES fixtures,
  licence_id      uuid REFERENCES mr_licences,
  provider        text NOT NULL CHECK (provider IN ('youtube','twitch','vimeo','facebook','mux','cloudflare_stream','aws_ivs','custom_hls','other_external')),
  channel_ref     text NOT NULL CHECK (length(channel_ref) BETWEEN 1 AND 300),
  playback_ref    text CHECK (playback_ref IS NULL OR playback_ref ~ '^https://'),
  archive_ref     text CHECK (archive_ref IS NULL OR archive_ref ~ '^https://'),
  scheduled_start timestamptz,
  scheduled_end   timestamptz,
  state           text NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled','live','offline','ended')),
  state_source    text NOT NULL DEFAULT 'organiser' CHECK (state_source IN ('organiser','provider')),
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  access_policy   text NOT NULL DEFAULT 'public' CHECK (access_policy IN ('public','private','subscriber')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end > scheduled_start)
);
CREATE INDEX mr_streams_event ON mr_streams (event_id, fixture_id) WHERE status = 'active';

-- Governed media assets and clips: rights metadata over either an external link or a photo / PDF kept encrypted in the canonical document store.
-- Delivery re-checks rights on every request, so an embargo, expiry or takedown stops access immediately.
CREATE TABLE mr_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events,
  fixture_id      uuid REFERENCES fixtures,
  parent_asset_id uuid REFERENCES mr_assets,
  kind            text NOT NULL CHECK (kind IN ('video','clip','photo','audio','graphic','document')),
  right_kind      text NOT NULL CHECK (right_kind IN ('live_video','delayed_video','highlights','short_form','audio','photography','press','data_feed','archive','social')),
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 140),
  caption         text CHECK (caption IS NULL OR length(caption) <= 500),
  credit          text CHECK (credit IS NULL OR length(credit) <= 120),
  creator_id      uuid NOT NULL REFERENCES users,
  owner_kind      text NOT NULL CHECK (owner_kind IN ('organiser','partner','athlete','third_party')),
  owner_partner_id uuid REFERENCES media_partners,
  owner_name      text CHECK (owner_name IS NULL OR length(owner_name) <= 160),
  source_kind     text NOT NULL CHECK (source_kind IN ('upload','external_link')),
  external_url    text CHECK (external_url IS NULL OR external_url ~ '^https://'),
  stored_file     text,                         -- encrypted on disk (doc-store); photos and PDFs. Video stays an external link.
  file_name       text,
  content_type    text,
  size_bytes      integer,
  sha256          text,
  audience        text NOT NULL DEFAULT 'private' CHECK (audience IN ('private','licensed','public')),
  territory_mode  text NOT NULL DEFAULT 'worldwide' CHECK (territory_mode IN ('worldwide','include','exclude')),
  countries       text[] NOT NULL DEFAULT '{}',
  platforms       text[] NOT NULL DEFAULT '{}',
  publish_at      timestamptz,
  embargo_until   timestamptz,
  expires_at      timestamptz,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','withdrawn','taken_down')),
  status_reason   text CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  status_changed_by uuid REFERENCES users,
  status_changed_at timestamptz,
  row_version     integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_kind = 'external_link') = (external_url IS NOT NULL)),
  CHECK (territory_mode = 'worldwide' OR cardinality(countries) > 0),
  CHECK (parent_asset_id IS NULL OR parent_asset_id <> id)
);
CREATE INDEX mr_assets_event ON mr_assets (event_id, status);
CREATE INDEX mr_assets_parent ON mr_assets (parent_asset_id) WHERE parent_asset_id IS NOT NULL;
CREATE TABLE mr_collection_items (
  collection_id uuid NOT NULL REFERENCES mr_collections,
  asset_id      uuid NOT NULL REFERENCES mr_assets,
  added_by      uuid NOT NULL REFERENCES users,
  added_at      timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,                    -- taking an asset out of a collection keeps the row
  PRIMARY KEY (collection_id, asset_id)
);

-- Who or what appears in an asset, and the consent it relies on. A young person needs LIVE guardian media consent; it is re-read on every view.
CREATE TABLE mr_asset_subjects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id      uuid NOT NULL REFERENCES mr_assets,
  user_id       uuid REFERENCES users,
  team_id       uuid REFERENCES teams,
  consent_kind  text NOT NULL CHECK (consent_kind IN ('guardian_media','athlete_release','team_release','agreement','not_required')),
  consent_ref   text CHECK (consent_ref IS NULL OR length(consent_ref) <= 160),
  added_by      uuid NOT NULL REFERENCES users,
  removed_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR team_id IS NOT NULL)
);
CREATE INDEX mr_asset_subjects_asset ON mr_asset_subjects (asset_id) WHERE removed_at IS NULL;

-- Data-feed rights: an entitlement on a licence, with a real API credential (an api_tokens row, restricted to the event) behind it.
CREATE TABLE mr_feed_grants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licence_id      uuid NOT NULL REFERENCES mr_licences,
  consumer_name   text NOT NULL CHECK (length(consumer_name) BETWEEN 2 AND 80),
  consumer_user_id uuid REFERENCES users,           -- set when the partner issues its own credential (the secret is shown to that person only)
  api_token_id    uuid REFERENCES api_tokens,
  datasets        text[] NOT NULL CHECK (cardinality(datasets) >= 1),
  mode            text NOT NULL CHECK (mode IN ('live','delayed')),
  delay_seconds   integer NOT NULL DEFAULT 0 CHECK (delay_seconds BETWEEN 0 AND 86400 AND ((mode='live') = (delay_seconds=0))),
  rate_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_per_minute BETWEEN 1 AND 6000),
  daily_quota     integer NOT NULL DEFAULT 50000 CHECK (daily_quota BETWEEN 1 AND 10000000),
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users,
  revoke_reason   text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 500),
  granted_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to > valid_from)
);
CREATE INDEX mr_feed_grants_licence ON mr_feed_grants (licence_id, status);
CREATE UNIQUE INDEX mr_feed_grants_token ON mr_feed_grants (api_token_id) WHERE api_token_id IS NOT NULL;
CREATE TABLE mr_feed_usage (
  grant_id uuid NOT NULL REFERENCES mr_feed_grants,
  day      date NOT NULL,
  dataset  text NOT NULL,
  calls    integer NOT NULL DEFAULT 0,
  refused  integer NOT NULL DEFAULT 0,
  last_at  timestamptz,
  PRIMARY KEY (grant_id, day, dataset)
);
CREATE TABLE mr_feed_windows (        -- one row per grant: the current one-minute rate window
  grant_id     uuid PRIMARY KEY REFERENCES mr_feed_grants,
  window_start timestamptz NOT NULL,
  calls        integer NOT NULL DEFAULT 0
);

-- Commercial deliverables a licence carries. The sponsorship agreement stays authoritative (`sponsorship_id`); this tracks delivery only.
CREATE TABLE mr_deliverables (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licence_id    uuid NOT NULL REFERENCES mr_licences,
  sponsorship_id uuid REFERENCES sponsorships,
  kind          text NOT NULL CHECK (kind IN ('naming_mention','graphic_overlay','content_piece','signage','other')),
  title         text NOT NULL CHECK (length(title) BETWEEN 2 AND 140),
  detail        text CHECK (detail IS NULL OR length(detail) <= 1000),
  due_at        timestamptz,
  status        text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','delivered','verified','missed')),
  evidence_asset_id uuid REFERENCES mr_assets,
  evidence_url  text CHECK (evidence_url IS NULL OR evidence_url ~ '^https://'),
  delivered_at  timestamptz,
  verified_by   uuid REFERENCES users,
  verified_at   timestamptz,
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mr_deliverables_licence ON mr_deliverables (licence_id, status);
-- Only measured numbers from a named provider / analytics source. Nothing is estimated here.
CREATE TABLE mr_measurements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licence_id  uuid NOT NULL REFERENCES mr_licences,
  stream_id   uuid REFERENCES mr_streams,
  deliverable_id uuid REFERENCES mr_deliverables,
  metric      text NOT NULL CHECK (metric IN ('views','unique_viewers','peak_concurrent','watch_minutes','impressions')),
  value       bigint NOT NULL CHECK (value >= 0),
  period_start timestamptz NOT NULL,
  period_end  timestamptz NOT NULL,
  source_name text NOT NULL CHECK (length(source_name) BETWEEN 2 AND 80),
  source_ref  text NOT NULL CHECK (length(source_ref) BETWEEN 2 AND 300),
  recorded_by uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

-- Append-only history of every decision and change, for all of the above.
CREATE TABLE mr_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid REFERENCES events,
  subject_type text NOT NULL,
  subject_id   uuid NOT NULL,
  action       text NOT NULL,
  actor_id     uuid REFERENCES users,
  detail       jsonb NOT NULL DEFAULT '{}',
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mr_log_subject ON mr_log (subject_type, subject_id, at);
CREATE FUNCTION mr_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'media rights history is append-only'; END $$;
CREATE TRIGGER mr_log_append_only BEFORE UPDATE OR DELETE ON mr_log FOR EACH ROW EXECUTE FUNCTION mr_log_guard();
