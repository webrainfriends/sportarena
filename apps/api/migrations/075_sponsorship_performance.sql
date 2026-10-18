-- Sponsorship performance review (#145 §7): consent-gated access to an athlete's canonical results, agreed review objectives, dated reviews.
-- Additive only: new columns default to "no access", new tables hold new data, nothing existing is rewritten or removed. Results are never copied:
-- the review reads the athlete's own `performances` at request time, so corrected results show up immediately.
-- Rollback = deploy the previous code; it ignores these columns and tables, which can stay in place unused.
ALTER TABLE sponsorships
  ADD COLUMN performance_access    boolean NOT NULL DEFAULT false,   -- the athlete's switch; revoking stops all future reads, history stays
  ADD COLUMN performance_scope     text NOT NULL DEFAULT 'official' CHECK (performance_scope IN ('official','all_evidence')),
  ADD COLUMN performance_access_at timestamptz,
  ADD COLUMN performance_access_by uuid REFERENCES users;

-- A target the two sides agree to look at. It is a review aid only: missing it never cancels, pauses or reduces a due.
CREATE TABLE sponsorship_objectives (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id uuid NOT NULL REFERENCES sponsorships,
  sport_id       uuid NOT NULL REFERENCES sports,
  metric         text NOT NULL,
  direction      text NOT NULL CHECK (direction IN ('higher','lower')),
  evidence       text NOT NULL DEFAULT 'approved_competition' CHECK (evidence IN ('approved_competition','self_reported','imported')),
  baseline_value numeric,
  baseline_on    date,
  target_value   numeric NOT NULL,
  window_start   date NOT NULL,
  window_end     date NOT NULL,
  status         text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','agreed','declined','archived')),
  proposed_by    uuid NOT NULL REFERENCES users,
  decided_by     uuid REFERENCES users,
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end >= window_start)
);
CREATE INDEX sponsorship_objectives_deal ON sponsorship_objectives (sponsorship_id, id);

CREATE TABLE sponsorship_reviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id uuid NOT NULL REFERENCES sponsorships,
  author_id      uuid NOT NULL REFERENCES users,
  body           text NOT NULL,
  visibility     text NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared','author_only')),
  next_review_on date,
  response       text,
  responded_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sponsorship_reviews_deal ON sponsorship_reviews (sponsorship_id, created_at, id);
