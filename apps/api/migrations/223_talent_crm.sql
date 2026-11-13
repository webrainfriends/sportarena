-- Talent CRM & Recruiting Pipeline (issue #582). Club-side pipeline with 10-stage lifecycle.
-- Additive only — no DROP, no TRUNCATE, no rewriting existing data.

CREATE TABLE IF NOT EXISTS talent_crm_prospects (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid        NOT NULL REFERENCES organisations(id),
  athlete_id            uuid        REFERENCES users(id),
  athlete_name_enc      text,
  sport_id              uuid        NOT NULL REFERENCES sports(id),
  source_kind           text        NOT NULL DEFAULT 'manual' CHECK (source_kind IN ('manual','billboard','scouting','transfer','academy','referral')),
  source_ref_id         uuid,
  stage                 text        NOT NULL DEFAULT 'prospect' CHECK (stage IN ('prospect','identified','watching','scouted','trial','shortlisted','negotiating','offered','signed','rejected')),
  priority              text        NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low','watchlist')),
  position              text,
  notes_enc             text,
  decision_rationale_enc text,
  source_quality_weight int         CHECK (source_quality_weight BETWEEN 1 AND 10),
  handoff_kind          text        CHECK (handoff_kind IN ('opportunity','contract','transfer')),
  handoff_ref_id        uuid,
  created_by            uuid        NOT NULL REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz,
  row_version           int         NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS talent_crm_prospects_org_sport_stage ON talent_crm_prospects(org_id, sport_id, stage) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS talent_crm_prospects_athlete ON talent_crm_prospects(athlete_id) WHERE athlete_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS talent_crm_prospects_org_active ON talent_crm_prospects(org_id, created_at DESC) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS talent_crm_prospect_events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id   uuid        NOT NULL REFERENCES talent_crm_prospects(id),
  action        text        NOT NULL,
  from_stage    text,
  to_stage      text,
  actor_id      uuid        NOT NULL REFERENCES users(id),
  note_enc      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS talent_crm_prospect_events_prospect ON talent_crm_prospect_events(prospect_id, created_at DESC);

CREATE TABLE IF NOT EXISTS talent_crm_scout_assignments (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id   uuid        NOT NULL REFERENCES talent_crm_prospects(id),
  scout_id      uuid        NOT NULL REFERENCES users(id),
  role          text        NOT NULL DEFAULT 'lead' CHECK (role IN ('lead','secondary','observer')),
  assigned_by   uuid        NOT NULL REFERENCES users(id),
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  archived_at   timestamptz
);
CREATE INDEX IF NOT EXISTS talent_crm_assignments_prospect ON talent_crm_scout_assignments(prospect_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS talent_crm_assignments_scout ON talent_crm_scout_assignments(scout_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS talent_crm_evaluation_templates (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid        NOT NULL REFERENCES organisations(id),
  sport_id      uuid        REFERENCES sports(id),
  name          text        NOT NULL,
  criteria      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_by    uuid        NOT NULL REFERENCES users(id),
  archived_at   timestamptz,
  row_version   int         NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS talent_crm_eval_templates_org ON talent_crm_evaluation_templates(org_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS talent_crm_evaluations (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id       uuid        NOT NULL REFERENCES talent_crm_prospects(id),
  scout_id          uuid        NOT NULL REFERENCES users(id),
  template_id       uuid        REFERENCES talent_crm_evaluation_templates(id),
  basis             text        NOT NULL CHECK (basis IN ('live_viewing','video','match_report','trial','profile_only')),
  observed_on       date,
  ratings           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  overall           int         CHECK (overall BETWEEN 0 AND 10),
  notes_enc         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,
  idempotency_key   text        UNIQUE
);
CREATE INDEX IF NOT EXISTS talent_crm_evaluations_prospect ON talent_crm_evaluations(prospect_id, created_at DESC) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS talent_crm_shortlist_boards (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid        NOT NULL REFERENCES organisations(id),
  sport_id      uuid        REFERENCES sports(id),
  position      text,
  name          text        NOT NULL,
  created_by    uuid        NOT NULL REFERENCES users(id),
  archived_at   timestamptz,
  row_version   int         NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS talent_crm_boards_org ON talent_crm_shortlist_boards(org_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS talent_crm_shortlist_board_entries (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id      uuid        NOT NULL REFERENCES talent_crm_shortlist_boards(id),
  prospect_id   uuid        NOT NULL REFERENCES talent_crm_prospects(id),
  rank          int,
  notes_enc     text,
  added_by      uuid        NOT NULL REFERENCES users(id),
  added_at      timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  row_version   int         NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS talent_crm_board_entries_board ON talent_crm_shortlist_board_entries(board_id) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS talent_crm_communications (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id       uuid        NOT NULL REFERENCES talent_crm_prospects(id),
  actor_id          uuid        NOT NULL REFERENCES users(id),
  kind              text        NOT NULL CHECK (kind IN ('note','call','meeting','email','message','decision','trial_outcome','offer_sent','offer_response')),
  summary_enc       text        NOT NULL,
  follow_up_on      date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  idempotency_key   text        UNIQUE
);
CREATE INDEX IF NOT EXISTS talent_crm_communications_prospect ON talent_crm_communications(prospect_id, created_at DESC);
