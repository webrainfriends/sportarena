-- Issue #1190: Athlete Performance Posts, Peer Skill Graph, Profile Feedback Invitations & Verified Event Reviews
-- Additive only. Never drops or narrows existing tables.

-- Extend testimonials with nullable context columns (additive)
ALTER TABLE testimonials
  ADD COLUMN IF NOT EXISTS context_type TEXT,
  ADD COLUMN IF NOT EXISTS context_id UUID,
  ADD COLUMN IF NOT EXISTS role_context TEXT;

-- performance_publications: canonical performance post
CREATE TABLE IF NOT EXISTS performance_publications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  sport_id UUID NOT NULL REFERENCES sports(id),
  performance_id UUID REFERENCES performances(id),
  event_id UUID REFERENCES events(id),
  event_external_link_id UUID REFERENCES event_external_links(id),
  external_event_ref JSONB,
  provenance TEXT NOT NULL DEFAULT 'self_reported' CHECK (provenance IN ('officially_verified','organiser_attested','self_reported','imported','disputed','withdrawn','superseded')),
  metrics JSONB NOT NULL DEFAULT '[]',
  audience TEXT NOT NULL DEFAULT 'private' CHECK (audience IN ('private','followers','club_team','coach_recruiter','public')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','withdrawn','archived')),
  moderation_status TEXT NOT NULL DEFAULT 'approved' CHECK (moderation_status IN ('pending','approved','flagged','hidden')),
  idempotency_key TEXT UNIQUE,
  media_consent BOOLEAN NOT NULL DEFAULT false,
  source_rights_confirmed BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS performance_publications_event_uniq
  ON performance_publications(user_id, sport_id, event_id)
  WHERE event_id IS NOT NULL AND status != 'withdrawn';
CREATE INDEX IF NOT EXISTS performance_publications_user_sport_idx
  ON performance_publications(user_id, sport_id, status, audience);

-- performance_publication_media
CREATE TABLE IF NOT EXISTS performance_publication_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id UUID NOT NULL REFERENCES performance_publications(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('photo','video','document')),
  url_enc TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  alt_text TEXT,
  exif_stripped BOOLEAN NOT NULL DEFAULT false,
  virus_scanned BOOLEAN NOT NULL DEFAULT false,
  rights_statement TEXT,
  uploaded_by UUID REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS perf_pub_media_pub_idx ON performance_publication_media(publication_id);

-- performance_publication_revisions
CREATE TABLE IF NOT EXISTS performance_publication_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id UUID NOT NULL REFERENCES performance_publications(id),
  actor_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  snapshot JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS perf_pub_rev_pub_idx ON performance_publication_revisions(publication_id);

-- peer_rating_policy: admin-configurable thresholds per sport (NULL = global default)
CREATE TABLE IF NOT EXISTS peer_rating_policy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id UUID REFERENCES sports(id),
  submission_window_days INTEGER NOT NULL DEFAULT 7,
  edit_window_hours INTEGER NOT NULL DEFAULT 3,
  privacy_min_raters INTEGER NOT NULL DEFAULT 5,
  max_requests_per_30_days INTEGER NOT NULL DEFAULT 20,
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (sport_id)
);
INSERT INTO peer_rating_policy(sport_id, submission_window_days, edit_window_hours, privacy_min_raters, max_requests_per_30_days, enabled)
  VALUES (NULL, 7, 3, 5, 20, true)
  ON CONFLICT (sport_id) DO NOTHING;

-- peer_skill_assessments: one effective row per reviewer × athlete × sport
CREATE TABLE IF NOT EXISTS peer_skill_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES users(id),
  reviewer_id UUID NOT NULL REFERENCES users(id),
  sport_id UUID NOT NULL REFERENCES sports(id),
  eligibility_type TEXT NOT NULL CHECK (eligibility_type IN ('co_player','confirmed_coach','authorized_official')),
  eligibility_evidence_id UUID,
  eligibility_verified BOOLEAN NOT NULL DEFAULT false,
  overall_bucket INTEGER NOT NULL CHECK (overall_bucket BETWEEN 1 AND 5),
  criteria JSONB NOT NULL DEFAULT '[]',
  constructive_feedback_enc TEXT,
  observed_session_ref TEXT,
  confidence TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high')),
  effective BOOLEAN NOT NULL DEFAULT true,
  event_scope_id UUID REFERENCES events(id),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','withdrawn','hidden')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at TIMESTAMPTZ,
  row_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS peer_skill_assessments_athlete_idx
  ON peer_skill_assessments(athlete_id, sport_id, effective, status);
CREATE INDEX IF NOT EXISTS peer_skill_assessments_reviewer_idx
  ON peer_skill_assessments(reviewer_id, athlete_id, sport_id);
COMMENT ON COLUMN peer_skill_assessments.constructive_feedback_enc IS 'Encrypted via src/crypto.js encrypt(). Anonymised to athlete; identity only visible to trust/safety admin.';

-- peer_skill_assessment_revisions: edit audit
CREATE TABLE IF NOT EXISTS peer_skill_assessment_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id UUID NOT NULL REFERENCES peer_skill_assessments(id),
  actor_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- rating_requests: athlete invites an eligible contact
CREATE TABLE IF NOT EXISTS rating_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES users(id),
  invitee_id UUID REFERENCES users(id),
  sport_id UUID NOT NULL REFERENCES sports(id),
  context_type TEXT,
  context_id UUID,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','expired','revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rating_requests_athlete_idx ON rating_requests(athlete_id, sport_id, status);
CREATE INDEX IF NOT EXISTS rating_requests_invitee_idx ON rating_requests(invitee_id, status);

-- event_dimension_reviews: typed event review linked to a testimonial
CREATE TABLE IF NOT EXISTS event_dimension_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  testimonial_id UUID NOT NULL UNIQUE REFERENCES testimonials(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id),
  reviewer_role TEXT NOT NULL CHECK (reviewer_role IN ('participant','official','coach','ticketed_attendee','organizer_staff')),
  eligibility_evidence JSONB,
  verified BOOLEAN NOT NULL DEFAULT false,
  dimensions JSONB NOT NULL DEFAULT '[]',
  overall INTEGER NOT NULL CHECK (overall BETWEEN 1 AND 5),
  organizer_response TEXT,
  organizer_responded_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS event_dim_reviews_event_idx ON event_dimension_reviews(event_id, verified);

-- review_eligibility_evidence: provenance record for event review eligibility
CREATE TABLE IF NOT EXISTS review_eligibility_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id),
  user_id UUID NOT NULL REFERENCES users(id),
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('registration','check_in','ticket','official_assignment','coach_assignment','external_attestation')),
  evidence_ref_id UUID,
  evidence_ref_table TEXT,
  verified BOOLEAN NOT NULL DEFAULT false,
  verified_at TIMESTAMPTZ,
  verified_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id, evidence_type, evidence_ref_id)
);
CREATE INDEX IF NOT EXISTS review_eligibility_event_user_idx ON review_eligibility_evidence(event_id, user_id);

-- moderation_audit: unified moderation action log
CREATE TABLE IF NOT EXISTS moderation_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type TEXT NOT NULL,
  subject_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('flag','hide','unhide','warn','appeal_accepted','appeal_rejected','takedown','reinstate')),
  actor_id UUID NOT NULL REFERENCES users(id),
  reason TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_audit_subject_idx ON moderation_audit(subject_type, subject_id);
