-- Academy OS P2 / #804: curriculum licensing & training-content marketplace.
-- Additive only (new tables + one widened constraint; nothing altered, dropped, truncated or cascaded). Rollback = deploy the previous build, which ignores
-- these tables; the rows are licensing records and are never deleted (revoked_at / retired_at / status instead).
-- Nothing here copies curriculum: pack items REFERENCE approved curriculum / methodology versions (#782) and the licensee's use of an item is a link
-- (academy_content_uses) to its own academy session or class plan. Money goes through canonical payments (purpose 'content_licence') and the finance
-- ledger; territory/window rules reuse src/media-rights.js. Free-text notes are encrypted (*_enc).

-- 1. Packs: what an academy offers. Versions are append-only snapshots of the item set.
CREATE TABLE IF NOT EXISTS academy_content_packs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations,         -- the publisher (owner of the rights)
  title            text NOT NULL CHECK (length(title) BETWEEN 2 AND 140),
  summary          text CHECK (summary IS NULL OR length(summary) <= 1000),
  sport            text NOT NULL CHECK (length(sport) BETWEEN 2 AND 40),
  level_key        text CHECK (level_key IS NULL OR length(level_key) <= 40),
  age_min          int CHECK (age_min IS NULL OR age_min BETWEEN 3 AND 99),
  age_max          int CHECK (age_max IS NULL OR age_max BETWEEN 3 AND 99),
  languages        text[] NOT NULL DEFAULT '{}',
  methodology_id   uuid REFERENCES academy_methodologies,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  current_version  int  NOT NULL DEFAULT 0,                         -- last published version
  eligibility      text NOT NULL DEFAULT 'affiliated' CHECK (eligibility IN ('open','affiliated','invited')),
  territory_mode   text NOT NULL DEFAULT 'worldwide' CHECK (territory_mode IN ('worldwide','include','exclude')),
  countries        text[] NOT NULL DEFAULT '{}',
  max_seats        int  CHECK (max_seats IS NULL OR max_seats BETWEEN 1 AND 100000),
  offline_allowed  boolean NOT NULL DEFAULT false,
  offline_max_days int  NOT NULL DEFAULT 14 CHECK (offline_max_days BETWEEN 1 AND 90),
  price_minor      bigint NOT NULL DEFAULT 0 CHECK (price_minor >= 0),   -- per seat, per term
  currency         text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  term_months      int  NOT NULL DEFAULT 12 CHECK (term_months BETWEEN 1 AND 60),
  grace_days       int  NOT NULL DEFAULT 14 CHECK (grace_days BETWEEN 0 AND 90),
  revenue_share    jsonb NOT NULL DEFAULT '[]',                      -- [{name, kind:'academy'|'author'|'partner', user_id?, organisation_id?, bp}] basis points, sum <= 10000
  authors          jsonb NOT NULL DEFAULT '[]',                      -- [{name, role, user_id?}] credited authors
  attributions     jsonb NOT NULL DEFAULT '[]',                      -- third-party sources [{title, owner, licence}]
  row_version      int  NOT NULL DEFAULT 1,
  created_by       uuid REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  retired_at       timestamptz,
  CHECK (age_min IS NULL OR age_max IS NULL OR age_min <= age_max),
  CHECK (territory_mode = 'worldwide' OR cardinality(countries) > 0)
);
CREATE INDEX IF NOT EXISTS academy_content_packs_org ON academy_content_packs (organisation_id, status);
CREATE INDEX IF NOT EXISTS academy_content_packs_market ON academy_content_packs (sport, status) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS academy_content_pack_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id       uuid NOT NULL REFERENCES academy_content_packs,
  version       int  NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','superseded','retired')),
  objectives    jsonb NOT NULL DEFAULT '[]',        -- learning objectives [{title, success_criteria}]
  assessment    jsonb NOT NULL DEFAULT '{}',        -- {kind:'none'|'quiz'|'observation'|'portfolio', pass_mark}
  cpd_hours     numeric(5,1) NOT NULL DEFAULT 0 CHECK (cpd_hours >= 0),
  prerequisites jsonb NOT NULL DEFAULT '[]',
  note_enc      text,
  published_by  uuid REFERENCES users,
  published_at  timestamptz,
  created_by    uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_content_pack_versions_one_draft ON academy_content_pack_versions (pack_id) WHERE status = 'draft';

