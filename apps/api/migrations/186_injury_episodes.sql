-- Sports medicine & RTP (issue #584): longitudinal injury episode — the central organising concept
-- that links clinical artefacts (encounters, plans, investigations, clearances) to one injury event.
-- Additive only: nothing dropped or truncated. Rollback: deploy previous build; new tables are ignored.

-- Core episode record (one per distinct injury event)
CREATE TABLE IF NOT EXISTS injury_episodes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id      uuid NOT NULL REFERENCES users(id),
  organisation_id uuid REFERENCES organisations(id),
  sport_id        uuid REFERENCES sports(id),
  episode_ref     text NOT NULL,            -- human-readable ref e.g. INJ-2024-001
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','rehabilitation','restricted_training',
                                    'return_to_train','return_to_play','closed','cancelled')),
  body_region     text NOT NULL,
  side            text CHECK (side IN ('left','right','bilateral','central','na')),
  injury_type     text NOT NULL
                  CHECK (injury_type IN ('strain','sprain','fracture','contusion','laceration',
                                         'tendinopathy','concussion','dislocation','nerve','other')),
  mechanism       text CHECK (mechanism IN ('contact','non_contact','overuse',
                                             'acute_on_chronic','unknown')),
  severity        text CHECK (severity IN ('minor','moderate','significant','severe')),
  occurred_on     date NOT NULL,
  first_assessment_on date,
  expected_return_on  date,
  actual_return_on    date,
  is_recurrence   boolean NOT NULL DEFAULT false,
  prior_episode_id uuid REFERENCES injury_episodes(id),
  opened_by       uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS injury_episodes_ref ON injury_episodes (athlete_id, episode_ref);
CREATE INDEX IF NOT EXISTS injury_episodes_athlete ON injury_episodes (athlete_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS injury_episodes_org ON injury_episodes (organisation_id, status) WHERE organisation_id IS NOT NULL;

-- Append-only event log: every status change, note, link, impact recorded here
CREATE TABLE IF NOT EXISTS injury_episode_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id  uuid NOT NULL REFERENCES injury_episodes(id),
  event_type  text NOT NULL
              CHECK (event_type IN ('opened','status_change','severity_set',
                                    'expected_return_set','artifact_linked',
                                    'impact_recorded','note_added','closed')),
  from_status text,
  to_status   text,
  note_enc    text,
  by_user_id  uuid NOT NULL REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS injury_episode_events_ep ON injury_episode_events (episode_id, at DESC);
-- Immutability: no updates or deletes on the event log
CREATE OR REPLACE RULE injury_episode_events_no_update AS ON UPDATE TO injury_episode_events DO INSTEAD NOTHING;
CREATE OR REPLACE RULE injury_episode_events_no_delete AS ON DELETE TO injury_episode_events DO INSTEAD NOTHING;

-- Links episode to existing clinical artefacts
CREATE TABLE IF NOT EXISTS injury_episode_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id    uuid NOT NULL REFERENCES injury_episodes(id),
  artifact_type text NOT NULL
                CHECK (artifact_type IN ('encounter','treatment_plan','care_plan',
                                          'investigation','referral','clearance','rtp_approval')),
  artifact_id   uuid NOT NULL,
  linked_by     uuid NOT NULL REFERENCES users(id),
  linked_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS injury_episode_links_uniq ON injury_episode_links (episode_id, artifact_type, artifact_id);
CREATE INDEX IF NOT EXISTS injury_episode_links_ep ON injury_episode_links (episode_id);

-- Missed sessions / fixtures caused by this episode
CREATE TABLE IF NOT EXISTS injury_episode_impact (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id      uuid NOT NULL REFERENCES injury_episodes(id),
  impact_type     text NOT NULL CHECK (impact_type IN ('session','fixture','training_day')),
  reference_id    uuid,
  reference_date  date NOT NULL,
  reference_label text CHECK (reference_label IS NULL OR length(reference_label) <= 200),
  recorded_by     uuid NOT NULL REFERENCES users(id),
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS injury_episode_impact_ep ON injury_episode_impact (episode_id, reference_date DESC);
