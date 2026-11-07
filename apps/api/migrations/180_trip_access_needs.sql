-- PS-23: Accessible athlete delegation travel and transport logistics.
-- Additive only: new tables and new columns on academy_transport_vehicles.
-- No existing tables are dropped, truncated, or narrowed.

-- 1. Per-participant consented journey access needs
CREATE TABLE trip_access_needs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id           uuid        NOT NULL REFERENCES trips(id),
  participant_id    uuid        NOT NULL REFERENCES trip_participants(id),
  need_type         text        NOT NULL,
  note_enc          text,
  scope             text        NOT NULL DEFAULT 'ops_only',
  archived_at       timestamptz,
  archived_by       uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_access_needs_need_type_check CHECK (need_type IN (
    'wav','securement','guide_dog','hearing_loop','escort',
    'manual_support','medication_carry_on',
    'rooming_roll_in','rooming_hoist','rooming_ground_floor'
  )),
  CONSTRAINT trip_access_needs_scope_check CHECK (scope IN ('ops_only','provider_minimal')),
  UNIQUE (trip_id, participant_id, need_type)
);

CREATE INDEX idx_trip_access_needs_trip    ON trip_access_needs(trip_id);
CREATE INDEX idx_trip_access_needs_part    ON trip_access_needs(participant_id);
CREATE INDEX idx_trip_access_needs_active  ON trip_access_needs(trip_id) WHERE archived_at IS NULL;

-- 2. Accessibility specs per vehicle (additive columns on academy_transport_vehicles)
ALTER TABLE academy_transport_vehicles
  ADD COLUMN IF NOT EXISTS wheelchair_spaces    int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS low_floor            bool        NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hoist                bool        NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS securement_points    int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hearing_loop         bool        NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS access_verified_at   timestamptz,
  ADD COLUMN IF NOT EXISTS access_verified_by   uuid;

-- 3. Per-segment access suitability (computed + manager-overridable)
CREATE TABLE trip_segment_access_suitability (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id      uuid        NOT NULL REFERENCES trip_segments(id) ON DELETE CASCADE,
  need_type       text        NOT NULL,
  state           text        NOT NULL,
  note            text,
  overridden_by   uuid,
  overridden_at   timestamptz,
  checked_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tsas_state_check     CHECK (state IN ('met','partial','gap','unknown')),
  CONSTRAINT tsas_need_type_check CHECK (need_type IN (
    'wav','securement','guide_dog','hearing_loop','escort',
    'manual_support','medication_carry_on',
    'rooming_roll_in','rooming_hoist','rooming_ground_floor'
  )),
  CONSTRAINT tsas_unique UNIQUE (segment_id, need_type)
);

CREATE INDEX idx_tsas_segment ON trip_segment_access_suitability(segment_id);

-- 4. Alerts for accessibility status changes
CREATE TABLE trip_access_alerts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid        NOT NULL REFERENCES trips(id),
  segment_id    uuid        REFERENCES trip_segments(id),
  alert_type    text        NOT NULL,
  detail        jsonb       NOT NULL DEFAULT '{}',
  resolved_at   timestamptz,
  resolved_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT taa_type_check CHECK (alert_type IN (
    'status_changed','vehicle_cancelled','arrival_conflict','need_added','wav_capacity_gap'
  ))
);

CREATE INDEX idx_trip_access_alerts_trip   ON trip_access_alerts(trip_id);
CREATE INDEX idx_trip_access_alerts_open   ON trip_access_alerts(trip_id) WHERE resolved_at IS NULL;
