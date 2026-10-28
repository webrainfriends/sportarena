-- Procurement chain (issue #520): tender awards (#460) and service orders (#458) converge on ONE fulfilment record.
-- Additive only: nothing is dropped, rewritten or narrowed. Existing proc_orders keep working and can be linked later.

-- A tender order (the contract / award snapshot) points at the service order that carries delivery, acceptance, invoices and payments.
ALTER TABLE proc_orders ADD COLUMN IF NOT EXISTS svc_order_id uuid REFERENCES svc_orders;
CREATE UNIQUE INDEX IF NOT EXISTS proc_orders_svc_order ON proc_orders (svc_order_id) WHERE svc_order_id IS NOT NULL;

-- and the other way round, so a service order always says where it came from.
ALTER TABLE svc_orders ADD COLUMN IF NOT EXISTS proc_order_id uuid REFERENCES proc_orders;
ALTER TABLE svc_orders ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'rfq';
DO $$ BEGIN
  ALTER TABLE svc_orders ADD CONSTRAINT svc_orders_source_chk CHECK (source IN ('rfq','tender','direct'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS svc_orders_proc_order ON svc_orders (proc_order_id) WHERE proc_order_id IS NOT NULL;

-- The supplier entity (tender side) and the supplier profile (services side) are the same business: remember the mapping once.
ALTER TABLE supplier_entities ADD COLUMN IF NOT EXISTS svc_profile_id uuid REFERENCES svc_profiles;

-- Buyer rating after fulfilment. Append-only: one rating per order and buyer user; it is never edited or deleted.
CREATE TABLE IF NOT EXISTS svc_order_ratings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES svc_orders,
  profile_id  uuid NOT NULL REFERENCES svc_profiles,
  buyer_id    uuid NOT NULL REFERENCES svc_buyers,
  rated_by    uuid NOT NULL REFERENCES users,
  stars       int NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment     text CHECK (comment IS NULL OR length(comment) <= 1000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id)
);
CREATE INDEX IF NOT EXISTS svc_order_ratings_profile ON svc_order_ratings (profile_id, created_at DESC);
CREATE OR REPLACE FUNCTION svc_order_ratings_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'svc_order_ratings is append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS svc_order_ratings_immutable ON svc_order_ratings;
CREATE TRIGGER svc_order_ratings_immutable BEFORE UPDATE OR DELETE ON svc_order_ratings FOR EACH ROW EXECUTE FUNCTION svc_order_ratings_append_only();

-- A tender lot is either a service or goods. Goods are received and accepted line by line; services are scheduled, delivered and accepted.
ALTER TABLE proc_lots ADD COLUMN IF NOT EXISTS supply_kind text NOT NULL DEFAULT 'service';
DO $$ BEGIN
  ALTER TABLE proc_lots ADD CONSTRAINT proc_lots_supply_kind_chk CHECK (supply_kind IN ('service','goods'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RFQ evaluation history: re-scoring used to overwrite the evaluator's earlier scores. Every superseded evaluation is now kept (append-only).
CREATE TABLE IF NOT EXISTS svc_evaluation_revisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id uuid NOT NULL REFERENCES svc_evaluations,
  rfq_id       uuid NOT NULL REFERENCES svc_rfqs,
  quote_id     uuid NOT NULL REFERENCES svc_quotes,
  evaluator_id uuid NOT NULL REFERENCES users,
  scores       jsonb NOT NULL,
  total        numeric(8,2) NOT NULL,
  rationale    text NOT NULL,
  compliant    boolean NOT NULL,
  scored_at    timestamptz NOT NULL,
  superseded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS svc_evaluation_revisions_eval ON svc_evaluation_revisions (evaluation_id, superseded_at);
CREATE OR REPLACE FUNCTION svc_evaluation_keep_previous() RETURNS trigger AS $$
BEGIN
  INSERT INTO svc_evaluation_revisions(evaluation_id, rfq_id, quote_id, evaluator_id, scores, total, rationale, compliant, scored_at)
  VALUES (OLD.id, OLD.rfq_id, OLD.quote_id, OLD.evaluator_id, OLD.scores, OLD.total, OLD.rationale, OLD.compliant, OLD.created_at);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS svc_evaluations_keep_previous ON svc_evaluations;
CREATE TRIGGER svc_evaluations_keep_previous BEFORE UPDATE ON svc_evaluations FOR EACH ROW EXECUTE FUNCTION svc_evaluation_keep_previous();

-- Conflicts and recusal on direct RFQs (the tender route already has proc_conflicts). A recused person cannot score, shortlist or award the supplier concerned.
CREATE TABLE IF NOT EXISTS svc_rfq_conflicts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id      uuid NOT NULL REFERENCES svc_rfqs,
  user_id     uuid NOT NULL REFERENCES users,
  profile_id  uuid REFERENCES svc_profiles,                 -- NULL = recused from the whole RFQ
  reason      text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS svc_rfq_conflicts_unique ON svc_rfq_conflicts (rfq_id, user_id, coalesce(profile_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE OR REPLACE FUNCTION svc_rfq_conflicts_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'svc_rfq_conflicts is append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS svc_rfq_conflicts_immutable ON svc_rfq_conflicts;
CREATE TRIGGER svc_rfq_conflicts_immutable BEFORE UPDATE OR DELETE ON svc_rfq_conflicts FOR EACH ROW EXECUTE FUNCTION svc_rfq_conflicts_append_only();
