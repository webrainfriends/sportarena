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
| Staff cost | `academy_payroll_runs` (approved) → `academy_payroll_lines.detail` → `academy_timesheets` (programme, work date) from Academy OS 2/3 | a P&L read | `src/academy-cost-sources.js` `payrollCost`: read-only; each line carries its payroll line id |
| Venue cost | `session_venue_links` → `bookings` (confirmed, price) → `reservations.currency` | a per-session split | `venueCost`: a booking line's price is split exactly (whole minor units) across the live sessions sharing it; cancelled sessions and unbooked sessions are not guessed |
| Other cost, and gaps | none | management cost lines | `academy_cost_entries` (append-only, audited, labelled management entries; never a payment or invoice). Used where a canonical source has nothing for that programme, currency and category |
| Delivery | `academy_sessions` (status, ratio / lead rules via `evaluateSession`) | executive figures | `executiveHome()` reads them; `staffingExceptions()` is shared with the operations board |
| Branch / location | `venues` (referenced, never copied) | a grouping | `academy_branches` + nullable `academy_programmes.branch_id`; a programme belongs to at most one branch |
| PDF packs | `branded-documents` stack (templates, brand kits, encrypted storage, append-only `generated_documents`, live-checked audited download) | three families | `academy_progress_report`, `academy_management_review`, `academy_finance_pack`; they reuse `progressFor()`, `executiveHome()`, `pnl()` and `ageing()` |
| Decision follow-through | `issue_credential`, `invite_team_member`, `transfer_academy_enrolment` | a link from decision to result | `follow_through_academy_decision` calls them as the acting user; `academy_decision_follow_ups` (append-only) stores only the link |
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
- **Branches live in Settings** only; the P&L and Executive Home just filter and group by them. Decision follow-through lives on the athlete's Progress page, next to the decisions it follows.
- **One implementation per figure.** The operations board and the executive home share `staffingExceptions()`; the screen and the progress PDF share `progressFor()`; the screen and the management PDF share `executiveHome()`; the P&L screen, CSV and finance PDF share `pnl()`.
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
| Staff cost | Σ line amounts of **approved** payroll runs, attributed by the timesheet's programme and `work_date`. Draft and void runs are not cost. Adjustments and timesheets with no programme are **unattributed**: shown separately and deducted from the organisation result, never spread. Timesheets with no pay term (`unpriced`) are counted and reported as not costed |
| Venue cost | confirmed booking line price ÷ live academy sessions sharing it (remainder to the first sessions by id), by session date, cancelled sessions excluded; currency from the reservation. Sessions with no confirmed booking are counted as *unbooked* (cost missing) |
| Other direct cost | `academy_cost_entries` (not voided), by `incurred_on` |
| Precedence | a canonical staff or venue figure for a programme + currency **replaces** manual entries of that category, so nothing is counted twice; the set-aside entries stay visible in the drill-down and are counted in `cost_sources.manual_entries_superseded` |
| By branch | plain sum of the branch's programmes; programmes without a branch are an explicit *Unassigned* group; archived branches keep their programmes |
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
A scenario starts from real baseline data (current enrolment, the latest programme price, the last 90 days of approved payroll and confirmed bookings, or cost entries where those have nothing, and confirmed future invoices) and applies
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
`153_academy_branches.sql` is additive too (new tables `academy_branches` and `academy_decision_follow_ups`, nullable `academy_programmes.branch_id`, nullable `generated_documents.snapshot_sha`); it needs no backfill because *no branch* simply reads as Unassigned. `103_academy_os_outcomes.sql` is additive (new tables, two nullable columns on `academy_charges`; no drops, truncates, cascades or rewrites). To roll back the application, stop
calling the new capabilities; the tables can stay (they hold decisions and entries that must not be lost).

