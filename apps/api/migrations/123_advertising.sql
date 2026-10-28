-- Sports advertising & promoted marketplace (#524). Paid, clearly labelled placements in their own inventory, kept apart from every organic ranking.
-- Additive only: nothing is dropped or narrowed, no row is deleted. Delivery facts, reviews and the money ledger are append-only (enforced by triggers).
-- No demo rows: the only row inserted is the single platform policy row with conservative defaults (youth contextual ads OFF).

-- ------------------------------------------------------------------ platform policy (one row, versioned by its edits)
CREATE TABLE IF NOT EXISTS ad_policy (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
  version             int NOT NULL DEFAULT 1,
  youth_contextual    boolean NOT NULL DEFAULT false,      -- may approved, contextual-only campaigns reach under-18s / youth pages? Off until the platform decides.
  default_frequency   int NOT NULL DEFAULT 3 CHECK (default_frequency BETWEEN 1 AND 50),   -- impressions per person per day when a campaign sets no cap
  max_frequency       int NOT NULL DEFAULT 10 CHECK (max_frequency BETWEEN 1 AND 100),
  updated_by          uuid REFERENCES users,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ad_policy(id) VALUES (true) ON CONFLICT DO NOTHING;

-- Inventory switches. A row only exists once the platform changes a placement from its default (enabled, one slot).
CREATE TABLE IF NOT EXISTS ad_inventory (
  placement_code text PRIMARY KEY,
  enabled        boolean NOT NULL DEFAULT true,
  max_slots      int NOT NULL DEFAULT 1 CHECK (max_slots BETWEEN 1 AND 3),
  updated_by     uuid REFERENCES users,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ who may advertise
CREATE TABLE IF NOT EXISTS ad_advertisers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid REFERENCES organisations,
  user_id         uuid REFERENCES users,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  policy_version  int NOT NULL,                                 -- the advertising policy the account holder accepted
  accepted_by     uuid NOT NULL REFERENCES users,
  accepted_at     timestamptz NOT NULL DEFAULT now(),
  suspended_reason text,
  suspended_by    uuid REFERENCES users,
  suspended_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((organisation_id IS NULL) <> (user_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ad_advertisers_org ON ad_advertisers (organisation_id) WHERE organisation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ad_advertisers_user ON ad_advertisers (user_id) WHERE user_id IS NOT NULL;

-- ------------------------------------------------------------------ campaigns
CREATE TABLE IF NOT EXISTS ad_campaigns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id      uuid NOT NULL REFERENCES ad_advertisers,
  name               text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  objective          text NOT NULL CHECK (objective IN ('awareness','traffic')),
  category           text NOT NULL,                                -- checked against the platform's category policy in code
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','rejected','approved','scheduled','active','paused','ended','withdrawn')),
  billing_model      text NOT NULL CHECK (billing_model IN ('flat','cpm','cpc')),
  rate_minor         bigint NOT NULL CHECK (rate_minor > 0),       -- flat: the whole fee; cpm: per 1000 impressions; cpc: per click
  currency           text NOT NULL,
  budget_minor       bigint NOT NULL CHECK (budget_minor > 0),     -- the most the advertiser wants to spend; delivery stops at the funded amount or this, whichever is lower
  funded_minor       bigint NOT NULL DEFAULT 0 CHECK (funded_minor >= 0),
  refunded_minor     bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  spent_micro        bigint NOT NULL DEFAULT 0 CHECK (spent_micro >= 0),   -- 1 minor unit = 1,000,000 micro, so a per-impression price can be a fraction
  starts_on          date NOT NULL,
  ends_on            date NOT NULL,
  countries          text[] NOT NULL DEFAULT '{}',                 -- coarse geography only; empty = anywhere
  cities             text[] NOT NULL DEFAULT '{}',
  sports             text[] NOT NULL DEFAULT '{}',                 -- sport slugs; empty = any sport
  keywords           text[] NOT NULL DEFAULT '{}',                 -- search_sponsored only
  audience           text NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone','followers')),
  frequency_per_day  int CHECK (frequency_per_day IS NULL OR frequency_per_day BETWEEN 1 AND 100),
  youth_contextual   boolean NOT NULL DEFAULT false,               -- set only by a reviewer, only effective while the platform policy allows it
  disclosure         text NOT NULL DEFAULT 'sponsored' CHECK (disclosure IN ('sponsored','promoted')),
  landing_entity_type text CHECK (landing_entity_type IN ('venue','coach','academy','event','supplier')),
  landing_entity_id  uuid,
  landing_url        text,
  current_creative_id uuid,
  held_by_platform   boolean NOT NULL DEFAULT false,               -- paused or stopped by the platform: the advertiser cannot resume it
  submitted_at       timestamptz,
  decided_at         timestamptz,
  activated_at       timestamptz,
  ended_at           timestamptz,
  end_reason         text,
  created_by         uuid NOT NULL REFERENCES users,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on),
  CHECK ((landing_entity_type IS NULL) = (landing_entity_id IS NULL)),
  CHECK (landing_entity_type IS NOT NULL OR landing_url IS NOT NULL OR objective = 'awareness'),
  CHECK (billing_model <> 'flat' OR budget_minor = rate_minor)
);
CREATE INDEX IF NOT EXISTS ad_campaigns_advertiser ON ad_campaigns (advertiser_id, status);
CREATE INDEX IF NOT EXISTS ad_campaigns_serving ON ad_campaigns (status, starts_on, ends_on) WHERE status IN ('scheduled','active');
CREATE INDEX IF NOT EXISTS ad_campaigns_review ON ad_campaigns (submitted_at) WHERE status = 'submitted';

CREATE TABLE IF NOT EXISTS ad_campaign_placements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    uuid NOT NULL REFERENCES ad_campaigns,
  placement_code text NOT NULL,
  removed_at     timestamptz                                       -- taking a placement off a draft ends the row; it is not deleted
);
CREATE UNIQUE INDEX IF NOT EXISTS ad_campaign_placements_live ON ad_campaign_placements (campaign_id, placement_code) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS ad_campaign_placements_code ON ad_campaign_placements (placement_code) WHERE removed_at IS NULL;

-- Creative versions. A creative is never edited once submitted: a change is a new version that is reviewed again.
CREATE TABLE IF NOT EXISTS ad_creatives (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES ad_campaigns,
  version      int NOT NULL,
  headline     text NOT NULL CHECK (length(headline) BETWEEN 2 AND 60),
  body         text CHECK (body IS NULL OR length(body) <= 150),
  cta          text NOT NULL CHECK (cta IN ('learn_more','book_now','register','shop_now','view','get_directions')),
  media_id     uuid REFERENCES market_media,                       -- a photo uploaded through the canonical media pipeline
  alt_text     text CHECK (alt_text IS NULL OR length(alt_text) <= 140),
  claims       text[] NOT NULL DEFAULT '{}',                       -- what the advertiser declares the creative claims (price, discount, results, health, …)
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','withdrawn')),
  created_by   uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, version)
);
ALTER TABLE ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_current_creative_fk;
ALTER TABLE ad_campaigns ADD CONSTRAINT ad_campaigns_current_creative_fk FOREIGN KEY (current_creative_id) REFERENCES ad_creatives (id);

-- Review decisions: append-only, with the reason, its category and the claims the reviewer checked.
CREATE TABLE IF NOT EXISTS ad_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES ad_campaigns,
  creative_id     uuid REFERENCES ad_creatives,
  decision        text NOT NULL CHECK (decision IN ('approved','rejected','withdrawn','paused','resumed')),
  reason_category text CHECK (reason_category IN ('prohibited_category','misleading_claim','unsafe_or_harmful','youth_safety','landing_page','intellectual_property','targeting','other')),
  reason          text CHECK (reason IS NULL OR length(reason) <= 1000),
  claims_checked  text[] NOT NULL DEFAULT '{}',
  youth_contextual boolean NOT NULL DEFAULT false,
  reviewer_id     uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_reviews_campaign ON ad_reviews (campaign_id, created_at DESC);

-- A readable timeline of everything that happened to a campaign.
CREATE TABLE IF NOT EXISTS ad_campaign_log (
  id          bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES ad_campaigns,
  actor_id    uuid REFERENCES users,
  action      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_campaign_log_campaign ON ad_campaign_log (campaign_id, id);

-- ------------------------------------------------------------------ money
-- A funding is the invoice for budget the advertiser prepays; it is paid through the platform's hosted checkout (payments.purpose_type 'ad_funding').
CREATE SEQUENCE IF NOT EXISTS ad_funding_seq;
CREATE TABLE IF NOT EXISTS ad_fundings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         text NOT NULL UNIQUE,
  campaign_id    uuid NOT NULL REFERENCES ad_campaigns,
  payer_id       uuid NOT NULL REFERENCES users,
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  currency       text NOT NULL,
  status         text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','paid','void')),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  paid_at        timestamptz
);
CREATE INDEX IF NOT EXISTS ad_fundings_campaign ON ad_fundings (campaign_id);

-- What moved the campaign's available funds: funding +, refund −, flat fee −, flat credit +. Delivery spend is NOT repeated here: it is read from the delivery facts.
CREATE TABLE IF NOT EXISTS ad_ledger (
  id           bigserial PRIMARY KEY,
  campaign_id  uuid NOT NULL REFERENCES ad_campaigns,
  funding_id   uuid REFERENCES ad_fundings,
  kind         text NOT NULL CHECK (kind IN ('funding','refund','flat_charge','flat_credit')),
  amount_minor bigint NOT NULL,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_ledger_campaign ON ad_ledger (campaign_id, id);

-- ------------------------------------------------------------------ delivery facts: the one source for the advertiser's and the platform's reports
CREATE TABLE IF NOT EXISTS ad_delivery_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    uuid NOT NULL REFERENCES ad_campaigns,
  creative_id    uuid NOT NULL REFERENCES ad_creatives,
  placement_code text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('impression','click')),
  parent_id      uuid REFERENCES ad_delivery_events,               -- a click points at the impression it came from
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  day            date NOT NULL DEFAULT current_date,
  viewer_hash    text,                                             -- keyed hash, never reversible; NULL for young people and contextual-only delivery
  sport          text,                                             -- the sport of the page it appeared on
  geo_cell       text,                                             -- the campaign's own coarse cell that matched (a country or a city), never the viewer's position
  billable       boolean NOT NULL DEFAULT true,
  invalid_reason text,
  cost_micro     bigint NOT NULL DEFAULT 0 CHECK (cost_micro >= 0),
  dedupe_key     text
);
CREATE UNIQUE INDEX IF NOT EXISTS ad_delivery_dedupe ON ad_delivery_events (campaign_id, kind, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ad_delivery_one_click ON ad_delivery_events (parent_id) WHERE kind = 'click' AND parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ad_delivery_campaign_day ON ad_delivery_events (campaign_id, day);
CREATE INDEX IF NOT EXISTS ad_delivery_viewer ON ad_delivery_events (viewer_hash, occurred_at DESC) WHERE viewer_hash IS NOT NULL;

-- ------------------------------------------------------------------ people's controls
CREATE TABLE IF NOT EXISTS ad_hides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users,
  campaign_id   uuid REFERENCES ad_campaigns,
  advertiser_id uuid REFERENCES ad_advertisers,
  created_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,                                       -- "show me ads from them again" ends the hide; the row stays
  CHECK ((campaign_id IS NULL) <> (advertiser_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ad_hides_campaign ON ad_hides (user_id, campaign_id) WHERE campaign_id IS NOT NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ad_hides_advertiser ON ad_hides (user_id, advertiser_id) WHERE advertiser_id IS NOT NULL AND removed_at IS NULL;

CREATE TABLE IF NOT EXISTS ad_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES ad_campaigns,
  creative_id   uuid NOT NULL REFERENCES ad_creatives,
  impression_id uuid NOT NULL REFERENCES ad_delivery_events,
  reporter_id   uuid REFERENCES users,
  reason        text NOT NULL CHECK (reason IN ('misleading','offensive','irrelevant','unsafe','not_for_children','other')),
  note_enc      text,                                              -- free text, encrypted
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  outcome       text CHECK (outcome IN ('none','paused','withdrawn')),
  handled_by    uuid REFERENCES users,
  handled_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (impression_id)
);
CREATE INDEX IF NOT EXISTS ad_reports_open ON ad_reports (created_at) WHERE status = 'open';

-- ------------------------------------------------------------------ what the organiser allows on a public event page (default: no ads)
ALTER TABLE events ADD COLUMN IF NOT EXISTS public_ads boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------------ payments can be made for an ad funding
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'payments_purpose_type_check' AND conrelid = 'payments'::regclass;
  IF d IS NOT NULL AND position('ad_funding' IN d) = 0 THEN   -- widen whatever list is in force; never rewrite it, so other modules' purposes survive
    ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
    EXECUTE 'ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check ' || replace(d, '::text])', '::text, ''ad_funding''::text])');
  END IF;
END $$;

-- ------------------------------------------------------------------ append-only guards (facts and reviews can be added, never changed or removed)
CREATE OR REPLACE FUNCTION ad_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514'; END $$;
DROP TRIGGER IF EXISTS ad_delivery_events_immutable ON ad_delivery_events;
CREATE TRIGGER ad_delivery_events_immutable BEFORE UPDATE OR DELETE ON ad_delivery_events FOR EACH ROW EXECUTE FUNCTION ad_append_only();
DROP TRIGGER IF EXISTS ad_reviews_immutable ON ad_reviews;
CREATE TRIGGER ad_reviews_immutable BEFORE UPDATE OR DELETE ON ad_reviews FOR EACH ROW EXECUTE FUNCTION ad_append_only();
DROP TRIGGER IF EXISTS ad_ledger_immutable ON ad_ledger;
CREATE TRIGGER ad_ledger_immutable BEFORE UPDATE OR DELETE ON ad_ledger FOR EACH ROW EXECUTE FUNCTION ad_append_only();
DROP TRIGGER IF EXISTS ad_campaign_log_immutable ON ad_campaign_log;
CREATE TRIGGER ad_campaign_log_immutable BEFORE UPDATE OR DELETE ON ad_campaign_log FOR EACH ROW EXECUTE FUNCTION ad_append_only();
