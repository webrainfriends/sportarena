-- Media rights depth (#590), additive only: nothing existing is changed, dropped or rewritten.
--  * mr_rights_checks: every rights check before an asset is published, exported or handed to a partner (and every governed download) is written down with each rule's answer and the asset's provenance. Append-only.
--  * mr_assets.followers_notified_at: fans who follow the event, team, game or athlete are told once when a public asset goes live.
--  * spectator_follows.alerts may now also hold 'media' (a widening of the allowed list; existing rows keep their alerts).
CREATE TABLE mr_rights_checks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events,
  asset_id   uuid NOT NULL REFERENCES mr_assets,
  licence_id uuid REFERENCES mr_licences,
  user_id    uuid REFERENCES users,
  purpose    text NOT NULL CHECK (purpose IN ('publish','export','distribute','download')),
  platform   text,
  country    text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  outcome    text NOT NULL CHECK (outcome IN ('allowed','blocked')),
  rules      jsonb NOT NULL DEFAULT '[]',
  provenance jsonb NOT NULL DEFAULT '{}',
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mr_rights_checks_asset ON mr_rights_checks (asset_id, checked_at DESC);
CREATE INDEX mr_rights_checks_event ON mr_rights_checks (event_id, checked_at DESC);
CREATE FUNCTION mr_rights_checks_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rights checks are append-only'; END $$;
CREATE TRIGGER mr_rights_checks_append_only BEFORE UPDATE OR DELETE ON mr_rights_checks FOR EACH ROW EXECUTE FUNCTION mr_rights_checks_guard();

ALTER TABLE mr_assets ADD COLUMN followers_notified_at timestamptz;
-- assets that already went out before this change must not alert anyone retroactively
UPDATE mr_assets SET followers_notified_at = now() WHERE status = 'published';

ALTER TABLE spectator_follows DROP CONSTRAINT IF EXISTS spectator_follows_alerts_check;
ALTER TABLE spectator_follows ADD CONSTRAINT spectator_follows_alerts_check CHECK (alerts <@ ARRAY['start', 'score', 'result', 'schedule', 'media']::text[]);
