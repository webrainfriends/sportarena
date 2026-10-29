-- Sports agent & player representation (issue #484). Additive only: new tables, indexes and trigger functions, plus one widened CHECK list
-- (verification_cases.type gains 'agent'). Nothing is dropped, narrowed, rewritten or deleted.
-- Reused, not duplicated: users / organisations / sports (identity), verification_cases (type 'agent', what was checked), player_contracts +
-- player_contract_entries (#333), sponsorships + sponsorship_payments (agreements), billboard_posts / billboard_responses (#67), guardian_links and
-- consent (youth), notifications, audit_log. New here is only the *mandate layer*: who may act for an athlete, in which scope, with what data,
-- under which commission and conflict disclosures. There is no second contract, transfer, opportunity, payment, review or legal table.
-- Rollback: stop using the capabilities (revert the code). Dropping the tables is a deliberate maintainer decision, never automatic.

ALTER TABLE verification_cases DROP CONSTRAINT IF EXISTS verification_cases_type_check;
ALTER TABLE verification_cases ADD CONSTRAINT verification_cases_type_check
  CHECK (type IN ('gamer','coach','physio','doctor','sponsor','event','insurer','lawyer','recruiter','referee','agent'));

-- ---------------------------------------------------------------- agent / agency identity
-- One profile per accountable person. An agency profile points at its organisation; its principal answers for it.
CREATE TABLE IF NOT EXISTS agent_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('individual','agency')),
  user_id         uuid NOT NULL REFERENCES users,
  organisation_id uuid REFERENCES organisations,
  display_name    text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  bio             text CHECK (bio IS NULL OR length(bio) <= 1000),
  sport_ids       uuid[] NOT NULL DEFAULT '{}',
  markets         text[] NOT NULL DEFAULT '{}',              -- ISO country codes, or WW for worldwide
  is_public       boolean NOT NULL DEFAULT false,            -- listed in the directory only while true
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  suspended_reason text CHECK (suspended_reason IS NULL OR length(suspended_reason) <= 500),
  suspended_at    timestamptz,
  suspended_by    uuid REFERENCES users,
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id),
  CHECK ((kind = 'agency') = (organisation_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS agent_profiles_org ON agent_profiles (organisation_id) WHERE organisation_id IS NOT NULL;

-- Licence / registration declarations. The reference is encrypted (it identifies a person); only the last four characters are shown publicly.
-- verified_case_id is set only when a platform reviewer approved the agent's verification with the "standing checked" item ticked; it states
-- what was checked through the case's checklist and never implies universal licensing.
CREATE TABLE IF NOT EXISTS agent_licences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agent_profiles,
  issuing_body    text NOT NULL CHECK (length(issuing_body) BETWEEN 2 AND 120),
  grade           text NOT NULL DEFAULT '' CHECK (length(grade) <= 80),
  jurisdiction    text NOT NULL CHECK (jurisdiction ~ '^([A-Z]{2}|WW)$'),
  sport_id        uuid REFERENCES sports,
  reference_enc   text,
  reference_last4 text CHECK (reference_last4 IS NULL OR length(reference_last4) <= 4),
  valid_from      date,
  valid_to        date,
  status          text NOT NULL DEFAULT 'declared' CHECK (status IN ('declared','withdrawn')),
  verified_case_id uuid REFERENCES verification_cases,
  verified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS agent_licences_agent ON agent_licences (agent_id, status);

-- Delegated agency staff. Staff act only inside the principal's mandates, only for what the athlete allowed (allow_staff on the mandate) and
-- only with the permissions listed here. Removing staff keeps the row (status 'removed') and the history of what they did.
CREATE TABLE IF NOT EXISTS agent_staff (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agent_profiles,
  user_id         uuid NOT NULL REFERENCES users,
  permissions     text[] NOT NULL DEFAULT '{view}' CHECK (permissions <@ ARRAY['view','outreach','negotiate','commission']::text[] AND cardinality(permissions) > 0),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  added_by        uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  UNIQUE (agent_id, user_id)
);

-- Declared interests (a club, sponsor, supplier or related party the agent or agency has a stake in). Compared with every deal the agent joins.
CREATE TABLE IF NOT EXISTS agent_interests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agent_profiles,
  kind            text NOT NULL CHECK (kind IN ('club','sponsor','supplier','related_party','other')),
  target_type     text CHECK (target_type IN ('team','organisation','sponsor','user')),
  target_id       uuid,
  label           text NOT NULL CHECK (length(label) BETWEEN 2 AND 160),
  note_enc        text,
  declared_by     uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);
CREATE INDEX IF NOT EXISTS agent_interests_agent ON agent_interests (agent_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS agent_interests_target ON agent_interests (target_type, target_id) WHERE ended_at IS NULL AND target_id IS NOT NULL;

-- ---------------------------------------------------------------- mandates (versioned, signed by every required party)
CREATE SEQUENCE IF NOT EXISTS representation_mandate_no_seq;
CREATE TABLE IF NOT EXISTS representation_mandates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_no      text NOT NULL UNIQUE,
  athlete_id      uuid NOT NULL REFERENCES users,
  agent_id        uuid NOT NULL REFERENCES agent_profiles,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','proposed','active','declined','withdrawn','revoked','expired')),
  current_version int,                                        -- the version in force (NULL until a first version is signed by everyone)
  row_version     int NOT NULL DEFAULT 1,
  show_on_profile boolean NOT NULL DEFAULT false,             -- the athlete's opt-in to show this representation on the public profile
  started_at      timestamptz,
  ended_at        timestamptz,
  end_kind        text CHECK (end_kind IN ('revoked_by_athlete','revoked_by_guardian','ended_by_agent','expired','agent_removed')),
  end_reason      text CHECK (end_reason IS NULL OR length(end_reason) <= 500),
  ended_by        uuid REFERENCES users,
  client_key      text CHECK (client_key IS NULL OR length(client_key) BETWEEN 1 AND 64),
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS representation_mandates_athlete ON representation_mandates (athlete_id, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS representation_mandates_agent ON representation_mandates (agent_id, status, created_at DESC, id);
CREATE UNIQUE INDEX IF NOT EXISTS representation_mandates_client_key ON representation_mandates (created_by, client_key) WHERE client_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS representation_mandate_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id      uuid NOT NULL REFERENCES representation_mandates,
  version         int NOT NULL CHECK (version >= 1),
  kind            text NOT NULL CHECK (kind IN ('initial','amendment','renewal')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','proposed','in_force','superseded','declined','withdrawn')),
  based_on        int,
  sport_ids       uuid[] NOT NULL CHECK (cardinality(sport_ids) BETWEEN 1 AND 300),
  territories     text[] NOT NULL CHECK (cardinality(territories) BETWEEN 1 AND 250),
  purposes        text[] NOT NULL CHECK (cardinality(purposes) > 0 AND purposes <@ ARRAY['opportunity_outreach','contract_negotiation','transfer_assistance','sponsorship_commercial','media_endorsement']::text[]),
  exclusive       boolean NOT NULL DEFAULT false,
  starts_on       date NOT NULL,
  ends_on         date NOT NULL,
  notice_days     int CHECK (notice_days IS NULL OR notice_days BETWEEN 0 AND 365),
  notice_terms_ref text CHECK (notice_terms_ref IS NULL OR length(notice_terms_ref) <= 200),
  data_access     text[] NOT NULL DEFAULT '{}' CHECK (data_access <@ ARRAY['public_passport','recruitment_materials','opportunity_applications','contract_workflow','transfer_workflow','sponsorship_discussions']::text[]),
  contact_actions text[] NOT NULL DEFAULT '{}' CHECK (contact_actions <@ ARRAY['share_opportunities','express_interest','draft_applications','manage_conversations','track_pipeline']::text[]),
  allow_staff     boolean NOT NULL DEFAULT false,
  licence_id      uuid REFERENCES agent_licences,             -- the registration this mandate relies on; if it lapses, access stops
  commission      jsonb NOT NULL DEFAULT '[]',
  reason          text CHECK (reason IS NULL OR length(reason) <= 500),
  changes         jsonb NOT NULL DEFAULT '[]',
  required_parties text[] NOT NULL DEFAULT '{athlete,agent}',
  proposed_by     uuid NOT NULL REFERENCES users,
  proposed_at     timestamptz,
  decided_at      timestamptz,
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mandate_id, version),
  CHECK (ends_on >= starts_on)
);
CREATE UNIQUE INDEX IF NOT EXISTS representation_versions_pending ON representation_mandate_versions (mandate_id) WHERE status = 'proposed';
CREATE UNIQUE INDEX IF NOT EXISTS representation_versions_in_force ON representation_mandate_versions (mandate_id) WHERE status = 'in_force';

CREATE OR REPLACE FUNCTION representation_versions_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.sport_ids IS DISTINCT FROM OLD.sport_ids OR NEW.territories IS DISTINCT FROM OLD.territories OR NEW.purposes IS DISTINCT FROM OLD.purposes
       OR NEW.exclusive <> OLD.exclusive OR NEW.starts_on <> OLD.starts_on OR NEW.ends_on <> OLD.ends_on OR NEW.data_access IS DISTINCT FROM OLD.data_access
       OR NEW.contact_actions IS DISTINCT FROM OLD.contact_actions OR NEW.allow_staff <> OLD.allow_staff OR NEW.licence_id IS DISTINCT FROM OLD.licence_id
       OR NEW.commission IS DISTINCT FROM OLD.commission OR NEW.notice_days IS DISTINCT FROM OLD.notice_days OR NEW.notice_terms_ref IS DISTINCT FROM OLD.notice_terms_ref
       OR NEW.version <> OLD.version) THEN
    RAISE EXCEPTION 'a mandate version is frozen once it has been proposed; propose an amendment instead' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS representation_versions_frozen ON representation_mandate_versions;
CREATE TRIGGER representation_versions_frozen BEFORE UPDATE ON representation_mandate_versions FOR EACH ROW EXECUTE FUNCTION representation_versions_frozen();

CREATE TABLE IF NOT EXISTS representation_signatures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id      uuid NOT NULL REFERENCES representation_mandate_versions,
  party           text NOT NULL CHECK (party IN ('athlete','guardian','agent')),
  signer_id       uuid NOT NULL REFERENCES users,
  decision        text NOT NULL CHECK (decision IN ('signed','declined')),
  comment         text CHECK (comment IS NULL OR length(comment) <= 500),
  signed_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, party)
);