-- Items: references to approved content, or a pack-native micro-module / video link. A curriculum or methodology item points at a PUBLISHED version.
CREATE TABLE IF NOT EXISTS academy_content_pack_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id       uuid NOT NULL REFERENCES academy_content_pack_versions,
  position         int  NOT NULL DEFAULT 0,
  kind             text NOT NULL CHECK (kind IN ('curriculum','methodology','drill','module','video','document')),
  ref_id           uuid,                            -- academy_curriculum_versions.id | academy_methodology_versions' methodology id
  ref_version      int,
  ref_key          text,                            -- drill key inside a methodology version
  title            text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  body             jsonb NOT NULL DEFAULT '{}',     -- module: {blocks:[{type,text}], sources:[{title,url,evidence}]}
  external_url     text CHECK (external_url IS NULL OR external_url ~ '^https://'),
  youth_footage    boolean NOT NULL DEFAULT false,  -- shows under-18s: stream-only, never offline, no redistribution
  required         boolean NOT NULL DEFAULT true,
  minutes          int  CHECK (minutes IS NULL OR minutes BETWEEN 1 AND 1440),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (kind NOT IN ('curriculum','methodology') OR ref_id IS NOT NULL),
  CHECK (kind <> 'video' OR external_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS academy_content_pack_items_version ON academy_content_pack_items (version_id, position);

-- A published version's item set is evidence of what was licensed: it cannot change.
CREATE OR REPLACE FUNCTION academy_content_items_freeze() RETURNS trigger AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM academy_content_pack_versions WHERE id = COALESCE(NEW.version_id, OLD.version_id);
  IF s IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'A published pack version cannot be edited; publish a new version'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS academy_content_items_freeze_trg ON academy_content_pack_items;
CREATE TRIGGER academy_content_items_freeze_trg BEFORE INSERT OR UPDATE OR DELETE ON academy_content_pack_items FOR EACH ROW EXECUTE FUNCTION academy_content_items_freeze();

-- 2. Licences: the buyer's right. Entitlement is read from this row on every request.
CREATE TABLE IF NOT EXISTS academy_content_licences (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id           uuid NOT NULL REFERENCES academy_content_packs,
  licensee_org_id   uuid NOT NULL REFERENCES organisations,
  stage             text NOT NULL DEFAULT 'proposed' CHECK (stage IN ('requested','proposed','awaiting_payment','active','suspended','revoked','expired','declined','withdrawn')),
  seats             int  NOT NULL DEFAULT 1 CHECK (seats BETWEEN 1 AND 100000),
  effective_from    date,
  effective_to      date,
  pinned_version    int,                            -- null = follows the latest published version
  territory_mode    text NOT NULL DEFAULT 'worldwide' CHECK (territory_mode IN ('worldwide','include','exclude')),
  countries         text[] NOT NULL DEFAULT '{}',
  offline_allowed   boolean NOT NULL DEFAULT false,
  offline_max_days  int  NOT NULL DEFAULT 14 CHECK (offline_max_days BETWEEN 1 AND 90),
  price_minor       bigint NOT NULL DEFAULT 0 CHECK (price_minor >= 0),   -- total for the term, fixed at proposal
  currency          text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  grace_days        int  NOT NULL DEFAULT 14 CHECK (grace_days BETWEEN 0 AND 90),
  auto_renew        boolean NOT NULL DEFAULT false,
  renewal_of        uuid REFERENCES academy_content_licences,
  requested_by      uuid REFERENCES users,
  decided_by        uuid REFERENCES users,           -- the publisher who proposed / decided
  accepted_by       uuid REFERENCES users,           -- the licensee's administrator who accepted the terms (the payer)
  accepted_at       timestamptz,
  decided_at        timestamptz,
  paid_at           timestamptz,
  suspended_at      timestamptz,
  revoked_at        timestamptz,
  reason_code       text CHECK (reason_code IS NULL OR reason_code IN ('non_payment','breach','rights_dispute','safeguarding','requested_by_licensee','end_of_term','other')),
  note_enc          text,
  row_version       int  NOT NULL DEFAULT 1,
  created_by        uuid REFERENCES users,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  CHECK (territory_mode = 'worldwide' OR cardinality(countries) > 0)
);
CREATE INDEX IF NOT EXISTS academy_content_licences_pack ON academy_content_licences (pack_id, stage);
CREATE INDEX IF NOT EXISTS academy_content_licences_licensee ON academy_content_licences (licensee_org_id, stage);
-- one running licence and one pending offer/renewal per pack and buyer: a renewal waits as 'proposed' while the current licence keeps running, then replaces it
CREATE UNIQUE INDEX IF NOT EXISTS academy_content_licences_live ON academy_content_licences (pack_id, licensee_org_id) WHERE stage IN ('active','suspended');
CREATE UNIQUE INDEX IF NOT EXISTS academy_content_licences_pending ON academy_content_licences (pack_id, licensee_org_id) WHERE stage IN ('requested','proposed','awaiting_payment');

CREATE TABLE IF NOT EXISTS academy_content_seats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licence_id  uuid NOT NULL REFERENCES academy_content_licences,
  user_id     uuid NOT NULL REFERENCES users,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  assigned_by uuid REFERENCES users,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_content_seats_live ON academy_content_seats (licence_id, user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS academy_content_seats_user ON academy_content_seats (user_id, status);

-- Append-only trail of everything that happens to a licence.
CREATE TABLE IF NOT EXISTS academy_content_licence_events (
  id         bigserial PRIMARY KEY,
  licence_id uuid NOT NULL REFERENCES academy_content_licences,
  actor_id   uuid REFERENCES users,
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_content_licence_events_licence ON academy_content_licence_events (licence_id, at DESC);
CREATE OR REPLACE FUNCTION academy_content_events_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'The licence history is append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS academy_content_events_append_only_trg ON academy_content_licence_events;
CREATE TRIGGER academy_content_events_append_only_trg BEFORE UPDATE OR DELETE ON academy_content_licence_events FOR EACH ROW EXECUTE FUNCTION academy_content_events_append_only();

-- 3. Use and consumption: a link to the licensee's own session / class plan (never a copy), and telemetry (ids only).
CREATE TABLE IF NOT EXISTS academy_content_uses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licence_id uuid NOT NULL REFERENCES academy_content_licences,
  item_id    uuid NOT NULL REFERENCES academy_content_pack_items,
  user_id    uuid NOT NULL REFERENCES users,
  session_id uuid REFERENCES academy_sessions,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (licence_id, item_id, session_id)
);

CREATE TABLE IF NOT EXISTS academy_content_consumption (
  id         bigserial PRIMARY KEY,
  licence_id uuid NOT NULL REFERENCES academy_content_licences,
  item_id    uuid NOT NULL REFERENCES academy_content_pack_items,
  user_id    uuid NOT NULL REFERENCES users,
  event      text NOT NULL CHECK (event IN ('opened','completed','offline_sync')),
  seconds    int  CHECK (seconds IS NULL OR seconds BETWEEN 0 AND 86400),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_content_consumption_licence ON academy_content_consumption (licence_id, at DESC);

CREATE TABLE IF NOT EXISTS academy_content_offline_grants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licence_id uuid NOT NULL REFERENCES academy_content_licences,
  user_id    uuid NOT NULL REFERENCES users,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_content_offline_grants_user ON academy_content_offline_grants (user_id, licence_id);

-- 4. Support / takedown cases (youth footage, rights disputes) and ratings from licensed coaches.
CREATE TABLE IF NOT EXISTS academy_content_cases (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licence_id uuid REFERENCES academy_content_licences,
  pack_id    uuid NOT NULL REFERENCES academy_content_packs,
  item_id    uuid REFERENCES academy_content_pack_items,
  raised_by  uuid NOT NULL REFERENCES users,
  kind       text NOT NULL CHECK (kind IN ('support','takedown','rights_dispute','safeguarding','billing')),
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved')),
  note_enc   text NOT NULL,
  resolution_enc text,
  resolved_by uuid REFERENCES users,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_content_cases_pack ON academy_content_cases (pack_id, status);

-- A takedown (youth footage, rights dispute) pulls an item from every licensee at once without editing the frozen version. Lifting it is a new row's absence: rows are kept.
CREATE TABLE IF NOT EXISTS academy_content_takedowns (
  item_id    uuid PRIMARY KEY REFERENCES academy_content_pack_items,
  case_id    uuid REFERENCES academy_content_cases,
  reason     text NOT NULL CHECK (reason IN ('youth_safeguarding','rights_dispute','accuracy','other')),
  taken_by   uuid REFERENCES users,
  taken_at   timestamptz NOT NULL DEFAULT now(),
  lifted_at  timestamptz
);

CREATE TABLE IF NOT EXISTS academy_content_ratings (
  licence_id uuid NOT NULL REFERENCES academy_content_licences,
  user_id    uuid NOT NULL REFERENCES users,
  stars      int  NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (licence_id, user_id)
);

-- 5. Provenance on the licensee's own planning (a reference, not a copy): which licensed item a session was planned from.
-- (academy_content_uses above carries it; no column is added to canonical tables.)

-- 6. A licence is paid through canonical payments (the constraint is widened, never narrowed).
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'payments_purpose_type_check' AND conrelid = 'payments'::regclass;
  IF d IS NOT NULL AND position('content_licence' IN d) = 0 THEN
    ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
    EXECUTE 'ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check ' || replace(d, '::text])', '::text, ''content_licence''::text])');
  END IF;
END $$;
