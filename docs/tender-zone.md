# Billboard Tender zone (issue #460)

Enterprise-grade sourcing inside the Billboard: organisations, schools, event organisers, **venue owners and managers** and their delegates publish RFIs, RFPs and RFQs; suppliers (individuals, sole traders, companies) discover and answer them; buyer committees qualify, evaluate, rank, negotiate and award with auditable decisions; an accepted award hands off to one order and one budget commitment.

Open it from **Billboard → Tender zone**. Buyers also reach it from the organisation screen, the event console (Business tab), and the venue console (**Hire suppliers (tender)**). One feature, one place: there is exactly one tender console (`TenderConsole`) and the event and venue consoles only link to it.

* API: `apps/api/src/capabilities/tender-*.js` (one definition → REST + OpenAPI + MCP). Binary files and PDFs are REST-only routes next to the other document folders (`tender-files.js`).
* Logic: `apps/api/src/tender/*` (pure, tested without a server: `money.js`, `scoring.js`, `award.js`, `sheet.js`, `xlsx.js`).
* Schema: `apps/api/migrations/113_tender_zone.sql` (additive; nothing existing is altered except one nullable column on `event_budget_lines`).
* App: `apps/app/src/screens/tender-*.js` and `apps/app/src/tender-ui.js`: one React Native codebase for iOS, iPadOS, Android and web.

## Repository baseline → gap → reuse → smallest enhancement

| Existing behaviour (verified in code) | Gap | Reused | Enhancement |
|---|---|---|---|
| `billboard.js`: person-based recruitment posts (match_players … sponsor_call) with passport consent, stages, roster effects | No tender kind; company bids must never use recruitment acceptance or rosters | Billboard navigation (a new segment), notifications, identity, organisations, venues, audit | Tender cards are projections of `proc_projects`. No tender row is stored in `billboard_posts`; recruitment code is untouched |
| `event-planning.js`: event requests/quotes to suppliers, budget lines | No lots, rubric, sealed bids, committee evaluation or award | Event budget lines (`event_budget_lines`), `eventForOrganizer` authority | Award acceptance writes one committed budget line (new nullable `proc_order_id`, unique) |
| `supply.js`, `shop.js`: stock and goods commerce | Services, lots and bids do not fit stock | Untouched | Not used; services never touch stock |
| `invoices.js`: venue/academy invoices | No supplier-issued purchase-side invoices | Currency exponents and the minor-unit convention | Money maths is its own BigInt module with the same exponents; invoicing stays with #458 |
| `organisations.js`, `org-access.js`: membership roles | Membership alone must not grant procurement authority | `hasOrgGrant`, `orgFor` | Explicit `proc_mandates` and per-tender `proc_members`; venue authority read live |
| `documents/render.js`, brand kits | No tender document families | pdfkit, fonts, `brand_kits` | `tender/pdf.js` + immutable `proc_documents` snapshots |
| `jobs.js`, worker cycle | No tender background work | Durable jobs, worker plumbing | `tender.export` job, deadline-reminder sweep |

**Relationship to #458 (merged into `main` while this work was in review).** `svc_*` ("Services & suppliers": supplier profiles, catalogue, direct RFQs and quotes, service orders, visits, acceptance, invoices, payments) is the delivery-side pipeline for ordinary buying. The Tender zone is the formal competitive process on top of the Billboard: published notices, entity proposals sealed in two envelopes, an opening register, a scored committee evaluation, award scenarios, appeals and framework call-offs. The two are linked from the UI (organisation and venue screens show both entries) and use disjoint tables (`proc_*`/`supplier_entities` vs `svc_*`) and capability names (the two colliding credential capabilities here are `tender_add_supplier_credential` and `tender_verify_supplier_credential`). They are **not yet integrated at the data level**: an accepted tender award creates a `proc_orders` row, a `proc_commitments` row and (for an event) an `event_budget_lines` row, but not an `svc_orders` row, and tender suppliers are `supplier_entities`, not `svc_profiles`. Running delivery, acceptance and invoicing for a tender order in #458 needs a decision on identity mapping (entity ↔ profile) and is left as an explicit follow-up rather than guessed at here.

## Benchmark evidence matrix (SAP Ariba, Ivalua; vendor pages reviewed 25 Oct 2026)

"Better" is stated as a measurable workflow property that the tests exercise, not as a claim of feature parity.

