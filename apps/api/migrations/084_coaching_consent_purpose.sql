-- Coaching completion, part F (issue #269). A guardian can now allow coaching records about their child to be shared with the child and
-- with them ('coaching'). Widening an allowed list only; every existing consent row keeps its meaning.
ALTER TABLE youth_consents DROP CONSTRAINT youth_consents_purpose_check;
ALTER TABLE youth_consents ADD CONSTRAINT youth_consents_purpose_check CHECK (purpose IN ('participation','medical','media','contact','coaching'));
