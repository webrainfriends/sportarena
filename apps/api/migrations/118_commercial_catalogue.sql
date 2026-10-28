-- Commercial product catalogue & entitlement engine (#504): what can be bought, at what price, under which terms, and what limits result.
-- Additive only: new tables, no existing row changes meaning and nothing is removed.
--  * Prices and entitlements live in immutable *versions*: once published a version can only be retired, never edited. Subscriptions pin the
--    version they were bought on (grandfathering) and quotes freeze the lines they were issued with, so history never moves.
--  * Plans, prices, entitlements, add-ons, promotions and overrides are data (an admin publishes them); no screen or module tests a plan name.
--  * Usage is metered per subject/meter/period with an idempotency key, so retries and concurrent callers cannot double count or overshoot.
--  * Nothing here deletes customer data: retire / archive / revoke via status columns. Venue memberships (venue_plans/user_plans) are a different
--    thing (a venue selling to its customers) and are untouched.
-- Rollback = deploy the previous code; it ignores these tables.

CREATE TABLE commercial_products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9_]{2,40}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  family      text NOT NULL CHECK (family IN ('athlete','professional','team','club','academy','venue','event','supplier','sponsor','education','enterprise','usage','other')),
  description text CHECK (description IS NULL OR length(description) <= 500),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_by  uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A plan/offer. kind=addon plans attach to a subscription that already holds one of `requires` (plan keys).
CREATE TABLE commercial_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL REFERENCES commercial_products,
  key             text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9_]{2,60}$'),
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  kind            text NOT NULL DEFAULT 'base' CHECK (kind IN ('base','addon')),
  eligible_actors text[] NOT NULL DEFAULT '{}' CHECK (eligible_actors <@ ARRAY['user','organisation','team','venue','event']),
  requires        text[] NOT NULL DEFAULT '{}',
  is_default      boolean NOT NULL DEFAULT false,   -- the free plan a subject of an eligible actor type falls back to
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- at most one default plan per actor type
CREATE UNIQUE INDEX commercial_plans_default_user ON commercial_plans ((1)) WHERE is_default AND 'user' = ANY(eligible_actors) AND status = 'active';
CREATE UNIQUE INDEX commercial_plans_default_org ON commercial_plans ((1)) WHERE is_default AND 'organisation' = ANY(eligible_actors) AND status = 'active';
CREATE UNIQUE INDEX commercial_plans_default_team ON commercial_plans ((1)) WHERE is_default AND 'team' = ANY(eligible_actors) AND status = 'active';
CREATE UNIQUE INDEX commercial_plans_default_venue ON commercial_plans ((1)) WHERE is_default AND 'venue' = ANY(eligible_actors) AND status = 'active';
CREATE UNIQUE INDEX commercial_plans_default_event ON commercial_plans ((1)) WHERE is_default AND 'event' = ANY(eligible_actors) AND status = 'active';

-- Price + terms + entitlements of a plan for a region/currency/interval, effective from a date. Immutable once published.
CREATE TABLE commercial_price_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id          uuid NOT NULL REFERENCES commercial_plans,
  version          integer NOT NULL CHECK (version >= 1),
  region           text NOT NULL DEFAULT 'IN' CHECK (region ~ '^[A-Z]{2}$|^\*$'),
  currency         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  billing_interval text NOT NULL CHECK (billing_interval IN ('one_time','monthly','annual','per_event','usage')),
  amount_minor     bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  -- priced components: fixed / per_unit (seat, team, location, event, athlete) / band (active-athlete bands) / percent_fee (bp + cap) / usage (per meter)
  components       jsonb NOT NULL DEFAULT '[]',
  tax_bp           integer NOT NULL DEFAULT 0 CHECK (tax_bp BETWEEN 0 AND 10000),
  tax_ref          text CHECK (tax_ref IS NULL OR length(tax_ref) <= 60),
  trial_days       integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),
  proration_policy text NOT NULL DEFAULT 'none' CHECK (proration_policy IN ('none','prorate','credit','at_period_end')),
  effective_from   date NOT NULL,
  effective_to     date,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  published_at     timestamptz,
  published_by     uuid REFERENCES users,
  created_by       uuid REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, region, currency, billing_interval, version),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX commercial_price_versions_plan ON commercial_price_versions (plan_id, status, effective_from);

