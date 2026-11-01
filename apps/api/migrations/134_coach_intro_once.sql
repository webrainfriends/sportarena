-- An intro / trial rate card can be used once per athlete per coach (or per sport). Additive only: nothing is dropped
-- or rewritten, and historical duplicates stay on file (they just stop counting against the allowance).

ALTER TABLE coach_rate_cards ADD COLUMN IF NOT EXISTS intro_scope text NOT NULL DEFAULT 'coach';
DO $$ BEGIN
  ALTER TABLE coach_rate_cards ADD CONSTRAINT coach_rate_cards_intro_scope_chk CHECK (intro_scope IN ('coach','sport'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- who the session is for (the payer is hirer_id; a guardian books for a child), and a snapshot of the intro rule at booking
ALTER TABLE coach_hires ADD COLUMN IF NOT EXISTS athlete_id uuid REFERENCES users(id);
ALTER TABLE coach_hires ADD COLUMN IF NOT EXISTS intro_scope text;
ALTER TABLE coach_hires ADD COLUMN IF NOT EXISTS intro_counted boolean NOT NULL DEFAULT true;
DO $$ BEGIN
  ALTER TABLE coach_hires ADD CONSTRAINT coach_hires_intro_scope_chk CHECK (intro_scope IS NULL OR intro_scope IN ('coach','sport'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE coach_hires SET athlete_id = hirer_id WHERE athlete_id IS NULL;

UPDATE coach_hires h SET intro_scope = k.intro_scope
  FROM coach_rate_cards k
 WHERE k.id = h.rate_card_id AND k.is_intro AND h.audience = 'individual' AND h.intro_scope IS NULL;

-- history counts: keep the earliest live intro per athlete/coach (or sport) as the counted one, flag the rest
UPDATE coach_hires h SET intro_counted = false
  FROM (SELECT id, row_number() OVER (PARTITION BY coach_id, athlete_id, CASE WHEN intro_scope = 'sport' THEN sport_id END ORDER BY created_at, id) AS rn
          FROM coach_hires
         WHERE intro_scope IS NOT NULL AND status IN ('requested','confirmed','completed') AND payment_status <> 'refunded') d
 WHERE d.id = h.id AND d.rn > 1;

-- the atomic guard: a second live intro for the same athlete/coach cannot be inserted, even by a concurrent request.
-- Cancelled, expired and refunded hires leave the predicate, which frees the allowance.
CREATE UNIQUE INDEX IF NOT EXISTS coach_hires_intro_coach_uq ON coach_hires (coach_id, athlete_id)
  WHERE intro_scope = 'coach' AND intro_counted AND status IN ('requested','confirmed','completed') AND payment_status <> 'refunded';
CREATE UNIQUE INDEX IF NOT EXISTS coach_hires_intro_sport_uq ON coach_hires (coach_id, athlete_id, sport_id)
  WHERE intro_scope = 'sport' AND intro_counted AND status IN ('requested','confirmed','completed') AND payment_status <> 'refunded';
