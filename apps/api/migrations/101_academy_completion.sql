-- Academy OS 1/3 completion (#392): the remaining reuse items. Additive and backwards compatible: existing venue plans, venue invoices,
-- venue discounts and education credentials keep working untouched; each table is widened so an organisation can also own a row.
-- Nothing is dropped, rewritten or cascaded.

-- 1. Memberships / passes / subscriptions: an organisation (academy) can own a plan, and a holder's plan can belong to an enrolment.
ALTER TABLE venue_plans ALTER COLUMN venue_id DROP NOT NULL;
ALTER TABLE venue_plans ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations;
ALTER TABLE venue_plans ADD COLUMN IF NOT EXISTS currency text;           -- organisation plans carry their own currency (a venue plan uses the venue's)
ALTER TABLE venue_plans ADD COLUMN IF NOT EXISTS duration_months int CHECK (duration_months IS NULL OR duration_months BETWEEN 1 AND 120);
ALTER TABLE venue_plans DROP CONSTRAINT IF EXISTS venue_plans_check;
ALTER TABLE venue_plans ADD CONSTRAINT venue_plans_check CHECK (
  (kind = 'membership' AND duration_days IS NOT NULL AND (discount_bp IS NOT NULL OR organisation_id IS NOT NULL))
  OR (kind = 'pass' AND sessions IS NOT NULL AND session_value_cents IS NOT NULL AND valid_days IS NOT NULL));
ALTER TABLE venue_plans ADD CONSTRAINT venue_plans_owner CHECK ((venue_id IS NOT NULL AND organisation_id IS NULL) OR (venue_id IS NULL AND organisation_id IS NOT NULL AND currency IS NOT NULL));
CREATE INDEX IF NOT EXISTS venue_plans_org ON venue_plans (organisation_id) WHERE organisation_id IS NOT NULL;

ALTER TABLE user_plans ALTER COLUMN venue_id DROP NOT NULL;
ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations;
ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS enrolment_id uuid REFERENCES org_enrolments;
ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS duration_months int CHECK (duration_months IS NULL OR duration_months BETWEEN 1 AND 120);
ALTER TABLE user_plans ADD CONSTRAINT user_plans_owner CHECK ((venue_id IS NOT NULL AND organisation_id IS NULL) OR (venue_id IS NULL AND organisation_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS user_plans_enrolment ON user_plans (enrolment_id) WHERE enrolment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_plans_org ON user_plans (organisation_id, status) WHERE organisation_id IS NOT NULL;

-- a programme version that sells a pack or a monthly fee points at the plan it created; a charge points at the plan period it buys
ALTER TABLE academy_programme_versions ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES venue_plans;
ALTER TABLE academy_charges ADD COLUMN IF NOT EXISTS user_plan_id uuid REFERENCES user_plans;
CREATE INDEX IF NOT EXISTS academy_charges_plan ON academy_charges (user_plan_id) WHERE user_plan_id IS NOT NULL;

-- 2. Invoices: an academy fee is invoiced in the canonical invoices table (numbered, gapless, credit-noted), owned by an organisation.
ALTER TABLE invoices ALTER COLUMN venue_id DROP NOT NULL;
ALTER TABLE invoices ALTER COLUMN reservation_id DROP NOT NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS academy_charge_id uuid REFERENCES academy_charges;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS academy_refund_key text;
ALTER TABLE invoices ADD CONSTRAINT invoices_source CHECK (
  (venue_id IS NOT NULL AND reservation_id IS NOT NULL AND organisation_id IS NULL AND academy_charge_id IS NULL)
  OR (venue_id IS NULL AND reservation_id IS NULL AND organisation_id IS NOT NULL AND academy_charge_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS invoices_academy_live ON invoices (academy_charge_id) WHERE kind = 'invoice' AND status IN ('open','paid');
CREATE UNIQUE INDEX IF NOT EXISTS invoices_academy_refund ON invoices (academy_charge_id, academy_refund_key) WHERE academy_refund_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoices_org ON invoices (organisation_id, issued_at DESC) WHERE organisation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS org_invoice_counters (
  organisation_id uuid NOT NULL REFERENCES organisations,
  kind            text NOT NULL CHECK (kind IN ('invoice','credit_note')),
  seq             int  NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, kind)
);
ALTER TABLE academy_profiles ADD COLUMN IF NOT EXISTS invoice_prefix text CHECK (invoice_prefix IS NULL OR invoice_prefix ~ '^[A-Z0-9]{3,8}$');
ALTER TABLE academy_profiles ADD COLUMN IF NOT EXISTS tax_id text CHECK (tax_id IS NULL OR length(tax_id) <= 40);
ALTER TABLE academy_profiles ADD COLUMN IF NOT EXISTS billing_address text CHECK (billing_address IS NULL OR length(billing_address) <= 300);
CREATE UNIQUE INDEX IF NOT EXISTS academy_profiles_invoice_prefix ON academy_profiles (invoice_prefix) WHERE invoice_prefix IS NOT NULL;

-- 3. Promo codes: the discounts framework can belong to an organisation (optionally one programme); a redemption can be an enrolment.
ALTER TABLE discounts ALTER COLUMN venue_id DROP NOT NULL;
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations;
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS programme_id uuid REFERENCES academy_programmes;
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS currency text;            -- a fixed-amount promo code is in one currency (venue discounts use the venue's)
ALTER TABLE discounts ADD CONSTRAINT discounts_org_fixed_currency CHECK (organisation_id IS NULL OR kind = 'percent' OR currency IS NOT NULL);
ALTER TABLE discounts ADD CONSTRAINT discounts_owner CHECK ((venue_id IS NOT NULL AND organisation_id IS NULL AND programme_id IS NULL) OR (venue_id IS NULL AND organisation_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS discounts_org_code ON discounts (organisation_id, upper(code)) WHERE organisation_id IS NOT NULL AND code IS NOT NULL;

ALTER TABLE discount_redemptions ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE discount_redemptions DROP CONSTRAINT IF EXISTS discount_redemptions_pkey;
ALTER TABLE discount_redemptions ADD PRIMARY KEY (id);
ALTER TABLE discount_redemptions ALTER COLUMN reservation_id DROP NOT NULL;
ALTER TABLE discount_redemptions ADD COLUMN IF NOT EXISTS enrolment_id uuid REFERENCES org_enrolments;
ALTER TABLE discount_redemptions ADD CONSTRAINT discount_redemptions_target CHECK ((reservation_id IS NOT NULL AND enrolment_id IS NULL) OR (reservation_id IS NULL AND enrolment_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS discount_redemptions_reservation ON discount_redemptions (discount_id, reservation_id) WHERE reservation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS discount_redemptions_enrolment ON discount_redemptions (discount_id, enrolment_id) WHERE enrolment_id IS NOT NULL;
ALTER TABLE academy_applications ADD COLUMN IF NOT EXISTS promo_discount_id uuid REFERENCES discounts;

-- 4. Graduation certificates: the existing credentials (verification code, revocation, profile visibility) can come from an academy enrolment.
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS enrolment_id uuid REFERENCES org_enrolments;
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS academy_programme_id uuid REFERENCES academy_programmes;
CREATE UNIQUE INDEX IF NOT EXISTS credentials_enrolment_kind ON credentials (enrolment_id, kind) WHERE enrolment_id IS NOT NULL AND status = 'issued';