-- Usage meters. counter = consumed over a period (AI credits, API calls, storage, messages); gauge = an authoritative live count supplied by the platform.
CREATE TABLE commercial_meters (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z0-9_]{2,40}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  unit        text NOT NULL CHECK (length(unit) BETWEEN 1 AND 24),
  mode        text NOT NULL DEFAULT 'counter' CHECK (mode IN ('counter','gauge')),
  period      text NOT NULL DEFAULT 'month' CHECK (period IN ('month','year','lifetime')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Entitlements granted by a price version (boolean feature or quantitative limit; NULL limit = unlimited).
CREATE TABLE commercial_version_entitlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id       uuid NOT NULL REFERENCES commercial_price_versions,
  key              text NOT NULL CHECK (key ~ '^[a-z0-9_.]{2,60}$'),
  limit_value      numeric CHECK (limit_value IS NULL OR limit_value >= 0),
  limit_behaviour  text NOT NULL DEFAULT 'hard' CHECK (limit_behaviour IN ('warn','soft','hard')),
  warn_at_pct      integer NOT NULL DEFAULT 80 CHECK (warn_at_pct BETWEEN 1 AND 100),
  UNIQUE (version_id, key)
);

-- A price point = one sellable price slot (plan + billing interval + currency + region), written <plan_key>:<interval>:<currency>:<region>.
-- Versions of a slot share its code, so an offer attached to a price point keeps applying after a re-price. An offer with no active row is
-- open to every price point. Rows are never deleted: detaching sets removed_at.
CREATE TABLE commercial_promotions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9_]{2,60}$'),
  name           text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  kind           text NOT NULL CHECK (kind IN ('trial','launch_offer','first_term_discount','coupon')),
  coupon_ref     text CHECK (coupon_ref IS NULL OR length(coupon_ref) <= 60),
  trial_days     integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),
  -- what the offer gives: N free months, a percentage off, or a flat amount off, for `duration_months` (all price points when plan_id is NULL)
  benefit        text NOT NULL DEFAULT 'none' CHECK (benefit IN ('none','free_months','percent_off','flat_off')),
  free_months    integer NOT NULL DEFAULT 0 CHECK (free_months BETWEEN 0 AND 60),
  discount_bp    integer NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
  flat_off_minor bigint NOT NULL DEFAULT 0 CHECK (flat_off_minor >= 0),
  flat_currency  text CHECK (flat_currency IS NULL OR flat_currency ~ '^[A-Z]{3}$'),
  duration_months integer NOT NULL DEFAULT 1 CHECK (duration_months BETWEEN 1 AND 60),
  CHECK (benefit <> 'flat_off' OR (flat_off_minor > 0 AND flat_currency IS NOT NULL)),
  CHECK (benefit <> 'free_months' OR free_months > 0),
  CHECK (benefit <> 'percent_off' OR discount_bp > 0),
  grants         jsonb NOT NULL DEFAULT '[]',              -- extra entitlements while active: [{key, limit_value|null}]
  starts_on      date NOT NULL,
  ends_on        date,
  max_redemptions integer CHECK (max_redemptions IS NULL OR max_redemptions >= 1),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  created_by     uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commercial_promotion_price_points (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id     uuid NOT NULL REFERENCES commercial_promotions,
  price_point_code text NOT NULL CHECK (price_point_code ~ '^(bundle\.)?[a-z0-9_]{2,60}:[a-z_]+:[A-Z]{3}:([A-Z]{2}|\*)$'),
  added_by         uuid REFERENCES users,
  added_at         timestamptz NOT NULL DEFAULT now(),
  removed_at       timestamptz
);
CREATE UNIQUE INDEX commercial_promotion_price_points_live ON commercial_promotion_price_points (promotion_id, price_point_code) WHERE removed_at IS NULL;

-- Who a subscription / usage / override belongs to. Enterprise hierarchy: a child subject inherits what its parent resolves to.
CREATE TABLE commercial_subject_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_type   text NOT NULL CHECK (child_type IN ('user','organisation','team','venue','event')),
  child_id     uuid NOT NULL,
  parent_type  text NOT NULL CHECK (parent_type IN ('organisation','user')),
  parent_id    uuid NOT NULL,
  ended_at     timestamptz,
  created_by   uuid REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (child_type = parent_type AND child_id = parent_id))
);
CREATE UNIQUE INDEX commercial_subject_links_live ON commercial_subject_links (child_type, child_id) WHERE ended_at IS NULL;

