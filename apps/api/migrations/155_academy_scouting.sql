-- Academy talent scouting & recruitment journey (issue #790). Additive only: new tables and nullable columns. Nothing is dropped, rewritten,
-- narrowed or cascaded. Reused, not duplicated: recruiter_list_entries / recruiter_evaluations / recruiter_access_requests (the Talent CRM: a prospect IS a
-- recruiter list entry held under a live athlete grant), passport_videos (video references are links to the athlete's own approved videos, no copies),
-- youth_consents + guardian links (consent), academy_applications / academy trial sessions / offers (admissions), organisations, sports, notifications, audit_log.
-- Rollback: stop calling the academy-scouting capabilities. The new tables can stay (they hold history); the nullable source_* columns on
-- academy_applications are simply ignored by every earlier screen and query.

-- The academy's own list of where prospects come from (school, club, federation, coach, event...). Archived, never deleted.
CREATE TABLE IF NOT EXISTS academy_referral_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  kind            text NOT NULL CHECK (kind IN ('school','club','federation','coach','agent','event','open_day','self','other')),
  region          text CHECK (region IS NULL OR length(region) <= 80),
  organisation_ref_id uuid REFERENCES organisations,           -- when the partner is itself on the platform
  archived_at     timestamptz,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_referral_sources_name ON academy_referral_sources (organisation_id, lower(name)) WHERE archived_at IS NULL;

-- A scouting campaign: the brief (who we want, where, by when), the evaluation model, safeguarding rules and the committee rules.
CREATE TABLE IF NOT EXISTS academy_scouting_campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  objective       text NOT NULL DEFAULT 'build_intake' CHECK (objective IN ('build_intake','scholarship','pathway_to_pro','talent_id','replace_departures')),
  season_label    text CHECK (season_label IS NULL OR length(season_label) <= 60),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','closed','archived')),
  step_reached    int NOT NULL DEFAULT 1 CHECK (step_reached BETWEEN 1 AND 8),
  -- brief
  sport_ids       uuid[] NOT NULL DEFAULT '{}',
  programme_ids   uuid[] NOT NULL DEFAULT '{}',
  owner_id        uuid REFERENCES users,
  target_places   int CHECK (target_places IS NULL OR target_places BETWEEN 1 AND 10000),
  scholarship_places int CHECK (scholarship_places IS NULL OR scholarship_places >= 0),
  pipeline_target int CHECK (pipeline_target IS NULL OR pipeline_target BETWEEN 1 AND 100000),
  starts_on       date,
  ends_on         date,
  decision_by     date,
  budget_minor    bigint CHECK (budget_minor IS NULL OR budget_minor >= 0),
  currency        text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  cost_centre     text CHECK (cost_centre IS NULL OR length(cost_centre) <= 80),
  -- player profile
  birth_year_min  int CHECK (birth_year_min IS NULL OR birth_year_min BETWEEN 1950 AND 2100),
  birth_year_max  int CHECK (birth_year_max IS NULL OR birth_year_max BETWEEN 1950 AND 2100),
  genders         text[] NOT NULL DEFAULT '{}' CHECK (genders <@ ARRAY['boys','girls','mixed']::text[]),
  dominance       text[] NOT NULL DEFAULT '{}' CHECK (dominance <@ ARRAY['right','left','either']::text[]),
  positions       text[] NOT NULL DEFAULT '{}',
  levels          text[] NOT NULL DEFAULT '{}',
  benchmarks      jsonb NOT NULL DEFAULT '[]',                 -- [{metric, unit, min, ideal}] from the platform measurement catalogue
  flag_relative_age boolean NOT NULL DEFAULT true,
  languages       text[] NOT NULL DEFAULT '{}',
  residency       text CHECK (residency IS NULL OR residency IN ('day','residential','either')),
  requirements    jsonb NOT NULL DEFAULT '{}',                 -- {academic, eligibility_rules}
  -- territory
  regions         text[] NOT NULL DEFAULT '{}',
  event_ids       uuid[] NOT NULL DEFAULT '{}',
  venue_ids       uuid[] NOT NULL DEFAULT '{}',
  referral_source_ids uuid[] NOT NULL DEFAULT '{}',
  scouting_modes  text[] NOT NULL DEFAULT '{}',
  -- evaluation model
  rubric          jsonb NOT NULL DEFAULT '[]',                 -- [{key, label, weight}] weights total 100
  min_evaluations int NOT NULL DEFAULT 2 CHECK (min_evaluations BETWEEN 1 AND 10),
  required_bases  text[] NOT NULL DEFAULT '{}' CHECK (required_bases <@ ARRAY['live_viewing','video','match_report','trial','profile_only']::text[]),
  -- safeguarding
  guardian_consent_required boolean NOT NULL DEFAULT true,
  notes_private   boolean NOT NULL DEFAULT true,
  video_requires_grant boolean NOT NULL DEFAULT true,
  contact_policy  text NOT NULL DEFAULT 'via_guardian' CHECK (contact_policy IN ('via_guardian','via_academy','direct_adult_only')),
  retention_months int NOT NULL DEFAULT 12 CHECK (retention_months BETWEEN 1 AND 120),
  -- committee & pipeline
  committee_quorum int NOT NULL DEFAULT 3 CHECK (committee_quorum BETWEEN 1 AND 15),
  committee_rule  text NOT NULL DEFAULT 'majority' CHECK (committee_rule IN ('majority','unanimous')),
  sla_days        jsonb NOT NULL DEFAULT '{}',                 -- {evaluate, committee, invite, trial}
  launched_at     timestamptz,
  closed_at       timestamptz,
  row_version     int NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  CHECK (birth_year_max IS NULL OR birth_year_min IS NULL OR birth_year_max >= birth_year_min),
  CHECK (scholarship_places IS NULL OR target_places IS NULL OR scholarship_places <= target_places)
);
CREATE INDEX IF NOT EXISTS academy_scouting_campaigns_org ON academy_scouting_campaigns (organisation_id, status, created_at DESC);

-- People on a campaign: scouts, regional leads, committee members, chair and safeguarding officer.
CREATE TABLE IF NOT EXISTS academy_campaign_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES academy_scouting_campaigns,
  user_id     uuid NOT NULL REFERENCES users,
  role        text NOT NULL CHECK (role IN ('scout','regional_lead','committee','chair','safeguarding_officer')),
  region      text CHECK (region IS NULL OR length(region) <= 80),
  capacity    int CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 500),     -- prospects this scout can carry
  removed_at  timestamptz,
  created_by  uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_campaign_members_live ON academy_campaign_members (campaign_id, user_id, role, coalesce(region, '')) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS academy_campaign_members_user ON academy_campaign_members (user_id) WHERE removed_at IS NULL;