-- ---------------------------------------------------------------- item-level consent (what, exactly, the agent may see or join)
CREATE TABLE IF NOT EXISTS representation_grants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id      uuid NOT NULL REFERENCES representation_mandates,
  category        text NOT NULL CHECK (category IN ('recruitment_materials','opportunity_applications','contract_workflow','transfer_workflow','sponsorship_discussions')),
  subject_type    text NOT NULL CHECK (subject_type IN ('passport_video','billboard_response','player_contract','sponsorship','transfer')),
  subject_id      uuid NOT NULL,
  level           text NOT NULL DEFAULT 'view' CHECK (level IN ('view','participate')),
  granted_by      uuid NOT NULL REFERENCES users,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users
);
CREATE UNIQUE INDEX IF NOT EXISTS representation_grants_live ON representation_grants (mandate_id, subject_type, subject_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS representation_grants_subject ON representation_grants (subject_type, subject_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- opportunity pipeline and delegated actions
CREATE TABLE IF NOT EXISTS representation_pipeline (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id      uuid NOT NULL REFERENCES representation_mandates,
  post_id         uuid NOT NULL REFERENCES billboard_posts,    -- the canonical opportunity; nothing is copied
  stage           text NOT NULL DEFAULT 'shared' CHECK (stage IN ('shared','interest_requested','drafting','awaiting_athlete','submitted','outcome','dropped')),
  athlete_response text NOT NULL DEFAULT 'pending' CHECK (athlete_response IN ('pending','interested','not_interested')),
  draft_message   text CHECK (draft_message IS NULL OR length(draft_message) <= 500),
  draft_sections  text[] NOT NULL DEFAULT '{}',
  response_id     uuid REFERENCES billboard_responses,         -- set when the athlete (or guardian) submitted the application
  note_enc        text,
  added_by        uuid NOT NULL REFERENCES users,
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mandate_id, post_id)
);

CREATE TABLE IF NOT EXISTS representation_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id      uuid NOT NULL REFERENCES representation_mandates,
  pipeline_id     uuid REFERENCES representation_pipeline,
  channel         text NOT NULL CHECK (channel IN ('call','email','meeting','message','other')),
  counterparty    text NOT NULL CHECK (length(counterparty) BETWEEN 2 AND 160),
  summary_enc     text NOT NULL,
  happened_on     date NOT NULL,
  logged_by       uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Actions the agent asks the athlete to approve. High-impact commitments (accepting a position or offer, signing a contract) are never an
-- approval kind: they stay with the athlete or guardian in the canonical workflow.
CREATE TABLE IF NOT EXISTS representation_approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id      uuid NOT NULL REFERENCES representation_mandates,
  kind            text NOT NULL CHECK (kind IN ('express_interest','submit_application')),
  pipeline_id     uuid REFERENCES representation_pipeline,
  summary         text NOT NULL CHECK (length(summary) BETWEEN 2 AND 300),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','cancelled','expired')),
  requested_by    uuid NOT NULL REFERENCES users,
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  decision_note   text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  result          jsonb NOT NULL DEFAULT '{}',
  expires_at      timestamptz NOT NULL,
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS representation_approvals_mandate ON representation_approvals (mandate_id, status, created_at DESC);

-- ---------------------------------------------------------------- negotiation participation (#333 stays the only contract table)
CREATE TABLE IF NOT EXISTS representation_contract_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id      uuid NOT NULL REFERENCES representation_mandates,
  contract_id     uuid NOT NULL REFERENCES player_contracts,
  version_no      int NOT NULL,
  state           text NOT NULL DEFAULT 'to_review' CHECK (state IN ('to_review','reviewing','reviewed','changes_requested')),
  updated_by      uuid REFERENCES users,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mandate_id, contract_id, version_no)
);

