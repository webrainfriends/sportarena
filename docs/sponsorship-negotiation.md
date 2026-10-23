# Sponsorship negotiation and counteroffers (#290)

Extends the existing agreement flow (#145); no second sponsorship system.

## Model
- `sponsorships.terms_side` — who wrote the CURRENT terms version (`sponsor` | `recipient`). The other side signs it off.
- `sponsorship_versions` — one row per numbered version: author side/user, reason, `restores` (set when a withdrawal re-issues earlier terms), period snapshot (NULL = not recorded for versions that predate this change), sign-off user/time. A trigger records version 1 for every new deal, whichever flow creates it.
- `sponsorship_comments` — `shared` (both sides) or `internal` (only the author's side; never the other side, admins or outsiders; never in history/notifications).
- Lines stay in `sponsorship_lines` (versioned). Migration `094` is additive; existing deals' versions are backfilled as the sponsor's.

## API (all `cap(...)`, so REST + OpenAPI + MCP)
| Capability | Who | Rule |
|---|---|---|
| `revise_sponsorship` | sponsor (`revise`) or recipient | open offer only; recipient must send `expected_version`; stale → 409; creates a new version, never activates |
| `withdraw_sponsorship_counter` | author side of the current version | re-issues the other side's last terms as a new version |
| `decide_sponsorship` (`active`) | the side that did NOT write the current terms | exact `version`; stale → 409; sponsor sign-off needs new `sign_off` action (manager, approver); admins cannot sign for a brand; freezes the brand identity snapshot |
| `comment_on_sponsorship` | either side | shared comments by a brand need `revise`; internal notes any brand member |
| `compare_sponsorship_versions` | either side / admin read | per-line added/removed/changed fields + period; currencies never combined |
| `get_sponsorship` | unchanged + `negotiation` | whose turn, versions, comments filtered to what the caller may see |

Decline cooldown and open-offer rules on `propose_sponsorship` are unchanged; a counteroffer is not a decline.

## Dependencies, rollback, recovery
- Needs #145 tables (migration 042) and sponsor roles (#283). Reuses notifications (no amounts/terms in notices).
- Rollback: deploy previous code; the new tables/column are ignored by it (a recipient counter left open would then simply be unanswerable by the recipient, and the sponsor can withdraw or revise it). No data is dropped.
- Recovery: a stale-version error reloads the agreement; every state is derived from `sponsorship_versions` + `sponsorships.terms_side`.

## Limits
No agreement export exists yet, so none carries notes. Amendments to an already accepted agreement are a separate flow: [sponsorship-amendments.md](sponsorship-amendments.md).
