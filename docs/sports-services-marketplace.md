# Sports Services & Opportunity Marketplace (#600)

One reusable framework carries every provider family through the same lifecycle:
**discover → verify → shortlist → communicate → request quote → negotiate → contract → schedule → deliver → invoice / pay → review.**
Everything is a capability (`apps/api/src/capabilities/marketplace*.js`), so REST, OpenAPI and MCP share one definition; the app (`Marketplace` hub, `MarketplaceEngagement`) only calls the API.

## Provider families
`athlete`, `coach`, `club` (organisation), `official`, `doctor`, `physio`, `venue`, `sponsor`, `supplier`, `agent`, `lawyer`, `insurer`, `media`, `other` (`src/marketplace/families.js`).
A family names the account role (or organisation) allowed to list under it and the approved verification case that must be current before a contract (coach, referee, physio, doctor, sponsor, recruiter, lawyer, insurer).

## What is reused (nothing is copied)
| Stage | Reused | New |
|---|---|---|
| Identity | `users`, `organisations` (a listing points at them) | `marketplace_listings` (headline, sports, place, rate range) |
| Discover | the shared sport catalogue, `testimonials` ratings, the ads engine placement `search_sponsored` | `search_marketplace` (one filter model for every family) |
| Verify | `verification_cases` (approved, unexpired) | credential gate at contract time, `credential_verified` in search |
| Shortlist | – | `marketplace_shortlist` (soft-removed) |
| Communicate / negotiate | – | `marketplace_messages` (encrypted), `marketplace_quotes` (every version kept) |
| Apply | #67 billboard responses | `request_marketplace_engagement` with `opportunity_response_id` |
| Contract | `generated_documents` + the shared PDF renderer | frozen terms snapshot with SHA-256 and contract number; `generate_marketplace_document` |
| Schedule | `athlete_blocks`, the athlete schedule feed | conflict check; scheduled work shows in both parties' schedules |
| Deliver / invoice | – | `deliver_…`, `accept_marketplace_delivery` raises invoice `MI-n` |
| Pay | `payments` (purpose `marketplace_engagement`), the provider ledger (commission, payouts, refunds) | – |
| Review | `testimonials` (#215): a payer of a completed engagement gets `verified_interaction`; one review per author and provider | the engagement moves to `reviewed` |

## Rules enforced on the server
- Only the buyer, the provider, or an owner/admin of the organisation on that side can see an engagement; everyone else gets `404`.
- The provider quotes first, then the sides alternate; you cannot accept your own offer; expired offers cannot be accepted.
- A regulated family cannot be contracted without a current verified credential.
- Free text (brief, quote terms, messages, delivery note) is encrypted at rest; every decrypted read is audit-logged.
- Accounts under 18 cannot list, engage, or be engaged (a guardian acts).
- Search never lets paid placement change organic order. `include_sponsored` returns the labelled ads slot separately; the app renders the existing `AdSlot` apart from the results.
- Data is never deleted: listings are paused/archived, shortlist rows are marked removed, closed engagements stay on both timelines.
- `accept_marketplace_quote` and `accept_marketplace_delivery` are pinned to the `payment` token scope because they create financial commitments.

## Sports coverage
The marketplace is sport-agnostic: listings and filters use the shared catalogue slugs, and `test/marketplace.test.js` walks every sport in the catalogue (offer + search). It does no scoring, so there is no per-family sport model to cover.

## Boundaries with existing workspaces
Category workspaces with their own domain rules stay as they are and are not duplicated here: clinical appointments and packages (Health), formal tenders and procurement approvals (Services & suppliers), single coaching sessions (`hire_coach`) and sponsorship agreements. The marketplace is the single discovery and quote-to-review path for services priced by quote; a provider may list in several families.