CREATE TABLE IF NOT EXISTS representation_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id      uuid NOT NULL REFERENCES representation_mandates,
  contract_id     uuid NOT NULL REFERENCES player_contracts,
  version_no      int,
  kind            text NOT NULL DEFAULT 'note' CHECK (kind IN ('note','suggestion')),
  visibility      text NOT NULL CHECK (visibility IN ('agent_only','athlete','all_parties')),
  body_enc        text NOT NULL,
  suggestion      jsonb NOT NULL DEFAULT '{}',                 -- a proposed change in words and numbers; never applied to the contract by itself
  author_id       uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS representation_notes_contract ON representation_notes (contract_id, created_at);

-- ---------------------------------------------------------------- deals the agent assisted, and the commission account of each
CREATE TABLE IF NOT EXISTS representation_deals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id      uuid NOT NULL REFERENCES representation_mandates,
  term_key        text NOT NULL,
  term_version    int NOT NULL,                                -- the mandate version whose commission term applies, frozen at link time
  deal_type       text NOT NULL CHECK (deal_type IN ('player_contract','sponsorship')),
  deal_id         uuid NOT NULL,
  deal_ref        text,
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','declined','ended')),
  proposed_by     uuid NOT NULL REFERENCES users,
  confirmed_by    uuid REFERENCES users,
  confirmed_at    timestamptz,
  ended_at        timestamptz,
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mandate_id, deal_type, deal_id)                      -- a deal is counted once per mandate, whatever its amendments
);
CREATE INDEX IF NOT EXISTS representation_deals_deal ON representation_deals (deal_type, deal_id);

