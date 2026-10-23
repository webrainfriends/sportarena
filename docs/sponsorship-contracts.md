# Branded sponsorship contracts and signatures (#295)

A contract is the frozen text of **one terms version** of a sponsorship agreement (#145), rendered as a branded PDF through the shared
branded-document system (#249) and signed by named people on each side. It is evidence about the text. It never changes the agreement's
terms, schedule, payments or acceptance, and it is not a ledger.

## States
| State | Meaning |
|---|---|
| `draft` | Unsigned. Every page of the PDF is stamped **DRAFT — NOT SIGNED**. Signatories can still be changed. |
| `awaiting_signatures` | The text is locked and every named signatory has been asked to sign. Still not binding. |
| `signed` | Every named signatory signed. An immutable signed PDF and one evidence row per signature exist. Final. |
| `voided` | Replaced or withdrawn before signing. Kept for the record, never deleted. A signed contract can never be voided. |

`signed_state` is `signed` or `unsigned` for clients that only need to tell the two apart. `stale` is true when the agreement moved to a
newer terms version before the contract was signed; a stale contract cannot be sent or signed (409 `stale_version`).

## API (all `cap(...)`: REST + OpenAPI + MCP)
| Capability | Route | Who |
|---|---|---|
| `generate_sponsorship_contract` | `POST /sponsorships/{id}/contracts` | sponsor staff with `contract` (manager, legal, approver) or the recipient side |
| `list_sponsorship_contracts` | `GET /sponsorships/{id}/contracts` | parties to the agreement |
| `get_sponsorship_contract` | `GET /sponsorship-contracts/{id}` | parties (404 for anyone else) |
| `list_contract_signers` | `GET /sponsorships/{id}/contract-signers` | who may manage; people eligible to be named, per side |
| `set_contract_signatories` | `PATCH /sponsorship-contracts/{id}/signatories` | managers; draft only |
| `request_contract_signatures` | `POST /sponsorship-contracts/{id}/request-signatures` | managers |
| `sign_sponsorship_contract` | `POST /sponsorship-contracts/{id}/sign` | a named signatory with live authority |
| `void_sponsorship_contract` | `POST /sponsorship-contracts/{id}/void` | managers; unsigned only |
| (callback) | `POST /webhooks/signatures/webhook` | external e-signature service (HMAC) |
| (download) | `GET /branded-documents/{id}/file` | parties, access re-checked on every download and audit-logged |

Signing needs `document_sha256` (the contract's `snapshot_sha256`, which the signer reviewed) and `agree: true`.

## Authority
* Sponsor side: a new sponsor action `sign_contract` (manager, approver) decides who can sign for the brand; `contract` (manager, legal, approver) who can issue and send.
* Recipient side: the target owner (athlete, team owner, event organiser) or an organisation owner/admin.
* Authority is read **live** when someone is named and again when they sign. A person who lost authority, a non-party, or an admin cannot sign. Admins can read, never sign.

## Immutability and idempotency
* `snapshot` (the exact content), its SHA-256, the terms version, the draft document and the pinned template version cannot be updated (trigger `sponsorship_contract_guard`). Status only moves forward.
* `sponsorship_signatures` and `sponsorship_signed_documents` are append-only (trigger `bd_append_only`). The signed PDF's bytes are stored encrypted in `generated_documents`; its SHA-256 and the accepted terms version are pinned in `sponsorship_signed_documents`.
* The brand kit and template are frozen into `document_template_versions` when published; the contract pins the version it was issued with, so editing a template, renaming the brand or revising the agreement never alters an issued contract.
* A repeated signature (double click, retry, replayed callback) returns the existing evidence and changes nothing. Callback events are recorded once in `provider_events` in the same transaction as the signature; concurrent identical callbacks apply once.

## Signature providers (`src/signatures/providers.js`)
* `internal`: the logged-in signatory signs in the app.
* `webhook`: an external service posts `{event_id, contract_id, user_id, document_sha256, provider_ref, status:"signed"}` with `X-Signature: t=<unix>,v1=<hmac-sha256 of "t.rawbody">`, enabled by setting `SIGNATURE_WEBHOOK_SECRET`. Authority and the text fingerprint are still re-checked server side.
* **Limitation:** no third-party e-signature vendor (DocuSign, Adobe Sign, ...) is integrated or configured; the outbound "create request" call to a vendor is not built. Signatures made in Sportarena are simple electronic signatures (identity, time, fingerprint, intent), not qualified/advanced signatures.

## Schema (migration `095_sponsorship_contracts.sql`, additive)
`sponsorship_contracts`, `sponsorship_signatories`, `sponsorship_signatures`, `sponsorship_signed_documents`. No existing table is altered and no contract is invented for existing agreements. Rollback: the feature is unused until a contract is issued, so reverting the code is safe; the new tables can stay (data is never dropped).

## Recovery
A contract stuck `awaiting_signatures` can be withdrawn by a manager and re-issued. A failed callback (non-2xx) is retried by the provider. Re-running a signature after a crash is safe because the signature and the event row commit together.

## Document family
`sponsorship_agreement` is now an available family in the Document designer: required blocks title, parties and lines; `text` blocks carry the template's own clauses. The signature block is always printed.
