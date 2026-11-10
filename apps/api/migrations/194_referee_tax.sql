-- Referee taxation settings and reports (#1020 R39).
-- Country-aware tax profile, effective-dated rates, generated tax invoices/credit notes
-- and periodic statements for match officials. Additive only: nothing is dropped or narrowed.
-- Reuses official_profiles, fixture_officials, payout_items, payout_batches, users.

-- ---- Referee tax profile --------------------------------------------------
-- One live profile per referee (official). Payee can be individual or company.
-- All tax-identifying numbers are field-encrypted. Each save creates a new
-- effective-dated version; old versions are kept for audit.
CREATE TABLE IF NOT EXISTS official_tax_profiles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id),
  payee_type            text NOT NULL DEFAULT 'individual' CHECK (payee_type IN ('individual','company')),
  legal_name            text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 160),
  tax_country           char(2) NOT NULL CHECK (tax_country ~ '^[A-Z]{2}$'),
  tax_regime            text NOT NULL DEFAULT 'none' CHECK (tax_regime IN ('none','gst','vat','sales_tax','hst','consumption_tax')),
  registration_status   text NOT NULL DEFAULT 'not_registered' CHECK (registration_status IN ('registered','not_registered','pending','exempt')),
  registration_id_enc   text,                        -- encrypted GST/VAT/tax number
  business_name_enc     text,                        -- company name (company payee only), encrypted
  business_reg_enc      text,                        -- company registration / ABN / CIN, encrypted
  price_display         text NOT NULL DEFAULT 'inclusive' CHECK (price_display IN ('inclusive','exclusive')),
  withholding_applicable boolean NOT NULL DEFAULT false,
  withholding_rate_bp   int CHECK (withholding_rate_bp IS NULL OR withholding_rate_bp BETWEEN 0 AND 10000),
  threshold_annual_minor bigint,                     -- annual threshold above which registration is required (jurisdiction-specific)
  threshold_currency    char(3) CHECK (threshold_currency IS NULL OR threshold_currency ~ '^[A-Z]{3}$'),
  notes_enc             text,                        -- private notes (encrypted)
  effective_from        timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT official_tax_profiles_user_effective UNIQUE (user_id, effective_from)
);
CREATE INDEX IF NOT EXISTS official_tax_profiles_user ON official_tax_profiles(user_id, effective_from DESC);

-- ---- Tax rates (effective-dated, per official) ----------------------------
-- Append-only. Each entry records the rate that applies from a date and the
-- official notice / source document the official relied on.
CREATE TABLE IF NOT EXISTS official_tax_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  tax_class       text NOT NULL DEFAULT 'standard' CHECK (tax_class IN ('standard','zero_rated','exempt','out_of_scope','reverse_charge','reduced')),
  rate_bp         int NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),  -- basis points (900 = 9%)
  source          text NOT NULL CHECK (length(source) BETWEEN 5 AND 500),
  effective_from  timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS official_tax_rates_user ON official_tax_rates(user_id, tax_class, effective_from DESC);

-- ---- Tax invoices and credit notes ----------------------------------------
CREATE SEQUENCE IF NOT EXISTS official_tax_invoice_seq START 1;

CREATE TABLE IF NOT EXISTS official_tax_invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id),
  invoice_no          text NOT NULL UNIQUE,          -- ORI-{year}-{seq:05}
  kind                text NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice','credit_note')),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  currency            char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  period_from         date NOT NULL,
  period_to           date NOT NULL,
  gross_minor         bigint NOT NULL DEFAULT 0,
  tax_minor           bigint NOT NULL DEFAULT 0,
  withholding_minor   bigint NOT NULL DEFAULT 0,
  net_minor           bigint NOT NULL DEFAULT 0,
  tax_country         char(2) NOT NULL,
  tax_regime          text NOT NULL,
  rate_bp             int NOT NULL DEFAULT 0,
  payee_type          text NOT NULL DEFAULT 'individual',
  legal_name          text NOT NULL,
  registration_id_enc text,
  parent_id           uuid REFERENCES official_tax_invoices(id), -- credit note parent
  paid_at             timestamptz,
  paid_note           text,
  voided_at           timestamptz,
  void_reason         text,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS official_tax_invoices_user ON official_tax_invoices(user_id, issued_at DESC);

