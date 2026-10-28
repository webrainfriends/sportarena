# Sports advertising & promoted marketplace (#524)

Paid, clearly labelled reach for venues, coaches, events and businesses — kept **apart from every organic list, ranking and review**. One capability
definition serves REST, OpenAPI and MCP (`apps/api/src/capabilities/advertising.js`, `advertising-admin.js`); the app (`Advertising`, `AdCampaign` and the
`AdSlot` component) only calls it, on iOS, iPadOS, Android and web.

Advertising is **not sponsorship** (#519): a sponsorship is an agreed deal with deliverables (`event_sponsor_placements`, #501); an ad is paid campaign
delivery against defined placements. They share no table and no code path.

## The rule that matters

Paid placements occupy their own labelled inventory beside organic content. They never change:

* an organic list or its order (`/venues`, `/events/search`, `/coaches`, feeds),
* a player or team ranking, a standing, an award,
* a tender / RFP evaluation, a sponsor application score, an eligibility or selection decision,
* a rating or review score.

How this is enforced, not just promised: the ad engine reads and writes only `ad_*` tables; no foreign key leads from any other table into them; the
source of the ranking, tender, scoring, evaluation, eligibility and community modules never imports the ad engine; and a test runs the same venue, event
and rating/price searches before and after delivery and compares them. Position among ads is a **fair rotation** (the campaign shown least today goes
first) — price buys the right to be shown, never a better position.

## Assessment: placement → organic source → eligibility → measurement → gap → extension

| Placement | Organic source (left untouched) | Who may buy | Measurement | Gap today | Extension |
|---|---|---|---|---|---|
| `featured_venue` | Venue search, `GET /venues` (Book a venue) | You manage the venue | Served impressions, button follows | — | Per-court promotion |
| `featured_coach` | Coach search, `GET /coaches` (Hire) | You, or a coach in your organisation | same | — | Programme-level promotion |
| `featured_academy` | Explore → Academies, `GET /academies` (by name) | You run the listed academy organisation | same | — | Programme-level promotion |
| `featured_event` | Event discovery, `GET /events/search` (Explore) | You organise a public, adult, open event | same | — | Registration-open boost for the organiser's own events |
| `promoted_supplier` | Explore → Suppliers, `GET /suppliers` (by name) | It is your active supplier profile | same | — | Per-offering promotion |
| `sponsored_post` | Community feed, `GET /market/posts` | Any approved advertiser | same | — | Sponsored challenges with their own entry flow |
| `event_display` | Public event page (#501) | Any approved advertiser; the **organiser must allow ads** on that page | same | — | Per-event inventory the organiser can sell |
| `scorecard_leaderboard` | Live centre and table (#501) | same, and the organiser must allow ads | same | Never reorders or sits inside scores, tables or awards | Rights-gated by the organiser's media licences (#482) |
| `search_sponsored` | The search results beside it | Any approved advertiser, matched on the visitor's search words | same | — | Per-vertical keyword packs |

The academy and supplier lists are new **Explore** tabs (Academies, Suppliers) with detail pages, backed by public capabilities that MCP agents use too
(`search_academies`, `get_academy_listing`, `search_suppliers`, `get_supplier_profile`). A placement whose organic list does not exist in the app would start
switched off (`ad_inventory`); none is in that state now.

## Campaign model

`advertiser` (you, or an organisation you own or administer) → `campaign` → one or more `placements` → versioned `creatives` → `reviews`.

* **What it promotes**: a venue, coach profile, academy, event or supplier profile you manage (picked from your own data — never typed), or an external
  `https` page. A category is chosen from a list; alcohol, tobacco and vaping, gambling and betting, weapons, adult content, performance-enhancing
  substances, supplements and health claims, prescription medicines, speculative finance, high-cost credit and political advocacy cannot be advertised
  (refused at creation, at review, and again at serve time).
* **Objective**: be seen (`awareness`) or get visits (`traffic`).
* **Billing**: `flat` (one fee, taken at start, credited back if nothing was shown), `cpm` (per 1,000 impressions), `cpc` (per click). Rates are in
  micro-units internally so a price per thousand can be charged per impression.
* **Targeting** — and only this: sport(s), coarse country / city (only when the page itself names a place), search words (sponsored search slot),
  followers of the venue or event promoted, and a daily frequency cap. Anything about health or clinical data, legal matters, insurance claims, inferred
  sensitive characteristics, young people's data, private messages or precise location is **not an option**: the create schema is strict and refuses the
  attribute by name.
* **Lifecycle**: `draft → submitted → approved | rejected → scheduled → active → paused → ended | withdrawn`. Changing a paused, rejected or approved
  ad puts it back to `draft` as a new creative version; a live campaign is paused before it is edited. A platform pause cannot be undone by the advertiser.
* **Review** (platform admin only, `mustBePlatformAdmin`): approve or reject with a reason, a reason category and the claims checked; the claims the
  advertiser declared must all be checked. Decisions are append-only.

## Disclosure and people's controls

Every rendered paid card carries **Sponsored** or **Promoted** first, then the advertiser's name. The ⓘ explains in plain words why it is shown (never
internal targeting detail), and lets the person hide that ad, hide an advertiser, or report it (reason chips, encrypted optional note read only by the
review desk with the read audit-logged). Hides are soft and reversible. A report or hide needs the impression token of an ad the person was actually shown.

## Youth

Young people and youth events get **no ads** unless the platform policy explicitly allows approved, contextual-only campaigns (off by default). When
allowed, only campaigns a reviewer marked youth-safe are eligible, and **no per-person record is kept** (no viewer hash, so no frequency profiling).
Youth events can never switch ads on, and a campaign cannot promote a youth event.

## Measurement — what is and is not counted

* **Impression**: the platform served the creative for the placement. Viewability is not measured.
* **Click**: one per impression, from the person it was served to, within an hour, while the campaign is live and its ad still approved.
* **Not charged**: repeats inside a short window (same person, same ad), views over the person's daily cap, and anything after the budget ran out. These
  are recorded as facts too (`billable = false` with the reason).
* **Unique reach and conversions are not measured** and are returned as `null` with the reason; an external conversion source would need an explicit
  integration.
* The advertiser's report and the platform's overview are both added up from `ad_delivery_events`, which is append-only (database trigger).

## Money and concurrency

A campaign is prepaid. `fund_ad_campaign` raises a numbered invoice (`AD-2026-000001`) and the advertiser pays it with `create_payment`
(`purpose_type: ad_funding`) through the hosted checkout; funds count only when the provider confirms. Every charge is one conditional
`UPDATE … WHERE spent + cost <= LEAST(budget, funded − refunded)`, so concurrent delivery cannot overspend (tested with 20 simultaneous viewers and 10
simultaneous clicks). `GET /advertising/campaigns/:id` shows the reconciliation of funds against payments and of the running spend against the delivery
facts; `admin_ad_overview` checks every campaign. Unspent funds of an ended or withdrawn campaign are refunded to the original payment method
(`refund_ad_balance`); the platform's own refund route refuses to refund money that was already spent. Plans can govern the feature through the
commercial engine (#504) with the `advertising.campaigns` entitlement (ungoverned until the platform defines it). Advertising funds are platform
revenue in the settlement classes (`platform_revenue`) — never provider money.

## Who can do what

| | Open account | Create / edit / pause / end | Fund | Read | Review & policy |
|---|---|---|---|---|---|
| Person (for themselves) | ✓ | ✓ | ✓ | ✓ | |
| Organisation owner / admin | ✓ | ✓ | ✓ | ✓ | |
| Organisation finance | | | ✓ | ✓ | |
| Platform admin (the two listed accounts) | | | | all | ✓ |

Outsiders get `404`, not `403`. Narrow API tokens: `fund_ad_campaign` and `refund_ad_balance` need the `payment` scope, the review desk needs `admin`.

## Sports coverage

Targeting works with every sport in the catalogue (a test walks all of them: each is accepted as a target and served only on pages about it). Ads do not
score, rank or generate results, so no sport needs its own model; there is no generic fallback to label.

## Screens (iOS, iPadOS, Android, web — one React Native codebase)

* **More → Advertising** — the advertiser's workspace: accounts, campaigns with status and spend, what needs attention, where ads can appear.
* **Campaign** — the ad as people see it, the review trail with reasons, funds and invoices (Pay with the hosted checkout), performance with its
  definitions, history, and only the actions the API says are possible.
* **New campaign wizard** — five short steps (what, where, who, budget and dates, the ad) with pickers, chips, a calendar, a currency amount and a
  stepper, and a live preview of the labelled ad.
* **Review desk** (platform admin only; the tabs do not exist for anyone else) — queue, decision screen, reports, policy and inventory, overview.
* **`AdSlot`** — placed beside Book a venue, Hire a coach, Explore events, the community feed, the public event page and the live centre.
* **Event console → Public page** — the organiser's switch for paid ads on that event's public page.