CREATE TABLE commercial_subscriptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type        text NOT NULL CHECK (subject_type IN ('user','organisation','team','venue','event')),
  subject_id          uuid NOT NULL,
  plan_id             uuid NOT NULL REFERENCES commercial_plans,
  product_id          uuid NOT NULL REFERENCES commercial_products,           -- the profile family (athlete, coach, organiser…): one live base plan per family
  kind                text NOT NULL CHECK (kind IN ('base','addon')),
  version_id          uuid NOT NULL REFERENCES commercial_price_versions,   -- pinned: the version bought (grandfathering)
  promotion_id        uuid REFERENCES commercial_promotions,
  status              text NOT NULL CHECK (status IN ('pending_payment','trial','active','scheduled','cancelled','ended')),
  quantities          jsonb NOT NULL DEFAULT '{}',                           -- seats / teams / locations / athletes bought
  started_at          timestamptz,
  current_period_start timestamptz,
  current_period_end  timestamptz,
  trial_ends_at       timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  non_renewing        boolean NOT NULL DEFAULT false,
  scheduled_version_id uuid REFERENCES commercial_price_versions,            -- upgrade / downgrade / re-price taking effect at scheduled_for
  scheduled_for       timestamptz,
  quote_id            uuid,
  bundle_version_id   uuid,                  -- set when bought as part of a bundle: all members share bundle_group and are cancelled together
  bundle_group        uuid,
  allocated_minor     bigint,                -- this member's share of the bundle price per term
  promotion_terms_total integer NOT NULL DEFAULT 0,   -- billing terms the offer covers (first N terms priced with the offer)
  promotion_terms_used  integer NOT NULL DEFAULT 0,   -- terms already billed with it; the renewal engine prices term (used+1) from the pinned offer
  created_by          uuid REFERENCES users,
  created_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz
);
-- one live base plan per subject; add-ons may be several (one per plan)
CREATE UNIQUE INDEX commercial_subscriptions_base ON commercial_subscriptions (subject_type, subject_id, product_id) WHERE kind = 'base' AND status IN ('pending_payment','trial','active','scheduled');
CREATE UNIQUE INDEX commercial_subscriptions_addon ON commercial_subscriptions (subject_type, subject_id, plan_id) WHERE kind = 'addon' AND status IN ('pending_payment','trial','active','scheduled');
CREATE INDEX commercial_subscriptions_subject ON commercial_subscriptions (subject_type, subject_id, status);

-- Contract / enterprise overrides (set = replace the resolved value, add = add to it).
CREATE TABLE commercial_overrides (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope        text NOT NULL CHECK (scope IN ('contract','enterprise')),
  subject_type text NOT NULL CHECK (subject_type IN ('user','organisation','team','venue','event')),
  subject_id   uuid NOT NULL,
  key          text NOT NULL CHECK (key ~ '^[a-z0-9_.]{2,60}$'),
  mode         text NOT NULL DEFAULT 'set' CHECK (mode IN ('set','add')),
  enabled      boolean NOT NULL DEFAULT true,
  limit_value  numeric CHECK (limit_value IS NULL OR limit_value >= 0),
  limit_behaviour text CHECK (limit_behaviour IN ('warn','soft','hard')),
  reason       text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  starts_on    date NOT NULL DEFAULT current_date,
  ends_on      date,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by   uuid REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX commercial_overrides_subject ON commercial_overrides (subject_type, subject_id, status);

CREATE TABLE commercial_usage (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL,
  subject_id   uuid NOT NULL,
  meter_key    text NOT NULL REFERENCES commercial_meters,
  period_start date NOT NULL,
  used         numeric NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id, meter_key, period_start)
);

-- Append-only; the idempotency key makes a retried call count once.
CREATE TABLE commercial_usage_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type    text NOT NULL,
  subject_id      uuid NOT NULL,
  meter_key       text NOT NULL REFERENCES commercial_meters,
  period_start    date NOT NULL,
  quantity        numeric NOT NULL CHECK (quantity > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  used_after      numeric NOT NULL,
  over_limit      boolean NOT NULL DEFAULT false,
  actor_id        uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id, idempotency_key)
);

