-- Current professional verification for clinical actions (issue #59). Additive only; nothing is rewritten or removed.
-- Jurisdiction the credential was issued for (free text such as a country/state code). NULL = not recorded / valid wherever the platform
-- policy allows. Enforced only when CLINICAL_JURISDICTIONS is configured (see docs/verification.md).
ALTER TABLE verification_cases ADD COLUMN IF NOT EXISTS jurisdiction text;

-- Emergency exception: a doctor/physio on event cover whose credential lapsed may still log a serious/emergency incident,
-- but only with a stated reason. The flag and the (encrypted) reason are kept with the incident so the exception is never silent.
ALTER TABLE event_medical_incidents ADD COLUMN IF NOT EXISTS credential_override boolean NOT NULL DEFAULT false;
ALTER TABLE event_medical_incidents ADD COLUMN IF NOT EXISTS credential_override_enc text;
