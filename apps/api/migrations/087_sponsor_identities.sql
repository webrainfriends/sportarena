-- Sponsor identities (#282): individual / company / organization sponsors with legal + billing identity, authorized
-- representatives (per entity), portfolios of brands, and an immutable identity snapshot per agreement version.
-- Purely additive: no existing row, column or constraint is changed or removed, and nothing is back-filled with invented data.
-- Existing brands keep entity_id NULL ("identity incomplete") until their owner confirms a real identity.
-- Rollback = deploy the previous code; the new tables/columns are simply ignored.

CREATE TABLE sponsor_entities (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_type            text NOT NULL CHECK (sponsor_type IN ('individual','company','organization')),
  legal_name              text,
  registration_country    text CHECK (registration_country IS NULL OR registration_country ~ '^[A-Z]{2}$'),
  registration_number_enc text,
  tax_id_enc              text,
  billing_email_enc       text,
  billing_address_enc     text,
  organisation_id         uuid REFERENCES organisations,
  created_by              uuid NOT NULL REFERENCES users,
  row_version             int NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sponsors ADD COLUMN entity_id uuid REFERENCES sponsor_entities;
CREATE INDEX sponsors_entity ON sponsors(entity_id) WHERE entity_id IS NOT NULL;

CREATE TABLE sponsor_representatives (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   uuid NOT NULL REFERENCES sponsor_entities,
  user_id     uuid NOT NULL REFERENCES users,
  role        text NOT NULL CHECK (role IN ('owner','admin','finance','portfolio_manager','viewer')),
  title       text,
  status      text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','declined','left')),
  invited_by  uuid REFERENCES users,
  joined_at   timestamptz,
  left_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sponsor_rep_live ON sponsor_representatives(entity_id, user_id) WHERE status IN ('invited','active');
CREATE INDEX sponsor_rep_user ON sponsor_representatives(user_id) WHERE status = 'active';

CREATE TABLE sponsor_portfolios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   uuid NOT NULL REFERENCES sponsor_entities,
  name        text NOT NULL,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX sponsor_portfolio_name ON sponsor_portfolios(entity_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE sponsor_portfolio_brands (
  portfolio_id uuid NOT NULL REFERENCES sponsor_portfolios,
  sponsor_id   uuid NOT NULL REFERENCES sponsors,
  added_at     timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz
);
CREATE UNIQUE INDEX sponsor_portfolio_brand_live ON sponsor_portfolio_brands(portfolio_id, sponsor_id) WHERE removed_at IS NULL;

CREATE TABLE sponsor_portfolio_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id      uuid NOT NULL REFERENCES sponsor_portfolios,
  representative_id uuid NOT NULL REFERENCES sponsor_representatives,
  assigned_by       uuid NOT NULL REFERENCES users,
  assigned_at       timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz
);
CREATE UNIQUE INDEX sponsor_portfolio_assignment_live ON sponsor_portfolio_assignments(portfolio_id, representative_id) WHERE ended_at IS NULL;

-- What each agreement version said about who the sponsor was, frozen when the version is proposed. Later renames,
-- entity edits or representative changes never rewrite it. Registration, tax and billing details are never copied here.
CREATE TABLE sponsorship_identity_snapshots (
  sponsorship_id  uuid NOT NULL REFERENCES sponsorships,
  version         int NOT NULL,
  sponsor_id      uuid NOT NULL REFERENCES sponsors,
  entity_id       uuid REFERENCES sponsor_entities,
  display_name    text NOT NULL,
  legal_name      text,
  sponsor_type    text,
  signed_by       uuid REFERENCES users,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sponsorship_id, version)
);

-- Existing agreements: record only what is already known (the brand name, and who proposed when that was the brand's own owner).
-- No legal name is invented; an event organiser's invitation is not recorded as the sponsor's signature.
INSERT INTO sponsorship_identity_snapshots(sponsorship_id, version, sponsor_id, display_name, signed_by, captured_at)
SELECT ss.id, ss.terms_version, ss.sponsor_id, sp.name, CASE WHEN ss.proposed_by = sp.owner_id THEN ss.proposed_by END, ss.created_at
  FROM sponsorships ss JOIN sponsors sp ON sp.id = ss.sponsor_id
ON CONFLICT DO NOTHING;