CREATE TABLE IF NOT EXISTS representation_milestones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id         uuid NOT NULL REFERENCES representation_deals,
  milestone_key   text NOT NULL,
  status          text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','confirmed','rejected')),
  claimed_by      uuid NOT NULL REFERENCES users,
  evidence_note   text CHECK (evidence_note IS NULL OR length(evidence_note) <= 500),
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, milestone_key)
);

-- Append-only commission ledger. owed = accrual+adjustment+refund; invoiced; reported (the payer says it paid); settled (the agent confirmed receipt).
CREATE TABLE IF NOT EXISTS representation_commission_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigserial NOT NULL,
  deal_id         uuid NOT NULL REFERENCES representation_deals,
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  kind            text NOT NULL CHECK (kind IN ('accrual','adjustment','refund','invoiced','payment_reported','payment_settled')),
  amount_cents    bigint NOT NULL CHECK (amount_cents <> 0),
  basis_cents     bigint,                                      -- what the calculation was based on (accrual lines)
  calc            jsonb NOT NULL DEFAULT '{}',                 -- term, rate, threshold, cap, deal version: the exact inputs
  statement_id    uuid,
  reference       text CHECK (reference IS NULL OR length(reference) <= 120),
  reason          text CHECK (reason IS NULL OR length(reason) <= 500),
  idem_key        text NOT NULL CHECK (length(idem_key) BETWEEN 1 AND 200),
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, idem_key)
);
CREATE INDEX IF NOT EXISTS representation_commission_entries_deal ON representation_commission_entries (deal_id, seq);
CREATE OR REPLACE FUNCTION representation_commission_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'the commission ledger is append-only; post a compensating entry' USING ERRCODE = '23514';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS representation_commission_append_only ON representation_commission_entries;
CREATE TRIGGER representation_commission_append_only BEFORE UPDATE OR DELETE ON representation_commission_entries FOR EACH ROW EXECUTE FUNCTION representation_commission_append_only();

