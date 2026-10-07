-- Player marketplace: billboard (demand board), sports shop, coach hiring.

ALTER TABLE sport_profiles ADD COLUMN hourly_rate_cents bigint CHECK (hourly_rate_cents >= 0);

CREATE TABLE billboard_posts (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  kind      text NOT NULL CHECK (kind IN ('match_players','team_recruiting','sponsorship_wanted','sponsor_call')),
  sport_id  uuid REFERENCES sports,
  team_id   uuid REFERENCES teams ON DELETE SET NULL,
  title     text NOT NULL,
  body      text,
  city      text,
  starts_at timestamptz,
  positions_needed int NOT NULL DEFAULT 1 CHECK (positions_needed BETWEEN 1 AND 200),
  budget_cents bigint CHECK (budget_cents >= 0),
  status    text NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billboard_open ON billboard_posts (status, kind, created_at DESC);
CREATE TABLE billboard_responses (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id   uuid NOT NULL REFERENCES billboard_posts ON DELETE CASCADE,
  responder_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  message   text,
  status    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, responder_id)
);

CREATE TABLE shop_products (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES users,
  sport_id  uuid REFERENCES sports,
  name      text NOT NULL,
  category  text NOT NULL DEFAULT 'equipment' CHECK (category IN ('equipment','apparel','footwear','nutrition','medical','accessories','other')),
  description text,
  price_cents bigint NOT NULL CHECK (price_cents >= 0),
  stock     int NOT NULL DEFAULT 0 CHECK (stock >= 0),
  emoji     text NOT NULL DEFAULT '🎽',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE shop_orders (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id  uuid NOT NULL REFERENCES users,
  seller_id uuid NOT NULL REFERENCES users,
  product_id uuid NOT NULL REFERENCES shop_products,
  quantity  int NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL,
  total_cents bigint NOT NULL,
  status    text NOT NULL DEFAULT 'placed' CHECK (status IN ('placed','shipped','delivered','cancelled')),
  ship_to_enc text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shop_orders_buyer ON shop_orders (buyer_id, created_at DESC);
CREATE INDEX shop_orders_seller ON shop_orders (seller_id, created_at DESC);

CREATE TABLE coach_hires (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hirer_id  uuid NOT NULL REFERENCES users,
  coach_id  uuid NOT NULL REFERENCES users,
  sport_id  uuid REFERENCES sports,
  starts_at timestamptz NOT NULL,
  duration_min int NOT NULL DEFAULT 60 CHECK (duration_min BETWEEN 15 AND 480),
  rate_cents_hour bigint NOT NULL DEFAULT 0,
  total_cents bigint NOT NULL DEFAULT 0,
  note      text,
  status    text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coach_hires_coach ON coach_hires (coach_id, starts_at);
