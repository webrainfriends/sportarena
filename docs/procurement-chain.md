# Procurement chain: need → source → compare → award → fulfil → invoice → pay → evaluate (issue #520)

One traceable commercial chain across the two sourcing routes that already existed. **Nothing new was built as a parallel stack**: #458 (Supplier services, `svc_*`) and #460 (Tender zone, `proc_*`) stay the foundation, and this change makes them share one fulfilment record.

* API: `apps/api/src/capabilities/procurement-chain.js` (REST + OpenAPI + MCP from one definition); shared logic in `apps/api/src/svc/from-tender.js`.
* Schema: `apps/api/migrations/123_procurement_chain.sql`, additive only (new nullable columns, three new tables, two triggers; nothing dropped, narrowed or rewritten).
* App: `ChainTrace` and `PerformanceRecord` in `apps/app/src/screens/svc-common.js`, used by the buyer and supplier order sheets and by the tender order screen. One React Native codebase for iOS, iPadOS, Android and web.

## Repository assessment: stage → canonical source → link/gap → smallest extension

| Stage | Canonical source (before) | Link / gap found | Smallest extension made |
|---|---|---|---|
| Demand / sourcing need | `svc_requirements` (buyer, event, venue, category, quantity, dates, budget) for RFQs; `proc_projects` (+ lots, event/venue/organisation links) for tenders | Both already linked to events, venues, organisations; goods vs services was only on the service side (`svc_order_lines.line_type`) | `proc_lots.supply_kind` (service or goods) so a tender lot becomes the right kind of order line |
| Route choice (direct RFQ or published tender) | RFQ: `svc_rfqs` (`audience` invited or published). Tender: `proc_projects.publication` (public, restricted, invite-only) | Both existed and are reachable from the same buyer contexts | None. They are two routes into one chain, not duplicates: RFQ is the lightweight route, tender the formal sealed one |
| Supplier response | `svc_quotes` (+ lines, versions, terms with assumptions / inclusions / exclusions, clarifications with attachments); `proc_proposals` / `proc_submissions` (sealed, immutable, alternatives, deviations, attachments) | Complete on both. Competing bids were already private on both | None |
| Evaluation | RFQ: `svc_evaluations`. Tender: weighted rubric, reviewer assignment, conflicts, consensus, hash-chained `proc_audit` | RFQ evaluation **overwrote** a re-score and had **no recusal** | `svc_evaluation_revisions` (every superseded evaluation kept) and `svc_rfq_conflicts` + `declare_rfq_conflict`; staff of a bidder can never evaluate it |
| Award | RFQ: `award_rfq` with separate approver (`svc_approvals`, DB check approver ≠ requester). Tender: scenarios, whole/partial/multi-supplier lots, human approval, notice, acceptance | Tender acceptance created `proc_orders` + `proc_commitments` + its own budget line, **not** the service order | Acceptance now also creates the one `svc_orders` row (`ensureServiceOrder`) |
| Order / fulfilment | `svc_orders`, `svc_order_lines`, visits, acceptance (receiving for goods), variations / change orders, incidents | Tender orders had no delivery, receiving or change-order path | They use the service order's. `proc_orders` stays the contract record (award snapshot, framework ceiling, renewals, notice, milestones) |
| Invoice / payment | `svc_invoices` → canonical `invoices`, matching against accepted quantity, exceptions need a separate approver, payments through `payments/service.js` (#503 / #498) | Tender orders could not be invoiced | Inherited through the service order. No procurement ledger exists or was added |
| Event budget | `event_budget_lines` / `event_budget_payments`; the service order owns one commitment line and mirrors each payment once | Tender acceptance wrote a second, separate line | One line per order, owned by the service order (it also carries `proc_order_id` for reports). A tender priced net commits its net award (`terms.commit_basis`) |
| Cancel / reduce | Cancel before work; termination variation after | Tender cancel only voided the budget line | Tender cancel delegates to the service order's rules (`cancelOrderRecords`): line voided and kept, never deleted; accepted or invoiced work needs a termination |
| Supplier performance | `supplier_dashboard` / `buyer_dashboard` rates (operational, no sample size, no buyer rating) | No evidence view, no rating | `get_supplier_performance` (each dimension with `n`, definition and a reliability flag) and `rate_service_order` (append-only) |
| Traceability | None across modules | Each side showed only its own stage | `get_procurement_chain` / `get_procurement_order_chain`: eleven stages, each naming its canonical record |

## The chain in one order

`demand → sourcing (RFQ or tender) → bids → evaluation → award → order → delivery or receiving → invoice and matching → payment → event budget → performance`

* **Tender acceptance** (`respond_to_award_line`) is one transaction: the contract record (`proc_orders`), the service order (`svc_orders`, `source = 'tender'`, `status = confirmed` because the supplier has just accepted), its lines priced from the winning bid's own lines scaled to the awarded quantity, and the single budget commitment. A retry or a concurrent second acceptance changes nothing.
* **Entity ↔ profile**: a tender supplier (`supplier_entities`) maps once to a supplier profile (`svc_profiles`). An existing profile of the same owner and organisation is reused; otherwise one is created (marked "complete the profile to invoice"). The mapping is stored on the entity.
* **Buyer context**: the tender's event, else venue, else organisation, else its owner. Who may act is read live from the existing buyer rules (organiser, venue team, organisation owner or admin, delegated roles); nothing is granted by this change.
* **Older orders** accepted before this change keep working. `link_procurement_order_to_service_order` gives one its service order on demand (idempotent). An existing budget line is taken over, never duplicated.
* **Framework call-offs** become a separate line on the service order (so they can be received, invoiced and paid) and the commitment follows the order total. Publish framework lots with the guaranteed volume only, since call-offs add to it.
* **Statuses stay separate**: award line, contract (`proc_orders.contract_status`), order, fulfilment, billing, settlement. The contract record's `status` follows the service order and cannot be started or completed by hand.

## Security and confidentiality

* A supplier sees only its own side of the chain: no competitor count, price or name. The buyer sees counts, never another supplier's prices in the chain view. Outsiders, losing bidders and the other side's staff get `404`.
* The order is priced from the winning supplier's sealed commercial envelope **after** the award is approved and the supplier has accepted it; the read happens inside the acceptance transaction and is recorded in the tender audit trail (`service_order_created`).
* Evaluation and approval: maker-checker is enforced in the database for RFQ approvals (approver ≠ requester) and by tender policy for tenders; recusal is enforced on both routes (tender `proc_conflicts`, RFQ `svc_rfq_conflicts`). Declarations and ratings are append-only (triggers).
* AI: the tender AI summary only quotes bid text and drops points without a source; no AI step scores, ranks, awards or invents compliance. The RFQ route has no AI step. Awards always need a human and, above thresholds, a different human.
* Personal data: no new personal free text is stored beyond an optional rating comment (not personal identification data). No new encrypted fields were needed. Audit: `svc_activity` for service-side actions, `proc_audit` for tender-side actions.
* Marketplace liquidity: catalogue and discovery stay free and basic. Nothing in ranking, scoring, comparison or performance reads any subscription or promotion; #504 does not exist in this codebase yet, and when it does it must not touch these paths.

## Supplier performance

`get_supplier_performance`: on-time delivery, first-time acceptance, rework, no-shows, issues per order, invoices needing a matching decision, median response time, buyer rating. Every dimension carries `n`, a plain definition and `reliable` (false below 5 observations, shown but marked). No combined or global score. A supplier sees its own record; a buyer (pass `buyer_id`) sees only the facts from its own orders, so one buyer never reads another buyer's experience.

## Requirement-to-evidence checklist (issue #520)

| Criterion | Evidence |
|---|---|
| #458 / #460 integrated, not duplicated | Assessment table above; one fulfilment stack; `proc_orders` kept as contract record; no second order, invoice, payment or ledger. `procurement-chain.test.js` (one `svc_orders` row per award line) |
| Tender award produces / references a canonical order | `procurement-chain.test.js` services and goods tenders; `proc_orders.svc_order_id` ↔ `svc_orders.proc_order_id` unique both ways |
| Bid revisions and evaluation history append-only | Tender: immutable `proc_submissions`, hash-chained `proc_audit` (existing suites). RFQ: `svc_evaluation_revisions` (`supplier-services.test.js`, RFQ evaluation integrity) |
| Competing suppliers cannot read each other's bids | Existing `tender-concurrency`, `supplier-services`; chain view: supplier never sees bid counts, losing bidder gets 404 (`procurement-chain.test.js`) |
| Conflict / recusal, maker-checker | Tender `proc_conflicts`; RFQ `declare_rfq_conflict`, staff-of-bidder block, DB approver check (`supplier-services.test.js`) |
| AI compares / summarises only | Tender AI tests in `tender-extras`; no AI path awards |
| Event-linked procurement reconciles to the event budget | Goods tender test: one commitment per order, committed − actual = still committed, payment mirrored once, cancel voids and keeps the line, spend cap blocks acceptance with nothing half-created |
| Receiving / acceptance controls invoice approval | Goods tender test: billing before receipt is refused, billing above what was received is refused, matched once received |
| Supplier performance evidence-based, sample-size aware | `procurement-chain.test.js` (n, definition, `reliable`, null when no evidence, no composite score, buyer scope, 404 for others) |
| GST / payment reuse #503 / #498, no procurement ledger | Invoices are the canonical `invoices` rows; payments go through the existing service; budget payments mirror once |

## Sports

Procurement is sport-agnostic (services, goods, suppliers, budgets), so there is no per-sport scoring model to cover. Sport appears only through the event or venue a need is linked to; all sports in the catalogue can be an event's sport. No sport falls back to a silent default because none is consulted.

## Platforms

`ChainTrace`, `PerformanceRecord` and the rating sheet use only shared React Native primitives, wrap from one column on a phone to a card grid on tablet and desktop, have accessibility labels per stage, and use chips (not free text) for the 1–5 rating. Verified with `expo export` and the web build at phone, tablet and desktop widths. Not run on a physical iOS, iPadOS or Android device from this environment.

## Limits stated plainly

* A tender order accepted before this change has no service order until the buying team links it.
* A supplier profile created from a tender has no tax registration or invoice prefix; the supplier completes it before invoicing (the existing profile screens).
* A quantity awarded with more than three decimals is rounded to three on the service order.
* If the supplier's days are blacked out or full, the award is not undone: the clash is recorded on the order (`terms.capacity_warning`) for both sides to resolve.
* Performance needs real orders to mean anything; with few orders every dimension is flagged unreliable by design.
