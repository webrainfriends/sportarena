-- Coach money follows the coach's country (issue: currency from the country setting). A rate card or commitment now records the currency it
-- was priced in. NULL means "priced before this column existed", i.e. in the platform currency, so every existing row keeps its meaning;
-- nothing is rewritten or dropped. Hires, classes, packages and subscriptions already store their own currency.
ALTER TABLE coach_rate_cards ADD COLUMN IF NOT EXISTS currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
ALTER TABLE coach_commitments ADD COLUMN IF NOT EXISTS currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
-- A coaching request's budget is in the athlete's currency; each coach's answer (and the session it becomes) is in the currency it was quoted in.
ALTER TABLE coach_requests ADD COLUMN IF NOT EXISTS currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
ALTER TABLE coach_request_responses ADD COLUMN IF NOT EXISTS currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
