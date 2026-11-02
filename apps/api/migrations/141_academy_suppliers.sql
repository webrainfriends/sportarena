-- Academy suppliers: maintenance contractors and sporting-goods / kit suppliers an academy works with. An academy can run several
-- venues (venues.organisation_id), so a supplier covers every venue of the academy or only chosen ones. Additive only: nothing is
-- deleted; a supplier is paused or archived and keeps its history. Contact details are encrypted at rest.
CREATE TABLE IF NOT EXISTS academy_suppliers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations,
  kind             text NOT NULL CHECK (kind IN ('maintenance','sporting_goods','cleaning','security','technology','catering','transport','other')),
  name             text NOT NULL,
  categories       text[] NOT NULL DEFAULT '{}',
  all_venues       boolean NOT NULL DEFAULT false,          -- true: covers every venue the academy has now or adds later
  contact_name_enc text,
  phone_enc        text,
  email_enc        text,
  address          text,
  website          text,
  emergency_24x7   boolean NOT NULL DEFAULT false,
  lead_time_days   int CHECK (lead_time_days BETWEEN 0 AND 365),
  payment_terms    text,
  rating           int CHECK (rating BETWEEN 1 AND 5),
  notes            text,
  svc_profile_id   uuid REFERENCES svc_profiles,            -- optional link to the supplier's marketplace profile
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  row_version      int NOT NULL DEFAULT 1,
  created_by       uuid REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_suppliers_org ON academy_suppliers (organisation_id, kind) WHERE status <> 'archived';

-- Which venues a (not all-venue) supplier serves. A link is ended (ended_at), never deleted.
CREATE TABLE IF NOT EXISTS academy_supplier_venues (
  supplier_id uuid NOT NULL REFERENCES academy_suppliers,
  venue_id    uuid NOT NULL REFERENCES venues,
  added_at    timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  PRIMARY KEY (supplier_id, venue_id)
);
CREATE INDEX IF NOT EXISTS academy_supplier_venues_venue ON academy_supplier_venues (venue_id) WHERE ended_at IS NULL;

-- A request to a supplier: repair, servicing, kit or equipment. venue_id empty means the whole academy.
CREATE TABLE IF NOT EXISTS academy_supplier_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id      uuid NOT NULL REFERENCES organisations,
  supplier_id          uuid NOT NULL REFERENCES academy_suppliers,
  venue_id             uuid REFERENCES venues,
  title                text NOT NULL,
  details              text,
  priority             text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status               text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','quoted','approved','in_progress','delivered','done','cancelled')),
  due_on               date,
  currency             text,
  estimated_cost_minor bigint CHECK (estimated_cost_minor >= 0),
  actual_cost_minor    bigint CHECK (actual_cost_minor >= 0),
  row_version          int NOT NULL DEFAULT 1,
  created_by           uuid REFERENCES users,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((estimated_cost_minor IS NULL AND actual_cost_minor IS NULL) OR currency IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS academy_supplier_requests_org ON academy_supplier_requests (organisation_id, status, due_on);
