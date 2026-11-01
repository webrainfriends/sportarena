-- Integration access (#597): an external integration is a paid, per-customer arrangement run as a small IT integration cycle.
-- The requester describes it; the platform team reviews, may ask for more, quotes a price; the requester accepts the price; if something
-- must be built it stays a DRAFT until the platform team deploys it; then it is enabled for that organisation (or event) only.
-- Additive only: nothing is deleted; every stage change is a status change plus a timeline row. Contact details are encrypted.
CREATE TABLE IF NOT EXISTS integration_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  scope_type text NOT NULL DEFAULT 'organisation' CHECK (scope_type IN ('organisation','event')),
  event_id uuid REFERENCES events(id),
  provider_key text,                       -- catalogue adapter, or NULL for a custom integration until the platform team deploys one
  integration_name text NOT NULL CHECK (length(integration_name) BETWEEN 2 AND 120),
  integration_url text,
  mode text NOT NULL CHECK (mode IN ('api_pull','api_push','webhook_in','webhook_out','file_transfer','sso','embed','other')),
  security text[] NOT NULL DEFAULT '{}',
  personal_data boolean NOT NULL DEFAULT false,
  monthly_volume integer CHECK (monthly_volume IS NULL OR monthly_volume >= 0),
  peak_per_minute integer CHECK (peak_per_minute IS NULL OR peak_per_minute >= 0),
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 3 AND 1000),
  starts_on date,
  ends_on date,
  contact_is_requester boolean NOT NULL DEFAULT true,
  contact_name text,
  contact_email_enc text,
  contact_phone_enc text,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','needs_info','quoted','accepted','in_development','enabled','declined','withdrawn','revoked')),
  needs_development boolean NOT NULL DEFAULT false,
  pricing_mode text CHECK (pricing_mode IN ('special','waived')),
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  currency text,
  billing text CHECK (billing IN ('one_time','monthly','annual')),
  quote_valid_until date,
  override_id uuid REFERENCES commercial_overrides(id),
  requested_by uuid REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_type = 'event') = (event_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS integration_access_open ON integration_access_requests(organisation_id, lower(coalesce(provider_key, integration_name)), coalesce(event_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('submitted','needs_info','quoted','accepted','in_development','enabled');
CREATE INDEX IF NOT EXISTS integration_access_status ON integration_access_requests(status, created_at);

-- The conversation and the stages of each request (who did what, with the note they gave). Never edited or deleted.
CREATE TABLE IF NOT EXISTS integration_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES integration_access_requests(id),
  actor_id uuid REFERENCES users(id),
  actor_side text NOT NULL CHECK (actor_side IN ('requester','platform')),
  kind text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_access_events_req ON integration_access_events(request_id, created_at);
ALTER TABLE integration_installs ADD COLUMN IF NOT EXISTS event_id uuid REFERENCES events(id);
ALTER TABLE integration_installs ADD COLUMN IF NOT EXISTS access_request_id uuid REFERENCES integration_access_requests(id);
