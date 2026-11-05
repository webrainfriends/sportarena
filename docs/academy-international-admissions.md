# International admissions & relocation readiness (#799)

An additive layer on Academy applications (#392). Home: **Organisation → Academy → International**, plus a panel in an application's review and a checklist in the family's *My academy*.

## Model (migration `160_academy_international_admissions.sql`)
| Table | Purpose |
|---|---|
| `academy_intl_templates` / `_template_versions` | Checklists as data, per programme and/or origin country. Versions are append-only; a case stays pinned to the version it started on. No country rule is built in. |
| `academy_intl_cases` | One per application: origin country, arrival date, reviewer, school organisation, residence. |
| `academy_intl_items` | The case's checklist: status (open, submitted, verified, rejected, waived), evidence expiry, optional `comp_record_id` (evidence stays in the compliance engine and is linked by reference). |
| `academy_intl_documents` | Passport/visa vault (shape of `trip_documents`, #485): status, expiry, encrypted number and evidence reference. |
| `academy_offer_conditions` | Conditions on the offer. An owner approves them before they bind. |
| `academy_arrival_tasks` | Pre-arrival task board. |
| `academy_residences` | Residences, host families, apartments (new: no residence domain existed). |
| `academy_intl_events` | Append-only decision trail. Never carries a document number. |

## Rules (server-enforced, `intl-readiness.js`, `capabilities/academy-international.js`)
- **Gate:** `enrol()` refuses an international athlete while any mandatory item or approved/proposed condition is unmet (409, code `international_readiness`). Applications without a case are unaffected.
- Readiness is derived on every read. Verified evidence that has since expired, a linked compliance record that lapsed, a passport not valid 6 months past arrival, or an unapproved visa all make an item unmet again.
- A young athlete always gets a mandatory guardian legal-permission item; verifying it needs an expiry date or a valid compliance record.
- Eligibility, guardian permission and travel documents can never be waived; only an owner can waive other items.
- Passport/visa numbers: encrypted (`academy_intl_documents.number` / `.evidence_ref` contexts), writable and revealable only by the holder or a live-verified guardian, reveal audit-logged. Staff see status and expiry. Nothing numeric reaches lists, history, notifications or documents.
- Family notifications use generic wording; reminders run from `remindIntlDeadlines` (worker) once per item per week.

## Capabilities (REST + OpenAPI + MCP)
`save_intl_template`, `list_intl_templates`, `start_intl_case`, `get_intl_case`, `update_intl_case`, `submit_intl_item`, `decide_intl_item`, `set_intl_document`, `reveal_intl_document`, `add_offer_condition`, `decide_offer_condition`, `add_arrival_task`, `update_arrival_task`, `get_intl_board`, `save_academy_residence`, `list_academy_residences`.

## Sports
Sport-agnostic (admissions). No scoring or rules model is involved.

## Rollback
All objects are new and additive; nothing existing is altered. To switch the feature off, stop opening cases (the gate only acts when a case exists). Data is never dropped; if a hard rollback is ever required it must be approved by the maintainer first.