| Capability | Baseline delivered | Sports-specific improvement | Evidence |
|---|---|---|---|
| Guided RFx | Templates with lots, typed questionnaire (9 types, conditional), rounds, versioned addenda; guided 8-step builder | Prelinked event, venue and site scopes; preparation / delivery / teardown windows; service families (ground, pitch, pool, crew, electrical, Wi-Fi, travel, accommodation) | `tender-flow`, `tender-extras` (addenda), UI `TenderBuilder` |
| Supplier participation | Invite, request, qualification, terms/NDA, secure proposals, clarifications | Individual and company entities share one proposal; mobile-first workspace with autosave and a missing-item checklist | `tender-flow` (supplier journey), `tender-concurrency` (restricted access) |
| Evaluation | Gates, weighted scoring, assigned and blind reviewers, consensus, audit | Safety and readiness evidence per criterion; capacity and crew in the technical envelope | `tender-evaluation`, `tender-lib` |
| Award | Scenarios, lot and quantity split, eligibility rechecks, approvals | Date- and capacity-aware lots, unfilled-lot reasons, venue/date overlap warnings in reports | `tender-evaluation` (award), `tender-governance` |
| Source-to-contract | Award → order → commitment, separate statuses | One event budget line per accepted lot | `tender-extras` (event-linked award), `tender-concurrency` |
| Decision intelligence | Explainable ranking, sensitivity, reports | Readiness coverage, unmet lots, venue/date conflicts, honest solver labelling | `tender-lib`, `tender-extras` (reports) |

Equivalent buyer and supplier tasks run in the integration suites with stated acceptance criteria (below). No marketing claim of parity is made.

## Roles and authority

Procurement authority is never implied by a personal account, a supplier role or plain organisation membership.

* **Creating a tender** needs one of: organisation owner/admin; an active procurement mandate (`procurement_admin`, `author`); the organiser of the event; the **owner or an active `manager` of the venue** (or an owner/admin of the organisation the venue belongs to). Plain venue `staff` cannot. Venue authority is read on every request, so removing a manager takes effect on their next call; what they created is kept.
* **Per-tender roles** (`proc_members`, with optional expiry and substitute): owner, author, technical_evaluator, commercial_evaluator, chair, approver, opener, legal_reviewer, auditor, stakeholder. Approvers must hold approver authority (a mandate or organisation owner/admin) where an organisation is involved. Outsiders get 404 so existence is not leaked.
* **Separation of duties**: nobody approves their own request; approvers differ from the requester; reviewers must declare conflicts; anyone who works for a bidding supplier cannot be added to, or act on, the buying team for that tender.
* **Supplier entities**: owner, bid_manager, contributor, signatory. Only owner or signatory submits. One proposal exists per entity, round and alternative, however many people work on it.
* **Human approval** is required for publish, material addenda, late windows, post-close deadline extensions, disqualification, reinstatement and award. Larger budgets need more approvals (`proc_policies`). No AI step approves or awards.

## Lifecycle and statuses

Tender: `draft → in_review → approved → published → evaluation → award → awarded | closed`, with `cancelled` and `archived`; the derived stage adds `scheduled`, `open`, `submission`, `closed`, `suspended`. Publication at a future `publish_at` stays hidden from suppliers until that instant.

Keep these separate (they are different columns on purpose): **tender status**, **proposal** (`draft | submitted | withdrawn`), **eligibility** (`pending | eligible | ineligible | withdrawn`), **award** (`approval_pending → approved → notified → partially_accepted | accepted | declined | cancelled`), **award line** (`provisional | accepted | declined | expired | cancelled`), **order** (`confirmed | in_progress | completed | cancelled`) and **contract** (`pending | agreed | signed_recorded`). A provisional award is not a contract; completion does not mean payment.

### Schedule semantics

Clarification, site visit, submission, opening, evaluation, negotiation and award dates, and the service duration (preparation, delivery, teardown), are distinct. Dates are wall-clock times in the tender's own time zone, stored as exact instants, and shown with the zone and UTC. **The server decides the deadline**: a submission is accepted only if its server commit time is strictly before `closes_at`; at the deadline instant the tender is already closed. The countdown in the UI is informative only. Nothing depends on a scheduler to close, so a delayed job can never open or close anything early or late.

Outage procedure: an owner **suspends** submissions; **resume** gives suppliers back exactly the time lost. After the deadline an extension, or a one-supplier **late window**, needs a recorded reason and another approver, and is audited. Nothing changes once proposals are opened.

## Sealing threat model

