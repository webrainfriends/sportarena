-- Governing body administration depth (#574, extends #475). Additive only: new tables, one new column with a safe default, and the history
-- subject list WIDENED (every existing value stays valid). Nothing existing changes meaning and nothing is removed.
--
--  * Renewal campaigns: a body invites the affiliations / licences ending in a window to renew. The campaign stores WHO was invited (a reference to the
--    canonical record); whether they renewed is always read live from the renewal record that points back at it, never copied.
--  * Exception reviews: an exception (a decision approved over a failed requirement, or a sanctioned event that moved) is reviewed by compliance. Reviews
--    are appended, never edited; the latest one is the current state and the earlier ones stay as history.
--  * Delegation by jurisdiction: a scoped role can be granted so that it also applies to every body recognised beneath this one.
-- Rollback = deploy the previous code; it ignores these tables and the column, which can stay in place unused.

ALTER TABLE fed_events DROP CONSTRAINT IF EXISTS fed_events_subject_type_check;
ALTER TABLE fed_events ADD CONSTRAINT fed_events_subject_type_check
  CHECK (subject_type IN ('body','link','role','affiliation','licence','sanction','policy','date','campaign','exception'));

ALTER TABLE governing_body_roles ADD COLUMN IF NOT EXISTS cascades boolean NOT NULL DEFAULT false;

CREATE TABLE fed_campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id      uuid NOT NULL REFERENCES governing_bodies,
  name         text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  kind         text NOT NULL CHECK (kind IN ('affiliation','licence')),
  sport_id     uuid REFERENCES sports,
  ends_from    date NOT NULL,                       -- records that run out between these two dates are invited
  ends_to      date NOT NULL,
  message      text CHECK (message IS NULL OR length(message) <= 1000),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','closed')),
  invited      integer NOT NULL DEFAULT 0,
  sent_by      uuid REFERENCES users,
  sent_at      timestamptz,
  closed_by    uuid REFERENCES users,
  closed_at    timestamptz,
  created_by   uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_to >= ends_from),
  CHECK (ends_to - ends_from <= 400)
);
CREATE INDEX fed_campaigns_body ON fed_campaigns (body_id, status, created_at DESC);

CREATE TABLE fed_campaign_targets (
  campaign_id  uuid NOT NULL REFERENCES fed_campaigns,
  subject_type text NOT NULL CHECK (subject_type IN ('affiliation','licence')),
  subject_id   uuid NOT NULL,                       -- fed_affiliations.id or fed_licences.id (canonical record, not a copy)
  invited_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, subject_id)
);
CREATE INDEX fed_campaign_targets_subject ON fed_campaign_targets (subject_type, subject_id);

CREATE TABLE fed_exception_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id      uuid NOT NULL REFERENCES governing_bodies,
  subject_type text NOT NULL CHECK (subject_type IN ('affiliation','licence','sanction')),
  subject_id   uuid NOT NULL,
  resolution   text NOT NULL CHECK (resolution IN ('accepted','remedy_required','remedied')),
  note         text NOT NULL CHECK (length(note) BETWEEN 3 AND 500),
  due_on       date,
  reviewed_by  uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX fed_exception_reviews_subject ON fed_exception_reviews (subject_type, subject_id, created_at DESC);
CREATE INDEX fed_exception_reviews_body ON fed_exception_reviews (body_id, created_at DESC);
CREATE FUNCTION fed_exception_reviews_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER fed_exception_reviews_append_only BEFORE UPDATE OR DELETE ON fed_exception_reviews FOR EACH ROW EXECUTE FUNCTION fed_exception_reviews_append_only();
