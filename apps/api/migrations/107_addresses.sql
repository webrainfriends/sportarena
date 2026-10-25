-- Reusable multi-address model: a person, organisation, team or venue can hold several addresses
-- (home, training, billing …), pick a default, and optionally tie an address to an organisation,
-- event, academy or team context. Additive only: nothing is dropped or rewritten; the old city/region
-- columns stay and are copied across once. Street lines of a person's address are field-encrypted.
CREATE TABLE IF NOT EXISTS addresses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind    text NOT NULL CHECK (owner_kind IN ('user','organisation','team','venue')),
  owner_id      uuid NOT NULL,
  kind          text NOT NULL DEFAULT 'other' CHECK (kind IN ('home','training','billing','venue','other')),
  label         text CHECK (label IS NULL OR char_length(label) <= 60),
  line1         text,
  line2         text,
  locality      text,                      -- city / town
  area          text,                      -- neighbourhood / district
  region        text,                      -- state / province
  postal_code   text,
  country       text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  latitude      double precision CHECK (latitude  BETWEEN -90  AND 90),
  longitude     double precision CHECK (longitude BETWEEN -180 AND 180),
  timezone      text,
  pii_enc       text,                      -- user-owned street lines/postcode (JSON), AES-GCM via crypto.js
  sport_id      uuid REFERENCES sports(id),
  context_kind  text CHECK (context_kind IS NULL OR context_kind IN ('organisation','event','academy','team')),
  context_id    uuid,
  is_default    boolean NOT NULL DEFAULT false,
  source_ref    text,                      -- set by the backfill so it can run twice without duplicating
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CHECK ((context_kind IS NULL) = (context_id IS NULL))
);
CREATE INDEX IF NOT EXISTS addresses_owner ON addresses (owner_kind, owner_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS addresses_search ON addresses (lower(btrim(locality))) WHERE archived_at IS NULL AND locality IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS addresses_one_default ON addresses (owner_kind, owner_id) WHERE is_default AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS addresses_source_ref ON addresses (source_ref) WHERE source_ref IS NOT NULL;

-- One-off copy of what already exists (idempotent through source_ref). Old columns are left untouched.
INSERT INTO addresses (owner_kind, owner_id, kind, locality, sport_id, is_default, source_ref)
SELECT 'user', p.user_id, 'training', btrim(p.region), p.sport_id,
       NOT EXISTS (SELECT 1 FROM addresses a WHERE a.owner_kind='user' AND a.owner_id=p.user_id AND a.is_default AND a.archived_at IS NULL)
         AND p.id = (SELECT p2.id FROM sport_profiles p2 WHERE p2.user_id=p.user_id AND p2.region IS NOT NULL AND btrim(p2.region) <> '' ORDER BY p2.created_at, p2.id LIMIT 1),
       'sport_profiles:' || p.id
FROM sport_profiles p
WHERE p.region IS NOT NULL AND btrim(p.region) <> ''
ON CONFLICT DO NOTHING;

INSERT INTO addresses (owner_kind, owner_id, kind, locality, is_default, source_ref)
SELECT 'organisation', o.id, 'other', btrim(o.city), true, 'organisations:' || o.id
FROM organisations o WHERE o.city IS NOT NULL AND btrim(o.city) <> ''
ON CONFLICT DO NOTHING;

INSERT INTO addresses (owner_kind, owner_id, kind, locality, is_default, source_ref)
SELECT 'team', t.id, 'other', btrim(t.city), true, 'teams:' || t.id
FROM teams t WHERE t.city IS NOT NULL AND btrim(t.city) <> ''
ON CONFLICT DO NOTHING;

INSERT INTO addresses (owner_kind, owner_id, kind, line1, locality, region, postal_code, country, latitude, longitude, timezone, is_default, source_ref)
SELECT 'venue', v.id, 'venue', nullif(btrim(v.address), ''), nullif(btrim(v.city), ''), NULL, nullif(btrim(v.postal_code), ''),
       CASE WHEN v.country ~ '^[A-Za-z]{2}$' THEN upper(v.country) END, v.latitude, v.longitude, v.timezone, true, 'venues:' || v.id
FROM venues v
WHERE nullif(btrim(v.address), '') IS NOT NULL OR nullif(btrim(v.city), '') IS NOT NULL
ON CONFLICT DO NOTHING;
