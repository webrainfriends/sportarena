-- Insurance: insurer profiles, normalised plan terms for search/comparison, a purchase-time snapshot of the terms on each
-- policy, and a reviewed claim lifecycle with an append-only history. Everything is additive: the free-text `insurer`
-- column and all existing plans, policies and claims stay exactly as they are (and are backfilled below).
CREATE TABLE insurers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  description  text,
  website      text,
  licence_no_enc text,                       -- regulator licence number (encrypted)
  verified_at  timestamptz,                  -- set by the platform team after checking the licence
  verified_by  uuid REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX insurers_name_ci ON insurers (lower(name));

ALTER TABLE insurance_plans
  ADD COLUMN insurer_id          uuid REFERENCES insurers,
  ADD COLUMN status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  ADD COLUMN currency            text,                                  -- NULL = the platform payment currency
  ADD COLUMN sports              text[] NOT NULL DEFAULT '{}',          -- sport slugs covered; empty = all sports
  ADD COLUMN min_age             int CHECK (min_age >= 0),
  ADD COLUMN max_age             int CHECK (max_age >= 0),
  ADD COLUMN term_months_min     int NOT NULL DEFAULT 1 CHECK (term_months_min >= 1),
  ADD COLUMN term_months_max     int NOT NULL DEFAULT 36 CHECK (term_months_max >= 1),
  ADD COLUMN waiting_period_days int NOT NULL DEFAULT 0 CHECK (waiting_period_days >= 0),
  ADD COLUMN deductible_cents    bigint NOT NULL DEFAULT 0 CHECK (deductible_cents >= 0),
  ADD COLUMN exclusions          text,                                  -- what is NOT covered (always shown to buyers)
  ADD COLUMN conditions          text,                                  -- other important conditions
  ADD COLUMN updated_at          timestamptz NOT NULL DEFAULT now();
CREATE INDEX insurance_plans_search ON insurance_plans (status, cover_for, premium_cents);

-- one insurer row per distinct existing free-text name, then link the plans (the old text column is kept)
INSERT INTO insurers(name) SELECT DISTINCT ON (lower(insurer)) insurer FROM insurance_plans ORDER BY lower(insurer), insurer;
UPDATE insurance_plans p SET insurer_id = i.id FROM insurers i WHERE lower(i.name) = lower(p.insurer);

-- the terms a policy was bought on; editing or retiring a plan never changes cover already sold
ALTER TABLE insurance_policies ADD COLUMN terms jsonb;
UPDATE insurance_policies p SET terms = jsonb_build_object(
  'plan_name', pl.name, 'insurer', pl.insurer, 'premium_cents', pl.premium_cents, 'coverage_cents', pl.coverage_cents,
  'deductible_cents', pl.deductible_cents, 'waiting_period_days', pl.waiting_period_days, 'exclusions', pl.exclusions, 'conditions', pl.conditions)
  FROM insurance_plans pl WHERE pl.id = p.plan_id;

ALTER TABLE insurance_claims
  ADD COLUMN incident_on     date,
  ADD COLUMN reviewer_id     uuid REFERENCES users,
  ADD COLUMN decision_reason text,
  ADD COLUMN decided_at      timestamptz,
  ADD COLUMN updated_at      timestamptz NOT NULL DEFAULT now();

CREATE TABLE insurance_claim_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id    uuid NOT NULL REFERENCES insurance_claims,
  actor_id    uuid NOT NULL REFERENCES users,
  action      text NOT NULL,
  from_status text,
  to_status   text,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX insurance_claim_events_claim ON insurance_claim_events (claim_id, created_at);
CREATE FUNCTION insurance_claim_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'insurance_claim_events is append-only'; END $$;
CREATE TRIGGER insurance_claim_events_append_only BEFORE UPDATE OR DELETE ON insurance_claim_events FOR EACH ROW EXECUTE FUNCTION insurance_claim_events_guard();
