-- Loyalty & referral engine (issue #509): one canonical programme + append-only ledger for venues, academies, coaches, events and the platform.
-- Additive only. The earlier venue loyalty tables (loyalty_lots, loyalty_events, venues.loyalty_*) are kept untouched as the pre-ledger record;
-- their balances are carried into the ledger below so no member loses a point. 1 point = 1 minor unit of the programme currency.

CREATE TABLE loyalty_programmes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind     text NOT NULL CHECK (owner_kind IN ('platform','venue','organisation','coach','event')),
  owner_id       uuid,                                   -- venue / organisation / coach (user) / event id; NULL for the platform
  slug           text NOT NULL DEFAULT 'main',
  name           text NOT NULL,
  unit           text NOT NULL DEFAULT 'points' CHECK (unit IN ('points','credits')),
  currency       text NOT NULL,
  funding_owner  text NOT NULL DEFAULT 'owner' CHECK (funding_owner IN ('owner','platform','sponsor')),
  sponsorship_id uuid REFERENCES sponsorships,           -- required when a sponsor funds it
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','ended')),
  current_version int,
  created_by     uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_kind = 'platform') = (owner_id IS NULL)),
  CHECK (funding_owner <> 'sponsor' OR sponsorship_id IS NOT NULL)
);
CREATE UNIQUE INDEX loyalty_programmes_owner_slug ON loyalty_programmes (owner_kind, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
CREATE INDEX loyalty_programmes_owner ON loyalty_programmes (owner_kind, owner_id, status);

-- A published version is immutable: changing the rules publishes a new version, and every ledger row remembers the version it was earned under.
CREATE TABLE loyalty_programme_versions (
  programme_id uuid NOT NULL REFERENCES loyalty_programmes,
  version      int NOT NULL,
  rules        jsonb NOT NULL,
  starts_at    timestamptz,                              -- campaign window
  ends_at      timestamptz,
  note         text,
  published_by uuid REFERENCES users,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (programme_id, version)
);

CREATE FUNCTION loyalty_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000'; END $$;
CREATE TRIGGER loyalty_versions_immutable BEFORE UPDATE OR DELETE ON loyalty_programme_versions FOR EACH ROW EXECUTE FUNCTION loyalty_immutable();

-- The ledger. A row with delta > 0 opens a lot (earn, restore, bonus, adjust, exchange_in); a row with delta < 0 draws a lot down and points at it.
-- The balance of a lot is its delta plus the deltas that point at it; nothing is ever updated or deleted.
CREATE TABLE loyalty_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigserial UNIQUE,
  programme_id    uuid NOT NULL REFERENCES loyalty_programmes,
  user_id         uuid NOT NULL REFERENCES users,
  kind            text NOT NULL CHECK (kind IN ('earn','bonus','restore','adjust','exchange_in','redeem','clawback','expire','exchange_out','legacy_use')),
  delta           int NOT NULL CHECK (delta <> 0),
  lot_id          uuid REFERENCES loyalty_ledger,
  expires_at      timestamptz,
  version         int,
  rule_key        text,
  source_type     text,
  source_id       text,
  funding_owner   text,
  sponsorship_id  uuid,
  idempotency_key text NOT NULL UNIQUE,
  reason          text,
  actor_id        uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((delta > 0 AND lot_id IS NULL AND expires_at IS NOT NULL) OR (delta < 0 AND lot_id IS NOT NULL AND expires_at IS NULL)),
  CHECK (kind NOT IN ('adjust') OR (reason IS NOT NULL AND actor_id IS NOT NULL))
);
CREATE INDEX loyalty_ledger_member ON loyalty_ledger (user_id, programme_id, seq DESC);
CREATE INDEX loyalty_ledger_programme ON loyalty_ledger (programme_id, created_at);
CREATE INDEX loyalty_ledger_lot ON loyalty_ledger (lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX loyalty_ledger_source ON loyalty_ledger (source_type, source_id);
CREATE TRIGGER loyalty_ledger_immutable BEFORE UPDATE OR DELETE ON loyalty_ledger FOR EACH ROW EXECUTE FUNCTION loyalty_immutable();
CREATE TRIGGER loyalty_ledger_no_truncate BEFORE TRUNCATE ON loyalty_ledger FOR EACH STATEMENT EXECUTE FUNCTION loyalty_immutable();

-- Backstop: a lot can never be drawn below zero or past its own programme/member, even under a race (the lot row is locked while the check runs).
CREATE FUNCTION loyalty_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lot loyalty_ledger; left_ int;
BEGIN
  IF NEW.lot_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO lot FROM loyalty_ledger WHERE id = NEW.lot_id FOR UPDATE;
  IF lot.programme_id <> NEW.programme_id OR lot.user_id <> NEW.user_id THEN RAISE EXCEPTION 'a lot belongs to one member of one programme' USING ERRCODE = '23514'; END IF;
  SELECT lot.delta + coalesce(sum(delta), 0) INTO left_ FROM loyalty_ledger WHERE lot_id = NEW.lot_id;
  IF left_ + NEW.delta < 0 THEN RAISE EXCEPTION 'not enough points left in that lot' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER loyalty_ledger_guard BEFORE INSERT ON loyalty_ledger FOR EACH ROW EXECUTE FUNCTION loyalty_guard();

CREATE VIEW loyalty_lots_open AS
  SELECT l.id, l.programme_id, l.user_id, l.kind, l.delta AS points, l.expires_at, l.source_type, l.source_id, l.funding_owner, l.created_at,
         (l.delta + coalesce((SELECT sum(c.delta) FROM loyalty_ledger c WHERE c.lot_id = l.id), 0))::int AS remaining
    FROM loyalty_ledger l WHERE l.delta > 0;

-- What a redemption took, so a cancellation can put exactly that back under the programme's restore policy.
CREATE TABLE loyalty_redemptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id  uuid NOT NULL REFERENCES loyalty_programmes,
  user_id       uuid NOT NULL REFERENCES users,
  purpose_type  text NOT NULL,
  purpose_id    uuid NOT NULL,
  points        int NOT NULL CHECK (points > 0),
  restored      int NOT NULL DEFAULT 0 CHECK (restored >= 0 AND restored <= points),
  version       int NOT NULL,
  restore_policy jsonb NOT NULL,
  request_key   text UNIQUE,                             -- caller-supplied: a retried request returns the same redemption
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loyalty_redemptions_purpose ON loyalty_redemptions (purpose_type, purpose_id);
CREATE INDEX loyalty_redemptions_member ON loyalty_redemptions (user_id, programme_id);

-- Referrals: revocable links/codes with attribution; invite -> registration -> qualifying event -> reward.
CREATE TABLE loyalty_referral_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id uuid NOT NULL REFERENCES loyalty_programmes,
  referrer_id uuid NOT NULL REFERENCES users,
  code        text NOT NULL UNIQUE,
  campaign    text,
  source      text,
  max_uses    int CHECK (max_uses IS NULL OR max_uses > 0),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loyalty_referral_codes_referrer ON loyalty_referral_codes (referrer_id, programme_id);

CREATE TABLE loyalty_referrals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id  uuid NOT NULL REFERENCES loyalty_programmes,
  code_id       uuid NOT NULL REFERENCES loyalty_referral_codes,
  referrer_id   uuid NOT NULL REFERENCES users,
  invitee_id    uuid NOT NULL REFERENCES users,
  status        text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','qualified','rewarded','held','blocked','void')),
  flags         text[] NOT NULL DEFAULT '{}',
  version       int NOT NULL,
  qualifying_source_type text,
  qualifying_source_id   text,
  qualified_at  timestamptz,
  release_at    timestamptz,
  rewarded_at   timestamptz,
  reviewed_by   uuid REFERENCES users,
  review_note   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (programme_id, invitee_id)
);
CREATE INDEX loyalty_referrals_referrer ON loyalty_referrals (referrer_id, programme_id);
CREATE INDEX loyalty_referrals_invitee ON loyalty_referrals (invitee_id);
CREATE INDEX loyalty_referrals_open ON loyalty_referrals (status) WHERE status IN ('registered','qualified','held');

