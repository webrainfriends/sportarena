-- Dynamic service needs (follow-up to #591). Additive only: one defaulted column. `needs` holds what a buyer chose for a requirement from the
-- suggestions built for its event (rules, catalogue, AI drafts, their own items). `compliance_kinds` stays as the enforceable subset, so older rows and clients keep working.
ALTER TABLE svc_requirements ADD COLUMN IF NOT EXISTS needs jsonb NOT NULL DEFAULT '[]';
