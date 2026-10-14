-- Unified feedback foundation (issue #215), additive only: nothing is dropped, rewritten or narrowed.
-- Existing testimonials keep their ids, rating, text and timestamps; they are labelled 'legacy' (never
-- treated as a verified interaction without proof) and stay published so no public rating changes.
ALTER TABLE testimonials
  ADD COLUMN status          text NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden','withdrawn')),
  ADD COLUMN visibility      text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  ADD COLUMN verification    text NOT NULL DEFAULT 'legacy' CHECK (verification IN ('legacy','unverified','verified_interaction')),
  ADD COLUMN context_type    text,
  ADD COLUMN context_id      uuid,
  ADD COLUMN updated_at      timestamptz,
  ADD COLUMN moderation_reason text,
  ADD COLUMN moderated_by    uuid REFERENCES users,
  ADD COLUMN moderated_at    timestamptz;

CREATE INDEX testimonials_published ON testimonials (subject_type, subject_id) WHERE status = 'published' AND visibility = 'public';

-- Immutable history: every edit, withdrawal and moderation action keeps the previous state.
CREATE TABLE testimonial_revisions (
  id             bigserial PRIMARY KEY,
  testimonial_id uuid NOT NULL REFERENCES testimonials,
  action         text NOT NULL CHECK (action IN ('edit','withdraw','restore','hide','unhide')),
  actor_id       uuid REFERENCES users,
  rating         int NOT NULL,
  body           text NOT NULL,
  status         text NOT NULL,
  reason         text,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX testimonial_revisions_t ON testimonial_revisions (testimonial_id, at);

-- Reports from readers; reviewed by staff. Reporting never changes the review by itself.
CREATE TABLE testimonial_reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  testimonial_id uuid NOT NULL REFERENCES testimonials,
  reporter_id    uuid NOT NULL REFERENCES users,
  category       text NOT NULL CHECK (category IN ('harassment','privacy','impersonation','spam','fabricated_interaction','conflict_of_interest','retaliation','irrelevant')),
  details        text,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','dismissed')),
  decided_by     uuid REFERENCES users,
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (testimonial_id, reporter_id)
);
CREATE INDEX testimonial_reports_open ON testimonial_reports (created_at) WHERE status = 'open';
