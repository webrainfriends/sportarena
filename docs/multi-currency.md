# Multi-currency presentation and integrity (issue #62)

## Behaviour

* **Amounts are integers in minor units**, always with the ISO 4217 code of the record they belong to. Zero-decimal (JPY, VND…) and two-decimal (INR, SGD, USD…) currencies are on the platform list used by venues, shop, wallet and payments. Three-decimal currencies (KWD, BHD, OMR, JOD, TND) stay where they already were: service procurement (`/service-currencies`, no online card payment). Their single definition now lives in `currency.js` (`THREE_DECIMAL`, reused by `svc/money.js`), and the amount helpers and the app formatter read and write them with three decimals everywhere.
* **One formatter in the app** — `apps/app/src/money.js` (bound to the person's locale) over the pure `money-core.js`. `theme.money`, `vtime.moneyIn` and the older per-screen formatters all delegate to it. Precision comes from the currency, separators and symbol position from the locale, and the **currency never comes from the locale**: an SGD invoice reads the same in `en-IN`, `ta-IN` or `ur-PK`. A missing currency renders as a bare number (never a guessed symbol); a missing amount as `—`.
* **Typed amounts** (`parseAmount`, used by `FormSheet` money fields, the wallet and the market composer) are parsed exactly (no floating point) and refused, not rounded, when they have more decimals than the currency.
* **Server**: `apps/api/src/currency.js` — `toMajor`/`fromMajor`/`parseMajor` use integer arithmetic, `exponent` knows the three-decimal table.
* **Immutable currency**: a database trigger (`forbid_currency_change`) stops the currency of an invoice/credit note, payment, wallet movement, top-up, gift card, shop order or coach hire from being updated. A viewer's locale or a later venue/profile setting cannot re-denominate a record (venues already refuse a currency change once they have bookings).
* **Explicit currency on previously implicit workflows**: shop products, shop orders, coach hires and market "for sale" cards now carry a currency (existing rows are backfilled with `INR`, which is what they were always charged in). New rows use the platform settlement currency unless the seller picks one (shop, market card). Events, insurance claims, recruitment offers, team invites and public sponsorship deals expose the currency they already stored.
* **Mixed currencies are never combined**
  * Venue booking: a basket across venues that price in different currencies is quoted per currency (`totals[]`, `currencies`, `mixed_currency`). `POST /reservations` is refused with `409 mixed_currency` (details: the currencies) unless `accept_mixed_currencies: true`; the app shows an explicit "I understand: one payment per currency" confirmation. Quotes list a `mixed_currency` problem until it is acknowledged. One invoice is issued per venue in its venue's currency, as before.
  * Shop cart: the first line sets the cart's currency; adding a product in another currency is refused with `409 currency_mismatch` (it can be saved for later); checkout re-validates. `list_products` price ranges only compare within one currency (`currency`, default the platform settlement currency).
  * There is no FX conversion policy yet, so **no estimated conversions are shown anywhere**; balances (wallet, finance, collections, academy) were already per currency and stay that way.

## Schema (migration `134_currency_integrity.sql`, additive)

`shop_products`, `shop_orders`, `coach_hires`, `market_posts` gain `currency text NOT NULL DEFAULT 'INR'` (backfill = existing meaning). `forbid_currency_change()` plus `BEFORE UPDATE OF currency` triggers on `invoices`, `payments`, `wallet_ledger`, `wallet_topups`, `gift_cards`, `shop_orders`, `coach_hires`.

**Rollback**: drop the `*_currency_fixed` triggers and `forbid_currency_change()`. The new columns can stay (harmless and defaulted); no data is removed or rewritten.

## Capabilities touched

`create_product` / `update_product` / `list_products` / `get_cart` / `set_cart_item` / `checkout_cart` / `buy_product` (currency), `create_reservation` / `quote_reservation` (`accept_mixed_currencies`, `currencies`, `mixed_currency`), `list_currencies`, `create_market_post` (`currency`), `create_payment` (currency read from the stored record), recruitment response (offer currency), claims lists (currency), public sponsor deals (currency). REST, OpenAPI and MCP share the same definitions.

## Operational failure modes and residual limitations

* A server whose settlement currency is not INR keeps INR on rows created before this change (that is what they were charged in); set seller-chosen currencies on new listings.
* `create_payment` for coach hires and shop orders now reads the stored currency; hires keep the platform settlement currency (coaches do not yet price in another currency).
* Venue/academy/team creation forms still pre-select a currency suggestion from the person's region (a convenience that the person confirms), and several older screens keep their own small `toMinor` helpers; they should migrate to `parseAmount` over time.
* Public sponsorship deals created before currency labelling have no currency and show as a bare number.
* No FX rates exist, so there is no estimated-conversion display; adding one needs a declared rate source and policy first.
* The app screens touched here are English-only today (only shell text goes through `t()`); the new strings are not in the 11 language packs.
