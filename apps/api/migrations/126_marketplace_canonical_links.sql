-- Marketplace (#600), canonical links: a marketplace invoice is a row of the shared `invoices` table, both contract signatures are recorded,
-- and service requests are #67 Billboard posts (kind service_request) whose accepted response becomes the marketplace engagement.
-- Additive only: CHECK lists are widened (never narrowed), new nullable columns and tables, nothing dropped or rewritten.

ALTER TABLE billboard_posts DROP CONSTRAINT IF EXISTS billboard_posts_kind_check;
ALTER TABLE billboard_posts ADD CONSTRAINT billboard_posts_kind_check CHECK (kind IN ('match_players','team_recruiting','coach_wanted','assignment','sponsorship_wanted','sponsor_call','service_request'));
ALTER TABLE billboard_posts DROP CONSTRAINT IF EXISTS billboard_posts_opportunity_type_check;
ALTER TABLE billboard_posts ADD CONSTRAINT billboard_posts_opportunity_type_check CHECK (opportunity_type IS NULL OR opportunity_type IN ('trial','paid_assignment','volunteering','sponsorship','team_role','service'));
ALTER TABLE billboard_responses DROP CONSTRAINT IF EXISTS billboard_responses_engagement_type_check;
ALTER TABLE billboard_responses ADD CONSTRAINT billboard_responses_engagement_type_check CHECK (engagement_type IS NULL OR engagement_type IN ('team_member','association','sponsorship','marketplace_engagement'));

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS marketplace_engagement_id uuid REFERENCES marketplace_engagements;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_source;
ALTER TABLE invoices ADD CONSTRAINT invoices_source CHECK (
  (venue_id IS NOT NULL AND reservation_id IS NOT NULL AND organisation_id IS NULL AND academy_charge_id IS NULL AND svc_order_id IS NULL AND pos_sale_id IS NULL AND marketplace_engagement_id IS NULL)
  OR (venue_id IS NULL AND reservation_id IS NULL AND organisation_id IS NOT NULL AND academy_charge_id IS NOT NULL AND svc_order_id IS NULL AND pos_sale_id IS NULL AND marketplace_engagement_id IS NULL)
  OR (venue_id IS NULL AND reservation_id IS NULL AND academy_charge_id IS NULL AND svc_order_id IS NOT NULL AND svc_profile_id IS NOT NULL AND pos_sale_id IS NULL AND marketplace_engagement_id IS NULL)
  OR (venue_id IS NOT NULL AND reservation_id IS NULL AND organisation_id IS NULL AND academy_charge_id IS NULL AND svc_order_id IS NULL AND pos_sale_id IS NOT NULL AND marketplace_engagement_id IS NULL)
  OR (venue_id IS NULL AND reservation_id IS NULL AND organisation_id IS NULL AND academy_charge_id IS NULL AND svc_order_id IS NULL AND pos_sale_id IS NULL AND team_charge_id IS NOT NULL AND team_id IS NOT NULL AND marketplace_engagement_id IS NULL)
  OR (venue_id IS NULL AND reservation_id IS NULL AND organisation_id IS NULL AND academy_charge_id IS NULL AND svc_order_id IS NULL AND pos_sale_id IS NULL AND team_charge_id IS NULL AND team_id IS NULL AND marketplace_engagement_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS invoices_marketplace_live ON invoices (marketplace_engagement_id) WHERE marketplace_engagement_id IS NOT NULL AND kind = 'invoice' AND status IN ('open','paid');

CREATE TABLE IF NOT EXISTS marketplace_invoice_counters (               -- gapless numbering per provider, like venue, academy and team invoices
  provider_id uuid PRIMARY KEY REFERENCES users,
  seq         bigint NOT NULL
);
ALTER TABLE marketplace_engagements ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES invoices;

CREATE TABLE IF NOT EXISTS marketplace_contract_signatures (            -- who accepted exactly which terms, and when; never edited
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES marketplace_engagements,
  user_id       uuid NOT NULL REFERENCES users,
  side          text NOT NULL CHECK (side IN ('buyer','provider')),
  terms_sha256  text NOT NULL,
  signed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engagement_id, side)
);