-- ---- Invoice lines --------------------------------------------------------
CREATE TABLE IF NOT EXISTS official_tax_invoice_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id          uuid NOT NULL REFERENCES official_tax_invoices(id),
  fixture_official_id uuid REFERENCES fixture_officials(id),
  description         text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  event_name          text,
  fixture_date        date,
  role                text,
  tax_class           text NOT NULL DEFAULT 'standard',
  unit_minor          bigint NOT NULL DEFAULT 0,     -- fee for this fixture (minor units)
  tax_minor           bigint NOT NULL DEFAULT 0,     -- tax on this line
  net_minor           bigint NOT NULL DEFAULT 0,     -- net = unit - tax (inclusive) or unit (exclusive)
  sort_order          int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS official_tax_invoice_lines_inv ON official_tax_invoice_lines(invoice_id, sort_order);

-- ---- Audit log for tax profile reads/writes --------------------------------
CREATE TABLE IF NOT EXISTS official_tax_audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  actor_id    uuid NOT NULL REFERENCES users(id),
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   uuid,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS official_tax_audit_user ON official_tax_audit_log(user_id, at DESC);

-- ---- Platform jurisdiction policies ---------------------------------------
-- Platform-managed reference table: known tax regimes, threshold rules, withholding rates.
-- Not editable by referees. Used as a hint/guide only; the official always records their own rate.
CREATE TABLE IF NOT EXISTS tax_jurisdiction_policies (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code         char(2) NOT NULL,
  tax_regime           text NOT NULL,
  display_name         text NOT NULL,
  standard_rate_bp     int NOT NULL DEFAULT 0,
  reduced_rate_bp      int,
  registration_threshold_annual_local bigint,
  threshold_currency   char(3),
  withholding_rate_bp  int NOT NULL DEFAULT 0,
  withholding_note     text,
  source_url           text,
  source_citation      text,
  effective_from       date NOT NULL,
  retired_at           date,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country_code, tax_regime, effective_from)
);
CREATE INDEX IF NOT EXISTS tax_jurisdiction_policies_cc ON tax_jurisdiction_policies(country_code, retired_at NULLS LAST);

-- Seed the policies platform uses as reference (not authoritative; officials set their own).
INSERT INTO tax_jurisdiction_policies (country_code, tax_regime, display_name, standard_rate_bp, registration_threshold_annual_local, threshold_currency, withholding_rate_bp, source_citation, effective_from)
VALUES
  ('SG','gst','Singapore GST',900,100000,'SGD',0,'IRAS circular, effective 1 Jan 2024','2024-01-01'),
  ('GB','vat','United Kingdom VAT',2000,85000,'GBP',0,'HMRC Notice 700, 2024','2024-04-06'),
  ('AU','gst','Australia GST',1000,75000,'AUD',0,'ATO GST guide 2024','2023-07-01'),
  ('NZ','gst','New Zealand GST',1500,60000,'NZD',0,'IR375 2024','2023-04-01'),
  ('IN','gst','India GST',1800,2000000,'INR',0,'CBIC circular 2023','2023-10-01'),
  ('DE','vat','Germany VAT',1900,22000,'EUR',0,'UStG §1 2024','2023-01-01'),
  ('FR','vat','France VAT',2000,34400,'EUR',0,'CGI art. 293B 2024','2023-01-01'),
  ('CA','hst','Canada HST/GST',1500,30000,'CAD',0,'CRA RC4022 2024','2023-01-01'),
  ('LK','vat','Sri Lanka VAT',1800,120000000,'LKR',0,'IRD Notice 2024','2024-01-01'),
  ('US','sales_tax','United States (sales tax varies by state)',0,NULL,NULL,0,'IRS Publication 15-B; state laws vary','2023-01-01')
ON CONFLICT (country_code, tax_regime, effective_from) DO NOTHING;
