-- Academy OS P1 / Gap 15 (#795): student wellbeing & personal development.
-- Additive and backwards-compatible. Nothing is dropped, rewritten or narrowed. Students, guardians, staff, sessions, safety events, care-network providers and
-- consents stay in their canonical tables (users, guardian_links, org_staff_engagements, academy_safety_events, org_provider_associations, youth_consents);
-- this migration adds only what did not exist: optional development tracks, the wellbeing consent scopes, mentor assignments, check-in scheduling with
-- transparent follow-up status, human-reviewed development goals, consented specialist referrals and an append-only transparency log.
-- Counselling, diagnosis and psychiatric or confidential safeguarding content has NO column here by design: a concern goes to academy_safety_events
-- (encrypted, safeguarding staff only) and clinical work stays in the Health workflow. Rollback: every statement is idempotent; to roll back deploy the
-- previous build (the new tables are ignored by it). No data has to be removed.

-- 1. Optional personal-development tracks (values, leadership, life skills, nutrition education), versioned by edit, archived never deleted.
CREATE TABLE IF NOT EXISTS academy_dev_tracks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  category        text NOT NULL CHECK (category IN ('values','leadership','life_skills','nutrition_education','study_skills')),
  title           text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  summary         text CHECK (summary IS NULL OR char_length(summary) <= 600),
  age_min         smallint NOT NULL DEFAULT 8  CHECK (age_min BETWEEN 4 AND 40),
  age_max         smallint NOT NULL DEFAULT 18 CHECK (age_max BETWEEN 4 AND 60),
  delivery        text NOT NULL DEFAULT 'group' CHECK (delivery IN ('group','one_to_one','blended')),
  sports          text[] NOT NULL DEFAULT '{}',                          -- empty = every sport
  modules         jsonb NOT NULL DEFAULT '[]',                           -- [{ title, outcome }] in order; progress is stored as the indexes done
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  version         int NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CHECK (age_min <= age_max)
);
CREATE INDEX IF NOT EXISTS academy_dev_tracks_org ON academy_dev_tracks (organisation_id, status, category);

CREATE TABLE IF NOT EXISTS academy_dev_track_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id     uuid NOT NULL REFERENCES academy_dev_tracks,
  athlete_id   uuid NOT NULL REFERENCES users,
  status       text NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','completed','withdrawn')),
  modules_done int[] NOT NULL DEFAULT '{}',
  enrolled_by  uuid REFERENCES users,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz,
  ended_at     timestamptz,
  UNIQUE (track_id, athlete_id)
);
CREATE INDEX IF NOT EXISTS academy_dev_track_members_athlete ON academy_dev_track_members (athlete_id, status);

-- 2. Consent scopes per athlete and academy. An adult athlete grants their own; a verified guardian with the 'consent' scope grants for a young person.
--    A grant is never edited: changing or withdrawing it retires the row (history kept). Every read path checks the live row, so revocation is immediate.
CREATE TABLE IF NOT EXISTS academy_wellbeing_consents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  athlete_id      uuid NOT NULL REFERENCES users,
  scopes          text[] NOT NULL,
  granted_by      uuid NOT NULL REFERENCES users,
  granted_as      text NOT NULL CHECK (granted_as IN ('self','guardian')),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users,
  CHECK (scopes <@ ARRAY['tracks','mentoring','checkins','goals','guardian_updates','referrals']::text[])
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_wellbeing_consents_live ON academy_wellbeing_consents (organisation_id, athlete_id) WHERE revoked_at IS NULL;

-- 3. Mentor assignments: a member of staff holding the 'wellbeing' permission, assigned to one athlete, visible to the athlete's guardians.
CREATE TABLE IF NOT EXISTS academy_mentor_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  athlete_id      uuid NOT NULL REFERENCES users,
  mentor_id       uuid NOT NULL REFERENCES users,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  cadence_days    smallint NOT NULL DEFAULT 14 CHECK (cadence_days BETWEEN 3 AND 120),   -- the check-in rhythm the director expects
  review_on       date,
  assigned_by     uuid NOT NULL REFERENCES users,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  ended_reason    text CHECK (ended_reason IS NULL OR ended_reason IN ('athlete_request','guardian_request','mentor_change','left_academy','consent_withdrawn','other'))
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_mentor_live ON academy_mentor_assignments (organisation_id, athlete_id) WHERE status <> 'ended';
CREATE INDEX IF NOT EXISTS academy_mentor_by_mentor ON academy_mentor_assignments (mentor_id, status);

