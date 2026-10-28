# Loyalty, referrals & rewards (issue #509)

One engine for every business on the platform. A **programme** is owned by the platform, a venue, an organisation (academy / club), a coach or an event; it has **versioned published rules** and an **append-only ledger**. Venue loyalty (migration `012`) is not a second system any more: its settings, lots and balances were carried into this engine by migration `120`, and the booking module now calls the engine.

**1 point = 1 minor unit of the programme currency.** Balances never mix between programmes (or currencies) unless two owners approve an explicit exchange rule.

## Programmes
| | |
|---|---|
| Owner | `platform` (admins), `venue` (venue team), `organisation` (owner/admin; finance reads), `coach` (the coach), `event` (organiser) |
| Funding | `owner` (default), `platform` (admins), `sponsor` — needs an **active sponsorship agreement** that names the owner as its recipient, in the programme currency; it also caps what can ever be issued. If the agreement ends, nothing more is issued. |
| Status | `draft` → `active` ⇄ `paused` → `ended`. Paused/ended programmes stop earning; members can still spend their balance until it expires. |

`POST /loyalty/programmes` creates a draft; `POST /loyalty/programmes/:id/publish` publishes **version N+1** of the rules (the first publish switches it on). A version is immutable (database trigger). Every ledger row remembers the version it was earned under, so changing a rate never rewrites history.

### Rules (what a version contains)
* **Earn** — one rule per canonical completed business event: `venue_booking_paid`, `academy_payment_paid`, `coach_session_completed`, `event_participation`, `membership_tenure`, `sponsored_challenge`; each is `% of what was paid` or `fixed points`, with a minimum spend, a per-award cap and a per-member cap per day/month/year/lifetime. Only events that can happen in the owner's scope are accepted (a venue cannot reward an academy fee).
* **Redeem** — which bills (`venue_invoice`, `academy_charge`, `coach_hire`), the largest share of one bill, a minimum, whether points come back when a payment is cancelled (`restore_on_cancel`) and with a fresh or the original expiry (`restore_expiry`).
* **Expiry** (months), **caps** (per member per month; a total programme budget), **eligibility** (young people: excluded, or only through a live verified guardian link), **campaign dates**, **referral** reward.
* Not rewarded: opening the app, creating fixtures, signing up, or any bill paid **entirely** with points/passes (no point-farming loops).

## Earning is idempotent and event-driven
`rewards/activity.js → recordActivity` is called once from each place a business fact becomes true: a venue invoice paid (`markInvoicePaid`), an academy charge paid (`fulfilChargePaid`), a coaching session that is paid **and** completed (`update_hire` / payment fulfilment, whichever comes last), a finished event (worker sweep over accepted entries and team rosters), a membership month (worker sweep), a verified challenge (`award_loyalty_challenge`). Keys are `earn:<programme>:<rule>:<source type>:<source id>` and unique in the database, so a replay pays nothing. The earner is the **payer** (for a young player, their guardian).

## The ledger
`loyalty_ledger`: a row with `delta > 0` opens a **lot** (`earn`, `bonus`, `restore`, `adjust`, `exchange_in`); a row with `delta < 0` draws a lot down and points at it (`redeem`, `clawback`, `expire`, `exchange_out`, `adjust`). Nothing is updated or deleted — triggers reject `UPDATE`, `DELETE` and `TRUNCATE`. Balances are derived from rows (`loyalty_lots_open`); there is no counter to drift. A member's writes in a programme are serialised by an advisory lock, and a trigger refuses to draw a lot below zero or across members/programmes even if the lock were bypassed. Oldest expiry is spent first. Admin adjustments need a reason and an actor and are audit-logged. Expiry is an `expire` row per lot, written by the worker.

Earlier venue lots became ledger lots with the same balance and expiry; what had already been spent/expired is one `legacy_use` row per lot. The earlier tables (`loyalty_lots`, `loyalty_events`, `venues.loyalty_*`) are untouched, and `loyalty_history` still shows the earlier itemised statement.

## Redemption
`POST /loyalty/redeem` (`redeem_points`, scope `payment`) takes the **bill's own lock** (the one a card checkout takes), draws the points, and applies them in the same transaction: venue and academy bills get an `invoice_credits` row (`source='points'`); a coaching session records `loyalty_credit_cents`. If points cover the bill it is paid. A retry with the same `request_key` returns the same redemption. `GET /loyalty/options` lists which of your balances can pay a bill and how much (after caps). Programme caps are measured against **all** points already on the bill, so two programmes cannot stack past the most permissive cap.

