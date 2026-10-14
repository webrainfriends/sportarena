-- Doctor workspace (issue #212), slice 1: structured clinical encounters. Additive only; medical_records, appointments and grants are untouched
-- and no legacy free text is converted into encounters. Content is encrypted JSON; the patient-visible visit summary is a separate encrypted
-- field so working notes never reach the athlete or a clearance-only reader.
CREATE TABLE IF NOT EXISTS clinical_encounters (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     uuid NOT NULL REFERENCES users,
  provider_id    uuid NOT NULL REFERENCES users,
  appointment_id uuid REFERENCES appointments,
  sport_id       uuid REFERENCES sports,
  kind           text NOT NULL DEFAULT 'encounter' CHECK (kind IN ('encounter','amendment')),
  amends_id      uuid REFERENCES clinical_encounters,
  template       text NOT NULL DEFAULT 'soap' CHECK (template IN ('soap','free')),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','signed','voided')),
  version        int  NOT NULL DEFAULT 1,
  content_enc    text NOT NULL,
  summary_enc    text,
  signed_at      timestamptz,
  signed_by      uuid REFERENCES users,
  credential_case_id uuid REFERENCES verification_cases,
  voided_at      timestamptz,
  voided_by      uuid REFERENCES users,
  void_reason_enc text,
  patient_ack_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'amendment') = (amends_id IS NOT NULL)),
  CHECK (status <> 'signed' OR (signed_at IS NOT NULL AND signed_by IS NOT NULL)),
  CHECK (status <> 'voided' OR (voided_at IS NOT NULL AND void_reason_enc IS NOT NULL))
);
-- a retried create cannot make a second live encounter for the same appointment
CREATE UNIQUE INDEX IF NOT EXISTS clinical_encounters_one_per_appointment ON clinical_encounters (appointment_id) WHERE kind = 'encounter' AND appointment_id IS NOT NULL AND status <> 'voided';
CREATE INDEX IF NOT EXISTS clinical_encounters_patient ON clinical_encounters (athlete_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS clinical_encounters_provider ON clinical_encounters (provider_id, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS clinical_encounters_amends ON clinical_encounters (amends_id) WHERE amends_id IS NOT NULL;

-- Signed entries are immutable: once signed (or voided) only voiding a signed entry and the patient's acknowledgement may change.
CREATE OR REPLACE FUNCTION clinical_encounters_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('signed','voided') THEN
    IF NEW.content_enc IS DISTINCT FROM OLD.content_enc OR NEW.summary_enc IS DISTINCT FROM OLD.summary_enc OR NEW.athlete_id <> OLD.athlete_id
       OR NEW.provider_id <> OLD.provider_id OR NEW.kind <> OLD.kind OR NEW.amends_id IS DISTINCT FROM OLD.amends_id
       OR NEW.signed_at IS DISTINCT FROM OLD.signed_at OR NEW.signed_by IS DISTINCT FROM OLD.signed_by THEN
      RAISE EXCEPTION 'signed clinical encounters are immutable; amend or void with a reason instead' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'voided' AND NEW.status <> 'voided' THEN RAISE EXCEPTION 'a voided encounter cannot be reopened' USING ERRCODE = 'check_violation'; END IF;
    IF OLD.status = 'signed' AND NEW.status NOT IN ('signed','voided') THEN RAISE EXCEPTION 'a signed encounter cannot return to draft' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS clinical_encounters_guard ON clinical_encounters;
CREATE TRIGGER clinical_encounters_guard BEFORE UPDATE ON clinical_encounters FOR EACH ROW EXECUTE FUNCTION clinical_encounters_guard();
