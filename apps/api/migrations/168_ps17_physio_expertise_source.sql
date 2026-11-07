-- PS-17 (para doctor consultations) records whether a declared para-sport specialism was self-declared or later verified, in
-- physio_para_expertise.source. That table was created by 163_para_physio_rehab without the column, and 165_para_doctor_consult only
-- uses CREATE TABLE IF NOT EXISTS, so the column never existed and declaring or listing a specialism failed. Additive and
-- backwards-compatible: existing rows read as self-declared.
ALTER TABLE physio_para_expertise ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'self_declared';