Submitted technical and commercial content (and each working draft) is encrypted with AES-256-GCM, bound to its row id, with the platform master key (KMS-wrapped in production). Every read passes one gate (`readEnvelope` / `assertEnvelopeAccess`): after the deadline, after the recorded opening with quorum, in the right order (commercial only after a passed technical sign-off for two envelopes), by a role that may read that envelope, and it is audited. Direct file URLs use the same rule, so they cannot be used to bypass it. API responses and files are `Cache-Control: private/no-store`; notifications carry only the tender reference and neutral text.

What this protects against: the API, UI, exports, direct file links, search, logs, caches and notifications; competing suppliers; and ordinary buyer insiders. **What it does not protect against:** an operator who holds both the database and the master key could decrypt offline. That access is outside the application. The application's own break-glass read (`breakglass_read_envelope`) requires a written justification, is read-only, is permanent in the audit trail and notifies the tender's chair and auditors. Ordinary UI hiding is never described as cryptographic sealing.

## Scoring, ranking and award (formulas)

Everything is deterministic and re-runnable. Worked fixtures are asserted in `test/tender-lib.test.js`.

* **Money**: integer minor units plus currency; BigInt arithmetic; half-up rounding once per step (quantity × rate, then discount, then tax split). Inclusive prices split as net = gross ÷ (1 + tax). Example: 36 × ₹1,500.00, 5% discount, 18% tax → net ₹51,300.00, tax ₹9,234.00, gross ₹60,534.00. Quantities carry up to 4 decimals; currencies use their own number of decimals.
* **FX** (comparison only): a dated snapshot on the tender, `rates[c]` = base units per 1 major unit of `c`. 100.00 USD at 83.10 = ₹8,310.00; 1,000 JPY (0 decimals) at 0.55 = ₹550.00. A missing rate is an error. Bid currencies are preserved; contract amounts are never rewritten from comparison FX.
* **Evaluated cost**: the priced lines of the lots bid on, net or gross of tax as declared on the tender, converted with the snapshot. A lot with no price makes the cost **unknown (null), never zero**.
* **Technical score** (0–100): per criterion, reviewers' locked scores averaged with reviewer weights (a chair consensus replaces the mean); normalised `(s − min) / (max − min) × 100`; N/A criteria are dropped and the remaining weights rescale; fewer than the required reviewers is "missing" and blocks the final ranking; a mandatory minimum can fail a bid. Example (weights 60/40, scores 8,6 and 9,7): 74.
* **Commercial score**: the lowest evaluated cost among bids that can still rank scores 100, others `100 × lowest ÷ own`. A bid that is ineligible, technically incomplete, below the pass mark or below a mandatory threshold never sets the baseline.
* **Total** = `technical_weight × technical + commercial_weight × commercial ÷ 100`, rounded half-up to 2 decimals. Example: technical 86, costs ₹46,000.00 and ₹41,400.00 → commercial 90 and 100, totals 87.60 and 76.00.
* **Ties** follow the published tie-break order (commercial, technical, earlier submission); a full tie shares the rank and is flagged. **Ineligible bids are listed but never ranked**, however cheap.
* **Sensitivity** shows how the order would change for alternative weights; it is never stored and never used for the award, which always uses the frozen rubric (frozen at approval; refused to change once proposals exist).
* **Award scenarios** (highest score, lowest compliant cost, single supplier, split by lot): up to 200,000 whole-lot combinations are solved exhaustively and reported "proven best"; larger instances, or lots that need a quantity split by capacity, use a greedy heuristic that is labelled "heuristic, not proven optimal". Output: allocation, evaluated cost, coverage, unfilled lots with reasons, violated constraints, budget impact. Lots already awarded are not offered again.

## Data model (new tables)

`supplier_entities`, `supplier_entity_members`, `supplier_credentials`; `proc_mandates`, `proc_policies`, `proc_templates`; `proc_projects`, `proc_lots`, `proc_questions`, `proc_members`, `proc_conflicts`, `proc_approvals`, `proc_approval_votes`, `proc_audit` (hash-chained, append-only), `proc_addenda`, `proc_addendum_acks`, `proc_participants`, `proc_qna`, `proc_files`; `proc_proposals`, `proc_submissions` (immutable), `proc_submission_costs` (immutable), `proc_openings` (immutable), `proc_opening_votes`, `proc_breakglass`; `proc_gates`, `proc_assignments`, `proc_scores`, `proc_consensus`, `proc_rankings` (immutable), `proc_rounds`, `proc_ai_runs`; `proc_scenarios`, `proc_awards`, `proc_award_lines`, `proc_orders`, `proc_commitments`, `proc_calloffs`, `proc_appeals`, `proc_documents` (immutable), `proc_exports`; `tender_saved`, `tender_alerts`. Immutability is enforced by trigger. Nothing is deleted: removal is a status or `*_at` column. Unique constraints and row locks protect submit, open, score lock, award issue and acceptance; `proc_award_lines` plus the unique `proc_orders.award_line_id` and `proc_commitments.order_id` make a second order or commitment impossible.

