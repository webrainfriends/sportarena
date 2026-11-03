-- Governance cases & sporting discipline (#479 / #563). Additive only; nothing is deleted or rewritten.
-- ONE case table (gov_cases) carries discipline, appeals, eligibility disputes, protests, licence issues and waivers; sanctions and service live beside it.
-- The platform support queue (cases) and integrity matters (int_*) are untouched: they are linked to by reference, never copied.

-- Versioned disciplinary policy per competition (what accumulates, what it costs, how long to appeal). Immutable: publish a new version.
CREATE TABLE IF NOT EXISTS disc_policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES comp_competitions,
  version        int  NOT NULL CHECK (version >= 1),
  rules          jsonb NOT NULL,
  note           text CHECK (note IS NULL OR length(note) <= 500),
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (competition_id, version)
);
DROP TRIGGER IF EXISTS disc_policies_immutable ON disc_policies;
CREATE TRIGGER disc_policies_immutable BEFORE UPDATE OR DELETE ON disc_policies FOR EACH ROW EXECUTE FUNCTION gov_immutable();

CREATE TABLE IF NOT EXISTS gov_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('discipline','appeal','eligibility_dispute','protest','licence_issue','waiver')),
  status          text NOT NULL DEFAULT 'received' CHECK (status IN ('received','under_review','interim','decided','appealed','closed','dismissed','withdrawn')),
  category        text NOT NULL CHECK (length(category) BETWEEN 2 AND 60),            -- caution, dismissal, misconduct, protest_result, waiver_request ...
  competition_id  uuid REFERENCES comp_competitions,
  season_id       uuid REFERENCES comp_seasons,
  fixture_id      uuid REFERENCES fixtures,
  sport_id        uuid REFERENCES sports,
  subject_user_id uuid REFERENCES users,                                             -- the accused / applicant / protested person
  subject_team_id uuid REFERENCES teams,
  subject_role    text CHECK (subject_role IS NULL OR subject_role IN ('player','coach','official','team','organisation')),
  parent_case_id  uuid REFERENCES gov_cases,                                          -- an appeal points at the decided case
  policy_id       uuid REFERENCES disc_policies,
  policy_version  int,
  source          jsonb NOT NULL DEFAULT '{}'::jsonb,                                 -- { type: 'match_event'|'official_report'|'manual', id } — a reference, never a copy of the match log
  summary_enc     text,                                                               -- allegation / grounds, field-level encrypted
  decision_enc    text,                                                               -- panel reasons, field-level encrypted
  auto            boolean NOT NULL DEFAULT false,                                     -- raised by a policy threshold, not a person
  outcome         text CHECK (outcome IS NULL OR outcome IN ('upheld','reduced','overturned','remitted','granted','refused','no_case')),
  appeal_deadline date,
  stay            boolean NOT NULL DEFAULT false,                                     -- sanction stayed while an appeal is heard
  needs_review    boolean NOT NULL DEFAULT false,                                     -- the canonical source was corrected: re-evaluate, never silently delete
  review_reason   text CHECK (review_reason IS NULL OR length(review_reason) <= 300),
  opened_by       uuid NOT NULL REFERENCES users,
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  row_version     int  NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'appeal' OR parent_case_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS gov_cases_competition ON gov_cases (competition_id, kind, status);
CREATE INDEX IF NOT EXISTS gov_cases_subject ON gov_cases (subject_user_id, kind, status);
CREATE INDEX IF NOT EXISTS gov_cases_fixture ON gov_cases (fixture_id);
-- a canonical incident feeds ONE case: a retry cannot open it twice
CREATE UNIQUE INDEX IF NOT EXISTS gov_cases_one_per_source ON gov_cases ((source->>'type'), (source->>'id'), kind, subject_user_id)
  WHERE source ? 'id' AND parent_case_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS gov_cases_one_appeal ON gov_cases (parent_case_id) WHERE kind = 'appeal' AND status NOT IN ('withdrawn','dismissed');

CREATE TABLE IF NOT EXISTS gov_case_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES gov_cases,
  version     int  NOT NULL,
  action      text NOT NULL CHECK (action IN ('opened','auto_raised','assigned','interim_set','decision','sanction_issued','sanction_amended','appeal_filed','appeal_decided','stay_set','flagged','review_cleared','withdrawn','closed','dismissed','fine_state','linked')),
  from_status text,
  to_status   text,
  actor_id    uuid REFERENCES users,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gov_case_events_case ON gov_case_events (case_id, created_at, id);
