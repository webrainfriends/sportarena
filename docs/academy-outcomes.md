# Academy OS 3/3: development, care & partnerships, management accounts and executive intelligence (#395)

This layer is a **projection** over the canonical domains. It adds configuration (pathways), human decisions, a provider *business* association,
management cost entries and forecast scenarios. It adds no athlete profile, no clinical, legal or sponsorship record, no cash ledger and no analytics
subsystem. Everything else on the screens (Athlete 360, P&L, receivables, retention indicators, executive home) is computed at read time.

## Reuse / gap matrix (requested → canonical source → missing piece → smallest extension)

| Requested | Canonical source (reused) | Missing | Smallest extension |
|---|---|---|---|
| Athlete 360 | `users`, `org_enrolments`, `org_attendance`, `coaching_observations` / `coaching_goals` (shared only), `performances` (approved competition), `clinical_clearances` via `currentClearance`, `academy_charges` | a role-aware assembly | `get_academy_athlete_360`: one section per source, each decided by the caller's role, nothing stored |
| Pathways, levels, versions | none (education pathways are admission to an institution, a different thing) | configurable ladder | `academy_pathways`, `academy_pathway_versions` (append-only) |
| Assessments | Coach Performance Studio rubrics and observations, `org_attendance`, `performances` | a review workflow with evidence references | `academy_assessments` (references and counts, no scoring engine; rubrics are listed read-only by `list_academy_rubrics`) |
| Progression decisions | `transfer_academy_enrolment` (programme move), team invitations (squad), passport/awards (certificate) | a governed decision record | `academy_progression_decisions` (append-only, human, idempotent). The response names the canonical capability for the follow-through; it never rewrites enrolments itself |
| Physio / doctor association | `provider_profiles`, verification cases, `clinicalCredential` | academy-provider relationship | `org_provider_associations` (business link only) |
| Participation clearance | `clinical_clearances` / `currentClearance` | consent for an academy to see the minimum | `academy_clearance_shares` (athlete or verified guardian grants; status, valid-through and source only) |
| Legal | `legal_intakes` (`acting_as='organisation'`), `legal_matters` | role-appropriate status | read-only projection of status and dates in `get_academy_partners`; no new legal tables |
| Sponsorship / scholarship | `sponsorships`, `sponsorship_obligations`, `beneficiaryScopeSql`, `academy_charges.funded_minor` | traceable funding on a charge | `academy_charges.funding_sponsorship_id` / `funding_award_id`; `set_academy_charge_funding` now requires an active agreement for sponsor funding. A charge is never marked paid by funding |
| Revenue | `academy_charges`, `payments` (`purpose_type='academy_charge'`, `refunded_cents`) | management view | `get_academy_pnl` (projection) |
| Cost | none for academies until Academy OS 2/3 (no timesheets or payroll exist) | management cost lines | `academy_cost_entries` (append-only, audited, labelled management entries; never a payment or invoice) |
| Receivables | `academy_charges` | ageing as of a date | `get_academy_receivables` (projection) |
| Retention | `org_attendance`, `org_enrolments`, `academy_charges` | explainable indicators | `list_academy_signals` (rules, no score) |
| Forecast | actuals above | editable assumptions | `academy_scenarios` (stored apart from actuals) |
| AI | `ai.js` (`askJson`), `quoteData`, `AI_RULES`, the `coaching-ai.js` pattern | executive prompts | `ask_academy_copilot`: deterministic answer first, optional re-wording; no athlete names, no clinical or coach-private data |
| Analytics #73 | none exists | – | nothing added; no analytics subsystem introduced |

