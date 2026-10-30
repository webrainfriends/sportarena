-- A plan subscription can be paid through the hosted checkout (payments.purpose_type 'commercial_subscription').
-- Additive: widen whatever purpose list is in force, never rewrite it, so every other module's purposes survive.
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'payments_purpose_type_check' AND conrelid = 'payments'::regclass;
  IF d IS NOT NULL AND position('commercial_subscription' IN d) = 0 THEN
    ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
    EXECUTE 'ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check ' || replace(d, '::text])', '::text, ''commercial_subscription''::text])');
  END IF;
END $$;
