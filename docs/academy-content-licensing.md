# Academy content licensing & training-content marketplace (#804)

An academy can license its own approved methodology, curricula, drills and micro-courses to affiliated or independent organisations. It lives in
**Organisation → Academy → Content**; there is no separate shop, silo or second source of truth.

## Requested feature → existing source of truth → verified gap → minimal additive extension

| Requested | Source of truth that is reused | Gap | Extension (migration `157`) |
|---|---|---|---|
| Approved curriculum / methodology to publish (#782) | `academy_curriculum_versions` (published only), `academy_methodology_versions` + approved drills | Nothing could be shared outside one academy | `academy_content_pack_items` **reference** version ids; nothing is copied. Publishing re-checks that each reference is the academy's own approved, published content |
| Product catalogue, price, checkout (#504, payments) | `payments` (purpose types + fulfil hooks), finance ledger (`fin_transactions`) | No purpose for a content licence | New payments purpose `content_licence` (constraint widened, never narrowed), `describePurpose` + `fulfilContentLicencePaid`; finance module `academy_content` ("Academy content licences") |
| Rights, territory, expiry, renewal | `src/media-rights.js` (`territoryWithin`, `terr`), `mr_licences` pattern | `mr_licences` is bound to events/packages | `academy_content_licences` (stage, window, territory, grace, renewal_of) reusing the territory helpers; expiry sweep `expireAcademyContent()` in the worker |
| Partner eligibility | `fed_affiliations` (approved, in date), `organisations.parent_organisation_id` (network campus), `addresses.country` | No "may buy" rule | `whyNotEligible()`: open / affiliated / invited + territory, read live |
| Coach seats | `organisation_members`, youth flag | No per-content seat | `academy_content_seats` (assign / release, history kept) |
| Using licensed content in the coaching workflow | `academy_sessions`, the coach's own coaching session record and plan versions (`openSession`, `savePlan`, the same path as "Load drills" for #782) | Buyer would have needed copies; the session screen did not show licensed content | `academy_content_uses` links a licensed item to the buyer's own session (soft-unlink via `unlinked_at`, migration `158`). The session's Curriculum tab lists linked items with the **live** licence state. `load_licensed_content_into_plan` adds drills, curriculum objectives and micro-modules to the coach's own plan as tagged blocks (`licensed`, `licence:<id>`, `item:<id>`): the text is copied into the block only when the licence allows offline copies, otherwise the block is a titled reference whose text stays behind the licence. Footage and documents are never plan blocks. After a revocation new loads are refused (402); blocks already in a coach's record stay as history |
| Video (#565) and youth footage | `youth.js` (`youth_until`), `doc-store.js`, audit | No licensed-video rules | Video items are https references; `youth_footage` items are stream-only, watermarked with the reader's name, never offline, audited on view, and can be withdrawn everywhere by a takedown |
| Offline access | `offline-sync` pattern | No licensed-content grants | `academy_content_offline_grants` (expiry capped by licence end), re-checked by `check_content_offline` on every sync |
| Renewal, revocation, telemetry, support, audit | `audit()`, domain trail pattern | None | `academy_content_licence_events` (append-only trigger), `academy_content_consumption` (ids and seconds only), `academy_content_cases` (+ `academy_content_takedowns`), encrypted notes (`*_enc`) |
| Financial attribution | `fin_transactions`, payments | Revenue split for authors | `revenue_share` (basis points) on the pack; `get_content_finance` returns a statement computed from paid, refunded licences. Paying authors out remains a finance action |

#565, #794 (network governance), #515 (white-label) are adjacent: a network campus (child organisation) counts as affiliated, and no brand or
contract store is created here.

## Rules enforced on the server

* Access to an item is decided **on every request** from the licence row (`entitlement()`): seat held + member of the licensed organisation + stage
  active (or inside the grace period) + territory + a published version + item not withdrawn. Revoked / expired / suspended ⇒ `402 licence_inactive`
  and offline copies are revoked. The buyer's own academy data and access are never touched.
* People without access get `404`, never `403` (no existence leaks). Publishers need the academy `curriculum` permission; buyers' owners/admins
  accept, pay and assign seats.
* A published pack version and its items are immutable (trigger). The licence history is append-only (trigger). Nothing is deleted.
* Territory of a licence can only narrow the pack's; offline cannot be enabled unless the pack allows it; seats cannot exceed the pack's limit.
* Listing never depends on price or promotion (no ranking influence).

## API (REST + OpenAPI + MCP from one definition each, `src/capabilities/academy-content.js`)

Publisher: `list_content_packs`, `create_content_pack`, `update_content_pack`, `save_content_pack_draft`, `publish_content_pack`,
`retire_content_pack`, `get_content_pack`, `list_content_sources`, `propose_content_licence`, `renew_content_licence`, `manage_content_licence`,
`list_content_licences`, `get_content_licence`, `get_content_overview`, `get_content_telemetry`, `get_content_finance`, `list_content_cases`,
`resolve_content_case`.
Buyer / reader: `browse_content_marketplace`, `request_content_licence`, `respond_content_licence`, `assign_content_seat`, `release_content_seat`,
`list_my_content_library`, `open_content_item`, `complete_content_item`, `use_content_item`, `rate_content_licence`, `grant_content_offline`,
`check_content_offline`, `raise_content_case`.

## Sports

Packs carry the catalogue sport slug; the content itself (methodology, drills, curricula) is each sport's own native model from #782. A test creates a
pack for every sport in the catalogue. There is no generic fallback in this feature.

## Rollback

Deploy the previous build: it ignores the new tables. Rows are licensing records and are never deleted. The widened payments constraint only adds a
value.
