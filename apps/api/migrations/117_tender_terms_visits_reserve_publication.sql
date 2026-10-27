-- Tender zone follow-ups (issue #460). Additive and backwards-compatible: nothing is dropped or rewritten.
--  1. contract terms: renewal options, notice period and milestones, carried from the tender onto each order
--  2. site-visit documents suppliers must acknowledge, with an append-only acknowledgement record; amended documents keep their history
--  3. a published reserve-bidder rule and the link from a reserve award line to the declined/expired line it replaces
--  4. separately approved public award publications (an immutable allowlisted snapshot)

-- ------------------------------------------------------------------ 1. contract terms
ALTER TABLE proc_projects
  ADD COLUMN IF NOT EXISTS renewal_options       int    NOT NULL DEFAULT 0 CHECK (renewal_options BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS renewal_term_months   int    CHECK (renewal_term_months IS NULL OR renewal_term_months BETWEEN 1 AND 60),
  ADD COLUMN IF NOT EXISTS renewal_ceiling_minor bigint CHECK (renewal_ceiling_minor IS NULL OR renewal_ceiling_minor >= 0),
  ADD COLUMN IF NOT EXISTS notice_days           int    NOT NULL DEFAULT 0 CHECK (notice_days BETWEEN 0 AND 365),
  ADD COLUMN IF NOT EXISTS milestones            jsonb  NOT NULL DEFAULT '[]';

ALTER TABLE proc_orders
  ADD COLUMN IF NOT EXISTS renewal_options       int    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS renewals_used         int    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS renewal_term_months   int,
  ADD COLUMN IF NOT EXISTS renewal_ceiling_minor bigint,
  ADD COLUMN IF NOT EXISTS notice_days           int    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notice_kind           text   CHECK (notice_kind IS NULL OR notice_kind IN ('terminate','not_renew')),
  ADD COLUMN IF NOT EXISTS notice_served_at      timestamptz,
  ADD COLUMN IF NOT EXISTS notice_served_by      uuid   REFERENCES users,
  ADD COLUMN IF NOT EXISTS notice_effective_on   date;

CREATE TABLE IF NOT EXISTS proc_order_milestones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES proc_orders,
  position    int  NOT NULL,
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  description text,
  due_on      date NOT NULL,
  status      text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','completed','waived')),
  note        text,                                       -- a contract milestone record: not acceptance of work, not a payment trigger
  updated_by  uuid REFERENCES users,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, position)
);

-- every renewal is kept; renewals never rewrite earlier terms
CREATE TABLE IF NOT EXISTS proc_order_renewals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES proc_orders,
  n                   int  NOT NULL,
  previous_service_end date,
  new_service_end     date NOT NULL,
  added_ceiling_minor bigint NOT NULL DEFAULT 0,
  renewed_by          uuid NOT NULL REFERENCES users,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, n)
);
DROP TRIGGER IF EXISTS proc_order_renewals_immutable ON proc_order_renewals;
CREATE TRIGGER proc_order_renewals_immutable BEFORE UPDATE OR DELETE ON proc_order_renewals FOR EACH ROW EXECUTE FUNCTION proc_immutable();

-- ------------------------------------------------------------------ 2. site-visit documents
ALTER TABLE proc_files ADD COLUMN IF NOT EXISTS visit_pack boolean NOT NULL DEFAULT false;
-- an amended document is a new file that points at the one it replaces; the earlier file is archived, never deleted
ALTER TABLE proc_files ADD COLUMN IF NOT EXISTS replaces_id uuid REFERENCES proc_files;

CREATE TABLE IF NOT EXISTS proc_visit_acks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES proc_projects,
  entity_id       uuid NOT NULL REFERENCES supplier_entities,
  file_id         uuid NOT NULL REFERENCES proc_files,
  sha256          text NOT NULL,                          -- the exact content that was acknowledged
  acknowledged_by uuid NOT NULL REFERENCES users,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, file_id)
);
CREATE INDEX IF NOT EXISTS proc_visit_acks_project ON proc_visit_acks (project_id, entity_id);
DROP TRIGGER IF EXISTS proc_visit_acks_immutable ON proc_visit_acks;
CREATE TRIGGER proc_visit_acks_immutable BEFORE UPDATE OR DELETE ON proc_visit_acks FOR EACH ROW EXECUTE FUNCTION proc_immutable();

-- ------------------------------------------------------------------ 3. reserve bidders
-- 'none' = a declined or expired lot is not offered to the next bidder (re-tender or close instead); 'next_ranked' = it may be offered to the
-- next eligible bidder in the published ranking order, with a fresh approval. Tenders that already exist keep the behaviour they had.
ALTER TABLE proc_projects ADD COLUMN IF NOT EXISTS reserve_policy text NOT NULL DEFAULT 'next_ranked' CHECK (reserve_policy IN ('none','next_ranked'));
ALTER TABLE proc_projects ALTER COLUMN reserve_policy SET DEFAULT 'none';
ALTER TABLE proc_award_lines ADD COLUMN IF NOT EXISTS reserve_of uuid REFERENCES proc_award_lines;

-- ------------------------------------------------------------------ 4. public award publications
CREATE TABLE IF NOT EXISTS proc_award_publications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES proc_projects,
  approval_id   uuid REFERENCES proc_approvals,
  fields        text[] NOT NULL,                          -- the allowlist that was requested: supplier, lots, award_date, service_period, value
  record        jsonb NOT NULL,                           -- the exact public record, built when requested; never edited afterwards
  status        text NOT NULL DEFAULT 'approval_pending' CHECK (status IN ('approval_pending','published','rejected','withdrawn')),
  requested_by  uuid NOT NULL REFERENCES users,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  withdrawn_at  timestamptz,
  withdrawn_by  uuid REFERENCES users,
  withdraw_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS proc_award_publications_live ON proc_award_publications (project_id) WHERE status IN ('approval_pending','published');
CREATE OR REPLACE FUNCTION proc_publication_record_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'proc_award_publications rows are kept'; END IF;
  IF NEW.record IS DISTINCT FROM OLD.record OR NEW.fields IS DISTINCT FROM OLD.fields THEN RAISE EXCEPTION 'a publication record cannot be edited'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS proc_award_publications_fixed ON proc_award_publications;
CREATE TRIGGER proc_award_publications_fixed BEFORE UPDATE OR DELETE ON proc_award_publications FOR EACH ROW EXECUTE FUNCTION proc_publication_record_fixed();

-- a public award notice is its own approval kind (the list is only widened)
ALTER TABLE proc_approvals DROP CONSTRAINT IF EXISTS proc_approvals_kind_check;
ALTER TABLE proc_approvals ADD CONSTRAINT proc_approvals_kind_check CHECK (kind IN ('publish','material_change','opening','award','disqualify','reinstate','late_submission','deadline_extension','reissue','award_publication'));