## Documents, exports, notifications and AI

* **PDFs** (branded from the organisation's or owner's brand kit): notice, addendum, proposal receipt, opening register, scorecard, ranked comparison, award recommendation, award notice, regret notice and agreement summary. Each is issued once into `proc_documents` and later renders from that snapshot, so historical values survive. Audience is part of the key: technical-only roles never receive commercial figures.
* **Exports**: report CSV/XLSX (formula-injection safe; XLSX has no formulas or macros), a tender pack ZIP, and bounded asynchronous exports (worker job, encrypted, downloadable only by the requester). Pricing sheets are versioned CSV/XLSX tied to the exact tender version; imports accept CSV only.
* **Notifications** (in-app and push through the existing channel; idempotent per person and event; neutral previews): publication and invitation, category alerts, clarifications and addenda, receipts, deadline reminders, evaluator assignment, approvals, award, decline, acceptance, call-offs, break-glass.
* **AI** (optional, off by default): authoring suggestions and a reviewer evidence summary. Supplier text is quoted as untrusted data; points without a valid question source are dropped; model, input hash and output are recorded; nothing scores, ranks, disqualifies, negotiates or awards; with AI off everything still works.

## Performance

Expected volumes: hundreds of published tenders per year per organisation; up to 200 lots, 300 questions, 200 suppliers and 20 reviewers per tender; attachments up to 10 MB each.

Budgets (p95, stated before measuring) and the measured result of `apps/api/scripts/tender-load.mjs` (local PostgreSQL 16, one API process; profile: 300 published tenders, one tender with 40 lots, 12 questions, 60 suppliers each submitting 40 priced lots plus an attachment, 8 reviewers, ranking, scenario and award across all 40 lots; 20 concurrent clients):

| Operation | Budget | Measured p95 |
|---|---|---|
| Tender list/search (25 cards) | 400 ms | 307 ms |
| Tender notice | 400 ms | 96 ms |
| Proposal submit (40 priced lots) | 1,500 ms | 172 ms |
| Open technical envelope (60 submissions, gates and costs) | 8,000 ms | 180 ms |
| Ranking (60 bids × 6 criteria) | 1,500 ms | 136 ms |
| Build scenario (40 lots) | 2,500 ms | 45 ms |
| Issue award (40 lots, all rechecks) | 3,000 ms | 138 ms |

Lists and reports are paginated and bounded; large exports run as background jobs.

## Verification

```
npm test                         # needs PostgreSQL; includes the tender suites below
node --import ./test/setup.js --test --test-concurrency=1 test/tender-*.test.js
TEST_DATABASE_URL=… node --import ./test/setup.js scripts/tender-load.mjs
npx expo export --platform web | ios | android   # from apps/app
```

`test/setup.js` is a test-only preload: the suites reset the database with `DROP SCHEMA public CASCADE`, which locks every relation at once and exceeds the default lock table once the schema passes ~2,000 relations ("out of shared memory" on stock PostgreSQL). The preload runs the same reset but drops tables in small batches. Nothing in `src/` depends on it.

## Requirement-to-evidence checklist

