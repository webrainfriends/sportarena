-- Officials Services & Opportunity Marketplace (Issue #1003, REF-R11)
-- Adds official-specific metadata to marketplace_listings and a structured review table.
-- The base marketplace_listings, marketplace_engagements and marketplace_quotes tables already exist
-- (family=official is already supported in families.js). This migration only adds the extra metadata
-- and official-specific review criteria tables; it does not touch any existing column or row.

-- official_listing_meta
-- Stores official-specific metadata attached to a marketplace_listings row (family='official').
-- One row per listing; created/updated via PUT /me/official-service-listing.
CREATE TABLE IF NOT EXISTS official_listing_meta (
  listing_id              UUID        PRIMARY KEY REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  roles                   TEXT[]      NOT NULL DEFAULT '{}',
  -- values: referee,umpire,linesman,fourth_official,video_assistant_referee,reserve_assistant_referee,
  --         scorer,timekeeper,goal_line_official,technical_official,shot_clock_operator
  grades                  TEXT[]      NOT NULL DEFAULT '{}',
  -- free-form grade labels matching the official's grade_scheme_catalogue rows, e.g. 'FIFA Level 1', 'Regional Level 3'
  event_types             TEXT[]      NOT NULL DEFAULT '{}',
  -- values: league,cup,friendly,tournament,international,school,university,amateur,corporate,volunteer
  equipment_own           TEXT[]      NOT NULL DEFAULT '{}',
  -- values: whistle,flag_set,vanishing_spray,board,timing_equipment,uniform_formal,uniform_casual,kit_bag,comms_headset
  max_travel_km           INT         CHECK (max_travel_km IS NULL OR max_travel_km BETWEEN 1 AND 50000),
  insurance_valid_until   DATE,
  volunteer_available     BOOL        NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- official_service_reviews
-- Stores structured 5-criteria reviews for official marketplace bookings.
-- Created via POST /official-service-bookings/:engagement_id/review.
-- A matching testimonial row (subject_type='user', subject_id=provider_id) is also created so the
-- official's public rating (which the marketplace search reads from testimonials) stays up-to-date.
CREATE TABLE IF NOT EXISTS official_service_reviews (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id           UUID        NOT NULL REFERENCES marketplace_engagements(id),
  reviewer_id             UUID        NOT NULL REFERENCES users(id),
  official_id             UUID        NOT NULL REFERENCES users(id),
  testimonial_id          UUID        REFERENCES testimonials(id),
  -- Five 1–5 integer criteria
  punctuality             SMALLINT    NOT NULL CHECK (punctuality BETWEEN 1 AND 5),
  communication           SMALLINT    NOT NULL CHECK (communication BETWEEN 1 AND 5),
  officiating_quality     SMALLINT    NOT NULL CHECK (officiating_quality BETWEEN 1 AND 5),
  professionalism         SMALLINT    NOT NULL CHECK (professionalism BETWEEN 1 AND 5),
  rules_adherence         SMALLINT    NOT NULL CHECK (rules_adherence BETWEEN 1 AND 5),
  overall                 NUMERIC(3,2) GENERATED ALWAYS AS (
    (punctuality + communication + officiating_quality + professionalism + rules_adherence) / 5.0
  ) STORED,
  public_note             TEXT        CHECK (char_length(public_note) <= 1000),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (engagement_id, reviewer_id)  -- one review per engagement per reviewer
);

-- official_service_bookings
-- Tracks the link between a contracted marketplace engagement and the resulting fixture assignment.
-- Created via POST /official-service-bookings/:engagement_id/assign; idempotent.
CREATE TABLE IF NOT EXISTS official_service_bookings (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id           UUID        NOT NULL UNIQUE REFERENCES marketplace_engagements(id),
  fixture_official_id     UUID        REFERENCES fixture_officials(id),
  -- NULL when the booking is not yet linked to a specific fixture (pre-event booking)
  fixture_id              UUID        REFERENCES fixtures(id),
  status                  TEXT        NOT NULL DEFAULT 'booked'
                                      CHECK (status IN ('booked','assigned','completed','cancelled')),
  agreed_fee_minor        BIGINT,
  agreed_fee_currency     TEXT,
  engagement_id_snapshot  UUID        NOT NULL,
  -- immutable copy of engagement_id for audit trail after potential engagement deletion
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add source columns to fixture_officials so the assign endpoint can record
-- that an appointment originated from a marketplace booking.
ALTER TABLE fixture_officials
  ADD COLUMN IF NOT EXISTS source               TEXT CHECK (source IN ('manual','bulk','open_slot','marketplace_booking')),
  ADD COLUMN IF NOT EXISTS source_engagement_id UUID REFERENCES marketplace_engagements(id);

-- Indexes for the most common access patterns
CREATE INDEX IF NOT EXISTS official_listing_meta_roles ON official_listing_meta USING GIN (roles);
CREATE INDEX IF NOT EXISTS official_listing_meta_grades ON official_listing_meta USING GIN (grades);
CREATE INDEX IF NOT EXISTS official_listing_meta_event_types ON official_listing_meta USING GIN (event_types);
CREATE INDEX IF NOT EXISTS official_service_reviews_official ON official_service_reviews (official_id);
CREATE INDEX IF NOT EXISTS official_service_reviews_engagement ON official_service_reviews (engagement_id);
CREATE INDEX IF NOT EXISTS official_service_bookings_fixture ON official_service_bookings (fixture_id) WHERE fixture_id IS NOT NULL;
