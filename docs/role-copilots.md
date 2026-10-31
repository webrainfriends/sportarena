# Role copilots (issue #598)

One framework gives each role purpose-built workflow help instead of a generic chat. A copilot run is a **draft**: items that each cite the records
behind them, the limits of the data, who produced it (rules, or a named model), and proposed actions that do nothing until a person approves them.

## Capabilities (REST + OpenAPI + MCP from one definition)
`list_copilots` · `run_copilot_task` · `list_copilot_runs` · `get_copilot_run` · `resolve_copilot_action` — `apps/api/src/capabilities/role-copilots.js`.
Catalogue, forbidden set and rule-based derivations: `apps/api/src/copilots.js`. Screen: **More → Copilots** (`apps/app/src/screens/copilots.js`).

## Copilots and tasks
| Copilot | Who | Scope | Tasks (reads) |
|---|---|---|---|
| coach | coach | team / athlete | plan_session, player_focus, outstanding_actions — runs `draft_ai_coaching_assist` |
| athlete | athlete | self | week, goals, training — runs `ask_player_assistant` |
| event | organizer | event | readiness_gaps, incidents, vendor_followup, run_of_show (`get_event_readiness`, `list_event_incidents`, `list_event_vendors`) |
| federation | any, decided by body access | governing body | expiring_affiliations, expiring_licences, registration_exceptions, governance_report |
| sponsor | sponsor | — | fulfilment, expiring_rights, renewal_prep |
| supplier | supplier | — | opportunities (RFQ invitations), delivery_obligations (draft tender proposals) |
| venue | venue_manager | venue | maintenance, operations |
| official | referee | — | my_week (`get_officials_home`) |
| organisation | any, decided by org access | organisation | attention (`get_org_command_centre`) |

## Guardrails
* **Grounding:** every read goes through the owning capability via `invoke()`, so its ownership, consent and youth rules apply unchanged. A record the caller may not open is a `404`, never a hint it exists. An event must always be one the caller runs.
* **Provenance:** each item carries a source reference to the capability that produced it. A model may add a one-line "why" to existing items only; it cannot add items or actions.
* **Approval:** actions are proposed by code from items. Approving runs only an allowlisted low-risk action (`todo`, `create_event_task`) **as the approver**, so permissions are checked again. Repeating an approval is harmless.
* **Never executable:** procurement award, medical clearance, discipline, classification, contract signature, transfer approval and money movement are stored `advisory:*`, risk `forbidden`, `executable=false` (also enforced by a table CHECK), and can only be rejected.
* **Logging:** `copilot_runs` records provider, model, rules version and input hash; `copilot_actions` records proposed/approved/executed with who and when; `audit_log` records every run and decision. Typed notes are stored encrypted (`note_enc`) and shown only to their author.
* Runs and actions belong to the person who ran them; anyone else gets `404`.

## Data
Migration `134_role_copilots.sql` — additive; no deletes, no cascades.

## Sports
Copilot tasks are sport-agnostic: they re-present what the owning capabilities return, which carry each sport's own model. Nothing here adds a scoring default.

## Languages
66 `copilot.*` keys in English and all 11 packs (ta, te, ml, mr, kn, bn, or, hi, si, ur, id). The 11 translations are machine-drafted and stay `reviewed: false` until a native speaker signs them off.

## Known gaps
* Federation, sponsor and supplier derivations are verified against real (empty) records and the capabilities' documented shapes, not against populated data.
* No on-device run of iOS / iPadOS / Android; verified by `expo export` only.
