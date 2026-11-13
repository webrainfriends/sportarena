-- Fan & Community Feed — canonical feed card projections (issue #522). Additive only; no data is copied.
-- A feed card is a pointer (ref_kind + ref_id) to a canonical record. When the source record is retracted
-- (hidden, archived, visibility changed) a trigger sets retracted_at and the card disappears from all feeds
-- automatically. Official scores, rankings and awards are NEVER modified by feed reactions or comments.

CREATE TABLE IF NOT EXISTS feed_cards (
  id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  card_kind       text        NOT NULL CHECK (card_kind IN ('result','fixture','achievement','clip','announcement','challenge','ranking','post')),
  ref_kind        text        NOT NULL,   -- canonical table name, e.g. 'events', 'awards', 'smart_clips'
  ref_id          text        NOT NULL,   -- id or composite key in that table
  author_kind     text        NOT NULL CHECK (author_kind IN ('team','academy','venue','event','coach','organisation','user')),
  author_id       uuid        NOT NULL,
  visibility      text        NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','followers','private')),
  is_youth_subject boolean    NOT NULL DEFAULT false,  -- true → visibility is locked to 'followers'; no location/contact projected
  sport_id        uuid        REFERENCES sports,
  geo_city        text,
  geo_venue_id    uuid,
  is_promoted     boolean     NOT NULL DEFAULT false,
  promoted_by     uuid        REFERENCES organisations,
  promoted_until  timestamptz,
  is_sponsored    boolean     NOT NULL DEFAULT false,
  sponsor_id      uuid,
  reactions_count int         NOT NULL DEFAULT 0,
  comments_count  int         NOT NULL DEFAULT 0,
  published_at    timestamptz NOT NULL DEFAULT now(),
  retracted_at    timestamptz,
  retracted_reason text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- Keep the ref immutable after insert: reactions/comments on a card can NEVER mutate the canonical record.
CREATE UNIQUE INDEX IF NOT EXISTS feed_cards_ref ON feed_cards (ref_kind, ref_id) WHERE retracted_at IS NULL;
CREATE INDEX IF NOT EXISTS feed_cards_author     ON feed_cards (author_kind, author_id, published_at DESC) WHERE retracted_at IS NULL;
CREATE INDEX IF NOT EXISTS feed_cards_public     ON feed_cards (published_at DESC, id DESC) WHERE retracted_at IS NULL AND visibility = 'public';
CREATE INDEX IF NOT EXISTS feed_cards_sport      ON feed_cards (sport_id, published_at DESC) WHERE retracted_at IS NULL;
CREATE INDEX IF NOT EXISTS feed_cards_city       ON feed_cards (geo_city, published_at DESC) WHERE retracted_at IS NULL;

-- Reactions and comments on feed cards reuse market_reactions / market_comments but keyed by feed_card_id.
-- A nullable feed_card_id column is added to market_reactions and market_comments so the same reaction/comment
-- tables work for both market posts and feed cards, with no data duplication.
ALTER TABLE market_reactions  ADD COLUMN IF NOT EXISTS feed_card_id uuid REFERENCES feed_cards;
ALTER TABLE market_comments   ADD COLUMN IF NOT EXISTS feed_card_id uuid REFERENCES feed_cards;
-- Make post_id nullable so a reaction/comment may belong to either a market_post or a feed_card.
ALTER TABLE market_reactions  ALTER COLUMN post_id DROP NOT NULL;
ALTER TABLE market_comments   ALTER COLUMN post_id DROP NOT NULL;

-- Trigger: when a market_post is hidden, retract any feed card that references it.
CREATE OR REPLACE FUNCTION _retract_feed_card_on_post_hide()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hidden_at IS NOT NULL AND OLD.hidden_at IS NULL THEN
    UPDATE feed_cards SET retracted_at = now(), retracted_reason = 'source_hidden'
     WHERE ref_kind = 'market_posts' AND ref_id = NEW.id::text AND retracted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trig_feed_card_post_hide ON market_posts;
CREATE TRIGGER trig_feed_card_post_hide
  AFTER UPDATE ON market_posts
  FOR EACH ROW EXECUTE FUNCTION _retract_feed_card_on_post_hide();

-- Trigger: when an activity_item_settings row is moderated/hidden, retract any feed card for it.
CREATE OR REPLACE FUNCTION _retract_feed_card_on_item_hide()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.hidden_at IS NOT NULL AND (OLD.hidden_at IS NULL))
     OR (NEW.moderated_at IS NOT NULL AND (OLD.moderated_at IS NULL)) THEN
    UPDATE feed_cards SET retracted_at = now(), retracted_reason = 'source_hidden'
     WHERE ref_kind = 'activity_items' AND ref_id = (NEW.actor_id::text || ':' || NEW.kind || ':' || NEW.source_id) AND retracted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trig_feed_card_item_hide ON activity_item_settings;
CREATE TRIGGER trig_feed_card_item_hide
  AFTER UPDATE ON activity_item_settings
  FOR EACH ROW EXECUTE FUNCTION _retract_feed_card_on_item_hide();

-- Counts updated by trigger when a reaction or comment is added/removed.
CREATE OR REPLACE FUNCTION _feed_card_counts_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_card_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'market_reactions' THEN
    v_card_id := COALESCE(NEW.feed_card_id, OLD.feed_card_id);
    IF v_card_id IS NULL THEN RETURN NEW; END IF;
    UPDATE feed_cards SET reactions_count = (
      SELECT count(*) FROM market_reactions WHERE feed_card_id = v_card_id AND active = true
    ) WHERE id = v_card_id;
  ELSIF TG_TABLE_NAME = 'market_comments' THEN
    v_card_id := COALESCE(NEW.feed_card_id, OLD.feed_card_id);
    IF v_card_id IS NULL THEN RETURN NEW; END IF;
    UPDATE feed_cards SET comments_count = (
      SELECT count(*) FROM market_comments WHERE feed_card_id = v_card_id AND archived_at IS NULL
    ) WHERE id = v_card_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trig_feed_card_reaction_count ON market_reactions;
CREATE TRIGGER trig_feed_card_reaction_count
  AFTER INSERT OR UPDATE ON market_reactions
  FOR EACH ROW EXECUTE FUNCTION _feed_card_counts_update();
DROP TRIGGER IF EXISTS trig_feed_card_comment_count ON market_comments;
CREATE TRIGGER trig_feed_card_comment_count
  AFTER INSERT OR UPDATE OR DELETE ON market_comments
  FOR EACH ROW EXECUTE FUNCTION _feed_card_counts_update();
