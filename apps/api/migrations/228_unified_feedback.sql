-- 228_unified_feedback.sql
-- Additive only: extends testimonials, adds feedback_policies, feedback_appeals,
-- feedback_blind_sessions, feedback_invitations, and bridges coach_reviews.
-- Never drops columns or tables.

-- Extend testimonials with new columns (all prior columns already exist)
ALTER TABLE testimonials
  ADD COLUMN IF NOT EXISTS author_role          text,
  ADD COLUMN IF NOT EXISTS nps_score            int CHECK (nps_score BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS dimensions_json      jsonb,
  ADD COLUMN IF NOT EXISTS is_blind             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reveal_at            timestamptz,
  ADD COLUMN IF NOT EXISTS appeal_status        text NOT NULL DEFAULT 'none' CHECK (appeal_status IN ('none','pending','upheld','dismissed')),
  ADD COLUMN IF NOT EXISTS private_recipient_id uuid REFERENCES users;

-- Bridge FK from coach_reviews to unified testimonials
ALTER TABLE coach_reviews
  ADD COLUMN IF NOT EXISTS testimonial_id uuid REFERENCES testimonials;
CREATE INDEX IF NOT EXISTS coach_reviews_testimonial ON coach_reviews(testimonial_id) WHERE testimonial_id IS NOT NULL;

-- Eligibility policy matrix (what interactions allow which review type)
CREATE TABLE IF NOT EXISTS feedback_policies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context_type       text NOT NULL,
  reviewer_role      text NOT NULL DEFAULT 'any',
  subject_type       text NOT NULL,
  subject_role       text,
  window_days        int NOT NULL DEFAULT 90,
  max_per_context    int NOT NULL DEFAULT 1,
  dimensions_allowed text[],
  visibility_default text NOT NULL DEFAULT 'public' CHECK (visibility_default IN ('public','private')),
  nps_enabled        boolean NOT NULL DEFAULT false,
  blind_capable      boolean NOT NULL DEFAULT false,
  active             boolean NOT NULL DEFAULT true,
  version            int NOT NULL DEFAULT 1,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_policies_lookup ON feedback_policies (context_type, subject_type) WHERE active;

INSERT INTO feedback_policies (context_type, reviewer_role, subject_type, subject_role, window_days, dimensions_allowed, nps_enabled, blind_capable, notes) VALUES
  ('hire',               'any',   'user',        'coach',      90,  ARRAY['instruction_quality','punctuality','communication','preparation','value'],          true,  false, 'Athlete reviews coach after completed hire'),
  ('appointment',        'any',   'user',        'physio',     90,  ARRAY['communication','scheduling','professionalism','value'],                              false, false, 'Patient reviews physio (no clinical outcome)'),
  ('appointment',        'any',   'user',        'doctor',     90,  ARRAY['communication','scheduling','professionalism','value'],                              false, false, 'Patient reviews doctor'),
  ('booking',            'any',   'venue',       null,         90,  ARRAY['condition','cleanliness','access','facilities','booking_accuracy','value'],          false, false, 'Customer reviews venue after booking'),
  ('event_participation','any',   'event',       null,         90,  ARRAY['organisation','scheduling','officiating','venue_readiness','safety','communication'], true,  true,  'Participant reviews event (blind capable)'),
  ('order',              'any',   'product',     null,         180, ARRAY['accuracy','quality','delivery','value'],                                              false, false, 'Buyer reviews product after delivery'),
  ('order',              'any',   'sponsor',     null,         180, ARRAY['communication','fulfilment','transparency','value'],                                  false, true,  'Counterparty reviews sponsor (blind capable)'),
  ('sponsorship',        'any',   'user',        'organiser',  180, ARRAY['arrangements','coordination','transparency','communication'],                         false, true,  'Sponsor reviews event organiser (blind capable)'),
  ('programme_enrolment','any',   'institution', null,         365, ARRAY['teaching','content','arrangements','communication','value'],                          true,  false, 'Learner reviews institution'),
  ('programme_enrolment','any',   'programme',   null,         365, ARRAY['teaching','content','arrangements','communication','value'],                          true,  false, 'Learner reviews programme'),
  ('fixture_assignment', 'any',   'user',        'official',   30,  ARRAY['professional_conduct','communication','punctuality','impartiality'],                  false, false, 'Organiser/participant reviews official'),
  ('volunteer_assignment','any',  'user',        'volunteer',  90,  ARRAY['reliability','communication','teamwork','contribution'],                              false, false, 'Coordinator reviews volunteer'),
  ('hire',               'coach', 'user',        'athlete',    90,  ARRAY['commitment','communication','attitude','preparation'],                                false, false, 'Coach reviews athlete (private by default)')
ON CONFLICT DO NOTHING;

-- Appeals for moderation decisions
CREATE TABLE IF NOT EXISTS feedback_appeals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  testimonial_id uuid NOT NULL REFERENCES testimonials,
  author_id      uuid NOT NULL REFERENCES users,
  reason         text NOT NULL,
  evidence_refs  text[],
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','upheld','dismissed')),
  decided_by     uuid REFERENCES users,
  decided_at     timestamptz,
  outcome_notes  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (testimonial_id, author_id)
);
CREATE INDEX IF NOT EXISTS feedback_appeals_pending ON feedback_appeals (created_at) WHERE status = 'pending';

-- Blind review pairings (both reviews hidden until both submit or deadline passes)
CREATE TABLE IF NOT EXISTS feedback_blind_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context_type   text NOT NULL,
  context_id     uuid NOT NULL,
  party_a_id     uuid NOT NULL REFERENCES users,
  party_b_id     uuid NOT NULL REFERENCES users,
  party_a_review uuid REFERENCES testimonials,
  party_b_review uuid REFERENCES testimonials,
  reveal_at      timestamptz NOT NULL,
  revealed       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (context_type, context_id, party_a_id, party_b_id)
);
CREATE INDEX IF NOT EXISTS feedback_blind_pending ON feedback_blind_sessions (reveal_at) WHERE NOT revealed;

-- Invitation campaigns (anti-cherry-pick: whole cohort only, throttled)
CREATE TABLE IF NOT EXISTS feedback_invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context_type text NOT NULL,
  context_id   uuid NOT NULL,
  sender_id    uuid NOT NULL REFERENCES users,
  cohort       text NOT NULL CHECK (cohort IN ('all','participants','officials','coaches','customers','staff')),
  sent_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (context_type, context_id, sender_id, cohort)
);

-- Supporting indexes for new query patterns
CREATE INDEX IF NOT EXISTS testimonials_blind   ON testimonials (reveal_at)                                   WHERE is_blind = true AND status = 'published';
CREATE INDEX IF NOT EXISTS testimonials_private ON testimonials (private_recipient_id)                        WHERE visibility = 'private' AND private_recipient_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS testimonials_role    ON testimonials (subject_type, subject_id, author_role)       WHERE status = 'published';
