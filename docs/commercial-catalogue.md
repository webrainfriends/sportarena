# Commercial catalogue & entitlement engine (#504)

One place that decides **what can be bought, at what price, under which terms, and what limits result**. It is not a payment gateway (#498 owns payments): payments take a **frozen quote** from here and never recompute prices.

Nothing else in the app tests a plan name. A module asks `requireEntitlement(subjectType, subjectId, key)` (one call), `assertCapacity(...)` for live counts (seats, athletes, teams, locations) or `consume(...)` for metered usage (AI credits, API/MCP calls, storage, paid messages, verifications). A key no published version or override mentions is *ungoverned* and always allowed, so modules adopt the engine one at a time.

## Model (`apps/api/migrations/118_commercial_catalogue.sql`, `apps/api/src/commercial/`)
| Concept | Table | Notes |
|---|---|---|
| Product family | `commercial_products` | athlete, professional, team, club, academy, venue, event, supplier, sponsor, education, enterprise… A person holds **one base plan per family**, so one person can be athlete + coach + organiser at once. |
| Plan / add-on | `commercial_plans` | `kind` base \| addon (`requires` plans), `eligible_actors` (user, organisation, team, venue, event), `is_default` = the free plan that actor starts on. |
| Price version | `commercial_price_versions` | region, currency, interval (monthly, annual, one_time, per_event, usage), base amount, **components** (fixed, per-unit seat/team/location/event/athlete, bands, usage, **percent fee with cap — a 0% venue commission is just `bp: 0`**), tax %, trial days, proration policy, effective dates, entitlements. **Immutable once published** (DB trigger); retire it, publish a new one. |
| Entitlement | `commercial_version_entitlements` | key, limit (null = included/unlimited), behaviour `warn` / `soft` / `hard`, warn-at %. |
| Meter | `commercial_meters` | counter (period usage) or gauge (live count). |
| Offer | `commercial_promotions` + `commercial_promotion_price_points` | free months, % off, flat off for N months, trial days, coupon reference, extra entitlements; attached to **one or more price points or all**. |
| Subscription | `commercial_subscriptions` | pins the version bought (**grandfathering**), scheduled change, cancel at period end, never deleted. |
| Override | `commercial_overrides` | contract (one account) or enterprise (everything under a parent); set or add. |
| Hierarchy | `commercial_subject_links` | child account inherits what its parent resolves to. |
| Usage | `commercial_usage`, `commercial_usage_events` | atomic, idempotency key per call, append-only. |
| Quote | `commercial_quotes` | frozen lines, discount, tax, total, version ids, digest; never edited or deleted. |
| Bundle | `commercial_bundles`, `commercial_bundle_items`, `commercial_bundle_versions` | several price points of one person sold at one versioned bundle price. |
| Audit | `commercial_audit` | append-only. |

## Price-point codes
A price point is one sellable slot: `<plan_key>:<interval>:<currency>:<region>`, e.g. `team_pro:monthly:INR:IN`. Versions of a slot share its code, so an offer attached to it survives a re-price. A bundle's code is `bundle.<key>:<interval>:<currency>:<region>`.

## Entitlement precedence (deterministic, lowest to highest)
1. default plan of the actor type · 2. parent's resolved entitlements · 3. own base plan(s) on the pinned (or due scheduled) version — the first replaces, further ones (other profile families) **add** · 4. add-ons (add) · 5. offer grants while in force (add) · 6. contract override · 7. enterprise override (highest). Limits add (null/unlimited absorbs), features OR. `resolveEntitlements` returns the sources that shaped each key.

## Offers
Benefit: `free_months` (monthly price: first N terms cost nothing; annual/one-off: the first period lasts N months longer), `percent_off` or `flat_off` (capped at the price, same currency) for `duration_months`. A quote shows the per-term schedule then the regular price; the subscription records `promotion_terms_total/used` for the renewal engine. All price points = every plan price point and every bundle.

## Bundles
Two or more plans of different profile families, same interval/currency/region. Price: fixed, % off or flat off the members' list; a fixed price above the list total is refused at publish. Subscribing creates one subscription per member sharing a `bundle_group` and each member's `allocated_minor`; paying once starts all, ending one ends all.

## Downgrade and data
Cancelling or downgrading never deletes anything: entitlements fall back (the default plan), creating premium things is refused by the guard, everything already created stays readable.

## Console and API
`apps/app/src/screens/commercial-console.js` (platform admin only; hidden for every other role) over `/admin/commercial/*`; customers use `/commercial/*` (catalogue, account, quote, subscribe, change, cancel, usage). Every capability is REST + OpenAPI + MCP from one definition (`apps/api/src/capabilities/commercial.js`). Load the India launch baseline from the console ("Load India launch catalogue", `apps/api/src/commercial/india-launch.json`); re-importing never changes anything existing.

## Reuse / duplication matrix
| Existing | Decision |
|---|---|
| `venue_plans` / `user_plans` (a venue's memberships and passes sold to its customers) | Different thing (venue → customer). Untouched. |
| Academy billing / programme fees | Untouched; the platform's academy licence bands live in the catalogue. |
| `PROVIDER_COMMISSION_BP`, `partner_contracts.commission_bp` | Settlement terms stay; a catalogue price component expresses the launch 0% venue commission. |
| `create_platform_user` etc. | Restricted to the platform-admin email list (see `docs/auth.md`). |

## Left for the maintainer / #498
Prices and limits not given in #504 (Venue Starter/Pro/Business, academy bands above 30 athletes, supplier/sponsor/school/university/enterprise) are plans marked "needs a price" in the console; the launch entitlement limits are placeholders to review; tax is 0% until set per version; charging against a quote and renewals (pricing term N of an offer) belong to #498; existing modules are not yet moved onto `requireEntitlement`.
