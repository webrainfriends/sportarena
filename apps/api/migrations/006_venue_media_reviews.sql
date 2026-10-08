-- Venue media (photos, videos, embedded video links) and venue-team replies to reviews.
-- Files live on the server's persistent media directory (MEDIA_DIR); rows are retired with removed_at, never deleted.

CREATE TABLE venue_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    uuid NOT NULL REFERENCES venues,
  resource_id uuid REFERENCES resources,                       -- optional: a photo of one specific court
  kind        text NOT NULL CHECK (kind IN ('photo','video','video_link')),
  content_type text,                                           -- sniffed from the file's bytes, never trusted from the client
  file_name   text,                                            -- server-generated; null for links
  size_bytes  bigint,
  sha256      text,
  link_url    text,                                            -- embeddable URL for video_link
  caption     text,
  position    int NOT NULL DEFAULT 0,
  is_cover    boolean NOT NULL DEFAULT false,
  uploaded_by uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  CHECK ((kind = 'video_link') = (link_url IS NOT NULL))
);
CREATE INDEX venue_media_venue ON venue_media (venue_id, position, created_at) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX venue_media_one_cover ON venue_media (venue_id) WHERE is_cover AND removed_at IS NULL;

-- A venue team's public answer to a review.
ALTER TABLE testimonials
  ADD COLUMN reply_body text,
  ADD COLUMN reply_by   uuid REFERENCES users,
  ADD COLUMN replied_at timestamptz;
