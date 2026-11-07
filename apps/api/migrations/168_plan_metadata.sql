-- Additive: attach rich planning metadata to training_plans (plan type, phase, load architecture, intensity model, para flags, etc.)
ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE training_plan_revisions ADD COLUMN IF NOT EXISTS metadata JSONB;