-- Bundles: several price points of the same person (their different profiles: athlete, coach, organiser…) sold together at one bundle price.
-- A bundle names its members (price point codes, all in the bundle's billing interval / currency / region); its price is versioned like any other.
-- Its own price-point code is bundle.<key>:<interval>:<currency>:<region>, so offers attach to bundles exactly as they attach to plan price points.
CREATE TABLE commercial_bundles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key              text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9_]{2,40}$'),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  description      text CHECK (description IS NULL OR length(description) <= 500),
  eligible_actors  text[] NOT NULL DEFAULT '{user}' CHECK (eligible_actors <@ ARRAY['user','organisation','team','venue','event']),
  region           text NOT NULL DEFAULT 'IN' CHECK (region ~ '^[A-Z]{2}$|^\*$'),
  currency         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  billing_interval text NOT NULL CHECK (billing_interval IN ('monthly','annual')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_by       uuid REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE commercial_bundle_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id        uuid NOT NULL REFERENCES commercial_bundles,
  price_point_code text NOT NULL CHECK (price_point_code ~ '^[a-z0-9_]{2,60}:[a-z_]+:[A-Z]{3}:([A-Z]{2}|\*)$'),
  UNIQUE (bundle_id, price_point_code)
);
CREATE TABLE commercial_bundle_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id       uuid NOT NULL REFERENCES commercial_bundles,
  version         integer NOT NULL CHECK (version >= 1),
  price_mode      text NOT NULL CHECK (price_mode IN ('fixed','percent_off','flat_off')),   -- fixed total · % off the members' list prices · flat amount off them
  amount_minor    bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),                     -- fixed: the bundle price · flat_off: the amount taken off
  discount_bp     integer NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
  tax_bp          integer NOT NULL DEFAULT 0 CHECK (tax_bp BETWEEN 0 AND 10000),
  effective_from  date NOT NULL,
  effective_to    date,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  published_at    timestamptz,
  published_by    uuid REFERENCES users,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bundle_id, version),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (price_mode <> 'percent_off' OR discount_bp > 0),
  CHECK (price_mode <> 'flat_off' OR amount_minor > 0)
);
CREATE INDEX commercial_bundle_versions_bundle ON commercial_bundle_versions (bundle_id, status, effective_from);

