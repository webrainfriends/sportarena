-- Billboard Tender zone: enterprise RFP publishing, sealed proposals, evaluation, ranking and awards (issue #460).
-- Additive only. Nothing is dropped, rewritten or deleted; removal is soft (archived_at / status). Issued, submitted and audit rows are
-- immutable (enforced by trigger). The shared procurement core (proc_*) is the model #458 extends: projects, lots, orders, commitments.

CREATE SEQUENCE IF NOT EXISTS proc_ref_seq;
CREATE SEQUENCE IF NOT EXISTS proc_order_seq;

CREATE OR REPLACE FUNCTION proc_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '23000'; END $$;

-- ------------------------------------------------------------------ supplier legal entities (individual, sole trader, company)
CREATE TABLE IF NOT EXISTS supplier_entities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('individual','sole_trader','company')),
  legal_name      text NOT NULL CHECK (length(legal_name) BETWEEN 2 AND 120),
  trading_name    text,
  country         text,
  tax_id_enc      text,                                   -- field-level encrypted
  categories      text[] NOT NULL DEFAULT '{}',
  coverage        text,
  currencies      text[] NOT NULL DEFAULT '{}',
  capacity_note   text,
  organisation_id uuid REFERENCES organisations,
  owner_user_id   uuid NOT NULL REFERENCES users,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS supplier_entity_members (
  entity_id  uuid NOT NULL REFERENCES supplier_entities,
  user_id    uuid NOT NULL REFERENCES users,
  role       text NOT NULL CHECK (role IN ('owner','bid_manager','contributor','signatory')),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  added_by   uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, user_id)
);
CREATE INDEX IF NOT EXISTS supplier_entity_members_user ON supplier_entity_members (user_id) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS supplier_credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   uuid NOT NULL REFERENCES supplier_entities,
  kind        text NOT NULL CHECK (kind IN ('insurance','safeguarding','safety_certificate','trade_licence','tax_registration','qualification','other')),
  title       text NOT NULL,
  number_enc  text,
  issuer      text,
  valid_from  date,
  valid_to    date,
  status      text NOT NULL DEFAULT 'declared' CHECK (status IN ('declared','verified','rejected')),
  verified_by uuid REFERENCES users,
  verified_at timestamptz,
  verified_what text,                                     -- what was actually checked
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_credentials_entity ON supplier_credentials (entity_id) WHERE archived_at IS NULL;

