-- Communities and moderated activity sharing (issue #66). Additive and backwards-compatible: nothing is dropped, narrowed or rewritten.
-- Follow / friends / blocks / mutes already exist (136_social_graph, 127_unified_inbox) and are reused as they are.
-- Community posts and comments live in the existing market_posts / market_comments tables (a nullable community_id); everything removed is
-- hidden (archived_at / hidden_at), never deleted. New community text is stored encrypted (body_enc).
-- Rollback: deploy the previous code. Every column added here is nullable or defaulted and every table is new, so the old code ignores them.

CREATE TABLE IF NOT EXISTS communities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$'),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 80),
  description text CHECK (description IS NULL OR char_length(description) <= 600),
  sport_id    uuid REFERENCES sports,
  city        text,
  visibility  text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private','hidden')),
  join_mode   text NOT NULL DEFAULT 'open' CHECK (join_mode IN ('open','request','invite')),
  audience    text NOT NULL DEFAULT 'adults' CHECK (audience IN ('adults','all')),   -- 'all' lets a guardian-approved young person join by invitation
  owner_id    uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS communities_slug ON communities (lower(slug));
CREATE INDEX IF NOT EXISTS communities_browse ON communities (created_at DESC, id DESC) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS community_members (
  community_id uuid NOT NULL REFERENCES communities,
  user_id      uuid NOT NULL REFERENCES users,
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','moderator','member')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','left','removed')),
  muted_until  timestamptz,                     -- a moderator has silenced this member until then
  decided_by   uuid REFERENCES users,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  left_at      timestamptz,
  PRIMARY KEY (community_id, user_id)
);
CREATE INDEX IF NOT EXISTS community_members_user ON community_members (user_id, status);

CREATE TABLE IF NOT EXISTS community_invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities,
  invitee_id   uuid NOT NULL REFERENCES users,
  invited_by   uuid NOT NULL REFERENCES users,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','withdrawn')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  CHECK (invitee_id <> invited_by)
);
CREATE UNIQUE INDEX IF NOT EXISTS community_invitations_open ON community_invitations (community_id, invitee_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS community_invitations_invitee ON community_invitations (invitee_id, status);

-- Posts: the same table as the marketplace, scoped to a community when community_id is set (those rows never appear in the public marketplace).
ALTER TABLE market_posts ADD COLUMN IF NOT EXISTS community_id uuid REFERENCES communities;
ALTER TABLE market_posts ADD COLUMN IF NOT EXISTS body_enc     text;           -- encrypted text of a community post (body stays NULL for these)
ALTER TABLE market_posts ADD COLUMN IF NOT EXISTS ref_kind     text;           -- achievement share: result | award | event ...
ALTER TABLE market_posts ADD COLUMN IF NOT EXISTS ref_id       text;
ALTER TABLE market_posts ADD COLUMN IF NOT EXISTS hidden_at    timestamptz;
ALTER TABLE market_posts ADD COLUMN IF NOT EXISTS hidden_by    uuid REFERENCES users;
ALTER TABLE market_posts ADD COLUMN IF NOT EXISTS hidden_reason text;
ALTER TABLE market_posts DROP CONSTRAINT IF EXISTS market_posts_kind_check;
ALTER TABLE market_posts ADD CONSTRAINT market_posts_kind_check CHECK (kind IN ('wanted','match','schedule','sale','campaign','announcement','post','share'));
CREATE INDEX IF NOT EXISTS market_posts_community ON market_posts (community_id, created_at DESC, id DESC) WHERE community_id IS NOT NULL;

ALTER TABLE market_comments ADD COLUMN IF NOT EXISTS body_enc text;
ALTER TABLE market_comments ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
ALTER TABLE market_comments ADD COLUMN IF NOT EXISTS hidden_by uuid REFERENCES users;
CREATE INDEX IF NOT EXISTS market_comments_cursor ON market_comments (post_id, created_at, id);

-- Reports: community content joins the one social report model, with a reasoned decision.
ALTER TABLE social_reports DROP CONSTRAINT IF EXISTS social_reports_target_type_check;
ALTER TABLE social_reports ADD CONSTRAINT social_reports_target_type_check CHECK (target_type IN ('user','activity','community_post','community_comment'));
ALTER TABLE social_reports ADD COLUMN IF NOT EXISTS community_id        uuid REFERENCES communities;
ALTER TABLE social_reports ADD COLUMN IF NOT EXISTS outcome             text CHECK (outcome IS NULL OR outcome IN ('hidden','warned','silenced','dismissed'));
ALTER TABLE social_reports ADD COLUMN IF NOT EXISTS decision_reason_enc text;
CREATE INDEX IF NOT EXISTS social_reports_community ON social_reports (community_id, status) WHERE community_id IS NOT NULL;

-- Appeals reuse the canonical support cases: the case carries the conversation, this row links it to the decision.
CREATE TABLE IF NOT EXISTS moderation_appeals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id    uuid NOT NULL REFERENCES social_reports,
  appellant_id uuid NOT NULL REFERENCES users,
  case_id      uuid NOT NULL REFERENCES cases,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, appellant_id)
);
