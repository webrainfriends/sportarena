-- Sports Services & Opportunity Marketplace (#600). One reusable framework for the whole lifecycle
-- discover -> verify -> shortlist -> communicate -> quote/apply -> negotiate -> contract -> schedule -> deliver -> invoice/pay -> review.
-- A listing points at the canonical identity (users / organisations); it never copies a provider. Money goes through the canonical
-- payments + provider ledger (purpose 'marketplace_engagement'), reviews through testimonials (#215), credentials through verification_cases.
-- Additive only: nothing is dropped or rewritten, no ON DELETE CASCADE on user data, rows are archived, never deleted.

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family          text NOT NULL,                                    -- provider category, validated against src/marketplace/families.js
  provider_id     uuid NOT NULL REFERENCES users,                   -- the account that acts (and is paid)
  organisation_id uuid REFERENCES organisations,                    -- set when the provider is an organisation (club, venue, media company ...)
  headline        text NOT NULL CHECK (char_length(headline) BETWEEN 3 AND 120),
  summary         text CHECK (char_length(summary) <= 1000),        -- public marketing text; no personal data
  sport_ids       uuid[] NOT NULL DEFAULT '{}',
  city            text,
  country         text,
  remote_ok       boolean NOT NULL DEFAULT false,
  currency        text NOT NULL DEFAULT 'INR',
  rate_min_minor  bigint CHECK (rate_min_minor >= 0),
  rate_max_minor  bigint CHECK (rate_max_minor >= 0),
  rate_unit       text CHECK (rate_unit IN ('hour','session','day','match','project','month')),
  accepting       boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  source_type     text CHECK (source_type IN ('provider_profile','svc_profile','coach_profile','legal_profile')),   -- existing richer record this listing fronts
  source_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CHECK (rate_max_minor IS NULL OR rate_min_minor IS NULL OR rate_max_minor >= rate_min_minor)
);
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_listing_one ON marketplace_listings (provider_id, family, coalesce(organisation_id, '00000000-0000-0000-0000-000000000000')) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS marketplace_listing_search ON marketplace_listings (family, status, city);

CREATE TABLE IF NOT EXISTS marketplace_shortlist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users,
  listing_id  uuid NOT NULL REFERENCES marketplace_listings,
  note        text CHECK (char_length(note) <= 300),
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_shortlist_one ON marketplace_shortlist (user_id, listing_id) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS marketplace_engagements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             bigint GENERATED ALWAYS AS IDENTITY,
  listing_id         uuid REFERENCES marketplace_listings,
  family             text NOT NULL,
  buyer_id           uuid NOT NULL REFERENCES users,
  buyer_org_id       uuid REFERENCES organisations,
  provider_id        uuid NOT NULL REFERENCES users,
  provider_org_id    uuid REFERENCES organisations,
  title              text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 140),
  sport_id           uuid REFERENCES sports,
  brief_enc          text,                                          -- what the buyer needs (free text, encrypted)
  budget_minor       bigint CHECK (budget_minor >= 0),
  currency           text NOT NULL DEFAULT 'INR',
  status             text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','quoted','negotiating','contracted','scheduled','delivered','invoiced','paid','reviewed','declined','cancelled')),
  origin_type        text CHECK (origin_type IN ('listing','opportunity_response')),
  origin_id          uuid,
  agreed_minor       bigint CHECK (agreed_minor >= 0),
  accepted_quote_id  uuid,
  contract_number    text,
  terms_json         jsonb,                                         -- immutable snapshot of what was agreed
  terms_sha256       text,
  contracted_at      timestamptz,
  starts_at          timestamptz,
  ends_at            timestamptz,
  timezone           text NOT NULL DEFAULT 'UTC',
  delivered_at       timestamptz,
  delivery_note_enc  text,
  delivery_accepted_at timestamptz,
  invoice_number     text,
  invoiced_at        timestamptz,
  paid_at            timestamptz,
  reviewed_at        timestamptz,
  testimonial_id     uuid REFERENCES testimonials,
  closed_reason      text,
  closed_by          uuid REFERENCES users,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_id <> provider_id),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS marketplace_eng_buyer ON marketplace_engagements (buyer_id, status);
CREATE INDEX IF NOT EXISTS marketplace_eng_provider ON marketplace_engagements (provider_id, status);
CREATE INDEX IF NOT EXISTS marketplace_eng_busy ON marketplace_engagements (provider_id, starts_at) WHERE status IN ('contracted','scheduled');
-- one live engagement per buyer and listing keeps requests from being spammed
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_eng_one_open ON marketplace_engagements (buyer_id, listing_id) WHERE listing_id IS NOT NULL AND status IN ('requested','quoted','negotiating');
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_eng_one_origin ON marketplace_engagements (origin_type, origin_id) WHERE origin_id IS NOT NULL AND origin_type = 'opportunity_response';

CREATE TABLE IF NOT EXISTS marketplace_quotes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id  uuid NOT NULL REFERENCES marketplace_engagements,
  version        int NOT NULL,
  by_id          uuid NOT NULL REFERENCES users,
  side           text NOT NULL CHECK (side IN ('buyer','provider')),
  amount_minor   bigint NOT NULL CHECK (amount_minor >= 0),
  currency       text NOT NULL,
  valid_until    date,
  terms_enc      text,                                              -- scope, deliverables, conditions (encrypted)
  status         text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','accepted','declined','superseded','expired')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  responded_at   timestamptz,
  UNIQUE (engagement_id, version)
);

CREATE TABLE IF NOT EXISTS marketplace_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id  uuid NOT NULL REFERENCES marketplace_engagements,
  sender_id      uuid NOT NULL REFERENCES users,
  body_enc       text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketplace_messages_thread ON marketplace_messages (engagement_id, created_at);

CREATE TABLE IF NOT EXISTS marketplace_events (                     -- the engagement timeline; also the audit trail of who did what
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id  uuid NOT NULL REFERENCES marketplace_engagements,
  actor_id       uuid REFERENCES users,
  kind           text NOT NULL,
  detail         jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketplace_events_eng ON marketplace_events (engagement_id, created_at);

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_purpose_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check CHECK (purpose_type IN ('shop_order','coach_hire','insurance_policy','venue_invoice','wallet_topup','gift_card','venue_plan','appointment','shop_checkout','physio_package','sponsorship_payment','academy_charge','service_invoice','media_rights_fee','pos_sale','team_charge','team_contribution','ad_funding','marketplace_engagement'));
