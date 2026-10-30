-- Offers: a launch offer can be marked "auto apply" (applied to every purchase it fits, no code needed) and several offers can stack on one purchase.
-- Additive only: nothing is dropped or rewritten; existing single-offer subscriptions are backfilled into the new redemption table.
ALTER TABLE commercial_promotions ADD COLUMN IF NOT EXISTS auto_apply boolean NOT NULL DEFAULT false;

-- Every offer a subscription was bought with (subscriptions.promotion_id stays as the first one). Also the record that stops one account redeeming an offer twice.
CREATE TABLE IF NOT EXISTS commercial_subscription_promotions (
  subscription_id uuid NOT NULL REFERENCES commercial_subscriptions,
  promotion_id    uuid NOT NULL REFERENCES commercial_promotions,
  subject_type    text NOT NULL CHECK (subject_type IN ('user','organisation','team','venue','event')),
  subject_id      uuid NOT NULL,
  auto            boolean NOT NULL DEFAULT false,   -- true = applied automatically, false = the customer keyed in the code
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subscription_id, promotion_id)
);
CREATE INDEX IF NOT EXISTS commercial_subscription_promotions_offer ON commercial_subscription_promotions (promotion_id);
CREATE INDEX IF NOT EXISTS commercial_subscription_promotions_subject ON commercial_subscription_promotions (subject_type, subject_id, promotion_id);

INSERT INTO commercial_subscription_promotions(subscription_id, promotion_id, subject_type, subject_id, created_at)
SELECT s.id, s.promotion_id, s.subject_type, s.subject_id, s.created_at FROM commercial_subscriptions s WHERE s.promotion_id IS NOT NULL
ON CONFLICT DO NOTHING;
