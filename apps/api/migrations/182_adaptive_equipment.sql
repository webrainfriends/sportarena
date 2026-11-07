-- PS-18 (#848): Adaptive sports equipment — inventory, fitting, hire and service.
-- Additive and backwards-compatible. No existing table is altered, narrowed or dropped.
-- Reuses: organisations, venues, users, events, academy_programmes (FK only).
-- No diagnosis field anywhere: operational equipment specs only (seat_width_mm, frame_size_cm, etc.).
-- Encrypted columns (suffix _enc): stored via src/crypto.js field-level encryption.
-- Soft-deletes only: retired_at / cancelled_at / archived_at flags, never DELETE.
-- Rollback: deploy previous build; all new tables are ignored by older code.

-- 1. Adaptive asset registry.
--    One row per named asset (a "Quickie GP Sport Wheelchair medium", serial ABC123).
--    owner_id is always set (the user who registered it); org_id/venue_id/supplier_id says whose fleet it belongs to.
CREATE TABLE IF NOT EXISTS adaptive_assets (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id               uuid NOT NULL REFERENCES users,
  org_id                 uuid REFERENCES organisations,
  venue_id               uuid REFERENCES venues,
  supplier_id            uuid REFERENCES supplier_entities,
  type                   text NOT NULL CHECK (type IN (
                           'wheelchair','handcycle','throwing_frame','standing_frame',
                           'communication_device','prosthetic_sports_limb','guide_runner_tether',
                           'boccia_ramp','sitting_volleyball_net','power_wheelchair',
                           'recumbent_cycle','other')),
  name                   text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  sport_codes            text[] NOT NULL DEFAULT '{}',
  size_family            text,
  adjustment_notes_enc   text,            -- encrypted operational setup notes (seat width mm, armrest height cm, etc.)
  serial_number          text,
  purchase_date          date,
  purchase_value_cents   bigint,
  currency               text NOT NULL DEFAULT 'AUD' CHECK (char_length(currency) = 3),
  service_interval_months int NOT NULL DEFAULT 12 CHECK (service_interval_months BETWEEN 1 AND 120),
  status                 text NOT NULL DEFAULT 'available' CHECK (status IN ('available','on_loan','in_service','retired')),
  last_serviced_at       date,
  next_service_due       date,
  retired_at             timestamptz,
  funding_agreement_id   uuid,            -- FK to sponsorship_agreements (soft ref: no FK constraint to avoid cross-schema coupling)
  created_by             uuid NOT NULL REFERENCES users,
  row_version            int NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adaptive_assets_org    ON adaptive_assets (org_id)     WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS adaptive_assets_venue  ON adaptive_assets (venue_id)   WHERE venue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS adaptive_assets_supp   ON adaptive_assets (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS adaptive_assets_status ON adaptive_assets (status);

-- 2. Serial-numbered units within an asset model (barcode / QR trackable).
CREATE TABLE IF NOT EXISTS adaptive_asset_units (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid NOT NULL REFERENCES adaptive_assets,
  serial_number text NOT NULL CHECK (char_length(serial_number) BETWEEN 1 AND 60),
  barcode      text CHECK (barcode IS NULL OR char_length(barcode) <= 80),
  status       text NOT NULL DEFAULT 'available' CHECK (status IN ('available','on_loan','in_service','retired')),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adaptive_asset_units_asset ON adaptive_asset_units (asset_id);

-- 3. Equipment loans / hire to athletes.
CREATE TABLE IF NOT EXISTS adaptive_loans (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id                uuid NOT NULL REFERENCES adaptive_assets,
  athlete_id              uuid NOT NULL REFERENCES users,
  org_id                  uuid REFERENCES organisations,
  event_id                uuid REFERENCES events,
  start_date              date NOT NULL,
  end_date                date NOT NULL CHECK (end_date >= start_date),
  purpose                 text NOT NULL CHECK (purpose IN ('session','event','trial','personal','academy_programme')),
  status                  text NOT NULL DEFAULT 'requested'
                            CHECK (status IN ('requested','confirmed','active','returned','cancelled','overdue')),
  deposit_cents           bigint,
  deposit_paid_at         timestamptz,
  deposit_refunded_at     timestamptz,
  funding_agreement_id    uuid,
  deposit_waived          boolean NOT NULL DEFAULT false,
  condition_at_handover   text CHECK (condition_at_handover IN ('excellent','good','fair')),
  condition_at_return     text CHECK (condition_at_return IN ('excellent','good','fair','damaged','missing')),
  handed_over_at          timestamptz,
  returned_at             timestamptz,
  return_notes_enc        text,
  notes_enc               text,
  cancelled_at            timestamptz,
  cancel_reason           text,
  created_by              uuid NOT NULL REFERENCES users,
  row_version             int NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adaptive_loans_asset   ON adaptive_loans (asset_id);
CREATE INDEX IF NOT EXISTS adaptive_loans_athlete ON adaptive_loans (athlete_id);
CREATE INDEX IF NOT EXISTS adaptive_loans_status  ON adaptive_loans (status);

-- 4. Damage/loss incidents on loans.
CREATE TABLE IF NOT EXISTS adaptive_loan_incidents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id         uuid NOT NULL REFERENCES adaptive_loans,
  reported_by     uuid NOT NULL REFERENCES users,
  severity        text NOT NULL CHECK (severity IN ('minor','moderate','major','total_loss')),
  description_enc text,
  photos_available boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','decided')),
  decision        text CHECK (decision IN ('waived','charged','replaced')),
  charge_cents    bigint,
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adaptive_loan_incidents_loan ON adaptive_loan_incidents (loan_id);

-- 5. Equipment-specific service / inspection records. Not a general calendar.
CREATE TABLE IF NOT EXISTS adaptive_service_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id            uuid NOT NULL REFERENCES adaptive_assets,
  service_type        text NOT NULL CHECK (service_type IN ('routine','safety','repair','recall','pre_event')),
  technician_name     text NOT NULL CHECK (char_length(technician_name) BETWEEN 1 AND 120),
  performed_at        date NOT NULL,
  next_due_date       date,
  findings_enc        text,
  pass_fail           text NOT NULL DEFAULT 'pass' CHECK (pass_fail IN ('pass','fail','conditional')),
  service_order_id    uuid,               -- FK to service_orders (soft ref)
  created_by          uuid NOT NULL REFERENCES users,
  row_version         int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adaptive_service_records_asset ON adaptive_service_records (asset_id);
CREATE INDEX IF NOT EXISTS adaptive_service_records_date  ON adaptive_service_records (performed_at);

-- 6. Event allocations: reserve an asset for an event window.
CREATE TABLE IF NOT EXISTS adaptive_event_allocations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid NOT NULL REFERENCES adaptive_assets,
  event_id     uuid NOT NULL REFERENCES events,
  start_dt     timestamptz NOT NULL,
  end_dt       timestamptz NOT NULL CHECK (end_dt > start_dt),
  notes        text,
  cancelled_at timestamptz,
  created_by   uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adaptive_event_allocs_asset ON adaptive_event_allocations (asset_id);
CREATE INDEX IF NOT EXISTS adaptive_event_allocs_event ON adaptive_event_allocations (event_id);

-- 7. Clinician / vendor fitting appointments.
CREATE TABLE IF NOT EXISTS adaptive_fittings (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id                 uuid NOT NULL REFERENCES adaptive_assets,
  athlete_id               uuid NOT NULL REFERENCES users,
  clinician_id             uuid NOT NULL REFERENCES users,
  para_case_id             uuid,          -- optional soft FK to para_cases (not surfaced on asset record)
  preferred_slot_start     timestamptz NOT NULL,
  preferred_slot_end       timestamptz NOT NULL CHECK (preferred_slot_end > preferred_slot_start),
  status                   text NOT NULL DEFAULT 'requested'
                             CHECK (status IN ('requested','confirmed','completed','cancelled')),
  recommended_size         text,
  recommended_adjustments_enc text,
  outcome_notes_enc        text,
  notes_enc                text,
  created_by               uuid NOT NULL REFERENCES users,
  row_version              int NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adaptive_fittings_asset    ON adaptive_fittings (asset_id);
CREATE INDEX IF NOT EXISTS adaptive_fittings_athlete  ON adaptive_fittings (athlete_id);
CREATE INDEX IF NOT EXISTS adaptive_fittings_clinician ON adaptive_fittings (clinician_id);

-- 8. Athlete-owned equipment profile (what they bring; recorded for venue ops only).
CREATE TABLE IF NOT EXISTS adaptive_athlete_equipment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id      uuid NOT NULL REFERENCES users,
  type            text NOT NULL CHECK (type IN (
                    'wheelchair','handcycle','throwing_frame','standing_frame',
                    'communication_device','prosthetic_sports_limb','guide_runner_tether',
                    'boccia_ramp','sitting_volleyball_net','power_wheelchair',
                    'recumbent_cycle','other')),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description_enc text,
  acquired_date   date,
  notes_enc       text,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adaptive_athlete_equip_athlete ON adaptive_athlete_equipment (athlete_id);

-- 9. Sponsor-funded asset allocations (financial privacy: athlete view excludes funding details).
CREATE TABLE IF NOT EXISTS adaptive_asset_sponsor_funding (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id             uuid NOT NULL REFERENCES adaptive_assets,
  funding_agreement_id uuid NOT NULL,     -- FK to sponsorship_agreements (soft ref)
  allocation_type      text NOT NULL CHECK (allocation_type IN ('purchase','loan_waiver','service')),
  amount_cents         bigint,
  notes                text,
  created_by           uuid NOT NULL REFERENCES users,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adaptive_asset_sponsor_asset ON adaptive_asset_sponsor_funding (asset_id);
