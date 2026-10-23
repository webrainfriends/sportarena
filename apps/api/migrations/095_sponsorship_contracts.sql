-- Branded sponsorship contracts and signatures (#295). Additive only: existing agreements, payments and history are untouched, and no
-- contract is invented for them (one can be issued for any agreement on demand).
--
-- A contract is the frozen text of ONE terms version of an agreement. `snapshot` is what gets signed; it is written once and never
-- changes, so later edits to the agreement, the brand kit or the template cannot alter an issued contract. `draft` = unsigned,
-- `awaiting_signatures` = text locked and sent to the named signatories, `signed` = everyone required has signed, `voided` = replaced.
CREATE TABLE sponsorship_contracts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id      uuid NOT NULL REFERENCES sponsorships,
  terms_version       integer NOT NULL,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','awaiting_signatures','signed','voided')),
  snapshot            jsonb NOT NULL,
  snapshot_sha256     text NOT NULL,
  document_id         uuid NOT NULL REFERENCES generated_documents,   -- the unsigned draft PDF
  template_version_id uuid REFERENCES document_template_versions,      -- pinned at issue; null = the plain classic layout
  created_by          uuid NOT NULL REFERENCES users,
  requested_at        timestamptz,
  signed_at           timestamptz,
  voided_at           timestamptz,
  void_reason         text,
  row_version         integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now()
);
-- one live (not voided) contract per terms version of an agreement
CREATE UNIQUE INDEX sponsorship_contracts_live ON sponsorship_contracts (sponsorship_id, terms_version) WHERE status <> 'voided';
CREATE INDEX sponsorship_contracts_deal ON sponsorship_contracts (sponsorship_id, created_at DESC, id);

CREATE TABLE sponsorship_signatories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES sponsorship_contracts,
  side        text NOT NULL CHECK (side IN ('sponsor','recipient')),
  user_id     uuid NOT NULL REFERENCES users,
  capacity    text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed','declined','removed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, user_id)
);
CREATE INDEX sponsorship_signatories_user ON sponsorship_signatories (user_id, status);

-- Evidence: one immutable row per signature (who, which text fingerprint, which terms version, through which provider).
CREATE TABLE sponsorship_signatures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     uuid NOT NULL REFERENCES sponsorship_contracts,
  signatory_id    uuid NOT NULL REFERENCES sponsorship_signatories,
  user_id         uuid NOT NULL REFERENCES users,
  side            text NOT NULL,
  terms_version   integer NOT NULL,
  document_sha256 text NOT NULL,           -- fingerprint of the contract text that was signed (= sponsorship_contracts.snapshot_sha256)
  provider        text NOT NULL,
  provider_ref    text,
  intent          text NOT NULL,
  signed_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, signatory_id)
);

-- The final signed PDF, kept once. The bytes live (encrypted) in generated_documents; this row pins its hash and the accepted terms version.
CREATE TABLE sponsorship_signed_documents (
  contract_id   uuid PRIMARY KEY REFERENCES sponsorship_contracts,
  document_id   uuid NOT NULL REFERENCES generated_documents,
  sha256        text NOT NULL,
  terms_version integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER sponsorship_signatures_append_only BEFORE UPDATE OR DELETE ON sponsorship_signatures FOR EACH ROW EXECUTE FUNCTION bd_append_only();
CREATE TRIGGER sponsorship_signed_documents_append_only BEFORE UPDATE OR DELETE ON sponsorship_signed_documents FOR EACH ROW EXECUTE FUNCTION bd_append_only();
CREATE TRIGGER sponsorship_contracts_no_delete BEFORE DELETE ON sponsorship_contracts FOR EACH ROW EXECUTE FUNCTION bd_no_delete();
CREATE TRIGGER sponsorship_signatories_no_delete BEFORE DELETE ON sponsorship_signatories FOR EACH ROW EXECUTE FUNCTION bd_no_delete();

-- The text, version and draft of a contract never change; status only moves forward draft -> awaiting_signatures -> signed, or to voided
-- from draft / awaiting_signatures. A signed or voided contract is final.
CREATE FUNCTION sponsorship_contract_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.sponsorship_id IS DISTINCT FROM OLD.sponsorship_id OR NEW.terms_version IS DISTINCT FROM OLD.terms_version
     OR NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
     OR NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'an issued sponsorship contract cannot be edited';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('awaiting_signatures','voided'))
    OR (OLD.status = 'awaiting_signatures' AND NEW.status IN ('signed','voided'))) THEN
    RAISE EXCEPTION 'a % sponsorship contract cannot become %', OLD.status, NEW.status;
  END IF;
  IF OLD.status IN ('signed','voided') AND (NEW.signed_at IS DISTINCT FROM OLD.signed_at OR NEW.voided_at IS DISTINCT FROM OLD.voided_at OR NEW.void_reason IS DISTINCT FROM OLD.void_reason) THEN
    RAISE EXCEPTION 'a % sponsorship contract is final', OLD.status;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER sponsorship_contracts_guard BEFORE UPDATE ON sponsorship_contracts FOR EACH ROW EXECUTE FUNCTION sponsorship_contract_guard();
