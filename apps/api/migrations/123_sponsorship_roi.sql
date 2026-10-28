-- Sponsorship ROI & portfolio intelligence (#519). Adds only what the sponsorship lifecycle (#145 and its extensions), the public event pages (#501), media rights
-- (#482: licence deliverables and named-source reach stay in mr_deliverables / mr_measurements and are READ, not copied) and the reports (#305) lack: governed sponsor INVENTORY with conflict-aware bookings, DELIVERABLES with evidence + reviewer semantics, a ledger for
-- non-broadcast provider-reported EXPOSURE, customer-owned versioned VALUATION assumptions, and immutable issued ROI REPORTS. Money stays in the existing
-- obligations/payments tables; nothing here is a second ledger. Additive: no column is dropped or narrowed, no row is deleted, no seed data.

-- ------------------------------------------------------------------ inventory: what a recipient can offer a sponsor
CREATE TABLE IF NOT EXISTS sponsor_inventory_units (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type        text NOT NULL CHECK (target_type IN ('event', 'team', 'athlete')),
  target_id          uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('title_partner', 'associate_partner', 'team_association', 'athlete_association', 'kit_placement', 'event_page', 'leaderboard',
                                                    'scorecard', 'livestream_overlay', 'replay', 'social_content', 'hospitality', 'sponsored_challenge', 'appearance', 'content_deliverable')),
  name               text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  description        text CHECK (description IS NULL OR length(description) <= 1000),
  capacity           integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 100),
  exclusive_category boolean NOT NULL DEFAULT false,         -- no two sponsors of the same category may overlap on this unit
  placement_slot     text CHECK (placement_slot IS NULL OR (target_type = 'event' AND placement_slot IN ('title_partner', 'fixture', 'scorecard', 'leaderboard'))),
  available_from     date,
  available_to       date,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  row_version        integer NOT NULL DEFAULT 1,
  created_by         uuid NOT NULL REFERENCES users,
  created_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz,
  CHECK (available_to IS NULL OR available_from IS NULL OR available_to >= available_from)
);
CREATE INDEX IF NOT EXISTS sponsor_inventory_units_target ON sponsor_inventory_units (target_type, target_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS sponsor_inventory_bookings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id        uuid NOT NULL REFERENCES sponsor_inventory_units,
  sponsorship_id uuid NOT NULL REFERENCES sponsorships,
  category       text NOT NULL CHECK (category IN ('beverage', 'nutrition', 'apparel', 'footwear', 'equipment', 'banking_finance', 'insurance', 'telecom', 'automotive', 'technology',
                                                   'healthcare', 'education', 'travel_hospitality', 'media', 'retail', 'other')),
  starts_on      date NOT NULL,
  ends_on        date NOT NULL,
  status         text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'released')),
  note           text CHECK (note IS NULL OR length(note) <= 500),
  booked_by      uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  released_by    uuid REFERENCES users,
  released_at    timestamptz,
  release_reason text,
  CHECK (ends_on >= starts_on),
  CHECK ((status = 'released') = (released_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS sponsor_inventory_bookings_unit ON sponsor_inventory_bookings (unit_id, starts_on) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS sponsor_inventory_bookings_deal ON sponsor_inventory_bookings (sponsorship_id);

-- a public placement (#501) may be backed by a booking; an event that has defined inventory for a slot only accepts placements backed by one
ALTER TABLE event_sponsor_placements ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES sponsor_inventory_bookings;
-- ... and so may a media-licence deliverable that names the sponsorship (graphic overlay, naming mention, content, signage)
ALTER TABLE mr_deliverables ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES sponsor_inventory_bookings;

-- ------------------------------------------------------------------ deliverables: appearances, content, hospitality, rewards ... with evidence and a reviewer
CREATE TABLE IF NOT EXISTS sponsorship_deliverables (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id   uuid NOT NULL REFERENCES sponsorships,
  booking_id       uuid REFERENCES sponsor_inventory_bookings,
  kind             text NOT NULL CHECK (kind IN ('appearance', 'content', 'hospitality', 'challenge_reward', 'activation', 'other')),   -- dated posts are endorsement dues; broadcast items are media-licence deliverables
  title            text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  brief            text CHECK (brief IS NULL OR length(brief) <= 1000),
  owed_by          text NOT NULL CHECK (owed_by IN ('recipient', 'sponsor')),   -- who must deliver; the OTHER side reviews
  owner_user_id    uuid REFERENCES users,                                        -- the named person responsible
  due_on           date NOT NULL,
  evidence_required text NOT NULL CHECK (evidence_required IN ('link', 'file', 'either')),
  status           text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'submitted', 'accepted', 'rework', 'excepted', 'cancelled')),
  rev              integer NOT NULL DEFAULT 1,
  reviewed_by      uuid REFERENCES users,
  reviewed_at      timestamptz,
  review_note      text,
  created_by       uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'accepted' OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL))   -- accepted only ever by a named reviewer, never by the clock
);
CREATE INDEX IF NOT EXISTS sponsorship_deliverables_deal ON sponsorship_deliverables (sponsorship_id, due_on, id);

