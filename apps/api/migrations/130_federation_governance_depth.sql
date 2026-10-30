-- Federation governance depth (#574), on top of #475: jurisdiction-scoped delegation, renewal campaigns and a compliance-exception register.
-- Additive only: new tables and nullable columns; one CHECK constraint is widened (fed_events.subject_type) and every old value stays valid.

-- ------------------------------------------------------------------ jurisdictions a body administers (regions, states, districts)
CREATE TABLE fed_jurisdictions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id     uuid NOT NULL REFERENCES governing_bodies,
  level       text NOT NULL CHECK (level IN ('region','state','district')),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  archived_at timestamptz,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fed_jurisdictions_name ON fed_jurisdictions (body_id, level, lower(name)) WHERE archived_at IS NULL;

-- A record sits in at most one jurisdiction of the body it is filed with; a role may be limited to some of them.
ALTER TABLE fed_affiliations ADD COLUMN IF NOT EXISTS jurisdiction_id uuid REFERENCES fed_jurisdictions;
ALTER TABLE fed_licences     ADD COLUMN IF NOT EXISTS jurisdiction_id uuid REFERENCES fed_jurisdictions;
ALTER TABLE fed_sanctions    ADD COLUMN IF NOT EXISTS jurisdiction_id uuid REFERENCES fed_jurisdictions;
ALTER TABLE governing_body_roles ADD COLUMN IF NOT EXISTS jurisdiction_ids uuid[] NOT NULL DEFAULT '{}';

-- ------------------------------------------------------------------ compliance exceptions (decisions approved over a failed requirement)
ALTER TABLE fed_events DROP CONSTRAINT IF EXISTS fed_events_subject_type_check;
ALTER TABLE fed_events ADD CONSTRAINT fed_events_subject_type_check
  CHECK (subject_type IN ('body','link','role','affiliation','licence','sanction','policy','date','exception','campaign','jurisdiction'));

CREATE TABLE fed_exceptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id      uuid NOT NULL REFERENCES governing_bodies,
  subject_type text NOT NULL CHECK (subject_type IN ('affiliation','licence','sanction')),
  subject_id   uuid NOT NULL,
  reason       text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  failed       jsonb NOT NULL DEFAULT '[]',          -- the requirement checks that failed when the decision was made
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','remedied','extended','accepted')),
  review_due   date NOT NULL,
  decided_by   uuid REFERENCES users,
  decided_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_by  uuid REFERENCES users,
  reviewed_at  timestamptz,
  review_note  text CHECK (review_note IS NULL OR length(review_note) <= 500),
  review_count integer NOT NULL DEFAULT 0,
  row_version  integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fed_exceptions_one_open ON fed_exceptions (subject_type, subject_id) WHERE status IN ('open','extended');
CREATE INDEX fed_exceptions_body ON fed_exceptions (body_id, status, review_due);

-- Decisions already approved over a failed requirement become open exceptions, due 90 days after the decision. Nothing is changed on the records.
INSERT INTO fed_exceptions(body_id, subject_type, subject_id, reason, failed, review_due, decided_by, decided_at)
SELECT a.body_id, 'affiliation', a.id, a.override_reason, coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements(a.checks) x WHERE x->>'status' = 'fail' AND (x->>'required')::boolean), '[]'), (coalesce(a.decided_at, now())::date + 90), a.decided_by, coalesce(a.decided_at, now())
  FROM fed_affiliations a WHERE a.override_reason IS NOT NULL AND a.status IN ('approved','suspended')
UNION ALL
SELECT l.body_id, 'licence', l.id, l.override_reason, coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements(l.checks) x WHERE x->>'status' = 'fail' AND (x->>'required')::boolean), '[]'), (coalesce(l.decided_at, now())::date + 90), l.decided_by, coalesce(l.decided_at, now())
  FROM fed_licences l WHERE l.override_reason IS NOT NULL AND l.status IN ('active','suspended')
UNION ALL
SELECT s.body_id, 'sanction', s.id, s.override_reason, coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements(s.checks) x WHERE x->>'status' = 'fail' AND (x->>'required')::boolean), '[]'), (coalesce(s.decided_at, now())::date + 90), s.decided_by, coalesce(s.decided_at, now())
  FROM fed_sanctions s WHERE s.override_reason IS NOT NULL AND s.status IN ('approved','suspended')
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------------ renewal campaigns
CREATE TABLE fed_campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id          uuid NOT NULL REFERENCES governing_bodies,
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  target           text NOT NULL CHECK (target IN ('affiliation','licence')),
  category_ids     uuid[] NOT NULL DEFAULT '{}',      -- affiliation categories or licence types; empty = all
  jurisdiction_ids uuid[] NOT NULL DEFAULT '{}',      -- empty = every jurisdiction
  sport_id         uuid REFERENCES sports,
  window_from      date NOT NULL,
  window_to        date NOT NULL,
  reminder_days    integer[] NOT NULL DEFAULT '{30,14,7}',
  message          text CHECK (message IS NULL OR length(message) <= 500),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','closed','cancelled')),
  launched_at      timestamptz,
  closed_at        timestamptz,
  created_by       uuid NOT NULL REFERENCES users,
  row_version      integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (window_to >= window_from)
);
CREATE INDEX fed_campaigns_body ON fed_campaigns (body_id, status);

-- The records a campaign covers, fixed at launch. Whether each was renewed is read live from the renewal chain (previous_id), never copied.
CREATE TABLE fed_campaign_recipients (
  campaign_id   uuid NOT NULL REFERENCES fed_campaigns,
  subject_type  text NOT NULL CHECK (subject_type IN ('affiliation','licence')),
  subject_id    uuid NOT NULL,
  reminders     integer NOT NULL DEFAULT 0,
  last_reminded_at timestamptz,
  PRIMARY KEY (campaign_id, subject_id)
);
CREATE INDEX fed_campaign_recipients_subject ON fed_campaign_recipients (subject_id);