## Close-out additions (Academy OS 2/3 now present)
- **PDF packs.** `generate_academy_progress_report` (owner/admin, the athlete's coach, the athlete, or a verified guardian), `generate_academy_management_review` (owner/admin) and `generate_academy_finance_pack` (owner/admin/finance). Each is a snapshot taken at issue time and stored as the PDF only. Access is re-checked on every download (a coach removed from the group, a revoked guardian or a lapsed finance role gets 404). Identical content for the same person and template returns the same document (`duplicate: true`); changed data makes a new one. The progress report uses the athlete-safe projection, so it never carries coach-private notes, clinical data or fees; the management review suppresses counts under three and prints legal only as a count. Text the built-in fonts cannot draw is refused with a clear error (set `DOC_FONT_REGULAR` to enable other scripts).
- **Follow-through.** `follow_through_academy_decision` (owner/admin) issues the certificate for a *graduate* decision (`issue_credential`, which requires a completed or graduated enrolment), invites to a squad for *invite_squad* (`invite_team_member`, which asks for the athlete or guardian's participation consent, and the invitation stays pending until accepted) and moves the cohort for *move_programme* (`transfer_academy_enrolment`). Each action runs once per decision (advisory lock plus a unique link row); a retry returns the first result. Nothing happens unless a person calls it.
- **Delivery figures** in the executive home are `academy_sessions` scheduled / completed / cancelled and the staffing exceptions defined by `evaluateSession`; a configured rule, not a legal finding.

## Leadership insights (Finance → Overview, Executive pulse, branch scorecard)
- **`get_academy_pnl_trend`** (owner/admin/finance): per currency, monthly revenue (invoice basis, by charge due month), cash (by payment month), staff cost (approved payroll by timesheet date), venue cost (confirmed bookings by session date), other cost (manual entries), result, totals, the **prior window of equal length** and the percentage change. A prior value of zero gives a *null* change, never an infinite one. Optional branch filter. Unattributed payroll and unallocated overhead are included only without a branch filter.
- **`get_academy_branch_scorecard`** (owner/admin; finance gets money columns only, and `data_quality` is null for finance): per branch plus an explicit *Unassigned* row: athletes against target and capacity, delivery (scheduled / completed / cancelled, attendance, staffing exceptions), retention flags and per-currency finance with margin.
- **Every status is a stated rule over a measured figure** (returned in `rules` and printed under the matrix): capacity 60-100% green, 40-59% amber, otherwise red (over capacity is red); attendance >=85% green, 70-84% amber; cancellation <=5% green, <=10% amber; staffing exceptions none green, <=10% of sessions amber; retention flags <=10% of athletes green, <=20% amber; margin >=15% green, 0-14% amber, below 0 red, only when staff cost is known. A status without data is *unknown*, never green. There is no composite score and no model; thresholds are fixed in code and documented here, not configurable per academy yet.
- **Evidence completeness** (`data_quality`): % of sessions with a confirmed venue booking, % of approved timesheets inside an approved payroll run, % of programmes placed in a branch. A missing denominator is null.
- **Executive Home** gains `status` (same rules) and the UI renders them as chips with an icon and a word, never colour alone. Branch profile fields (code, manager, address, opening date, athlete target) live on `academy_branches`; the manager must be an active member of the academy.

## Known limitations and approved deferrals
- Status thresholds are fixed product defaults, not per-academy configuration; a performance director who wants different bands cannot change them yet.
- The trend and scorecard read live from canonical tables on each request (no snapshot tables); very large academies may want caching later.
- The athlete / guardian progress-report button is verified through the API and a unit test, but its screen was not captured in the browser journey (the route to that screen changed in the new navigation).
- The branch form shows the venues a branch already uses as "Selected" rather than by name until they are re-picked.
- Branch is a grouping the academy defines, with one branch per programme. A programme that runs at several locations is placed in one branch; per-session location is not a dimension.
- Executive Home people, delivery and outcomes sections are not filtered by branch (only the finance section is); branch filtering of those would need a programme-to-branch join in each read.
- Approved payroll is attributed by timesheet programme; a shift-only timesheet with no programme, and every pay adjustment, is shown as unattributed cost rather than guessed. Payroll runs and venue bookings made before this release are read as they stand.
- A booking line shared by several sessions is split equally by session; a weighting by duration is not applied.
- The PDF renderer uses built-in fonts, so names in scripts it cannot draw are refused until `DOC_FONT_REGULAR` is configured.
- Sponsor-funded credit reduces the amount owed on the charge with a traceable agreement reference; reconciling sponsor money received against it stays in the Sponsorship module.
- Receivables as-of reconstruction uses charge terms as they stand now.
- Machine-drafted translations of the new text are in all eleven packs and stay unreviewed until a native speaker signs them off; the academy screens still carry some older hard-coded English (tracked by the i18n baseline).
- Not run: native iOS / Android devices. The web build is exercised at phone, tablet and desktop widths; the native bundles are exported to confirm they compile.
