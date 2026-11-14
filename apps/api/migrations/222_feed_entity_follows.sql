-- Fan & Community Feed — entity follow graph (issue #522). Additive and backwards-compatible.
-- Person-to-person follows already use spectator_follows (subject_type='athlete') and social_follow_requests.
-- This adds entity follows (team, academy, venue, event, coach, organisation) in a separate table so the
-- existing person-follow logic is never touched. Following an entity grants NO private data access.

CREATE TABLE IF NOT EXISTS feed_entity_follows (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  follower_id  uuid        NOT NULL REFERENCES users,
  entity_kind  text        NOT NULL CHECK (entity_kind IN ('team','academy','venue','event','coach','organisation')),
  entity_id    uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  PRIMARY KEY (follower_id, entity_kind, entity_id)
);
CREATE INDEX IF NOT EXISTS feed_entity_follows_follower    ON feed_entity_follows (follower_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS feed_entity_follows_entity      ON feed_entity_follows (entity_kind, entity_id) WHERE removed_at IS NULL;

-- Running follower counts per entity — updated by trigger so the feed query is fast.
CREATE TABLE IF NOT EXISTS feed_entity_follow_counts (
  entity_kind  text    NOT NULL,
  entity_id    uuid    NOT NULL,
  count        bigint  NOT NULL DEFAULT 0,
  PRIMARY KEY (entity_kind, entity_id)
);

-- Trigger to keep counts current on follow/unfollow.
CREATE OR REPLACE FUNCTION _feed_entity_follow_count_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.removed_at IS NULL THEN
    INSERT INTO feed_entity_follow_counts(entity_kind, entity_id, count) VALUES (NEW.entity_kind, NEW.entity_id, 1)
      ON CONFLICT (entity_kind, entity_id) DO UPDATE SET count = feed_entity_follow_counts.count + 1;
  ELSIF TG_OP = 'UPDATE' THEN
    -- was active → now removed
    IF OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL THEN
      UPDATE feed_entity_follow_counts SET count = GREATEST(0, count - 1) WHERE entity_kind = NEW.entity_kind AND entity_id = NEW.entity_id;
    -- was removed → now re-active
    ELSIF OLD.removed_at IS NOT NULL AND NEW.removed_at IS NULL THEN
      INSERT INTO feed_entity_follow_counts(entity_kind, entity_id, count) VALUES (NEW.entity_kind, NEW.entity_id, 1)
        ON CONFLICT (entity_kind, entity_id) DO UPDATE SET count = feed_entity_follow_counts.count + 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trig_feed_entity_follow_count ON feed_entity_follows;
CREATE TRIGGER trig_feed_entity_follow_count
  AFTER INSERT OR UPDATE ON feed_entity_follows
  FOR EACH ROW EXECUTE FUNCTION _feed_entity_follow_count_update();

-- Entity mutes: a user silences feed cards from a specific entity without unfollowing.
CREATE TABLE IF NOT EXISTS feed_entity_mutes (
  muter_id    uuid        NOT NULL REFERENCES users,
  entity_kind text        NOT NULL CHECK (entity_kind IN ('team','academy','venue','event','coach','organisation')),
  entity_id   uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  lifted_at   timestamptz,
  PRIMARY KEY (muter_id, entity_kind, entity_id)
);
CREATE INDEX IF NOT EXISTS feed_entity_mutes_muter ON feed_entity_mutes (muter_id) WHERE lifted_at IS NULL;
