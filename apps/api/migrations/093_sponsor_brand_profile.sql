-- Rich, editable sponsor brand profile (additive: new nullable columns, nothing dropped or rewritten).
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS tagline text;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS about text;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS brand_color text;                       -- #RRGGBB accent shown on the brand card
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS founded_year int;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS country text;                           -- two-letter ISO code
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS sports text[] NOT NULL DEFAULT '{}';    -- sport slugs the brand backs (empty = any)
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS regions text[] NOT NULL DEFAULT '{}';   -- cities / areas it sponsors in (empty = anywhere)
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS offers text[] NOT NULL DEFAULT '{}';    -- what it provides: cash, equipment, travel, ... (same vocabulary as an athlete's "looking for")
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS backs text[] NOT NULL DEFAULT '{}';     -- athlete, team, event
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS budget_currency text;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS budget_min_cents bigint;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS budget_max_cents bigint;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '{}';      -- {instagram, linkedin, x, youtube}
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS updated_at timestamptz;
