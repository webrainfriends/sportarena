-- One rubric can serve several sports, and a coach gets the governing bodies' standard rubrics for the sports they coach.
-- Additive only: coaching_rubrics.sport_id stays (kept in step with the first linked sport); nothing is deleted.
CREATE TABLE coaching_rubric_sports (
  rubric_id  uuid NOT NULL REFERENCES coaching_rubrics,
  sport_id   uuid NOT NULL REFERENCES sports,
  removed_at timestamptz,          -- soft: taking a sport off a rubric keeps the row
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rubric_id, sport_id)
);
INSERT INTO coaching_rubric_sports(rubric_id, sport_id) SELECT id, sport_id FROM coaching_rubrics WHERE sport_id IS NOT NULL;

ALTER TABLE coaching_rubrics
  ADD COLUMN standard_key    text,   -- set when the rubric came from the standards library (see src/standard-rubrics.js)
  ADD COLUMN standard_source text;   -- the body the framework is aligned with, e.g. 'FIFA'
-- a coach is given each standard once; archiving it means "I do not want it", so it is never given again
CREATE UNIQUE INDEX coaching_rubrics_standard ON coaching_rubrics (coach_id, standard_key) WHERE standard_key IS NOT NULL;
