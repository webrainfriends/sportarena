-- 196: Referee assignment clash and travel checks (REF-R04)
-- Additive only: no DROP / TRUNCATE / rewrites.

-- Sport-specific typical match duration for auto-populating duration_min on fixtures
ALTER TABLE sports ADD COLUMN IF NOT EXISTS typical_match_min int NOT NULL DEFAULT 90 CHECK (typical_match_min BETWEEN 10 AND 600);

UPDATE sports SET typical_match_min = CASE slug
  WHEN 'football'       THEN 105   -- 90 min + 15 min half-time
  WHEN 'rugby_union'    THEN 100   -- 80 min + 20 min half-time
  WHEN 'rugby_league'   THEN 90    -- 80 min + 10 min half-time
  WHEN 'cricket'        THEN 420   -- T20 ~3.5 h, ODI 7+ h; use T20 default
  WHEN 'baseball'       THEN 180   -- ~3 h average
  WHEN 'basketball'     THEN 60    -- 48 min game time + stoppages
  WHEN 'volleyball'     THEN 90    -- best-of-5 ~1.5 h
  WHEN 'tennis'         THEN 120   -- 2 h average
  WHEN 'badminton'      THEN 60    -- best-of-3 ~1 h
  WHEN 'squash'         THEN 60    -- best-of-5 ~1 h
  WHEN 'hockey'         THEN 75    -- 60 min + 15 min half-time
  WHEN 'ice_hockey'     THEN 70    -- 60 min + intermissions
  WHEN 'netball'        THEN 60    -- 60 min
  WHEN 'handball'       THEN 70    -- 60 min + 10 min half-time
  WHEN 'futsal'         THEN 50    -- 40 min + 10 min half-time
  WHEN 'water_polo'     THEN 60    -- 32 min + stoppages
  WHEN 'lacrosse'       THEN 70    -- 60 min + 10 min half-time
  WHEN 'field_hockey'   THEN 75    -- 60 min + 15 min half-time
  WHEN 'american_football' THEN 180 -- NFL ~3 h
  WHEN 'australian_rules' THEN 120  -- AFL ~2 h
  WHEN 'gaelic_football' THEN 80   -- 60 min + 20 min warm-up
  WHEN 'hurling'        THEN 80    -- 70 min + 10 min warm-up
  WHEN 'table_tennis'   THEN 45    -- best-of-7 ~45 min
  WHEN 'athletics'      THEN 180   -- track meet session
  WHEN 'swimming'       THEN 120   -- session
  WHEN 'gymnastics'     THEN 180   -- competition session
  WHEN 'cycling'        THEN 120   -- road race / track session
  WHEN 'wrestling'      THEN 60    -- bout series
  WHEN 'boxing'         THEN 60    -- bout series
  WHEN 'judo'           THEN 90    -- competition session
  WHEN 'karate'         THEN 90    -- competition session
  WHEN 'taekwondo'      THEN 90    -- competition session
  WHEN 'fencing'        THEN 60    -- competition session
  WHEN 'archery'        THEN 90    -- competition round
  WHEN 'shooting'       THEN 90    -- competition round
  WHEN 'golf'           THEN 270   -- 18 holes ~4.5 h
  WHEN 'rowing'         THEN 30    -- 2000 m heat + rest
  WHEN 'canoeing'       THEN 30    -- sprint event
  WHEN 'sailing'        THEN 120   -- race series
  WHEN 'equestrian'     THEN 90    -- dressage / jumping session
  ELSE 90
END;

-- reporting_min: minutes before kickoff the official must arrive at the venue (enforced in clash window)
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS reporting_min int NOT NULL DEFAULT 30 CHECK (reporting_min BETWEEN 0 AND 180);

-- locked assignments: cannot be released/swapped/substituted without an authorised override
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS locked_at    timestamptz;
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS locked_by    uuid REFERENCES users(id);
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS lock_reason  text;

-- clash exception audit: every time checkClash is bypassed (emergency substitution, organiser override)
-- a row is written here so the bypass is permanently auditable.
CREATE TABLE IF NOT EXISTS official_clash_exceptions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_official_id   uuid        NOT NULL REFERENCES fixture_officials(id),
  overriding_fixture_id uuid        REFERENCES fixture_officials(id),    -- the assignment that caused the clash, if known
  actor_id              uuid        NOT NULL REFERENCES users(id),
  override_reason       text        NOT NULL,
  computed_gap_min      int,         -- negative = actual overlap in minutes
  venue_distance_km     numeric,
  at                    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS official_clash_exceptions_fo  ON official_clash_exceptions(fixture_official_id, at);
CREATE INDEX IF NOT EXISTS official_clash_exceptions_act ON official_clash_exceptions(actor_id, at);
