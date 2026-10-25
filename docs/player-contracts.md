# Player contracts, earnings, expenses and payout runs

Issue [#333](https://github.com/webrainfriends/sportarena/issues/333) (player transformation item 24/28). Migration `111_player_contracts.sql`; API in
`apps/api/src/capabilities/player-contracts.js` and `player-contract-money.js`, engine in `apps/api/src/player-contracts.js`; screen `PlayerContracts`
(More → Contracts, Team → Rates → *Open player contracts*, Event → Hiring → *Paid Billboard work*, and *My contracts* from an accepted application).

## What exists, what this adds

| Already on main | Reused as is |
|---|---|
| Billboard opportunities and the recruitment pipeline (#67): an accepted paid application records one `team_payouts` row as *due* | the accepted application is the source of a contract; that due row is linked and settled through the contract (kept, set to `cancelled` with a note — never deleted) |
| Verified appearances, minutes, goals and results (#322, scoring) | the only triggers for per-game pay |
| Provider payout accounts and their verification (#71) | the bank account a person is paid into (`set_payout_account`, verified by the platform team) |
| `team_payouts`, the team's settlement ledger | every payment made through a run also lands there as `paid`, so existing team and organisation finance reports stay complete |
| Guardian links and consent (`youth.js`), `audit_log`, `notify`, `encrypt`, org roles | enforced inside every capability |

Added: versioned contracts, amendments with signatures, an append-only earnings ledger, expenses with receipts, payout runs with a bank file, statements
and credit notes, and a club desk. There is **no second ledger** for provider sales: that stays #71.

**Overlap to decide:** event staff hired through *Open positions* keep their existing `event_contracts` (one signed fee, no versions or payouts). This module
covers Billboard-accepted work for a team or an event. Merging the two (moving `event_contracts` into player contracts) needs a data migration and is left to the maintainer.

## Money model

* **Committed value** is what the terms could pay. It is never income and never a ledger entry.
* **Earned** needs a verified trigger: a played game with *verified* minutes (appearance fee, start bonus), goals on the official record (goal bonus), a won game
  (win bonus), a finished monthly period (pro-rata for a part period and when a contract ends early), or a due date (fixed, signing, retention — retention is lost if the
  person is no longer under contract on that date).
* **Paid** exists only when the club records a transfer with a bank reference. SportArena exports a bank file; it does not move money. No escrow is stated or implied.
* Withholding is a **rate the club enters** and a line on every earning. SportArena does not calculate or file tax.
* Ledger entries are signed in the payee's favour (`fee`, `withholding`, `expense`, `adjustment`, `payment`, `refund`), append-only (a trigger rejects UPDATE/DELETE), idempotent
  (`UNIQUE(contract_id, idem_key)`) and carry source and reason. A correction (voided goal, retro-dated amendment, unverified minutes) is a compensating line.
* Which version prices a game: the highest version number whose effective date has arrived. A monthly period is priced on its first day.

## Schema (migration 111, additive)

`player_contracts` (status `draft → offered → active → completed | terminated | void`; `row_version`; `legacy_payout_id`), `player_contract_versions` (terms frozen by a trigger
once proposed; `components` jsonb; `required_parties`; stored `changes` diff), `player_contract_signatures`, `player_contract_entries` (ledger), `player_contract_expenses`
(encrypted note; encrypted receipt file on disk), `player_payout_runs` / `player_payout_lines` (one open run per team/event and currency; unique bank reference among paid lines),
`player_contract_invoices` (+ `_entries`, `player_contract_counters`: sequential `INV-YYYY-0001` / `CN-YYYY-0001` per team or event), sequences for contract and run numbers.

## Capabilities (REST + OpenAPI + MCP, one definition each)

| Area | Capabilities |
|---|---|
| Contracts | `list_contract_candidates`, `create_player_contract`, `update_contract_draft`, `send_player_contract`, `list_player_contracts`, `get_player_contract`, `compare_contract_versions`, `end_player_contract` |
| Amendments | `preview_contract_amendment`, `propose_contract_amendment`, `decide_contract_version`, `withdraw_contract_version` |
| Money | `accrue_contract_fees`, `get_contract_ledger` (`format=csv`), `add_contract_adjustment`, `record_contract_refund` |
| Expenses | `submit_contract_expense`, `list_contract_expenses`, `decide_contract_expense`; binary `PUT/GET /player-contract-expenses/{id}/receipt` |
| Payout runs | `create_payout_run`, `list_payout_runs`, `get_payout_run`, `approve_payout_run`, `export_payout_run`, `record_payout_line_result`, `cancel_payout_run` |
| Statements | `list_contract_invoices`, `get_contract_invoice` (`format=csv`), `issue_contract_credit_note` |
| Desk | `get_contract_desk` |

Money-moving ones are token scope `payment` (`create_payout_run`, `approve_payout_run`, `export_payout_run`, `record_payout_line_result`, `cancel_payout_run`, `add_contract_adjustment`,
`record_contract_refund`, `issue_contract_credit_note`, `decide_contract_expense`, `submit_contract_expense`); reads are `read`, the rest `write`.

## Who may do what (enforced on the server)

| | Person paid | Guardian (under 18) | Club manager | Owner / finance |
|---|---|---|---|---|
| Draft, edit draft, send | no | no | yes | yes |
| Sign a version | yes | yes (also required for a young person) | yes (the club) | finance party when required |
| Propose / counter an amendment | yes | yes | yes | yes |
| Submit an expense, add a receipt | yes | no | no | no |
| Approve / decline an expense | no | no | yes (over the contract limit: owner/finance) | yes |
| Prepare, approve (second person), export, record results, adjust, refund, credit note | no | no | no | yes |

* "The club" is the team's owner, its `manager` members and its organisation's owner/admin/finance; for an event, the organiser and organisation owner/admin/finance.
  A **finance** approver is required on a version when the payer belongs to an organisation and the value rises by more than `PLAYER_CONTRACT_FINANCE_THRESHOLD_CENTS`
  (default 2,500,000 minor units) or the amendment takes effect on a past date.
* Nobody acts as the club on their own pay or on a young person they are guardian of. The proposer cannot give the second finance approval, and the preparer cannot approve a
  run — unless nobody else holds finance authority, in which case the approval is recorded as `sole_authority`. Nobody approves a run containing their own pay.
* Outsiders get `404` (existence is not revealed). A **draft is the club's** until sent.
* Young people: creating or sending needs current guardian `participation` consent; a guardian signs as well as the young person. When consent is not current the contract is
  hidden from staff and from the young person (placeholder rows, `404` on detail, hidden run lines, blocked payment) **immediately**; the guardian keeps access. Records are never deleted.
* Audit-logged: reads by anyone but the person paid, ledger and run exports, every bank-detail read for a bank file, receipt downloads, signatures, runs, payments, adjustments.
* Bank details and notes are field-level encrypted; receipts are encrypted on disk (`contract-receipts`).

## Failure and recovery behaviour

* `stale_version` (409): draft edits and sends take `row_version`; an amendment takes `base_version`; expense decisions and run approval take `row_version`. The latest is reloaded by the app.
* Duplicates and retries: `client_key` on create, expense, run, adjustment, refund and credit note; repeating a signature, an approval, an expense decision or a recorded result changes nothing; a repeated
  bank reference is refused (`duplicate_reference`); a second open run is refused (`run_open`); parallel accruals, runs and results are covered by tests.
* A blocked payout line (no bank account, account unverified, guardian consent not current, not signed) stays owed and is listed; nothing is dropped. A failed transfer leaves the amount owed for the next run.
* `balance_changed`: a result cannot exceed what is still owed; cancel the run and prepare a new one. Negative balances (a person owes the club) are never paid out.
* Cancelling a run keeps it with the reason; every amount stays owed. Contracts are ended, never deleted.

## Operations

* The worker step `player_contracts` (`contract_earnings_posted`) brings every active contract up to date each cycle; reading a contract and opening the desk also do. All idempotent.
* No new environment variable is required. Optional: `PLAYER_CONTRACT_FINANCE_THRESHOLD_CENTS`. Payout accounts need `SETTLEMENT_CURRENCIES` to include the currency (as for #71).
* Rollback: stop using the capabilities (revert the code). The tables are only read by the new code; the `create_squad_payouts` change only skips people who have an offered or active contract.
  Dropping tables (never automatic, maintainer's decision) would remove contract history; nothing existing depends on them.

## Limits (stated plainly)

* Goal bonuses use `goal` events on the match record, so they apply to sports scored that way; other sports' scoring events are not mapped.
* Tax is a rate entered by the club; there is no tax engine. Statements are CSV (web download, share sheet on phones/tablets), not PDF.
* Payment is a bank file plus recorded results; there is no bank integration, no automatic matching of a bank statement and no payout rail. The platform team verifies bank accounts (#71).
* There is no budget source of truth for clubs, so the desk shows committed value, earned and paid but not "budget remaining".
* A payout run pays everything due **up to** a date (not a from–to window): an older unpaid balance is never skipped.
* Event staff contracts from *Open positions* are a separate, older feature (see above).
* iOS, iPadOS and Android are built with `expo export` and share the same React Native code; on-device testing was not possible here.