-- ------------------------------------------------------------------ buyer authority
CREATE TABLE IF NOT EXISTS proc_mandates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  user_id         uuid NOT NULL REFERENCES users,
  role            text NOT NULL CHECK (role IN ('procurement_admin','author','approver','evaluator','auditor')),
  event_id        uuid REFERENCES events,                 -- null = every procurement of the organisation
  expires_at      timestamptz,
  revoked_at      timestamptz,
  granted_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proc_mandates_user ON proc_mandates (user_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS proc_policies (
  organisation_id uuid PRIMARY KEY REFERENCES organisations,
  publish_threshold_minor bigint,                         -- budgets at or above need extra_approvals more approvals
  award_threshold_minor   bigint,
  extra_approvals int NOT NULL DEFAULT 1 CHECK (extra_approvals BETWEEN 0 AND 3),
  currency        text NOT NULL DEFAULT 'INR',
  updated_by      uuid REFERENCES users,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ templates
CREATE TABLE IF NOT EXISTS proc_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid REFERENCES organisations,
  owner_user_id   uuid NOT NULL REFERENCES users,
  kind            text NOT NULL CHECK (kind IN ('rfp_template','question_set')),
  name            text NOT NULL,
  version         int NOT NULL DEFAULT 1,
  body            jsonb NOT NULL,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ the canonical sourcing project (RFI / RFP / RFQ)
CREATE TABLE IF NOT EXISTS proc_projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref              text NOT NULL UNIQUE,
  kind             text NOT NULL DEFAULT 'rfp' CHECK (kind IN ('rfi','rfp','rfq')),
  parent_id        uuid REFERENCES proc_projects,         -- reissue / next phase
  organisation_id  uuid REFERENCES organisations,         -- the acting entity (organisation) ...
  owner_user_id    uuid NOT NULL REFERENCES users,        -- ... or the individual organiser
  event_id         uuid REFERENCES events,
  venue_id         uuid REFERENCES venues,                 -- a venue owner or manager hiring suppliers for the venue
  sites            jsonb NOT NULL DEFAULT '[]',            -- [{venue_id,label}]
  title            text NOT NULL CHECK (length(title) BETWEEN 3 AND 140),
  objective        text,
  scope            text,
  inclusions       text,
  exclusions       text,
  category         text NOT NULL,
  sport_id         uuid REFERENCES sports,
  location         text,
  contract_type    text NOT NULL DEFAULT 'one_off' CHECK (contract_type IN ('one_off','fixed_term','recurring','framework')),
  prep_start       date,
  service_start    date,
  service_end      date,
  teardown_end     date,
  currency         text NOT NULL DEFAULT 'INR',
  budget_minor     bigint CHECK (budget_minor >= 0),
  budget_public    boolean NOT NULL DEFAULT false,
  ceiling_minor    bigint CHECK (ceiling_minor >= 0),     -- framework ceiling (not guaranteed spend)
  cost_basis       text NOT NULL DEFAULT 'net' CHECK (cost_basis IN ('net','gross')),
  fx               jsonb,                                  -- dated snapshot {date,base,rates} for comparison only
  publication      text NOT NULL DEFAULT 'public' CHECK (publication IN ('public','restricted','invite_only','private')),
  envelope_mode    text NOT NULL DEFAULT 'sealed_dual' CHECK (envelope_mode IN ('open','sealed_single','sealed_dual')),
  timezone         text NOT NULL DEFAULT 'UTC',
  publish_at       timestamptz,
  clarification_deadline timestamptz,
  site_visit_at    timestamptz,
  site_visit_mandatory boolean NOT NULL DEFAULT false,
  closes_at        timestamptz,
  opens_at         timestamptz,                            -- earliest permitted opening
  evaluation_due   timestamptz,
  negotiation_due  timestamptz,
  award_target     timestamptz,
  standstill_days  int NOT NULL DEFAULT 0 CHECK (standstill_days BETWEEN 0 AND 60),
  allow_revision   boolean NOT NULL DEFAULT true,
  allow_withdrawal boolean NOT NULL DEFAULT true,
  allow_alternatives boolean NOT NULL DEFAULT false,
  quorum           int NOT NULL DEFAULT 1 CHECK (quorum BETWEEN 1 AND 10),
  approvals_required int NOT NULL DEFAULT 1,
  required_credentials jsonb NOT NULL DEFAULT '[]',        -- [{kind,title}] checked at gates and again before award
  disclosure       jsonb NOT NULL DEFAULT '{"rank":false,"bidder_count":false,"award_public":false}',
  rubric           jsonb,
  rubric_version   int NOT NULL DEFAULT 0,
  rubric_frozen_at timestamptz,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','published','evaluation','award','awarded','closed','cancelled','archived')),
  suspended_at     timestamptz,
  suspend_reason   text,
  published_at     timestamptz,
  cancelled_reason text,
  version          int NOT NULL DEFAULT 1,                 -- bumped by every material change; submissions pin it
  row_version      int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (organisation_id IS NOT NULL OR event_id IS NOT NULL OR venue_id IS NOT NULL OR owner_user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS proc_projects_discover ON proc_projects (status, publication, closes_at) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS proc_projects_org ON proc_projects (organisation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS proc_projects_event ON proc_projects (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS proc_projects_venue ON proc_projects (venue_id) WHERE venue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS proc_projects_owner ON proc_projects (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS proc_lots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES proc_projects,
  code          text NOT NULL,
  title         text NOT NULL,
  description   text,
  service_family text,
  qty           numeric(14,4) NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit          text,
  estimate_minor bigint CHECK (estimate_minor >= 0),
  allow_partial boolean NOT NULL DEFAULT true,
  bundle_with   text[] NOT NULL DEFAULT '{}',              -- lot codes that must be bid together
  starts_on     date,
  ends_on       date,
  site          text,
  position      int NOT NULL DEFAULT 0,
  archived_at   timestamptz,
  UNIQUE (project_id, code)
);
CREATE TABLE IF NOT EXISTS proc_questions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES proc_projects,
  key           text NOT NULL,
  section       text NOT NULL CHECK (section IN ('qualification','technical','commercial','legal')),
  prompt        text NOT NULL,
  type          text NOT NULL CHECK (type IN ('yes_no','single_select','multi_select','text','number','date','currency','table','attachment')),
  options       jsonb,
  unit          text,
  required      boolean NOT NULL DEFAULT true,
  pass_fail     boolean NOT NULL DEFAULT false,
  pass_value    jsonb,
  evidence_required boolean NOT NULL DEFAULT false,
  lot_code      text,
  show_if       jsonb,                                     -- {key, equals}
  position      int NOT NULL DEFAULT 0,
  archived_at   timestamptz,
  UNIQUE (project_id, key)
);

CREATE TABLE IF NOT EXISTS proc_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES proc_projects,
  user_id     uuid NOT NULL REFERENCES users,
  role        text NOT NULL CHECK (role IN ('owner','author','technical_evaluator','commercial_evaluator','chair','approver','legal_reviewer','auditor','stakeholder','opener')),
  expires_at  timestamptz,
  substitute_for uuid REFERENCES users,
  revoked_at  timestamptz,
  added_by    uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS proc_members_live ON proc_members (project_id, user_id, role) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS proc_members_user ON proc_members (user_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS proc_conflicts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES proc_projects,
  user_id     uuid NOT NULL REFERENCES users,
  has_conflict boolean NOT NULL,
  entity_id   uuid REFERENCES supplier_entities,
  note        text,
  declared_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proc_conflicts_project ON proc_conflicts (project_id, user_id);

-- approvals: one row per decision request, executed only after enough distinct approvers (never the requester)
CREATE TABLE IF NOT EXISTS proc_approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES proc_projects,
  kind        text NOT NULL CHECK (kind IN ('publish','material_change','opening','award','disqualify','reinstate','late_submission','deadline_extension','reissue')),
  payload     jsonb NOT NULL DEFAULT '{}',
  required    int NOT NULL DEFAULT 1,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  requested_by uuid NOT NULL REFERENCES users,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
CREATE INDEX IF NOT EXISTS proc_approvals_project ON proc_approvals (project_id, status);
CREATE TABLE IF NOT EXISTS proc_approval_votes (
  approval_id uuid NOT NULL REFERENCES proc_approvals,
  user_id     uuid NOT NULL REFERENCES users,
  decision    text NOT NULL CHECK (decision IN ('approve','reject')),
  reason      text,
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (approval_id, user_id)
);

-- append-only, hash-chained audit trail
CREATE TABLE IF NOT EXISTS proc_audit (
  id         bigserial PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES proc_projects,
  actor_id   uuid REFERENCES users,
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  prev_hash  text,
  hash       text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proc_audit_project ON proc_audit (project_id, id);
DROP TRIGGER IF EXISTS proc_audit_immutable ON proc_audit;
CREATE TRIGGER proc_audit_immutable BEFORE UPDATE OR DELETE ON proc_audit FOR EACH ROW EXECUTE FUNCTION proc_immutable();

CREATE TABLE IF NOT EXISTS proc_addenda (
  project_id uuid NOT NULL REFERENCES proc_projects,
  n          int NOT NULL,
  summary    text NOT NULL,
  body       text,
  changed_sections text[] NOT NULL DEFAULT '{}',
  material   boolean NOT NULL DEFAULT false,
  rfp_version int NOT NULL,
  new_closes_at timestamptz,
  reason     text NOT NULL,
  issued_by  uuid NOT NULL REFERENCES users,
  issued_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, n)
);
CREATE TABLE IF NOT EXISTS proc_addendum_acks (
  project_id uuid NOT NULL, n int NOT NULL, entity_id uuid NOT NULL REFERENCES supplier_entities, user_id uuid NOT NULL REFERENCES users, at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, n, entity_id),
  FOREIGN KEY (project_id, n) REFERENCES proc_addenda (project_id, n)
);

CREATE TABLE IF NOT EXISTS proc_participants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES proc_projects,
  entity_id   uuid NOT NULL REFERENCES supplier_entities,
  status      text NOT NULL DEFAULT 'interested' CHECK (status IN ('invited','interested','requested','approved','declined','withdrawn')),
  invited_by  uuid REFERENCES users,
  terms_accepted_at timestamptz,
  nda_accepted_at   timestamptz,
  site_visit_attended boolean,
  site_visit_exempt_reason text,
  decline_reason text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, entity_id)
);
CREATE INDEX IF NOT EXISTS proc_participants_entity ON proc_participants (entity_id);

CREATE TABLE IF NOT EXISTS proc_qna (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES proc_projects,
  entity_id   uuid NOT NULL REFERENCES supplier_entities,
  asked_by    uuid NOT NULL REFERENCES users,
  question    text NOT NULL CHECK (length(question) BETWEEN 3 AND 2000),
  private_requested boolean NOT NULL DEFAULT false,
  answer      text,
  answered_by uuid REFERENCES users,
  answered_at timestamptz,
  published   boolean NOT NULL DEFAULT false,              -- common Q&A: the question is shown without the asker's identity
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proc_qna_project ON proc_qna (project_id, created_at);

CREATE TABLE IF NOT EXISTS proc_files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES proc_projects,
  entity_id   uuid REFERENCES supplier_entities,           -- null = buyer pack file
  proposal_id uuid,
  uploaded_by uuid NOT NULL REFERENCES users,
  audience    text NOT NULL CHECK (audience IN ('public','participants','technical','commercial','buyer')),
  name        text NOT NULL,
  mime        text NOT NULL,
  bytes       int NOT NULL,
  sha256      text NOT NULL,
  stored      text NOT NULL,
  scan        text NOT NULL DEFAULT 'clean' CHECK (scan IN ('clean','quarantined')),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proc_files_project ON proc_files (project_id, audience);
CREATE INDEX IF NOT EXISTS proc_files_proposal ON proc_files (proposal_id) WHERE proposal_id IS NOT NULL;

-- ------------------------------------------------------------------ supplier proposals and immutable submissions
CREATE TABLE IF NOT EXISTS proc_proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES proc_projects,
  entity_id     uuid NOT NULL REFERENCES supplier_entities,
  round         int NOT NULL DEFAULT 1,
  alt_key       text NOT NULL DEFAULT 'base',
  lots          text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','withdrawn')),
  draft_enc     text,                                      -- the working draft is encrypted too: {technical:{...}, commercial:{lines:[...],...}}
  draft_version int NOT NULL DEFAULT 1,
  current_submission_id uuid,
  eligibility   text NOT NULL DEFAULT 'pending' CHECK (eligibility IN ('pending','eligible','ineligible','withdrawn')),
  eligibility_reason text,
  tech_signoff  text CHECK (tech_signoff IN ('pass','fail')),
  tech_signoff_by uuid REFERENCES users,
  tech_signoff_at timestamptz,
  commercial_unlocked_at timestamptz,
  shortlisted   boolean NOT NULL DEFAULT false,
  disqualified_at timestamptz,
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, entity_id, round, alt_key)
);
CREATE INDEX IF NOT EXISTS proc_proposals_entity ON proc_proposals (entity_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS proc_proposals_project ON proc_proposals (project_id, round);
CREATE TABLE IF NOT EXISTS proc_submissions (
  id            uuid PRIMARY KEY,
  proposal_id   uuid NOT NULL REFERENCES proc_proposals,
  project_id    uuid NOT NULL REFERENCES proc_projects,
  version       int NOT NULL,
  receipt_no    text NOT NULL UNIQUE,
  rfp_version   int NOT NULL,
  addendum_n    int NOT NULL DEFAULT 0,
  lots          text[] NOT NULL,
  tech_enc      text,                                      -- sealed envelopes: AES-256-GCM, bound to this row id
  comm_enc      text,
  content_hash  text NOT NULL,
  submitted_by  uuid NOT NULL REFERENCES users,
  submitted_at  timestamptz NOT NULL DEFAULT now(),        -- server commit time; the deadline decision uses it
  late          boolean NOT NULL DEFAULT false,
  idempotency_key text,
  UNIQUE (proposal_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS proc_submissions_idem ON proc_submissions (proposal_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
DROP TRIGGER IF EXISTS proc_submissions_immutable ON proc_submissions;
CREATE TRIGGER proc_submissions_immutable BEFORE UPDATE OR DELETE ON proc_submissions FOR EACH ROW EXECUTE FUNCTION proc_immutable();
-- evaluated figures are written once when the commercial envelope is opened
CREATE TABLE IF NOT EXISTS proc_submission_costs (
  submission_id uuid PRIMARY KEY REFERENCES proc_submissions,
  cost          jsonb NOT NULL,
  fx_date       text,
  computed_at   timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS proc_submission_costs_immutable ON proc_submission_costs;
CREATE TRIGGER proc_submission_costs_immutable BEFORE UPDATE OR DELETE ON proc_submission_costs FOR EACH ROW EXECUTE FUNCTION proc_immutable();

CREATE TABLE IF NOT EXISTS proc_openings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES proc_projects,
  envelope    text NOT NULL CHECK (envelope IN ('technical','commercial')),
  round       int NOT NULL DEFAULT 1,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  participants jsonb NOT NULL,
  submissions jsonb NOT NULL,
  hash        text NOT NULL,
  UNIQUE (project_id, envelope, round)
);
DROP TRIGGER IF EXISTS proc_openings_immutable ON proc_openings;
CREATE TRIGGER proc_openings_immutable BEFORE UPDATE OR DELETE ON proc_openings FOR EACH ROW EXECUTE FUNCTION proc_immutable();
CREATE TABLE IF NOT EXISTS proc_opening_votes (
  project_id uuid NOT NULL REFERENCES proc_projects,
  envelope   text NOT NULL,
  round      int NOT NULL DEFAULT 1,
  user_id    uuid NOT NULL REFERENCES users,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, envelope, round, user_id)
);
CREATE TABLE IF NOT EXISTS proc_breakglass (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES proc_projects,
  actor_id   uuid NOT NULL REFERENCES users,
  submission_id uuid REFERENCES proc_submissions,
  envelope   text,
  reason     text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ evaluation
CREATE TABLE IF NOT EXISTS proc_gates (
  proposal_id uuid NOT NULL REFERENCES proc_proposals,
  gate_key    text NOT NULL,
  result      text NOT NULL CHECK (result IN ('pass','fail','pending')),
  reason      text,
  decided_by  uuid REFERENCES users,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, gate_key)
);
CREATE TABLE IF NOT EXISTS proc_assignments (
  project_id  uuid NOT NULL REFERENCES proc_projects,
  user_id     uuid NOT NULL REFERENCES users,
  section     text NOT NULL CHECK (section IN ('technical','commercial')),
  criteria    text[],                                      -- null = all criteria of the section
  lot_codes   text[],
  blind       boolean NOT NULL DEFAULT false,
  weight      numeric(6,3) NOT NULL DEFAULT 1 CHECK (weight > 0),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','recused','reassigned')),
  note        text,
  assigned_by uuid NOT NULL REFERENCES users,
  PRIMARY KEY (project_id, user_id, section)
);
CREATE TABLE IF NOT EXISTS proc_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES proc_projects,
  submission_id uuid NOT NULL REFERENCES proc_submissions,
  reviewer_id   uuid NOT NULL REFERENCES users,
  criterion_key text NOT NULL,
  lot_code      text,
  score         numeric(8,3),
  na            boolean NOT NULL DEFAULT false,
  rationale     text,
  evidence      jsonb,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','locked')),
  locked_at     timestamptz,
  version       int NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, reviewer_id, criterion_key),
  CHECK ((na AND score IS NULL) OR (NOT na AND score IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS proc_scores_project ON proc_scores (project_id, submission_id);
CREATE TABLE IF NOT EXISTS proc_consensus (
  submission_id uuid NOT NULL REFERENCES proc_submissions,
  criterion_key text NOT NULL,
  score         numeric(8,3) NOT NULL,
  rationale     text NOT NULL,
  chair_id      uuid NOT NULL REFERENCES users,
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, criterion_key)
);
CREATE TABLE IF NOT EXISTS proc_rankings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES proc_projects,
  round       int NOT NULL DEFAULT 1,
  rubric_version int NOT NULL,
  rows        jsonb NOT NULL,
  blockers    jsonb NOT NULL DEFAULT '[]',
  committed_by uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS proc_rankings_immutable ON proc_rankings;
CREATE TRIGGER proc_rankings_immutable BEFORE UPDATE OR DELETE ON proc_rankings FOR EACH ROW EXECUTE FUNCTION proc_immutable();
CREATE TABLE IF NOT EXISTS proc_rounds (
  project_id  uuid NOT NULL REFERENCES proc_projects,
  n           int NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('initial','clarification','demo','site_assessment','bafo')),
  invited     uuid[] NOT NULL DEFAULT '{}',
  closes_at   timestamptz,
  note        text,
  created_by  uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, n)
);
CREATE TABLE IF NOT EXISTS proc_ai_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES proc_projects,
  user_id     uuid NOT NULL REFERENCES users,
  purpose     text NOT NULL,
  model       text,
  input_hash  text NOT NULL,
  output      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ award, acceptance, orders, commitments
CREATE TABLE IF NOT EXISTS proc_scenarios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES proc_projects,
  ranking_id  uuid NOT NULL REFERENCES proc_rankings,
  kind        text NOT NULL,
  constraints jsonb NOT NULL DEFAULT '{}',
  result      jsonb NOT NULL,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS proc_awards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES proc_projects,
  scenario_id uuid NOT NULL REFERENCES proc_scenarios,
  approval_id uuid REFERENCES proc_approvals,
  status      text NOT NULL DEFAULT 'approval_pending' CHECK (status IN ('approval_pending','approved','notified','partially_accepted','accepted','declined','cancelled','no_award')),
  rationale   text NOT NULL,
  rubric_version int NOT NULL,
  rfp_version int NOT NULL,
  snapshot    jsonb NOT NULL,
  recommended_by uuid NOT NULL REFERENCES users,
  notified_at timestamptz,
  accept_after timestamptz,
  accept_by   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- one award in flight at a time; a follow-up award (reserve bidder, unfilled lot) is allowed once the previous one is final
CREATE UNIQUE INDEX IF NOT EXISTS proc_awards_live ON proc_awards (project_id) WHERE status IN ('approval_pending','approved','notified');
CREATE TABLE IF NOT EXISTS proc_award_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id    uuid NOT NULL REFERENCES proc_awards,
  project_id  uuid NOT NULL REFERENCES proc_projects,
  lot_code    text NOT NULL,
  entity_id   uuid NOT NULL REFERENCES supplier_entities,
  proposal_id uuid NOT NULL REFERENCES proc_proposals,
  submission_id uuid NOT NULL REFERENCES proc_submissions,
  qty         numeric(14,4) NOT NULL CHECK (qty > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency    text NOT NULL,
  status      text NOT NULL DEFAULT 'provisional' CHECK (status IN ('provisional','accepted','declined','expired','cancelled')),
  responded_by uuid REFERENCES users,
  responded_at timestamptz,
  decline_reason text,
  UNIQUE (award_id, lot_code, entity_id)
);
CREATE INDEX IF NOT EXISTS proc_award_lines_project ON proc_award_lines (project_id, lot_code) WHERE status IN ('provisional','accepted');
CREATE TABLE IF NOT EXISTS proc_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref         text NOT NULL UNIQUE,
  project_id  uuid NOT NULL REFERENCES proc_projects,
  award_line_id uuid NOT NULL UNIQUE REFERENCES proc_award_lines,       -- exactly one order per accepted award line
  organisation_id uuid REFERENCES organisations,
  buyer_user_id uuid NOT NULL REFERENCES users,
  event_id    uuid REFERENCES events,
  entity_id   uuid NOT NULL REFERENCES supplier_entities,
  lot_code    text NOT NULL,
  scope       jsonb NOT NULL,                                           -- immutable snapshot: RFP version, lot, proposal version, ranking, approvals
  amount_minor bigint NOT NULL,
  currency    text NOT NULL,
  contract_type text NOT NULL,
  prep_start  date, service_start date, service_end date, teardown_end date,
  ceiling_minor bigint,
  status      text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','in_progress','completed','cancelled')),
  contract_status text NOT NULL DEFAULT 'pending' CHECK (contract_status IN ('pending','agreed','signed_recorded')),
  cancelled_reason text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proc_orders_entity ON proc_orders (entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS proc_orders_project ON proc_orders (project_id);
CREATE TABLE IF NOT EXISTS proc_commitments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL UNIQUE REFERENCES proc_orders,                -- one financial commitment per order
  event_id    uuid REFERENCES events,
  budget_line_id uuid REFERENCES event_budget_lines,
  amount_minor bigint NOT NULL,
  currency    text NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE event_budget_lines ADD COLUMN IF NOT EXISTS proc_order_id uuid REFERENCES proc_orders;
CREATE UNIQUE INDEX IF NOT EXISTS event_budget_lines_proc_order ON event_budget_lines (proc_order_id) WHERE proc_order_id IS NOT NULL AND status <> 'void';
CREATE TABLE IF NOT EXISTS proc_calloffs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES proc_orders,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  description text NOT NULL,
  service_date date,
  requested_by uuid NOT NULL REFERENCES users,
  status      text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','cancelled')),
  idempotency_key text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS proc_calloffs_idem ON proc_calloffs (order_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS proc_appeals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES proc_projects,
  entity_id   uuid NOT NULL REFERENCES supplier_entities,
  proposal_id uuid NOT NULL REFERENCES proc_proposals,
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','dismissed')),
  decision    text,
  decided_by  uuid REFERENCES users,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id)
);
CREATE TABLE IF NOT EXISTS proc_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES proc_projects,
  kind        text NOT NULL,
  ref_id      uuid,
  audience    text NOT NULL,
  snapshot    jsonb NOT NULL,
  sha256      text NOT NULL,
  issued_by   uuid REFERENCES users,
  issued_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS proc_documents_once ON proc_documents (project_id, kind, coalesce(ref_id, '00000000-0000-0000-0000-000000000000'::uuid), audience);
DROP TRIGGER IF EXISTS proc_documents_immutable ON proc_documents;
CREATE TRIGGER proc_documents_immutable BEFORE UPDATE OR DELETE ON proc_documents FOR EACH ROW EXECUTE FUNCTION proc_immutable();

-- ------------------------------------------------------------------ discovery helpers
CREATE TABLE IF NOT EXISTS tender_saved (
  user_id    uuid NOT NULL REFERENCES users,
  project_id uuid NOT NULL REFERENCES proc_projects,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);
CREATE TABLE IF NOT EXISTS tender_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users,
  category    text,
  sport_slug  text,
  region      text,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tender_alerts_user ON tender_alerts (user_id) WHERE archived_at IS NULL;

-- asynchronous, bounded exports (report CSV/XLSX and tender packs): built by the worker, stored encrypted, downloaded by their requester only
CREATE TABLE IF NOT EXISTS proc_exports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users,
  kind         text NOT NULL CHECK (kind IN ('report','tender_pack')),
  format       text NOT NULL CHECK (format IN ('csv','xlsx','zip')),
  params       jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','ready','failed')),
  name         text,
  mime         text,
  stored       text,
  row_count    int,
  truncated    boolean NOT NULL DEFAULT false,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS proc_exports_user ON proc_exports (user_id, created_at DESC);
