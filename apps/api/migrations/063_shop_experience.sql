-- Shop experience: product photos, list price (for offers), brand, highlights, a server-side cart that follows the user across devices,
-- a wishlist, product reviews (reusing testimonials) and one checkout/payment for a whole cart. Additive only; nothing is dropped or rewritten.

ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS brand            text,
  ADD COLUMN IF NOT EXISTS compare_at_cents bigint CHECK (compare_at_cents IS NULL OR compare_at_cents >= 0),
  ADD COLUMN IF NOT EXISTS highlights       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS archived_at      timestamptz;
CREATE INDEX IF NOT EXISTS shop_products_listing ON shop_products (created_at DESC) WHERE archived_at IS NULL;

-- Product photos reuse the marketplace upload (PUT /market/media); the file row is attached to the product.
ALTER TABLE market_media ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES shop_products;
CREATE INDEX IF NOT EXISTS market_media_product ON market_media (product_id, position) WHERE removed_at IS NULL;

-- The cart. A line removed from the cart keeps its row (removed_at); saved_for_later keeps it out of the total.
CREATE TABLE IF NOT EXISTS shop_cart_items (
  user_id    uuid NOT NULL REFERENCES users,
  product_id uuid NOT NULL REFERENCES shop_products,
  quantity   int  NOT NULL CHECK (quantity > 0),
  saved_for_later boolean NOT NULL DEFAULT false,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

-- The wishlist (un-hearting flips active; the row is kept).
CREATE TABLE IF NOT EXISTS shop_wishlist (
  user_id    uuid NOT NULL REFERENCES users,
  product_id uuid NOT NULL REFERENCES shop_products,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

-- Orders bought together share a checkout and are paid with one payment.
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS checkout_id uuid;
CREATE INDEX IF NOT EXISTS shop_orders_checkout ON shop_orders (checkout_id) WHERE checkout_id IS NOT NULL;

-- Product reviews live with the other testimonials; a payment can be for a whole checkout.
ALTER TABLE testimonials DROP CONSTRAINT IF EXISTS testimonials_subject_type_check;
ALTER TABLE testimonials ADD CONSTRAINT testimonials_subject_type_check CHECK (subject_type IN ('user','team','event','venue','sponsor','product'));
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_purpose_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check CHECK (purpose_type IN ('shop_order','coach_hire','insurance_policy','venue_invoice','wallet_topup','gift_card','venue_plan','appointment','shop_checkout'));
