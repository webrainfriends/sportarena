# Governed para-sport catalogue (PS-01, #831)

Para and adaptive sports live in the **single sports catalogue** (`sports.is_para`, linked to the standard sport they adapt through `base_sport_id`).
There is no second catalogue and no parallel entity: the governed definition is the existing versioned classification definition (`para_class_versions`, #488),
extended with governing-body evidence and an approval flow. Legacy standard sports are unchanged.

## Requirement → source of truth → gap → implementation
| Requirement | Existing source | Gap closed here |
|---|---|---|
| Para sport / discipline variants | `sports`, `governing_body_sports`, `para_class_versions` (#488) | one-time import of 34 para sports (`160_para_sport_catalogue.sql`), `is_para`, `base_sport_id`, programme tags |
| Recreational vs sanctioned | registration policy `required_clearances` (#477) | `event_disciplines.participation_context`: sanctioned / recreational / mixed_ability; only sanctioned pins a rule version; classification is never required for the other two |
| Source URL, publisher, dates, scope, history, approval | `para_class_versions.source_ref`, `para_history` | `source_url`, `publisher`, `scope_countries`, `scope_competitions`, `approval_status`; evidence frozen once published |
| Categories, adaptations, roles, rule references | `gov_rule_packs` (#563) | `event_categories`, `adaptations`, `permitted_roles`, `classification_required` on the version; `get_para_sport` returns a rule reference (id + hash) |
| Approval, rollback, snapshots, deprecation | immutable published versions, append-only history | `submit` / `reject` / `rollback` (a new version) / `deprecate`; event pin stores a frozen snapshot + hash |

## API (REST + OpenAPI + MCP from one definition)
`para_sport_coverage` (extended: `para`, `q`, `programme`, `state`, summary) · `get_para_sport` · `submit_para_class_version` · `reject_para_class_version` ·
`rollback_para_class_version` · `deprecate_para_class_version` · `create_para_class_version` (new evidence fields) · `list_sports` (`para`, para programmes) ·
`create_discipline` / `update_discipline` (`participation_context`, `para_version_id`, `para_categories`, `para_change_reason`).

## Rules enforced on the server
- Only a version that is published, approved, in force and not deprecated can be pinned; categories must come from it; a standard sport cannot carry a para context.
- A pinned version or context changes only with a recorded reason, only before the discipline is ongoing, and never rewrites the stored snapshot of other events.
- A version with an official source is submitted for approval before it is published; a second officer decides unless the actor holds platform authority.
- Published versions are immutable (trigger); rollback drafts a NEW version; nothing is deleted.
- Discovery exposes no actor identities. A class is an administrative sporting classification, never a diagnosis; AI never assigns one.

## UI
Sport pickers (athlete, event, academy programme) have a **Para & adaptive** filter with programme sub-filters. Para classification → **Disciplines** tab (catalogue,
state filters, rule evidence); Authority desk gets the evidence fields and the submit / reject / deprecate / restore actions; the event "Add a sport" sheet
and discipline sheet carry the participation context and rule version. Screens: `npm run` journey `node scripts/e2e/para-catalogue-ux.mjs`.