## Overlap review (what was merged, what was not duplicated)
- **One home.** The executive view is the lower half of the existing Academy **Home** tab (no second dashboard).
- **One place for money.** The existing **Billing** tab is now **Finance** with sub-tabs *Charges* (the billing screen), *Profit & loss*, *Collections* (the work queue, schedules, policy and report; its ageing is the receivables ageing, and #511 replaced the old *Receivables* sub-tab with it), *Costs* and *Forecast*.
- **One athlete page.** The existing Families detail gained the Athlete 360 sections; no separate screen.
- **No second sponsor, legal, health, coaching or ledger system.** Sponsorship, legal and health appear as links/projections into their own tables.
- Coaches now reach the academy desk through the existing **Academy** workspace tab (Progress only).

## Permissions (server-side, per section)
| Role | Sees |
|---|---|
| owner / admin | everything in the academy except coach-private notes and clinical data; clearance only if shared |
| coach | Progress (review queue, assessments, decisions) and the Athlete 360 sections for athletes in their own groups: attendance, pathway, shared coaching, official results, shared clearance; provider directory. No billing, funding, sponsors or legal |
| finance | Finance (P&L, receivables, costs, forecast, charges), sponsorship panel if a payee; billing/funding sections of the 360. No coaching, attendance, pathway, clearance, providers or legal |
| athlete / guardian | `get_my_academy_progress`: level, decisions, approved assessments (comment only if made visible to the athlete), attendance trend, next review; controls clearance sharing. A young person's coaching material needs the guardian's `coaching` consent; sharing clearance needs `medical` consent and a verified guardian |
| sponsor staff | only what Sponsorship already shows them; the academy exposes nothing extra |

Clinical checks happen at the source: `get_academy_athlete_360` calls `currentClearance` only when an active `academy_clearance_shares` row exists and, for a
young person, the guardian's medical consent is current; revoking either hides it at once. Reads of the 360, receivables, signals and the executive home are audit-logged; P&L CSV export is audit-logged.

## Metric definitions
All money is in minor units and **per currency; currencies are never summed**. Missing data is `null` ("missing"), never 0. The P&L is a *management view*, not statutory accounts.

| Metric | Formula / basis |
|---|---|
| Gross billed | Σ `gross_minor` of charges due in the period, status ≠ cancelled (**invoice basis**, by `due_on`) |
| Discounts | Σ `discount_minor` |
| Funded | Σ `funded_minor` by `funding_source` (scholarship / bursary / sponsor), shown separately |
| Net invoiced | Σ `amount_minor` (what the payer owes) |
| Refunds | Σ `payments.refunded_cents` on those charges |
| Management revenue | gross billed − discounts − tax − refunds (the funded part counts: a funder carries it) |
| Cash collected / refunded | Σ `payments.amount_cents` by `paid_at`; Σ `refunded_cents` by `refunded_at` (**cash basis**) |
| Outstanding | Σ `amount_minor` of charges `awaiting_payment` |
| Direct costs | staff, venue, other from `academy_cost_entries` (not voided), by `incurred_on` |
| Contribution | management revenue − known direct costs. `contribution_complete=false` while a programme has no staff cost entry |
| Allocated overhead | each overhead entry spread by its own rule: participants (enrolled in period), revenue share, or explicit % split (must total 100%); an entry that cannot be allocated is reported as unallocated |
| Operating result / margin | contribution − overhead; margin % = result / revenue, only when the cost picture is complete |
| Revenue per athlete | management revenue / distinct athletes billed |
| Revenue / cost per session | ÷ distinct (group, date) attendance sessions recorded in the period; missing when none |
| Utilisation | enrolled / capacity (missing without a capacity) |
| Break-even athletes | ⌈known direct cost / revenue per athlete⌉ |
| Refund rate | refunds / cash collected |
| Receivable rate | outstanding / net invoiced |
| Discount & funding mix | (discounts + funded) / gross |
| Receivables ageing | as of a date: charges that existed by then and were unpaid on that day, bucketed by days past `due_on`: not yet due, 1–30, 31–60, 61–90, 90+. It uses charge terms as they stand now |

## Allocation rules and cost entries
`academy_cost_entries` are append-only; a mistake is voided (reason recorded) and re-entered. Direct costs belong to one programme; overhead carries an
allocation (`participants`, `revenue_share`, `split` with percentages summing to 100). They have an idempotency key, are audit-logged, and touch no payment, invoice or settlement table.

## Forecast assumptions
A scenario starts from real baseline data (current enrolment, the latest programme price, the last 90 days of cost entries, confirmed future invoices) and applies
editable assumptions: renewal %, new athletes, price change %, discount %, extra cohorts (size and cost), billing periods, scholarship/sponsor funding, optional cost overrides.
Athletes are capped at capacity (+ extra seats). It is stored in `academy_scenarios` apart from actuals and changes no price, payroll or booking.

## Retention definitions (`list_academy_signals`)
Each indicator is a rule with its evidence and suggested human actions; there is no score or model: *attendance falling* (last 28 days ≥25 points below the 28 before, 3+
sessions in each), *repeated absence* (3+ unexcused in 28 days), *programme ending without a next step* (ends in 30 days, nothing else active), *not renewed* (completed within 45 days, no renewal),
*balance overdue* (owner/admin/finance only; never changes access or history).

## Pathway versioning and progression
Publishing a version appends to `academy_pathway_versions` (trigger-enforced). A decision stores the version, `from`/`to` level, reason, actor, the criteria snapshot
and an optional assessment. The current level is the latest decision; a stale `expected_from_level` returns 409 (concurrency), the same `idempotency_key` returns the same
decision. Promotion needs the next level's prerequisites; unmet or missing evidence requires an explicit acknowledgement. Payment status is not an input.

## AI boundaries
`ask_academy_copilot` builds a deterministic, source-tagged answer first. If a model is configured it only re-words it; any statement whose `source` is not one of the supplied
sources is demoted to a suggestion. Prompts hold aggregate figures only (no athlete names, clinical data or coach-private notes); the free-text question is quoted as data. It
cannot call any capability, and without a model the answer is identical in substance.

## Migration and rollback
`103_academy_os_outcomes.sql` is additive (new tables, two nullable columns on `academy_charges`; no drops, truncates, cascades or rewrites). To roll back the application, stop
calling the new capabilities; the tables can stay (they hold decisions and entries that must not be lost).

## Known limitations and approved deferrals
- **Academy OS 2/3 is not in the repository** (sessions, staff assignment, timesheets, payroll). Until it lands: staff cost is entered as management cost entries; session counts come from `org_attendance` (cohort and date); cancelled sessions and staffing/ratio exceptions are reported as *missing*.
- Venue cost is not read from venue reservations (no academy session is linked to a reservation yet); it is entered as a cost entry.
- Branch/location is not a dimension (the academy has no branch model); P&L slices by programme and sport.
- Branded PDF packs (progress report, management pack, finance pack) are not added; CSV export of the P&L is. A new document family can be added in `documents/`.
- A promotion/graduation does not issue a certificate or move the enrolment itself: the response names the canonical capability (`transfer_academy_enrolment`, team invitation, passport/awards).
- Sponsor-funded credit reduces the amount owed on the charge with a traceable agreement reference; reconciling sponsor money received against it stays in the Sponsorship module.
- Receivables as-of reconstruction uses charge terms as they stand now.