-- Balances stay separate per programme unless both owners approve an explicit exchange rule.
CREATE TABLE loyalty_exchange_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_programme  uuid NOT NULL REFERENCES loyalty_programmes,
  to_programme    uuid NOT NULL REFERENCES loyalty_programmes,
  rate_bp         int NOT NULL CHECK (rate_bp BETWEEN 1 AND 100000),      -- 10000 = 1:1 by money value
  max_points_per_member_month int CHECK (max_points_per_member_month IS NULL OR max_points_per_member_month > 0),
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','ended')),
  proposed_by     uuid NOT NULL REFERENCES users,
  from_approved_by uuid REFERENCES users,
  to_approved_by  uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (from_programme <> to_programme)
);

-- Redemption on a canonical invoice remembers which programme paid.
ALTER TABLE invoice_credits ADD COLUMN redemption_id uuid REFERENCES loyalty_redemptions;
-- Coach sessions have no invoice: the points applied to the session are recorded on it and reduce what is still due.
ALTER TABLE coach_hires ADD COLUMN loyalty_credit_cents bigint NOT NULL DEFAULT 0 CHECK (loyalty_credit_cents >= 0);

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- Carry the earlier venue loyalty into the engine: each venue that has a scheme (or members with points) gets a "main" programme whose
-- version 1 is its current settings; each earlier lot opens a ledger lot with the same expiry, and what was already used/expired/clawed
-- back is one 'legacy_use' row (the itemised statement stays in loyalty_events, which is not changed).
INSERT INTO loyalty_programmes (owner_kind, owner_id, slug, name, currency, status, current_version, created_by)
SELECT 'venue', v.id, 'main', v.name || ' rewards', v.currency, CASE WHEN v.loyalty_earn_bp > 0 THEN 'active' ELSE 'paused' END, 1, v.owner_id
  FROM venues v WHERE v.loyalty_earn_bp > 0 OR EXISTS (SELECT 1 FROM loyalty_lots l WHERE l.venue_id = v.id);

