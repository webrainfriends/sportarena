-- Public marketplace / member feed: posts shown as cards on the landing page, with media, reactions, comments and
-- applications ("leads"). Additive only; rows are retired with archived_at / removed_at, never deleted.

CREATE TABLE market_posts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id   uuid NOT NULL REFERENCES users,
  kind        text NOT NULL CHECK (kind IN ('wanted','match','schedule','sale','campaign','announcement')),
  title       text NOT NULL,
  body        text,
  sport_id    uuid REFERENCES sports,
  city        text,
  starts_at   timestamptz,
  price_cents bigint CHECK (price_cents >= 0),
  positions   int CHECK (positions BETWEEN 1 AND 500),
  cta_label   text,
  link_url    text CHECK (link_url IS NULL OR link_url ~* '^https?://'),
  visibility  text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','members')),
  -- paid ads / campaigns: requested by the author, switched on by an admin for a date window
  sponsor_status text NOT NULL DEFAULT 'none' CHECK (sponsor_status IN ('none','pending','approved','rejected')),
  promo_starts_at timestamptz,
  promo_ends_at   timestamptz,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX market_posts_feed ON market_posts (created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX market_posts_kind ON market_posts (kind, created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX market_posts_author ON market_posts (author_id, created_at DESC);

CREATE TABLE market_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     uuid REFERENCES market_posts,
  uploader_id uuid NOT NULL REFERENCES users,
  kind        text NOT NULL CHECK (kind IN ('photo','video')),
  content_type text NOT NULL,
  file_name   text NOT NULL,
  size_bytes  bigint NOT NULL,
  sha256      text NOT NULL,
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz
);
CREATE INDEX market_media_post ON market_media (post_id) WHERE removed_at IS NULL;

CREATE TABLE market_reactions (
  post_id uuid NOT NULL REFERENCES market_posts,
  user_id uuid NOT NULL REFERENCES users,
  active  boolean NOT NULL DEFAULT true, -- un-liking flips this; rows are kept
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE market_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     uuid NOT NULL REFERENCES market_posts,
  author_id   uuid NOT NULL REFERENCES users,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX market_comments_post ON market_comments (post_id, created_at);

CREATE TABLE market_leads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    uuid NOT NULL REFERENCES market_posts,
  user_id    uuid NOT NULL REFERENCES users,
  message    text,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, user_id)
);
