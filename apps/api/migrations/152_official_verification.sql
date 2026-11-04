-- Official verification (#479, ported onto the governance discipline): an entitled organiser, competition official or academy asks the platform for a verified statement of a
-- person's standing; an Official verifier answers it. Additive only. Attestations carry the result and its validity, never the sanction, the reason or the evidence.
-- official verification of a person's standing, asked by an entitled organiser/official/academy and answered by an Official verifier. Attestation only: no sanction detail is ever stored here.
CREATE TABLE IF NOT EXISTS disc_verification_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no    text NOT NULL UNIQUE,
  requester_id  uuid NOT NULL REFERENCES users,
  organisation_id uuid REFERENCES organisations,
  subject_user_id uuid NOT NULL REFERENCES users,
  sport_id      uuid NOT NULL REFERENCES sports,
  competition_id uuid REFERENCES comp_competitions,
  purpose       text NOT NULL CHECK (purpose IN ('event_entry','tournament_selection','academy_admission','official_appointment','other')),
  note_enc      text,
  status        text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','in_review','decided','withdrawn')),
  verifier_id   uuid REFERENCES users,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS disc_vreq_queue ON disc_verification_requests (status, created_at);
CREATE INDEX IF NOT EXISTS disc_vreq_requester ON disc_verification_requests (requester_id, created_at DESC);
CREATE SEQUENCE IF NOT EXISTS disc_vreq_seq;
CREATE TABLE IF NOT EXISTS disc_attestations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES disc_verification_requests,
  result      text NOT NULL CHECK (result IN ('eligible','not_eligible','unable_to_verify')),
  as_of       date NOT NULL,
  valid_until date NOT NULL,
  issued_by   uuid NOT NULL REFERENCES users,
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS disc_attest_live ON disc_attestations (request_id) WHERE revoked_at IS NULL;

-- an attestation never changes except its revocation
CREATE OR REPLACE FUNCTION disc_attestation_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Attestations are never deleted'; END IF;
  IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.result IS DISTINCT FROM OLD.result OR NEW.as_of IS DISTINCT FROM OLD.as_of
     OR NEW.valid_until IS DISTINCT FROM OLD.valid_until OR NEW.issued_by IS DISTINCT FROM OLD.issued_by THEN
    RAISE EXCEPTION 'An attestation cannot be edited; revoke it and issue a new one';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS disc_attestation_guard ON disc_attestations;
CREATE TRIGGER disc_attestation_guard BEFORE UPDATE OR DELETE ON disc_attestations FOR EACH ROW EXECUTE FUNCTION disc_attestation_guard();
