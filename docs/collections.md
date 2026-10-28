# Recurring collections & dunning (#511)

One collections layer for money that is owed repeatedly: academy fees, club and team dues, and venue membership renewals. It owns **no money**.
What is owed stays on the canonical records (`academy_charges`, `invoices`, `payments`, and `user_plans` for venue memberships); this layer adds the
facts around them (part payments, waivers, schedules) and the work that follows an unpaid charge (reminders, retries, promises, escalation, access).

## Repository-first assessment (use case → canonical source → behaviour today → verified gap → extension)

| Recurring use case | Canonical plan / charge source | Renewal behaviour before this change | Verified gap | Extension |
|---|---|---|---|---|
| Academy monthly programme | `user_plans` (`auto_renew`) + `academy_charges` raised by `raiseRenewalCharge` a week before expiry | One notice at raise time ("Nothing is charged automatically"); then silence | No reminder cadence, no overdue handling, no retries, no part payment, no work queue | Dunning **cases** over the same charges; shared reminders, escalation, promises, plans |
| Academy term / deposit + instalments | `academy_charges` rows from `planCharges` at enrolment | No reminder at all before or after a due date | Same, plus a fixed row set that cannot take a later instalment | Same dunning; part payments and payment plans against the charge |
| Club / team dues | **none** (cohort enrolments exist, team payouts are outgoing money) | Nothing recurring could be raised | No schedule, no due-date source | `billing_schedules` raise one `dues` charge per period on a cohort enrolment |
| Venue membership / subscription | `user_plans` (`venue_id`, `renews_id`) paid as `venue_plan` payments | Renewal raised with one notice | No follow-up when unpaid | The same cases, with the venue team as the desk (reminders, promises, holds, history) |
| Professional packages (physio, coach) | prepaid `physio_package` / hires, **not** recurring | n/a | There is no recurring professional plan to attach to | Not covered: documented gap, nothing invented |
| India mandates / UPI AutoPay | none yet (**#498**) | n/a | No provider adapter | `mandate_ref` / `mandate_status` stored beside the schedule, a pluggable executor hook, honest "unavailable" |

## What was added

* **Schedules** (`create_billing_schedule`, `list_billing_schedules`, `update_billing_schedule`): amount, tax and every future due date are frozen at creation; each period inserts a unique `(schedule, period)` row *then* its charge in the same transaction, so concurrent workers raise one charge and one numbered invoice. Pause / resume / end are soft. An enrolment that already renews through a subscription plan is refused so it is never billed twice.
* **Part payments, waivers, concessions**: `charge_receipts` and `charge_adjustments` are append-only rows against the charge; `settled_minor` / `adjusted_minor` keep the running totals and a CHECK keeps `settled + adjusted <= amount`. The balance is `amount - settled - adjusted`. The original charge and numbered invoice are never edited. `record_academy_payment` gained `amount_minor` and `idempotency_key`; online payments (`create_payment`) charge the *balance* and record a receipt. If the balance shrank after checkout started, only the balance is taken and the difference is raised in the existing settlement exception queue.
* **Payment plans** (`approve_payment_plan`, `cancel_payment_plan`): dated instalments that add up to exactly the balance; reminders follow the next instalment; a missed one breaks the plan and the original date applies again.
* **Dunning cases** (`list_collection_cases`, `get_collection_case`, `act_on_collection_case`): one case per unpaid charge / membership renewal with the lifecycle `upcoming → due → attempted → paid | failed → retrying → overdue → escalated → resolved | waived | cancelled`. The state is derived from the canonical record and from `payments`; there is **no action that marks anything paid or recovered**. Reminders are idempotent per cadence step, go through the shared `notify()` (preferences, mute, WhatsApp opt-in), use generic wording with a deep link, and for a young person reach the verified guardian, never the child.
* **Policy** (`get_collection_policy`, `set_collection_policy`): reminder offsets, grace days, retry schedule, escalation, an optional late fee (needs amount, currency and the contractual basis; added once as its own charge in the same currency, never compounding) and optional access suspension. Late fees and suspension are **off** until someone chooses them.
* **Suspension**: prospective (blocks future self check-in, door/QR capture and pass minting, staff can still mark by hand), explicit (own table, reason, who/when), reversible (automatic when nothing is overdue any more, or by staff with a hold so policy does not re-apply it). Enrolment, attendance history, health and safety records are never touched.
* **Report** (`get_collections_report`): per currency (never summed) billed, collected, waived, conceded, still owed, overdue, ageing (the existing receivables ageing, now net of part payments), recovered amount and time, payment and auto-debit failure rates, and a forecast of what falls due. `reconciles` is true only when charge totals equal their receipts and adjustments, online receipts equal paid payments, and every paid charge has a paid invoice.

## Mandates are not payments

`billing_schedules.mandate_ref` / `mandate_status` (`none | pending | active | failed | revoked`) are a permission to collect. They are stored on their own and never read as invoice or payment state. `registerMandateExecutor(provider, fn)` is the hook #498 will use. With no adapter the case history says "automatic debit is not connected", the invoice stays open and the payer is asked to pay. A debit the provider accepts is recorded as *in flight*; the charge is collected only when the confirmed payment arrives through `settle()`.

## Where it lives in the app (no new console)

* Academy → **Finance → Collections** (replaces the *Receivables* sub-tab; its ageing and as-of date moved into the Collections report, and `get_academy_receivables` stays for API / MCP clients).
* Club and other organisations → **Collections** tab (owner / admin / finance).
* Venue console → **Passes, packages & memberships → Renewals waiting for payment**.
* Families see the balance, part payments, payment plan and "sessions paused until paid" on the existing Payments tab, and can pay the rest.

## Requirement → evidence (`apps/api/test/collections.test.js`)

| Acceptance criterion | Test |
|---|---|
| One billing period → exactly one charge / invoice despite retries and concurrency | "a schedule freezes its terms and raises exactly one charge and one invoice per period…" (6 concurrent runs) |
| Mandate state distinct from invoice / payment | "a mandate is a permission to collect…" |
| A failed payment never marks revenue as collected | "a failed payment is a recorded attempt…" |
| Reminders idempotent, canonical preferences | "the dunning lifecycle follows the due date…" (repeat sweeps, muted kind) |
| Part payments, funding, concessions, waivers reconcile | "part payments, waivers and concessions reconcile exactly…", "an online payment settles the balance…" |
| Youth billed to the authorised guardian | "a young person is billed to a verified guardian…" |
| Suspension / reinstatement by explicit policy, nothing deleted | "non-payment can pause access to future sessions only…" |
| Academy, club and venue use shared logic | "academy fees, club dues and venue membership renewals all land in the same desk logic" |
| Ageing / recovery reports reconcile | "ageing, forecast and recovery reports are per currency, reconcile to the desk…" |
| REST / OpenAPI / MCP cannot bypass roles or fabricate recovery | role tests in the lifecycle, payments and report tests; "the capabilities are wired into REST, OpenAPI, MCP scopes and the worker" |

## Platforms and sports

One React Native screen (`apps/app/src/screens/collections.js`) built from shared primitives: master-detail on tablet and desktop, a bottom sheet on phones, 44 pt touch targets, state words always paired with an icon, and pickers instead of typed text (calendar for dates, money fields, steppers, chips, search-and-pick for people). Collections is sport-agnostic money logic: it never reads a sport, so it behaves identically for every sport in the catalogue.

## Known limits

* Automatic debit needs a provider adapter (#498). Until then it is reported as unavailable, never simulated.
* A part-paid or waived charge keeps its single original invoice; the receipts and adjustments are shown on the collections case, not re-printed on the invoice.
* Venue membership renewals have no part payments or waivers (a plan is bought whole); they do have reminders, promises, holds, escalation and history.