INSERT INTO loyalty_programme_versions (programme_id, version, rules, note, published_by)
SELECT p.id, 1, jsonb_build_object(
    'earn', CASE WHEN v.loyalty_earn_bp > 0 THEN jsonb_build_array(jsonb_build_object('key','booking','event','venue_booking_paid','mode','percent','percent_bp', v.loyalty_earn_bp)) ELSE '[]'::jsonb END,
    'redeem', jsonb_build_object('max_redeem_bp', v.loyalty_max_redeem_bp, 'min_points', 1, 'purposes', jsonb_build_array('venue_invoice'), 'restore_expiry', 'fresh'),
    'expiry_months', v.loyalty_expiry_months, 'caps', '{}'::jsonb, 'eligibility', jsonb_build_object('youth', 'excluded'), 'referral', jsonb_build_object('enabled', false)),
  'Carried over from the venue loyalty settings', v.owner_id
  FROM loyalty_programmes p JOIN venues v ON v.id = p.owner_id WHERE p.owner_kind = 'venue';

INSERT INTO loyalty_ledger (programme_id, user_id, kind, delta, expires_at, version, rule_key, source_type, source_id, funding_owner, idempotency_key, reason, created_at)
SELECT p.id, l.user_id, CASE l.kind WHEN 'earn' THEN 'earn' WHEN 'restore' THEN 'restore' ELSE 'bonus' END, l.points, l.expires_at, 1,
       CASE l.kind WHEN 'earn' THEN 'booking' END, CASE WHEN l.invoice_id IS NOT NULL THEN 'venue_invoice' END, l.invoice_id::text, 'owner', 'legacy:lot:' || l.id, 'Carried over from the earlier venue loyalty', l.earned_at
  FROM loyalty_lots l JOIN loyalty_programmes p ON p.owner_kind = 'venue' AND p.owner_id = l.venue_id AND p.slug = 'main';

INSERT INTO loyalty_ledger (programme_id, user_id, kind, delta, lot_id, version, funding_owner, idempotency_key, reason)
SELECT g.programme_id, g.user_id, 'legacy_use', -(l.points - l.remaining), g.id, 1, 'owner', 'legacy:use:' || l.id, 'Spent, expired or reversed before the unified ledger — see the earlier statement'
  FROM loyalty_lots l JOIN loyalty_ledger g ON g.idempotency_key = 'legacy:lot:' || l.id WHERE l.remaining < l.points;