-- A frozen, authoritative quote. Payments (#498) take the quote, never recompute prices from the client.
CREATE TABLE commercial_quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_no      text NOT NULL UNIQUE,
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,
  requested_by  uuid NOT NULL REFERENCES users,
  currency      text NOT NULL,
  lines         jsonb NOT NULL,
  subtotal_minor bigint NOT NULL,
  discount_minor bigint NOT NULL DEFAULT 0,
  tax_minor     bigint NOT NULL,
  total_minor   bigint NOT NULL,
  version_ids   uuid[] NOT NULL,
  promotion_id  uuid,
  inputs        jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','accepted','expired','void')),
  expires_at    timestamptz NOT NULL,
  digest        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE commercial_subscriptions ADD CONSTRAINT commercial_subscriptions_quote FOREIGN KEY (quote_id) REFERENCES commercial_quotes;

CREATE TABLE commercial_audit (
  id         bigserial PRIMARY KEY,
  actor_id   uuid REFERENCES users,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  uuid,
  detail     jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commercial_audit_at ON commercial_audit (at DESC);

-- ---------------------------------------------------------------- immutability
-- A published version is frozen: only status -> retired and effective_to may change, and it can never be removed.
CREATE FUNCTION commercial_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'A published price version cannot be deleted (retire it instead)' USING ERRCODE = '23000'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    IF OLD.status = 'retired' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'A retired price version cannot be changed' USING ERRCODE = '23000'; END IF;
    IF (NEW.plan_id, NEW.version, NEW.region, NEW.currency, NEW.billing_interval, NEW.amount_minor, NEW.components, NEW.tax_bp, NEW.tax_ref, NEW.trial_days, NEW.proration_policy, NEW.effective_from, NEW.published_at)
       IS DISTINCT FROM (OLD.plan_id, OLD.version, OLD.region, OLD.currency, OLD.billing_interval, OLD.amount_minor, OLD.components, OLD.tax_bp, OLD.tax_ref, OLD.trial_days, OLD.proration_policy, OLD.effective_from, OLD.published_at) THEN
      RAISE EXCEPTION 'A published price version is immutable (publish a new version instead)' USING ERRCODE = '23000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_price_versions_guard BEFORE UPDATE OR DELETE ON commercial_price_versions FOR EACH ROW EXECUTE FUNCTION commercial_version_guard();

CREATE FUNCTION commercial_bundle_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'A published bundle price cannot be deleted (retire it instead)' USING ERRCODE = '23000'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    IF OLD.status = 'retired' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'A retired bundle price cannot be changed' USING ERRCODE = '23000'; END IF;
    IF (NEW.bundle_id, NEW.version, NEW.price_mode, NEW.amount_minor, NEW.discount_bp, NEW.tax_bp, NEW.effective_from, NEW.published_at)
       IS DISTINCT FROM (OLD.bundle_id, OLD.version, OLD.price_mode, OLD.amount_minor, OLD.discount_bp, OLD.tax_bp, OLD.effective_from, OLD.published_at) THEN
      RAISE EXCEPTION 'A published bundle price is immutable (publish a new version instead)' USING ERRCODE = '23000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_bundle_versions_guard BEFORE UPDATE OR DELETE ON commercial_bundle_versions FOR EACH ROW EXECUTE FUNCTION commercial_bundle_version_guard();

CREATE FUNCTION commercial_entitlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v uuid; s text;
BEGIN
  v := CASE WHEN TG_OP = 'INSERT' THEN NEW.version_id ELSE OLD.version_id END;
  SELECT status INTO s FROM commercial_price_versions WHERE id = v;
  IF s IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Entitlements of a published version are immutable' USING ERRCODE = '23000'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER commercial_version_entitlements_guard BEFORE INSERT OR UPDATE OR DELETE ON commercial_version_entitlements FOR EACH ROW EXECUTE FUNCTION commercial_entitlement_guard();

-- Quotes keep their numbers and never disappear; subscriptions are ended, never removed (the pinned version only changes through a scheduled change in the capability).
CREATE FUNCTION commercial_quote_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Quotes are never deleted' USING ERRCODE = '23000'; END IF;
  IF (NEW.quote_no, NEW.subject_type, NEW.subject_id, NEW.currency, NEW.lines, NEW.subtotal_minor, NEW.discount_minor, NEW.tax_minor, NEW.total_minor, NEW.version_ids, NEW.digest, NEW.expires_at)
     IS DISTINCT FROM (OLD.quote_no, OLD.subject_type, OLD.subject_id, OLD.currency, OLD.lines, OLD.subtotal_minor, OLD.discount_minor, OLD.tax_minor, OLD.total_minor, OLD.version_ids, OLD.digest, OLD.expires_at) THEN
    RAISE EXCEPTION 'An issued quote is frozen' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_quotes_guard BEFORE UPDATE OR DELETE ON commercial_quotes FOR EACH ROW EXECUTE FUNCTION commercial_quote_guard();

CREATE FUNCTION commercial_subscription_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Subscriptions are never deleted (end them)' USING ERRCODE = '23000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_subscriptions_guard BEFORE UPDATE OR DELETE ON commercial_subscriptions FOR EACH ROW EXECUTE FUNCTION commercial_subscription_guard();

CREATE FUNCTION commercial_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23000'; END $$;
CREATE TRIGGER commercial_audit_append BEFORE UPDATE OR DELETE ON commercial_audit FOR EACH ROW EXECUTE FUNCTION commercial_append_only();
CREATE TRIGGER commercial_usage_events_append BEFORE UPDATE OR DELETE ON commercial_usage_events FOR EACH ROW EXECUTE FUNCTION commercial_append_only();

-- The standard meters (data, so the admin can add more): counters over a period and live gauges.
INSERT INTO commercial_meters (key, name, unit, mode, period) VALUES
  ('ai_credits',      'AI credits',            'credit',  'counter', 'month'),
  ('api_calls',       'API calls',             'call',    'counter', 'month'),
  ('mcp_calls',       'MCP tool calls',        'call',    'counter', 'month'),
  ('storage_mb',      'Storage & media',       'MB',      'counter', 'lifetime'),
  ('messages',        'Paid messages (WhatsApp/SMS)', 'message', 'counter', 'month'),
  ('staff_seats',     'Staff seats',           'seat',    'gauge',   'lifetime'),
  ('active_athletes', 'Active athletes',       'athlete', 'gauge',   'lifetime'),
  ('teams',           'Teams',                 'team',    'gauge',   'lifetime'),
  ('locations',       'Locations',             'location','gauge',   'lifetime'),
  ('verifications',   'Verifications',         'check',   'counter', 'year')
ON CONFLICT DO NOTHING;