| # | Requirement (issue #460) | Code | Evidence |
|---|---|---|---|
| 1 | Authorised org, organiser, venue owner/manager and delegates can create; unrelated users cannot publish or approve | `tender/core.js` (`assertMayCreate`, `buyerRoles`, `venueAuthority`), `tender-parties.js`, `tender-rfps.js` | `tender-flow` (authority, venue), `tender-governance` (mandates, expiry, revocation) |
| 2 | Discovery and audience rules; no leak of restricted notices, attachments, bids | `tender-notice.js` (`noticeAccess`, `list_tenders`), `rfp.js` (`cardOf`) | `tender-flow` (publication), `tender-concurrency` (restricted), `tender-governance` (scheduled) |
| 3 | Public / restricted / invite-only publication, approvals, schedule, versioned addenda | `tender-rfps.js`, `approvals.js` | `tender-flow`, `tender-extras` (addenda), `tender-governance` |
| 4 | Entity proposal, immutable durable receipt, retries do not duplicate | `tender-proposals.js` | `tender-flow`, `tender-concurrency` |
| 5 | Lots, typed answers, alternatives, safe pricing import/export | `tender-proposals.js`, `sheet.js`, `xlsx.js` | `tender-extras` (sheet), `tender-lib` (sheet), `tender-concurrency` (alternatives) |
| 6 | Deadline race tests: before/at/after, delayed upload, revision, withdrawal, extension | `tender-proposals.js`, `tender-rfps.js` | `tender-evaluation` (deadline), `tender-concurrency` (race) |
| 7 | Sealing across API, exports, direct files, logs, caches, notifications | `core.js` (`readEnvelope`), `tender-files.js` | `tender-evaluation` (sealing), `tender-governance` (cache, exports), `tender-extras` |
| 8 | Two-envelope gate, quorum, opening register | `tender-evaluation.js` (`open_envelope`) | `tender-evaluation` (sealing, evaluation) |
| 9 | Rubric, weights, N/A, missing, reviewer permissions, independence, consensus reproducible | `scoring.js`, `tender-evaluation.js` | `tender-lib`, `tender-evaluation` |
| 10 | Ineligible cannot win; ties follow published rules | `scoring.js` | `tender-lib`, `tender-evaluation` |
| 11 | Multi-currency evaluated cost with declared FX/tax/rounding | `money.js` | `tender-lib`, `tender-extras` |
| 12 | Negotiation/BAFO keeps history and confidentiality | `start_tender_round`, `evaluation.js` | `tender-extras` |
| 13 | Scenarios enforce lot, quantity, capacity, budget; explain infeasible | `award.js` | `tender-lib`, `tender-evaluation` |
| 14 | Concurrent award/acceptance cannot over-allocate or duplicate orders/commitments | `tender-award.js` | `tender-evaluation`, `tender-concurrency` |
| 15 | Provisional award, acceptance, contract, order distinct | `tender-award.js`, schema | `tender-evaluation`, UI `TenderOrder` |
| 16 | Framework call-offs, duration, prep/teardown with #458 | `create_call_off`, `proc_orders` dates, `event_budget_lines` link | `tender-evaluation`, `tender-concurrency`, `tender-extras` |
| 17 | Outcome, debrief, appeal; public awards only approved fields | `get_my_outcome`, `file_tender_appeal` | `tender-evaluation`, `tender-governance` |
| 18 | PDFs and exports keep role and envelope access and historical values | `documents.js`, `pdf.js` | `tender-extras` |
| 19 | AI-off journey completes; AI cites evidence and cannot decide | `tender-reports.js` | `tender-extras` |
| 20 | Reports reconcile across withdrawals, revisions, partial awards, cancellations | `tender/reports.js` | `tender-extras`, `tender-governance` |
| 21 | Existing Billboard, supplier and event regressions pass unchanged | no existing file changed except wiring | full `npm test` run |
| 22 | Responsive native/web UX, accessible controls, load tests, REST/OpenAPI/MCP parity | `apps/app/src/screens/tender-*.js`, `scripts/tender-load.mjs`, `registry.js` | web render at phone/tablet/desktop; `expo export` (web, iOS, Android); load table above; `capability-registry` |

## Limits and items left to other issues

Stated plainly so nothing is overclaimed:

* **#458 integration**: delivery scheduling, acceptance of delivered work, supplier invoices and payments live in the merged `svc_*` pipeline. Tender orders do not flow into it yet (see "Relationship to #458"); this work provides the order, commitment and call-off records a follow-up would map across.
* **#249 / #243**: tender PDFs use brand kits, not the document-designer templates; notifications use the existing in-app and push channels. Email delivery follows whatever #243 provides.
* Pricing sheets export as CSV and XLSX; **import accepts CSV only** (no macro-capable formats).
* Pricing text in uploaded technical **PDFs** is not scanned; the technical envelope blocks spreadsheets, rejects price wording in answers, and the supplier attests to it.
* The solver is exhaustive only for small whole-lot instances; larger instances are a labelled heuristic with a manual fallback (build and compare scenarios by hand).
* The sealing model does not defend against an operator holding the database and master key (see above).
* The app was rendered and exercised on the web build and compiled with `expo export` for iOS and Android; it was not run on physical iOS, iPadOS or Android devices from this environment.
* Appeals and standstill are configurable tender policy, not a claim of public-procurement legal compliance. Tax treatment is a declared basis per tender, not a statement of any jurisdiction's tax rules.