CREATE TABLE IF NOT EXISTS sponsorship_deliverable_evidence (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deliverable_id uuid NOT NULL REFERENCES sponsorship_deliverables,
  label          text CHECK (label IS NULL OR length(label) <= 120),
  url            text CHECK (url IS NULL OR url ~ '^https://'),
  file_name      text,
  content_type   text,
  size_bytes     integer,
  sha256         text,
  file_enc       text,                                                           -- encrypted at rest like case evidence
  submitted_by   uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (url IS NOT NULL OR file_enc IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS sponsorship_deliverable_evidence_d ON sponsorship_deliverable_evidence (deliverable_id, created_at);

CREATE TABLE IF NOT EXISTS sponsorship_deliverable_exceptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deliverable_id uuid NOT NULL REFERENCES sponsorship_deliverables,
  kind           text NOT NULL CHECK (kind IN ('postpone', 'waive')),
  reason         text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  new_due_on     date,
  status         text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'declined')),
  requested_by   uuid NOT NULL REFERENCES users,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  decided_by     uuid REFERENCES users,
  decided_at     timestamptz,
  decision_note  text,
  CHECK ((kind = 'postpone') = (new_due_on IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_deliverable_exceptions_open ON sponsorship_deliverable_exceptions (deliverable_id) WHERE status = 'requested';

CREATE TABLE IF NOT EXISTS sponsorship_deliverable_log (
  id             bigserial PRIMARY KEY,
  deliverable_id uuid NOT NULL REFERENCES sponsorship_deliverables,
  actor_id       uuid NOT NULL REFERENCES users,
  action         text NOT NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ non-broadcast provider-reported exposure (platform-measured counts stay in placement_daily_counts / spectator_follows)
-- One live value per agreement, metric and day, whatever the source: two sources can never be added together. A correction supersedes, it never overwrites.
CREATE TABLE IF NOT EXISTS sponsor_exposure_signals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id uuid NOT NULL REFERENCES sponsorships,
  booking_id     uuid REFERENCES sponsor_inventory_bookings,
  metric         text NOT NULL CHECK (metric IN ('stream_views', 'overlay_impressions', 'clip_views', 'page_views', 'attendance', 'tickets_scanned', 'hospitality_guests')),
  day            date NOT NULL,
  value          bigint NOT NULL CHECK (value >= 0),
  source         text NOT NULL CHECK (length(source) BETWEEN 2 AND 80),          -- who supplied the figure, e.g. the streaming provider
  source_ref     text NOT NULL CHECK (length(source_ref) BETWEEN 2 AND 300),    -- where it can be checked (report name, export id, https link)
  recorded_by    uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  superseded_at  timestamptz,
  superseded_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_exposure_signals_live ON sponsor_exposure_signals (sponsorship_id, metric, day) WHERE superseded_at IS NULL;

-- ------------------------------------------------------------------ customer-configured valuation assumptions (versioned, immutable)
CREATE TABLE IF NOT EXISTS sponsor_valuation_models (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_id  uuid NOT NULL REFERENCES sponsors,
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (sponsor_id, name)
);
CREATE TABLE IF NOT EXISTS sponsor_valuation_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id    uuid NOT NULL REFERENCES sponsor_valuation_models,
  version     integer NOT NULL,
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  assumptions jsonb NOT NULL,                                                   -- { metric_key: { per: 1 | 1000, value_cents } } for MEASURED metrics only
  basis_note  text NOT NULL CHECK (length(basis_note) BETWEEN 10 AND 1000),     -- why these rates: the customer's own rationale, shown beside every estimate
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, version)
);

-- ------------------------------------------------------------------ issued reports: a frozen snapshot with its hash
CREATE TABLE IF NOT EXISTS sponsor_roi_reports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_id            uuid NOT NULL REFERENCES sponsors,
  view                  text NOT NULL CHECK (view IN ('sponsor', 'recipient')),
  kind                  text NOT NULL CHECK (kind IN ('period', 'end_of_agreement')),
  sponsorship_ids       uuid[] NOT NULL CHECK (cardinality(sponsorship_ids) BETWEEN 1 AND 50),
  period_from           date NOT NULL,
  period_to             date NOT NULL,
  valuation_version_id  uuid REFERENCES sponsor_valuation_versions,
  snapshot              jsonb NOT NULL,
  content_sha256        text NOT NULL,
  issued_by             uuid NOT NULL REFERENCES users,
  issued_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from)
);
CREATE INDEX IF NOT EXISTS sponsor_roi_reports_sponsor ON sponsor_roi_reports (sponsor_id, issued_at DESC);

-- issued reports and valuation versions are never changed or removed
CREATE OR REPLACE FUNCTION sponsorship_roi_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are immutable once written', TG_TABLE_NAME USING ERRCODE = '55000'; END $$;
DROP TRIGGER IF EXISTS sponsor_roi_reports_immutable ON sponsor_roi_reports;
CREATE TRIGGER sponsor_roi_reports_immutable BEFORE UPDATE OR DELETE ON sponsor_roi_reports FOR EACH ROW EXECUTE FUNCTION sponsorship_roi_immutable();
DROP TRIGGER IF EXISTS sponsor_valuation_versions_immutable ON sponsor_valuation_versions;
CREATE TRIGGER sponsor_valuation_versions_immutable BEFORE UPDATE OR DELETE ON sponsor_valuation_versions FOR EACH ROW EXECUTE FUNCTION sponsorship_roi_immutable();