-- 4. Check-ins: scheduled, held, and followed up. Topics are chosen from a catalogue; the only free text is a short, non-clinical agreed next step
--    (encrypted, screened). A concern is raised into academy_safety_events and only its id is kept here.
CREATE TABLE IF NOT EXISTS academy_wellbeing_checkins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  assignment_id   uuid REFERENCES academy_mentor_assignments,
  athlete_id      uuid NOT NULL REFERENCES users,
  mentor_id       uuid NOT NULL REFERENCES users,
  scheduled_for   timestamptz NOT NULL,
  duration_min    smallint NOT NULL DEFAULT 20 CHECK (duration_min BETWEEN 5 AND 120),
  setting         text NOT NULL DEFAULT 'academy_room' CHECK (setting IN ('academy_room','training_venue','video_with_guardian_aware','phone_with_guardian_aware')),
  topics          text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','missed','cancelled')),
  outcome         text CHECK (outcome IS NULL OR outcome IN ('on_track','follow_up','referral_suggested','concern_raised')),
  completed_at    timestamptz,
  next_step_enc   text,
  follow_up_due   date,
  follow_up_status text NOT NULL DEFAULT 'none' CHECK (follow_up_status IN ('none','open','done')),
  follow_up_done_at timestamptz,
  safety_event_id uuid REFERENCES academy_safety_events,
  series_id       uuid,
  idempotency_key text,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  row_version     int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS academy_wellbeing_checkins_org ON academy_wellbeing_checkins (organisation_id, status, scheduled_for);
CREATE INDEX IF NOT EXISTS academy_wellbeing_checkins_athlete ON academy_wellbeing_checkins (athlete_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS academy_wellbeing_checkins_mentor ON academy_wellbeing_checkins (mentor_id, status, scheduled_for);
CREATE UNIQUE INDEX IF NOT EXISTS academy_wellbeing_checkins_idem ON academy_wellbeing_checkins (created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 5. Development goals. Written in plain, non-clinical words; a named person reviews every decision and nothing is marked achieved automatically.
CREATE TABLE IF NOT EXISTS academy_dev_goals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  athlete_id      uuid NOT NULL REFERENCES users,
  track_id        uuid REFERENCES academy_dev_tracks,
  title           text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  measure         text CHECK (measure IS NULL OR char_length(measure) <= 300),     -- what "done" looks like, in observable terms
  target_date     date,
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','agreed','active','achieved','paused','dropped')),
  proposed_by     uuid NOT NULL REFERENCES users,
  reviewer_id     uuid NOT NULL REFERENCES users,                                 -- the human accountable for reviewing it
  athlete_agreed_at   timestamptz,
  guardian_agreed_at  timestamptz,
  guardian_agreed_by  uuid REFERENCES users,
  last_review_at  timestamptz,
  next_review_on  date,
  decision_note   text CHECK (decision_note IS NULL OR char_length(decision_note) <= 300),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS academy_dev_goals_org ON academy_dev_goals (organisation_id, status, next_review_on);
CREATE INDEX IF NOT EXISTS academy_dev_goals_athlete ON academy_dev_goals (athlete_id, status);

-- 6. Specialist referrals: the academy proposes, the family consents, the referral is handed to the Health workflow. Reason is a category, never a narrative.
CREATE TABLE IF NOT EXISTS academy_wellbeing_referrals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  athlete_id      uuid NOT NULL REFERENCES users,
  specialty       text NOT NULL CHECK (specialty IN ('sports_psychology','counselling','nutrition','sports_medicine','physiotherapy','learning_support','other_specialist')),
  reason          text NOT NULL CHECK (reason IN ('performance_pressure','load_and_recovery','nutrition_support','school_balance','general_wellbeing','transition_support','other')),
  association_id  uuid REFERENCES org_provider_associations,                       -- a provider already linked to the academy; null = the family chooses their own
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','consented','handed_over','declined','withdrawn','closed')),
  urgency         text NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine','soon')),
  proposed_by     uuid NOT NULL REFERENCES users,
  consent_by      uuid REFERENCES users,
  consent_as      text CHECK (consent_as IS NULL OR consent_as IN ('self','guardian')),
  consent_at      timestamptz,
  decided_at      timestamptz,
  handed_over_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  row_version     int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS academy_wellbeing_referrals_org ON academy_wellbeing_referrals (organisation_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS academy_wellbeing_referrals_athlete ON academy_wellbeing_referrals (athlete_id, status);

-- 7. Transparency log (append-only): what happened, who did it, and every staff read of an athlete's wellbeing record. Codes only, no personal free text.
CREATE TABLE IF NOT EXISTS academy_wellbeing_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  athlete_id      uuid NOT NULL REFERENCES users,
  kind            text NOT NULL,
  actor_id        uuid REFERENCES users,
  ref_type        text,
  ref_id          uuid,
  detail          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_wellbeing_events_athlete ON academy_wellbeing_events (athlete_id, organisation_id, created_at DESC);
DROP TRIGGER IF EXISTS academy_wellbeing_events_guard ON academy_wellbeing_events;
CREATE TRIGGER academy_wellbeing_events_guard BEFORE UPDATE OR DELETE ON academy_wellbeing_events FOR EACH ROW EXECUTE FUNCTION youth_history_guard();
