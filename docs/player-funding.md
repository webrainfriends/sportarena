# Player funding workspace

Issue [#334](https://github.com/webrainfriends/sportarena/issues/334) (player transformation item 25/28). Migration `112_player_funding.sql`; API in
`apps/api/src/capabilities/player-funding.js`, helpers in `apps/api/src/player-funding.js`; screen `PlayerFunding` (More → Funding, a guardian's
*Funding* button under Family, *Open my funding workspace* from a portfolio entry, and a coach's share notification).

## What exists, what this adds

| Already on main | Reused as is |
|---|---|
| Programs, applications, awards, agreements, dues, payments, deliveries, endorsements (#145, #282–#309) | the single source of every amount; the workspace never stores or copies money |
| Beneficiary portfolio (#292) | its SQL chain gained one scope, `athlete` (one athlete's own rows), so totals reconcile with the portfolio and with each agreement |
| `obligationRows` (agreement dues with paid, confirmed, goods position) | exported and reused for the per-due detail |
| Guardian links and consent (`youth.js`), coaching relationships, `audit_log`, `notify`, `encrypt` | enforced inside every capability |

Added: **funding needs** (what the player needs funded, and which application or agreement covers it), **shares** to a coach, one **workspace read**
and one **CSV export**. The portfolio keeps serving sponsors, teams and events; for an athlete it now links to this workspace instead of duplicating it.

## Capabilities (REST, OpenAPI and MCP from one definition)

`get_player_funding_workspace` `GET /player-funding` · `export_player_funding` `GET /player-funding/export` · `create_funding_need` `POST /funding-needs` ·
`update_funding_need` `PATCH /funding-needs/:id` (also withdraw / reopen) · `link_funding_need` `POST /funding-needs/:id/links` ·
`release_funding_need_link` `POST /funding-need-links/:id/release` · `list_funding_share_recipients` · `create_funding_share` `POST /funding-shares` ·
`update_funding_share` · `revoke_funding_share` · `list_funding_shares` · `list_funding_shared_with_me`.

## Rules

* **Who sees what.** The athlete, a verified guardian of a young athlete, or a coach with a live share. A coach needs the share (not revoked or expired),
  a current coaching relationship, and for a young athlete a guardian's current `coaching` consent: all re-derived on every read and export, so a
  revocation applies on the next call. Anyone else gets `404`. A share names sections (`needs`, `applications`, `support`, `dues`); money cells follow
  them (requested/awarded need `applications`, committed/paid need `dues`). The athlete's private note is never sent to a coach.
* **Honest money.** Minor units in their own currency, never added across currencies. A reported payment is not received until the recipient confirms
  it; goods and endorsement values are estimates, never cash.
* **No double counting.** A need links to an application or agreement with an allocated amount, capped by what the item can give (request, award, or the
  agreement's committed cash in that currency) after other needs' links; the application an agreement came from cannot also be linked to the same need.
  Coverage is read live: declined, withdrawn or ended items stop covering by themselves.
* **Concurrency and retries.** `rev` on needs and `version` on shares give `409` on a stale edit; `client_key` makes a retried create return the same
  need; links lock the need and the target row, so two needs racing for the same money yield one winner; repeated link, share and revoke calls are idempotent.
* **Data is kept.** Needs are withdrawn, links released, shares revoked; nothing is deleted. The migration only adds tables. Rollback: deploy the previous
  code; nothing else reads the new tables.
* **Audit and encryption.** A need's note is `*_enc` (column-bound). Guardian and coach reads, exports and share changes are audit-logged, and a coach's
  views and exports also appear in the athlete's share history.
* **Not included.** There is no public or anonymous share link: sharing is to a named coach only. Acting on money (confirming a payment, receiving goods,
  answering an offer) stays in the existing agreement and offer screens; the workspace links to them.
