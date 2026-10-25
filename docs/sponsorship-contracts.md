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
| `get_signature_policy` | `GET /signature-policy` | signed-in users; the expected signature level per country and which providers meet it |
| (callback) | `POST /webhooks/signatures/webhook` | generic external e-signature service (HMAC) |
| (callback) | `POST /webhooks/signatures/docusign` | DocuSign Connect (HMAC, `X-DocuSign-Signature-1`) |
| (download) | `GET /branded-documents/{id}/file` | parties, access re-checked on every download and audit-logged |

Signing needs `document_sha256` (the contract's `snapshot_sha256`, which the signer reviewed) and `agree: true`.

## Authority
* Sponsor side: a new sponsor action `sign_contract` (manager, approver) decides who can sign for the brand; `contract` (manager, legal, approver) who can issue and send.
* Recipient side: the target owner (athlete, team owner, event organiser) or an organisation owner/admin. A payee (a finance member named on the allocations only to confirm money) is on the deal and can read the contract, but cannot issue it, be named as a signatory or sign.
* Authority is read **live** when someone is named and again when they sign. A person who lost authority, a non-party, or an admin cannot sign. Admins can read, never sign.

## Immutability and idempotency
* `snapshot` (the exact content), its SHA-256, the terms version, the draft document and the pinned template version cannot be updated (trigger `sponsorship_contract_guard`). Status only moves forward.
* `sponsorship_signatures` and `sponsorship_signed_documents` are append-only (trigger `bd_append_only`). The signed PDF's bytes are stored encrypted in `generated_documents`; its SHA-256 and the accepted terms version are pinned in `sponsorship_signed_documents`.
* The brand kit and template are frozen into `document_template_versions` when published; the contract pins the version it was issued with, so editing a template, renaming the brand or revising the agreement never alters an issued contract.
* A repeated signature (double click, retry, replayed callback) returns the existing evidence and changes nothing. Callback events are recorded once in `provider_events` in the same transaction as the signature; concurrent identical callbacks apply once.

## Signature providers (`src/signatures/providers.js`)
* `internal`: the logged-in signatory signs in the app.
* `webhook`: an external service posts `{event_id, contract_id, user_id, document_sha256, provider_ref, status:"signed"}` with `X-Signature: t=<unix>,v1=<hmac-sha256 of "t.rawbody">`, enabled by setting `SIGNATURE_WEBHOOK_SECRET`. Authority and the text fingerprint are still re-checked server side.
* `docusign`: outbound vendor adapter. `request_contract_signatures` with `provider:"docusign"` creates an envelope (the draft PDF, one signer per named signatory, parallel routing; the vendor emails each signer). DocuSign Connect then calls `POST /webhooks/signatures/docusign` on `recipient-completed`; the recipient id maps back to the person we named (`sponsorship_signature_requests.recipients`) and goes through the same `applySignature` (live authority + pinned text fingerprint). Replays are recorded once in `provider_events`; a callback for a withdrawn / declined envelope signs nothing. Withdrawing the contract voids the envelope. While an envelope is out, in-app signing is closed (409 `signing_elsewhere`).
  * Enabled only when all of `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_USER_ID`, `DOCUSIGN_ACCOUNT_ID`, `DOCUSIGN_PRIVATE_KEY` (RSA PEM, `\n` allowed), `DOCUSIGN_CONNECT_KEY` (Connect HMAC key) and `DOCUSIGN_CALLBACK_URL` (public URL of the route above) are set. Optional: `DOCUSIGN_BASE_URI` (default demo `https://demo.docusign.net`; production uses the account's base URI) and `DOCUSIGN_AUTH_URL` (default `https://account-d.docusign.com/oauth/token`; production `https://account.docusign.com/oauth/token`). Auth is the JWT grant (the service user must have granted consent once).
  * Verified against a mocked vendor in `test/sponsorship-esign-vendor.test.js`; not yet run against a real DocuSign account.
* **Signature levels** (`src/signatures/policy.js`): signing in Sportarena is a *simple* electronic signature; DocuSign is treated as *advanced*; *qualified* is not offered. The sender picks the governing country in the send sheet; each country has a `minimum` (sending is refused below it, 409 `level_too_low`) and a `recommended` level with the governing law and a note. All recorded regions (EU, UK, US, India, Singapore, UAE, Australia) accept a simple signature for a commercial sponsorship contract, so none forces more today; the table is the place to record counsel's decision per region. The entries are working defaults and need legal review before being relied on.
* **Limitation:** Adobe Sign and other vendors are not integrated (add a provider next to `docusign`). The phone PDF path (share sheet) has only been exercised on the web; it still needs a check on a real iOS and Android device.

## Schema (migration `095_sponsorship_contracts.sql`, additive)
`sponsorship_contracts`, `sponsorship_signatories`, `sponsorship_signatures`, `sponsorship_signed_documents`. No existing table is altered and no contract is invented for existing agreements. Rollback: the feature is unused until a contract is issued, so reverting the code is safe; the new tables can stay (data is never dropped).

## Recovery
A contract stuck `awaiting_signatures` can be withdrawn by a manager and re-issued. A failed callback (non-2xx) is retried by the provider. Re-running a signature after a crash is safe because the signature and the event row commit together.

## Document family
`sponsorship_agreement` is now an available family in the Document designer: required blocks title, parties and lines; `text` blocks carry the template's own clauses. The signature block is always printed.