Cancellation is deterministic (`restoreRedemption`): an unpaid bill that is voided/cancelled returns everything; a refunded paid bill returns the share refunded (cumulative); policy `restore_on_cancel: none` keeps points spent. Points a refunded payment **earned** are taken back in proportion, as far as they are still unspent (never chased negative).

## Referrals
`create_referral_code` (campaign + source tags, optional max uses/expiry, revocable) → `claim_referral_code` (within the programme's sign-up window) → the invitee completes the configured **qualifying event** with at least the configured spend → a **holdback** (default 14 days) → both sides are rewarded by the worker. A refund of the qualifying payment inside the holdback voids it; after payout it is taken back as far as it is unspent.

Refused outright: your own code, a referral **loop** (anyone in the referrer's invitation chain), a second code in the same programme, revoked/expired/used-up codes, young people on either side, and referrers over their limit. **Held for a person** (`review_referral`): a shared device between the two accounts, or a burst of invites in a day; a shared network is recorded but not held (households share them). Held referrals never pay until approved.

## Separation, privacy, exchange
A programme's members, ledger, referrals and liability are visible only to the people who run that programme (anyone else gets a 404). A member's own balances, lots and statement are theirs. Exchange between programmes needs `propose_loyalty_exchange` by one owner **and** `decide_loyalty_exchange` approval by the other (same currency); each exchange is atomic with its own idempotency key.

## Rankings
Loyalty has **zero** impact on rankings: no standings, leaderboard or rating code reads or writes the loyalty tables (a test scans the source), sponsors cannot issue points, and challenge awards need a programme operator and an evidence reference.

## Reporting
`loyalty_liability`: issued, restored, spent, taken back, expired (breakage %), outstanding members/points/money value, what expires in 30 days, and outstanding by funder (owner / platform / sponsor).

## Capabilities (REST + OpenAPI + MCP from one definition)
Member: `get_loyalty`, `loyalty_history`, `get_loyalty_programme`, `list_redeemable_programmes`, `redeem_points`, `exchange_loyalty_points`, `list_loyalty_exchanges`, `create_referral_code`, `list_my_referral_codes`, `revoke_referral_code`, `claim_referral_code`, `list_my_referrals`.
Business: `list_loyalty_programmes`, `list_fundable_sponsorships`, `create_loyalty_programme`, `publish_loyalty_programme`, `set_loyalty_programme_status`, `get_loyalty_programme_admin`, `loyalty_liability`, `list_loyalty_members`, `adjust_loyalty_points`, `award_loyalty_challenge`, `list_programme_referrals`, `review_referral`, `propose_loyalty_exchange`, `decide_loyalty_exchange`.

**Merged away** (one feature, one place): `apply_points_to_invoice` → `redeem_points`; `venue_loyalty` → `loyalty_liability`; `grant_loyalty_points` → `adjust_loyalty_points`; the loyalty fields of `create_venue`/`update_venue` → `publish_loyalty_programme`. The venue "Money settings" rewards fields and the separate venue loyalty panel are replaced by the one rewards console.

## App (iOS, iPadOS, Android, web — one React Native codebase)
* **Rewards** (More → Rewards): balances per programme with expiry, programme rules in plain words, invite codes (share sheet / clipboard on web), enter a code, invited friends and their status, exchanges, the statement. Wallet shows a summary and links here.
* **Checkout**: the shared pay sheet and the booking screen offer “Use my points” for venue bills, academy fees and coaching sessions.
* **Rewards console** (`LoyaltyConsole`) is embedded where each business is run: venue (Manage → Payments), organisation (Rewards tab), coach (Rate cards), event (Money → Rewards, opens the console), platform (Partner management → Rewards). Create a programme, build rules with pickers/steppers/switches, set campaign dates with the calendar, fund it (sponsor agreements are picked from a list), pause/resume/end, give or take points, award challenges, review held invites, see liability.

## Not done / limits
* Event registration has no checkout today, so event programmes **earn** (participation, challenges) but cannot be **spent** on an event fee yet; their spend list is empty until an event checkout exists.
* Points are the business's own liability and are not netted in partner settlement. Advanced-campaign / message limits from the entitlement work (#504) are not wired: that issue has no code in the repository yet; programme counts are not limited.
* A shared network alone does not hold a referral (see above); stronger duplicate-account signals (verified phone) can be added to `duplicateSignals`.