CREATE SEQUENCE IF NOT EXISTS representation_statement_no_seq;
CREATE TABLE IF NOT EXISTS representation_statements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_no    text NOT NULL UNIQUE,
  deal_id         uuid NOT NULL REFERENCES representation_deals,
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  due_on          date,
  lines           jsonb NOT NULL,                              -- immutable snapshot of what was invoiced
  sha256          text NOT NULL,
  status          text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void')),
  issued_by       uuid NOT NULL REFERENCES users,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  voided_at       timestamptz,
  void_reason     text CHECK (void_reason IS NULL OR length(void_reason) <= 500)
);
CREATE INDEX IF NOT EXISTS representation_statements_deal ON representation_statements (deal_id, issued_at);

-- ---------------------------------------------------------------- conflicts of interest (disclosed, decided by people, auditable)
CREATE TABLE IF NOT EXISTS representation_conflicts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agent_profiles,
  athlete_id      uuid NOT NULL REFERENCES users,
  mandate_id      uuid REFERENCES representation_mandates,
  kind            text NOT NULL CHECK (kind IN ('opposing_sides','agent_interest','dual_representation','related_party')),
  subject_type    text CHECK (subject_type IN ('player_contract','sponsorship','transfer','mandate')),
  subject_id      uuid,
  counterparty    text CHECK (counterparty IS NULL OR length(counterparty) <= 160),
  detail_enc      text,
  raised_by       text NOT NULL CHECK (raised_by IN ('agent','athlete','system')),
  raised_user     uuid REFERENCES users,
  can_acknowledge boolean NOT NULL,                            -- policy at the time: false means only recusal or rejection resolve it
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','recused','rejected','withdrawn')),
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  decision_note_enc text,
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS representation_conflicts_mandate ON representation_conflicts (mandate_id, status);
CREATE INDEX IF NOT EXISTS representation_conflicts_subject ON representation_conflicts (subject_type, subject_id) WHERE subject_id IS NOT NULL;
-- the same automatically detected situation is raised once
CREATE UNIQUE INDEX IF NOT EXISTS representation_conflicts_auto ON representation_conflicts (agent_id, athlete_id, kind, subject_type, subject_id, coalesce(counterparty, '')) WHERE raised_by = 'system' AND status IN ('open','acknowledged');

-- ---------------------------------------------------------------- history of everything that happened under a mandate (append-only)
CREATE TABLE IF NOT EXISTS representation_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigserial NOT NULL,
  mandate_id      uuid NOT NULL REFERENCES representation_mandates,
  actor_id        uuid REFERENCES users,
  actor_side      text NOT NULL CHECK (actor_side IN ('athlete','guardian','agent','staff','system')),
  action          text NOT NULL CHECK (length(action) BETWEEN 2 AND 80),
  subject_type    text,
  subject_id      uuid,
  detail          jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS representation_events_mandate ON representation_events (mandate_id, seq);
CREATE OR REPLACE FUNCTION representation_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'the representation history is append-only' USING ERRCODE = '23514';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS representation_events_append_only ON representation_events;
CREATE TRIGGER representation_events_append_only BEFORE UPDATE OR DELETE ON representation_events FOR EACH ROW EXECUTE FUNCTION representation_events_append_only();
