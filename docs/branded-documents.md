# Branded documents & PDF templates (issue #249 — phase 1)

One shared module: brand kits (logo, colours, contact text), versioned templates, and branded PDFs generated from canonical records.
Phase 1 ships the foundation and **invoices / credit notes** as the first connected source. Everything else is listed as *not available*
by `GET /branded-documents/families` until its canonical workflow exists (no invented source data).

## Inventory → gap → smallest change
| Existing | Gap | Change |
|---|---|---|
| `invoices` (canonical numbers, lines, tax, seller/buyer snapshot), `get_invoice` | No printable PDF | `generate_invoice_document` renders the row as-is; nothing is recalculated |
| `doc-store.js` (encrypted files on disk, sniffed types) | Reused for logos and issued PDFs | `saveEncrypted('brand'\|'documents', …)` |
| `org-access.js` | Org permissions | Org kits/templates: owner/admin edit, finance may use; membership alone cannot edit; revocation is immediate (read live) |
| `subject-docs` (`/documents`) = uploaded files folder | Different job (storing uploads) | Not merged: this module *generates* documents; paths live under `/branded-documents` |
| Durable jobs (`jobs.js`) | Large/bulk renders | Not used yet: an invoice renders synchronously in milliseconds (see Deferred) |

## ADR: renderer = pdfkit
Compared: headless Chromium (best CSS fidelity, but needs a browser process, a network/filesystem sandbox and ~hundreds of MB per render),
wkhtmltopdf (unmaintained), pdfkit (pure Node, no process or network, deterministic primitives, embeds TrueType fonts with OpenType shaping via fontkit,
MIT, ~10 MB). Chosen: **pdfkit**, fed by a constrained document schema (`src/documents/layout.js`) — fixed block types, plain text, no HTML, URL, script or
expression, so templates cannot trigger fetches or execute anything. Selectable text; reading order follows the block order. PDF/UA is **not** claimed.

## Model (migration 075, additive)
`brand_kits` (personal XOR organisation, row_version, archived) · `brand_assets` (append-only logo bytes) · `document_templates` (draft, archived, never deleted) ·
`document_template_versions` (append-only: layout + kit text/colours + logo asset frozen at publish) · `generated_documents` (append-only; template version, logo,
sha256, pages, actor; bytes encrypted on disk). Triggers refuse UPDATE/DELETE on immutable tables and DELETE on kits/templates.

## API (capabilities → REST + OpenAPI + MCP; binary routes documented here)
`list_document_families`, `list_brand_kits`, `create_brand_kit`, `update_brand_kit`, `list_document_templates`, `create_document_template`,
`update_document_template`, `publish_document_template`, `retire_document_template`, `generate_invoice_document`, `list_generated_documents`.
Binary: `PUT /brand-kits/:id/logo` (raw PNG/JPEG ≤ 2 MB, 32–4000 px), `GET /brand-kits/:id/logo`, `POST /branded-documents/preview`
(`{template_id}` or `{layout, kit_id?}` → PDF on SAMPLE data, labelled SAMPLE), `GET /branded-documents/:id/file` (access re-checked live, audit-logged).

## Designer UI
**Me → Document designer** (every role, incl. doctor). Pick *Me* or an organisation you own/administer. Brand kits open in a full-screen editor (`brand-kit-editor.js`) with a live letterhead preview, a logo tile that works before the first save, swatch/custom colours and grouped contact fields.
Templates open in a full-screen **visual page editor** (`apps/app/src/screens/doc-editor.js`): a scaled A4/Letter page drawn with the kit's real logo, colours and
name; data sections (parties, line items, totals) show grey structure bars, never invented figures. Tap a section to select it, drag its **Move** grip to reorder
(↑/↓ buttons as fallback), edit text blocks (align, size) in the panel, switch look / paper / orientation / margin / brand kit, add blocks, undo/redo, autosaved
draft, **Preview PDF** (same renderer, SAMPLE data), **Publish**. Phone: panel at the bottom; ≥ 900 px: panel on the right. Required blocks can move but not be removed.
Text blocks accept optional `align` (left/centre/right) and `size` (small/normal/large); older layouts without them render exactly as before.
Only invoices are connected; other families are listed as coming soon (e.g. doctor care plans need their canonical workflow first).

## Rules enforced
* Template choose placement only: an invoice layout must keep `title, parties, lines, totals`; all figures come from the invoice row.
* Generating never changes, pays, sends or signs anything. Regeneration = new document row; issued bytes are never rewritten.
* Published versions are immutable; later logo/kit edits reach documents only after republishing. Optimistic locking (`row_version`) on kits/templates.
* Logos: type/dimensions read from the actual bytes, SVG/WebP refused (WebP: renderer cannot embed it), private to the kit scope.
* Characters the built-in fonts cannot show (e.g. Tamil) are **refused with 422**, never garbled. Set `DOC_FONT_REGULAR` (and optionally `DOC_FONT_BOLD`) to a TTF such as Noto Sans Tamil to enable them.

Sponsorship portfolio reports (#305) reuse the brand kit (name, colours, logo) and the pdfkit renderer (`renderSponsorshipReport`); they are generated on demand from live data and are not stored in `generated_documents`. See sponsorship-reporting.md.

## Deferred (tracked in #249, not in this PR)
Contextual "Download branded PDF" buttons on invoice screens · other families (plans, schedules, bookings, clinical; sponsorship contracts are connected, see sponsorship-contracts.md) as their canonical sources land (#210/#212/#145/#231) ·
durable-job/bulk/archive rendering and quotas · S3 storage (#247) · share links and email (#243) · stale-source detection for issue flows · defaults per branch/locale ·
metadata stripping of uploaded images (needs re-encoding) · bundled Tamil font fixtures and RTL evaluation · co-brand logos, stamps and signatures.
