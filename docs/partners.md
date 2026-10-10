# Partner management

A separate console (**Me → Partner management**, platform team only) and a **Partner account** page for venue owners. Everything is a capability, so the same actions exist over REST, OpenAPI and MCP.

## Who can do what

| Person | Rights |
|---|---|
| **Platform owner** (`platform_admin`, e.g. `platform@sportarena.com`) | Everything the platform team can do, plus create / remove platform users. The only account that can. |
| **Platform team** (`admin`) | Onboard, modify, suspend and offboard partners; approve venues; decide prices; contracts; settlements; reports. |
| **Everyone else** | Ordinary app users. `register` and `update_my_roles` reject `admin` and `platform_admin`, so platform rights cannot be self-assigned. |

The owner account is created at start-up from `PLATFORM_ADMIN_EMAIL` + `PLATFORM_ADMIN_PASSWORD` (+ `PLATFORM_ADMIN_HANDLE` default `platformarena`, `PLATFORM_ADMIN_NAME` default `PlatformArena`). The password is the `PLATFORM_ADMIN_PASSWORD` **repo secret**; it is never in git. Bootstrap is idempotent, never resets an existing password, and refuses to promote an ordinary account that happens to use the same email. Sign in with the **email** (login is by email). Use a long password: the bootstrap accepts any length, but a short one is easy to guess.

## Lifecycle

```
register venue ─► partner `applied` + venue `pending` (hidden, cannot self-activate)
       platform: review_partner (assistant) ─► decide_venue approve [+ contract] ─► venue live, partner `active`
       partner accepts contract ─► `active` contract ─► settlements possible
suspend ─► venues paused (restored on reinstate) · offboard ─► venues paused, contracts terminated (blocked while future bookings exist)
```

Nothing is deleted: partners are suspended/offboarded, venues paused, contracts superseded/terminated, settlements voided. Existing venues were back-filled as approved and their owners as active partners.

## Platform pricing

* Customers only see the **platform-approved price list**: base rates plus rules with `source = platform`. Platform rules always beat venue-set rules in the pricing engine, so a legacy venue rule can never undercut a platform price.
* A venue team's peak / off-peak / custom rules, base-rate edits, new priced areas and price categories are **price requests** (`list_price_requests`). The platform can `approve` (optionally with its own figure), `counter`, or `reject`; the venue answers a counter with `respond_price_request`. Only on approval is the price written back to the venue and a numbered **price-list version** recorded (`price_list_history`).
* A venue still `pending` proposes its rate card as part of the application; approving the venue is the review of it, and the platform sets the final list with `apply_pricing_plan`.
* `suggest_venue_pricing` is the pricing assistant: baseline = median of comparable venues (same city, kind, sport) → adjustments for demand (30-day utilisation), rating, facilities and standing discounts, each shown with its reason. Advisory; the platform applies it with `apply_pricing_plan`.

## Contracts

`generate_contract` renders a standard agreement (or a saved template) from negotiated terms — commission, tax on commission, payment costs, reserve and hold days, settlement cycle and delay, term, auto-renew, notice, exclusivity, governing law — plus custom clauses; `decide_venue` can generate and send one as part of approval. The partner sees the exact text and `respond_contract` accepts it; acceptance stores the SHA-256 of the text. A new version supersedes the old one only when accepted.

## Settlement

`generate_settlement` (dry-run first) takes every paid invoice and credit note of a venue that is not yet in a live settlement, up to the period end, under the venue's active contract:

```
net payable = platform-collected (online/wallet, incl. tax, net of refunds)
            − commission (on ex-tax sales, all channels) − tax on commission − payment costs
            − reserve held + reserve released (older than the hold period) ± adjustments
```

Cash taken at the venue is the partner's; its commission is set off through the formula, so a negative result means the partner owes the platform. Each invoice is settled once (unique while live); voiding a draft frees its invoices; reserves released by a voided settlement are freed too. Draft → approved (partner can see it) → paid (payout reference). Flags: negative payout, refunds > 20 %, mostly cash, ±50 % swing, empty.

## Reports

`platform_dashboard`, `revenue_report` (time × partner/venue/city, estimated commission), `settlement_report`, `pnl_report` (commission + recovered costs + ledger revenue − ledger costs and credits; commission tax shown as a liability, not income), `partner_statement` (partner-visible), and a manual platform ledger (`add_ledger_entry`) for costs that are not bookings (gateway actuals, marketing, incentives). `format: csv` on the reports for finance. Amounts are per currency.

## What we took from Zomato and Amazon — and where AI simplifies it

| Marketplace practice | Here | Simplified with the assistant |
|---|---|---|
| **Zomato** restaurant onboarding: documents (tax id, FSSAI, bank), photo/menu review, a field-visit step, then go-live | Partner checklist (tax id, payout, contract, site visit, photos), encrypted tax id and payout, venue approval gate | `review_partner` checks completeness, explains a risk score point by point, and proposes commission / reserve / cycle |
| **Zomato** commission slabs and weekly payouts with a statement of deductions | Contract terms (commission, tax, costs, cycle) and a line-by-line settlement with CSV | Settlement flags the unusual before a human approves |
| **Amazon** seller onboarding and account health, referral fee by category | Risk band drives terms; per-venue contracts | Terms are suggested, never applied automatically |
| **Amazon** fee-adjusted settlement reports and a reserve against returns | Reserve and release, credit notes netted in the same run, reports | — |
| **Amazon** pricing controls / Buy-Box style competitive price signals | Platform owns the price list; venues request changes | `suggest_venue_pricing` uses peer prices, demand, rating, facilities and discounts |

The assistant is deterministic and explainable (no model call, nothing leaves the server); every decision stays with the platform team.

## Settings

| Variable | Purpose |
|---|---|
| `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, `PLATFORM_ADMIN_HANDLE`, `PLATFORM_ADMIN_NAME` | Platform owner account (deploy passes them; password = repo secret) |
| `PLATFORM_APPROVALS=off` | Development / tests only; ignored in production, where approvals are always on |
