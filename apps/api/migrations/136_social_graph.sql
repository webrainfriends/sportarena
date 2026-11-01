-- Social graph (issue #695). Additive and backwards-compatible: nothing is dropped, narrowed or rewritten.
-- Following reuses spectator_follows (subject_type='athlete'); blocking reuses user_blocks. This adds only what did not exist:
-- friendships, follow requests (approval / guardian approval), per-person feed mutes, privacy settings, per-item visibility and reports.
-- Activity items are NOT stored: they are projected from canonical records (approved results, awards, public open games, rating moves),
-- so a reversed result or a revoked consent removes an item by itself. Only the person's per-item choice is stored.

CREATE TABLE IF NOT EXISTS social_settings (
  user_id                 uuid PRIMARY KEY REFERENCES users,
  default_item_visibility text NOT NULL DEFAULT 'followers' CHECK (default_item_visibility IN ('public','followers','friends','private')),
  follow_mode             text NOT NULL DEFAULT 'open' CHECK (follow_mode IN ('open','approval','closed')),
  discoverable            boolean NOT NULL DEFAULT true,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- A follow that is waiting for someone: the guardian of a young follower, or the person followed when they approve followers.
-- On approval the follow itself is written to spectator_follows, so every existing reader keeps working unchanged.
CREATE TABLE IF NOT EXISTS social_follow_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id   uuid NOT NULL REFERENCES users,
  target_id     uuid NOT NULL REFERENCES users,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('guardian_pending','pending','approved','declined','withdrawn')),
  guardian_id   uuid REFERENCES users,                       -- the guardian who approved (live-checked at read time)
  decided_by    uuid REFERENCES users,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (follower_id <> target_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS social_follow_requests_open ON social_follow_requests (follower_id, target_id) WHERE status IN ('guardian_pending','pending');
CREATE INDEX IF NOT EXISTS social_follow_requests_target ON social_follow_requests (target_id, status);

CREATE TABLE IF NOT EXISTS friendships (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id         uuid NOT NULL REFERENCES users,
  addressee_id         uuid NOT NULL REFERENCES users,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('guardian_pending','pending','accepted','declined','ended')),
  guardian_id          uuid REFERENCES users,                -- approving guardian of the young side, when there is one
  guardian_approved_at timestamptz,
  decided_at           timestamptz,
  ended_at             timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (requester_id <> addressee_id)
);
-- one live friendship or request per unordered pair
CREATE UNIQUE INDEX IF NOT EXISTS friendships_live_pair ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id)) WHERE status IN ('guardian_pending','pending','accepted');
CREATE INDEX IF NOT EXISTS friendships_addressee ON friendships (addressee_id, status);
CREATE INDEX IF NOT EXISTS friendships_requester ON friendships (requester_id, status);

CREATE TABLE IF NOT EXISTS social_mutes (
  muter_id   uuid NOT NULL REFERENCES users,
  muted_id   uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at  timestamptz,
  PRIMARY KEY (muter_id, muted_id),
  CHECK (muter_id <> muted_id)
);

-- The person's own choice for one derived item: who may see it, or hide it altogether.
CREATE TABLE IF NOT EXISTS activity_item_settings (
  actor_id   uuid NOT NULL REFERENCES users,
  kind       text NOT NULL CHECK (kind IN ('result','streak','achievement','hosted_game','rating')),
  source_id  text NOT NULL,
  visibility text CHECK (visibility IN ('public','followers','friends','private')),
  hidden_at  timestamptz,                                     -- hidden by the person
  moderated_at timestamptz,                                   -- hidden by the platform after a report (never lifted by the person)
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, kind, source_id)
);

CREATE TABLE IF NOT EXISTS social_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users,
  target_type text NOT NULL CHECK (target_type IN ('user','activity')),
  target_id   text NOT NULL,
  actor_id    uuid REFERENCES users,                          -- the person the report is about
  reason      text NOT NULL CHECK (reason IN ('harassment','unsafe_contact','impersonation','spam','privacy','inaccurate','other')),
  note_enc    text,                                           -- encrypted free text
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  decided_by  uuid REFERENCES users,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS social_reports_open ON social_reports (status, created_at);

-- Guardian authority: a new 'social' scope. Links that held the full default authority keep full authority (additive).
ALTER TABLE guardian_links ALTER COLUMN scopes SET DEFAULT '{pay,register,rsvp,travel_consent,consent,calendar,social}';
UPDATE guardian_links SET scopes = scopes || '{social}'
 WHERE NOT ('social' = ANY(scopes)) AND scopes @> '{pay,register,rsvp,travel_consent,consent,calendar}';
