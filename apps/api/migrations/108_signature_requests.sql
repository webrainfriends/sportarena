-- Third-party e-signature requests (#386). Additive only: no existing contract, signature or event row is touched.
-- One row per contract sent through an external vendor. `recipients` maps the vendor's recipient ids to our signatories so a vendor
-- callback can only ever sign for a person who was named on the contract (authority is still re-checked in applySignature).
CREATE TABLE sponsorship_signature_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id   uuid NOT NULL REFERENCES sponsorship_contracts,
  provider      text NOT NULL,
  external_ref  text NOT NULL,                       -- the vendor's envelope / agreement id
  jurisdiction  text,                                -- ISO 3166 country whose rules were chosen when sending
  level         text NOT NULL CHECK (level IN ('simple','advanced','qualified')),
  recipients    jsonb NOT NULL,                      -- [{ recipient_id, user_id }]
  status        text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','completed','declined','voided')),
  document_sha256 text NOT NULL,                     -- fingerprint of the contract text that was sent
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_ref)
);
CREATE INDEX sponsorship_signature_requests_contract ON sponsorship_signature_requests (contract_id, created_at DESC);
CREATE TRIGGER sponsorship_signature_requests_no_delete BEFORE DELETE ON sponsorship_signature_requests FOR EACH ROW EXECUTE FUNCTION bd_no_delete();