DROP TRIGGER IF EXISTS gov_case_events_immutable ON gov_case_events;
CREATE TRIGGER gov_case_events_immutable BEFORE UPDATE OR DELETE ON gov_case_events FOR EACH ROW EXECUTE FUNCTION gov_immutable();

-- Links from a case to the canonical record it concerns (a licence, an affiliation, a registration, an integrity matter ...). References only.
CREATE TABLE IF NOT EXISTS gov_case_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES gov_cases,
  entity_type text NOT NULL CHECK (entity_type IN ('fed_licence','fed_affiliation','reg_registration','reg_exception','fixture','match_event','int_case','support_case','transfer')),
  entity_id   uuid NOT NULL,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, entity_type, entity_id)
);
DROP TRIGGER IF EXISTS gov_case_links_immutable ON gov_case_links;
CREATE TRIGGER gov_case_links_immutable BEFORE UPDATE OR DELETE ON gov_case_links FOR EACH ROW EXECUTE FUNCTION gov_immutable();

CREATE TABLE IF NOT EXISTS disc_sanctions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid NOT NULL REFERENCES gov_cases,
  kind            text NOT NULL CHECK (kind IN ('warning','match_suspension','date_suspension','competition_ban','role_suspension','fine','points_deduction','other')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('interim','active','stayed','served','overturned','expired')),
  subject_user_id uuid REFERENCES users,
  team_id         uuid REFERENCES teams,                                              -- the team whose fixtures count towards service
  competition_id  uuid NOT NULL REFERENCES comp_competitions,
  season_id       uuid REFERENCES comp_seasons,
  scope           text NOT NULL DEFAULT 'competition' CHECK (scope IN ('competition','sport')),
  sport_id        uuid REFERENCES sports,
  matches         int  CHECK (matches IS NULL OR matches BETWEEN 1 AND 100),
  starts_on       date NOT NULL,
  starts_after    timestamptz,                                                         -- service counts fixtures scheduled strictly after this instant (the match the incident happened in is not served)
  ends_on         date,
  amount_minor    bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency        text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  fine_state      text CHECK (fine_state IS NULL OR fine_state IN ('imposed','invoiced','paid','waived')),   -- money state, never the sporting state
  invoice_ref     text CHECK (invoice_ref IS NULL OR length(invoice_ref) <= 120),
  points          int  CHECK (points IS NULL OR points BETWEEN 1 AND 100),
  adjustment_id   uuid REFERENCES comp_adjustments,                                    -- a points deduction goes through the competition adjustment mechanism
  replaces_id     uuid REFERENCES disc_sanctions,                                      -- an amended sanction supersedes, it is not edited
  superseded_at   timestamptz,
  public          boolean NOT NULL DEFAULT false,
  reason_enc      text,
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'match_suspension' OR (matches IS NOT NULL AND team_id IS NOT NULL)),
  CHECK (kind <> 'fine' OR (amount_minor IS NOT NULL AND currency IS NOT NULL)),
  CHECK (kind <> 'points_deduction' OR (points IS NOT NULL AND team_id IS NOT NULL)),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS disc_sanctions_subject ON disc_sanctions (subject_user_id, status) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS disc_sanctions_case ON disc_sanctions (case_id);
CREATE INDEX IF NOT EXISTS disc_sanctions_competition ON disc_sanctions (competition_id, status);

-- sanctions are never deleted
CREATE OR REPLACE FUNCTION disc_sanctions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'sanctions are never deleted' USING ERRCODE = '23514'; END IF;
  IF (NEW.kind, NEW.subject_user_id, NEW.matches, NEW.starts_on, NEW.case_id) IS DISTINCT FROM (OLD.kind, OLD.subject_user_id, OLD.matches, OLD.starts_on, OLD.case_id) THEN
    RAISE EXCEPTION 'a sanction is amended by superseding it, not by editing it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS disc_sanctions_guard ON disc_sanctions;
CREATE TRIGGER disc_sanctions_guard BEFORE UPDATE OR DELETE ON disc_sanctions FOR EACH ROW EXECUTE FUNCTION disc_sanctions_guard();
