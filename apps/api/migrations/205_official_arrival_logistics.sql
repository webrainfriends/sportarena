-- 205: Official arrival logistics and venue check-in (R21, Issue #1013)
-- Additive only: no DROP / TRUNCATE / rewrites.

-- Venue logistics packet per fixture (organiser/assignor-managed)
CREATE TABLE IF NOT EXISTS fixture_logistics (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id               uuid        NOT NULL REFERENCES fixtures(id) UNIQUE,
  parking_notes            text,
  gate_instructions        text,
  official_room            text,
  reporting_location_notes text,
  emergency_contacts       jsonb       NOT NULL DEFAULT '[]',   -- [{label, phone_enc, role}]
  equipment_checklist      jsonb       NOT NULL DEFAULT '[]',   -- [{id, label, required}]
  check_in_deadline_min    int         NOT NULL DEFAULT 20 CHECK (check_in_deadline_min BETWEEN 0 AND 120),
  weather_cache            jsonb,
  weather_fetched_at       timestamptz,
  dispatched_at            timestamptz,
  created_by               uuid        NOT NULL REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixture_logistics_fixture ON fixture_logistics(fixture_id);

-- Arrival check-in record per official per fixture (idempotent: UNIQUE on fixture+official)
CREATE TABLE IF NOT EXISTS fixture_official_check_ins (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id            uuid        NOT NULL REFERENCES fixtures(id),
  official_id           uuid        NOT NULL REFERENCES users(id),
  checked_in_at         timestamptz NOT NULL DEFAULT now(),
  method                text        NOT NULL CHECK (method IN ('qr','geofence','manual_code','organiser_manual')),
  is_late               bool        NOT NULL DEFAULT false,
  late_reason           text,
  estimated_arrival_min int,
  location_consent      bool        NOT NULL DEFAULT false,
  actor_id              uuid        NOT NULL REFERENCES users(id),
  UNIQUE (fixture_id, official_id)
);
CREATE INDEX IF NOT EXISTS foci_fixture  ON fixture_official_check_ins(fixture_id, checked_in_at);
CREATE INDEX IF NOT EXISTS foci_official ON fixture_official_check_ins(official_id, checked_in_at);

-- Per-official location consent preference (revocable at any time)
CREATE TABLE IF NOT EXISTS official_location_consent (
  official_id        uuid PRIMARY KEY REFERENCES users(id),
  geofence_check_in  bool        NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Columns added to fixture_officials (additive)
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS check_in_code       text;
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS logistics_viewed_at timestamptz;