-- A member's declared relationship with a prospect or intermediary: excludes them from evaluating and voting on that athlete.
CREATE TABLE IF NOT EXISTS academy_campaign_conflicts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES academy_scouting_campaigns,
  user_id     uuid NOT NULL REFERENCES users,
  athlete_id  uuid NOT NULL REFERENCES users,
  reason      text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_campaign_conflicts_one ON academy_campaign_conflicts (campaign_id, user_id, athlete_id);

-- The link between a campaign and a Talent CRM entry (recruiter_list_entries). The prospect, its evaluations and its access grant stay where they are;
-- this row only carries the campaign stage, the committee outcome and the resulting application.
CREATE TABLE IF NOT EXISTS academy_campaign_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES academy_scouting_campaigns,
  entry_id        uuid NOT NULL REFERENCES recruiter_list_entries,
  athlete_id      uuid NOT NULL REFERENCES users,
  scout_id        uuid NOT NULL REFERENCES users,
  region          text CHECK (region IS NULL OR length(region) <= 80),
  referral_source_id uuid REFERENCES academy_referral_sources,
  stage           text NOT NULL DEFAULT 'prospect' CHECK (stage IN ('prospect','evaluated','committee','decided','invited','applied','enrolled','declined','withdrawn')),
  decision        text CHECK (decision IS NULL OR decision IN ('advance','hold','decline')),
  decision_note   text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  round           int NOT NULL DEFAULT 1,
  submitted_at    timestamptz,
  application_id  uuid REFERENCES academy_applications,
  invited_at      timestamptz,
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_campaign_entries_one ON academy_campaign_entries (campaign_id, athlete_id) WHERE stage NOT IN ('declined','withdrawn');
CREATE UNIQUE INDEX IF NOT EXISTS academy_campaign_entries_entry ON academy_campaign_entries (campaign_id, entry_id);
CREATE INDEX IF NOT EXISTS academy_campaign_entries_campaign ON academy_campaign_entries (campaign_id, stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS academy_campaign_entries_application ON academy_campaign_entries (application_id) WHERE application_id IS NOT NULL;

-- What a scout chose to put in front of the committee: an immutable snapshot of one of their own evaluations (ratings, basis, date), with the notes
-- released only when the scout says so. The scout's original evaluation stays theirs and editable; the committee sees what was submitted.
CREATE TABLE IF NOT EXISTS academy_campaign_shares (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_entry_id uuid NOT NULL REFERENCES academy_campaign_entries,
  evaluation_id    uuid NOT NULL REFERENCES recruiter_evaluations,
  round            int NOT NULL DEFAULT 1,
  snapshot         jsonb NOT NULL,
  notes_released   boolean NOT NULL DEFAULT false,
  shared_by        uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_entry_id, evaluation_id, round)
);

