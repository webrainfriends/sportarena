-- PS-18: the athlete's own equipment list is read and updated with an optimistic-concurrency counter
-- (adaptive_athlete_equipment.row_version), but 182_adaptive_equipment created the table without it, so listing and
-- editing failed. Additive and backwards-compatible: existing rows start at 1.
ALTER TABLE adaptive_athlete_equipment ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;
