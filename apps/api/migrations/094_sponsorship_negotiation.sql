-- Sponsorship negotiation (#290): recipient counteroffers, per-version authorship, term comments, private internal notes and final sign-off.
-- Purely additive. Existing deals, their numbered versions, lines, history and financial rows are untouched: every existing version is
-- recorded as authored by the sponsor (that is who wrote it), and no date/term is invented for versions that did not store them.
ALTER TABLE sponsorships
  ADD COLUMN terms_side text NOT NULL DEFAULT 'sponsor' CHECK (terms_side IN ('sponsor','recipient')); -- who wrote the CURRENT version; the other side signs it off

-- One row per numbered terms version: who wrote it, why, and who signed it off. The lines themselves stay in sponsorship_lines.
CREATE TABLE sponsorship_versions (
  sponsorship_id uuid NOT NULL REFERENCES sponsorships,
  version        integer NOT NULL,
  authored_side  text NOT NULL CHECK (authored_side IN ('sponsor','recipient')),
  authored_by    uuid REFERENCES users,
  reason         text,
  restores       integer,                       -- set when a withdrawal re-issues the earlier terms of version `restores`
  starts_on      date,                          -- NULL = not recorded (versions that predate #290 only know the current period)
  ends_on        date,
  timezone       text,
  signed_off_by  uuid REFERENCES users,
  signed_off_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sponsorship_id, version)
);
INSERT INTO sponsorship_versions(sponsorship_id, version, authored_side, authored_by, starts_on, ends_on, timezone, signed_off_by, signed_off_at, created_at)
SELECT s.id, v.n, 'sponsor', s.proposed_by,
       CASE WHEN v.n = s.terms_version THEN s.starts_on END, CASE WHEN v.n = s.terms_version THEN s.ends_on END, CASE WHEN v.n = s.terms_version THEN s.timezone END,
       CASE WHEN s.accepted_version = v.n THEN s.decided_by END, CASE WHEN s.accepted_version = v.n THEN s.decided_at END, s.created_at
  FROM sponsorships s CROSS JOIN LATERAL generate_series(1, s.terms_version) AS v(n);

-- Comments on the terms. `shared` ones are visible to both sides; `internal` ones only to the side that wrote them (never the other side, never an admin).
CREATE TABLE sponsorship_comments (
  id             bigserial PRIMARY KEY,
  sponsorship_id uuid NOT NULL REFERENCES sponsorships,
  version        integer NOT NULL,
  line_position  integer,                       -- NULL = about the offer as a whole
  side           text NOT NULL CHECK (side IN ('sponsor','recipient')),
  visibility     text NOT NULL CHECK (visibility IN ('shared','internal')),
  author_id      uuid NOT NULL REFERENCES users,
  body           text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sponsorship_comments_deal ON sponsorship_comments (sponsorship_id, id);

-- Every deal, from whichever flow creates it (offer, award, event plan, vendor), starts with its version 1 recorded as the sponsor's.
CREATE FUNCTION sponsorship_first_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sponsorship_versions(sponsorship_id, version, authored_side, authored_by, starts_on, ends_on, timezone)
  VALUES (NEW.id, NEW.terms_version, 'sponsor', NEW.proposed_by, NEW.starts_on, NEW.ends_on, NEW.timezone) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER sponsorships_first_version AFTER INSERT ON sponsorships FOR EACH ROW EXECUTE FUNCTION sponsorship_first_version();