-- Video references: a link to the athlete's own coach-approved passport video, readable only while the athlete's grant is live.
CREATE TABLE IF NOT EXISTS academy_campaign_videos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_entry_id uuid NOT NULL REFERENCES academy_campaign_entries,
  passport_video_id uuid NOT NULL REFERENCES passport_videos,
  added_by         uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_entry_id, passport_video_id)
);

-- Committee votes are append-only: a changed mind is a new vote, the latest per member and round counts, and the whole history stays.
CREATE TABLE IF NOT EXISTS academy_committee_votes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_entry_id uuid NOT NULL REFERENCES academy_campaign_entries,
  round            int NOT NULL DEFAULT 1,
  voter_id         uuid NOT NULL REFERENCES users,
  vote             text NOT NULL CHECK (vote IN ('advance','hold','decline')),
  reason           text CHECK (reason IS NULL OR length(reason) <= 500),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_committee_votes_entry ON academy_committee_votes (campaign_entry_id, round, voter_id, created_at DESC);
DROP TRIGGER IF EXISTS academy_committee_votes_ao ON academy_committee_votes;
CREATE TRIGGER academy_committee_votes_ao BEFORE UPDATE OR DELETE ON academy_committee_votes FOR EACH ROW EXECUTE FUNCTION academy_append_only();

-- Every stage change, submission, vote, decision and invitation (who, when, from -> to). Append-only.
CREATE TABLE IF NOT EXISTS academy_campaign_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid NOT NULL REFERENCES academy_scouting_campaigns,
  campaign_entry_id uuid REFERENCES academy_campaign_entries,
  kind             text NOT NULL,
  from_stage       text,
  to_stage         text,
  actor_id         uuid REFERENCES users,
  note             text CHECK (note IS NULL OR length(note) <= 500),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_campaign_events_entry ON academy_campaign_events (campaign_entry_id, created_at, id);
CREATE INDEX IF NOT EXISTS academy_campaign_events_campaign ON academy_campaign_events (campaign_id, created_at, id);
DROP TRIGGER IF EXISTS academy_campaign_events_ao ON academy_campaign_events;
CREATE TRIGGER academy_campaign_events_ao BEFORE UPDATE OR DELETE ON academy_campaign_events FOR EACH ROW EXECUTE FUNCTION academy_append_only();

-- Source and consent provenance carried onto the canonical academy application (nullable: every earlier application is unchanged).
ALTER TABLE academy_applications
  ADD COLUMN IF NOT EXISTS source_kind        text CHECK (source_kind IS NULL OR source_kind IN ('scouting')),
  ADD COLUMN IF NOT EXISTS source_campaign_id uuid REFERENCES academy_scouting_campaigns,
  ADD COLUMN IF NOT EXISTS source_entry_id    uuid REFERENCES academy_campaign_entries,
  ADD COLUMN IF NOT EXISTS source_referral_id uuid REFERENCES academy_referral_sources,
  ADD COLUMN IF NOT EXISTS source_region      text,
  ADD COLUMN IF NOT EXISTS source_consent     jsonb;     -- {purpose, status, granted_by, captured_at}: the consent in force when the invitation was made
CREATE INDEX IF NOT EXISTS academy_applications_source ON academy_applications (source_campaign_id) WHERE source_campaign_id IS NOT NULL;
