# Academy OS 1/3: programmes, admissions, family enrolment, tuition and CRM

An academy is an **organisation** (`organisations.kind = 'academy'`) with an academy profile. It is not a separate tenant: people hold their usual
organisation roles, structure is the existing seasons/cohorts/enrolments, athletes and guardians are the canonical users, consent is the canonical
guardian consent, and money is the canonical payment flow. This page records what was reused, what was added and why (the duplication audit).

## Reuse / gap matrix

| Academy need | Existing canonical source (reused) | Gap | Smallest extension (new, additive) |
|---|---|---|---|
| Tenant, staff, permissions | `organisations`, `organisation_members`, `org-access.js` (`orgFor`) | none | `academy_profiles` 1:1 row per organisation (sports, focus, ages, currency, listing) |
| Term / group | `org_seasons`, `org_cohorts` | link to a programme, capacity | `org_cohorts.programme_id`, `org_cohorts.capacity` |
| Enrolment | `org_enrolments` (one table) | programme, version, application, paused/completed/graduated/transferred | columns + wider status check; no second enrolment table |
| Athlete identity | `users` | none | none (no student table) |
| Guardian authority and consent | `guardian_links`, `youth_consents`, `requireGuardian`, `requireConsent`, `hasConsent` | the bulk-enrol path did not check consent | `commit_bulk_enrolment` now checks `participation` consent; academy actions call the same helpers |
| Application questions | safe data-only question schema (same idea as `application-forms.js`) | clinical-question guard | `checkQuestions` refuses health questions |
| Admissions funnel | `enquiries` is education-provider admission (different semantics, untouched) | trial, offer, waitlist, capacity | `academy_applications` + append-only `academy_application_events` |
| Agreements | `age_policies` (versioned config), `sponsorship_signatures` (sponsorship only) | versioned org policies and acknowledgement record | `org_policies`, `org_policy_versions` (append-only), `org_acknowledgements` (append-only) |
| Money | `payments` (`describePurpose`/`fulfil`), `refundPartial`, settlement, `invoices` | tuition charge, instalments, numbered invoices | `academy_charges` (snapshot per instalment) + payable `academy_charge` purpose; instalment dates via `addMonths`, exact split via `allocate`; every charge that needs paying gets a numbered invoice in the canonical `invoices` table (see below) |
| Notifications | `notify()`, durable `jobs` | recipient resolver | `recipients()` (guardian vs athlete, de-duplicated) and job `academy.announce` |
| Documents/certificates | branded documents, `credentials` | issue from an academy enrolment | invoice/receipt PDFs reuse `generate_invoice_document`; graduation certificates reuse `issue_credential` with `enrolment_id` (same code, verification, revocation, profile visibility); enrolment letters are a new `enrolment_letter` family of the same branded-document stack (templates, brand kits, encrypted append-only `generated_documents`), so no new table |
| Memberships / packs / subscriptions | `venue_plans` / `user_plans`, `activateUserPlan`, `raiseSubscriptionRenewals`, `my_plans` | organisation ownership | a plan or a held plan can belong to an organisation; a programme version that sells a pack or a monthly fee owns one organisation plan; enrolling creates the holder's plan (sessions, period, renewal) and its charge pays for it |
| Discounts / promo codes | `discounts`, `discount_redemptions` | organisation ownership | an organisation (optionally one programme) can own a discount; a redemption can belong to an enrolment instead of a booking |
| Bulk import | `preview_bulk_enrolment` / `commit_bulk_enrolment` | capacity | capacity check added to the same capability |

### Deliberate boundary decisions
- **Education pathways** stay separate: they are admission to an *institution's* programme. Academy programmes are delivered by the organisation itself. The education desk stays reachable as "Study listing".
- **Plans.** `venue_plans`/`user_plans` now accept an organisation owner (`venue_id` nullable, `CHECK` exactly one owner). Venue behaviour is unchanged: the member discount and pass credits still key on `venue_id`. An academy plan is created by publishing a pack or monthly programme version and bought only by enrolling (`buy_plan` and `cancel_unpaid_plan` refuse it). Sessions come from the plan (`adjust_academy_sessions` until the schedule in Academy OS 2/3 records attendance); `org_enrolments.sessions_left` is a legacy column read only as a fallback.
- **Invoices.** `invoices` accepts an organisation owner (`venue_id`/`reservation_id` nullable, `CHECK` exactly one source). Numbers are gapless per organisation and kind (`org_invoice_counters`, prefix from the academy profile). Charge paid -> invoice paid (a paid invoice is the receipt); charge cancelled or fully funded -> invoice void; funding revises an open invoice; a refund issues a numbered credit note, once per refund key. Venue-only operations (`mark_invoice_paid`, `mark_credit_note_refunded`) refuse academy invoices; staff use `record_academy_payment` for desk payments. Platform venue-sales reports count venue invoices only.
- **Promo codes.** One discount applies per enrolment: the best of the code, the sibling discount and the second-programme discount. Limits count redemptions plus other open applications holding the code. The price shown at application is the price honoured at enrolment. A fixed code carries its currency and works only in that currency. For a monthly fee a sibling discount repeats every month and a code applies to the first month only.
- **Enrolment letters.** `generate_academy_enrolment_letter` renders a frozen snapshot (programme terms version accepted, group, dates, venues, fees as charged with their invoice numbers, agreements accepted, what to bring) through the shared renderer. Staff may add a welcome note and pick a published `enrolment_letter` template; the enrolled adult or verified guardian gets the standard letter (the existing one if already issued). Each issue is a new immutable document; downloads re-check access live (`source_type = academy_enrolment`). A young person's letter is addressed to the guardian. No contact details, date of birth or health data are printed; ended enrolments get no letter.
- **Certificates.** `credentials` gained `enrolment_id`/`academy_programme_id`. A young person's certificate is hidden from their profile until a verified guardian chooses (`set_credential_visibility` now accepts a guardian), and the guardian, not the child, is notified.

## What was added
Migrations `100_academy_os_programmes_admissions.sql` and `101_academy_completion.sql` (additive only; the second widens `venue_plans`, `user_plans`, `invoices`, `discounts`, `discount_redemptions` and `credentials` so an organisation can own a row): `academy_profiles`, `academy_programmes`, `academy_programme_versions` (append-only),
`org_policies`, `org_policy_versions` (append-only), `org_acknowledgements` (append-only), `academy_applications`, `academy_application_events` (append-only),
`academy_notes`, `academy_charges`; new nullable columns on `org_cohorts` and `org_enrolments`; the enrolment status check widened; `payments.purpose_type` widened
with `academy_charge`. Nothing is dropped, rewritten or cascaded.

Capabilities (REST + OpenAPI + MCP from one definition): `src/capabilities/academy-programmes.js`, `academy-admissions.js`, `academy-billing.js` and the read models in `academy-desk.js` (programme desk, athlete directory and 360, announcement history). `quote_academy_enrolment` returns the exact price and due dates before anyone applies; nothing is created by a quote. Rules in
`src/academy.js`; background work in `src/academy-sweeps.js` (offer expiry + waitlist promotion, next monthly charge, announcements).

## Lifecycle
`enquiry → trial_requested → trial_booked → trial_completed → application_draft → submitted → under_review → offered | waitlisted | declined → offer_accepted → enrolled`,
with `withdrawn`, `expired`, `cancelled`. The server owns every move (`moveStage`): optimistic `row_version`, an append-only event with actor and reason, and
a unique index so one athlete has one live application per programme. Programme `admission_mode` decides the route: `direct` enrols at once, `application` and
`trial_then_enrol` go through review, `invite_only` accepts only staff invitations, `waitlist_only` always queues.

## Capacity and waitlist
A seat is a live enrolment or an unexpired offer. Every seat decision first takes `SELECT … FOR UPDATE` on the programme row, so concurrent acceptances serialise
and cannot exceed capacity (tested with five parallel submissions for two seats). The waitlist is ordered by a database sequence (`waitlist_seq`);
`promoteWaitlist` offers places deterministically (`SKIP LOCKED`), is a no-op when no seat is free, and runs when someone withdraws, declines, an offer expires
(worker `academy_offers`) or staff press "Offer places". Waitlist position is the number of people ahead plus one; no wait-time estimate is invented.

## Permission matrix
| Action | Owner/Admin | Finance | Coach | Athlete / verified guardian | Others |
|---|---|---|---|---|---|
| Academy profile, programmes, agreements, decisions, notes, CRM | yes | no | no | no | no |
| Programme list, cohort roster | yes | list only | own cohorts | no | no |
| Charges, funding, refunds, money dashboard | yes | yes | no | own charges only | no |
| Apply, accept/decline offer, acknowledge, withdraw | n/a | n/a | n/a | adult self, or verified guardian for the child | no |
| Public discovery | published + public + academy listed, anonymous | | | | |

Guardian authority is checked live on every call (`actFor` → `guardianLink`), so revoking a link is immediate. A young person cannot enrol themselves.
Participation consent is checked at submission and at enrolment (`requireConsent`). Academy staff receive no clinical data: application answers are
non-clinical by construction and encrypted at rest (`answers_enc`), internal notes are encrypted and never returned to the athlete or in notifications, and
reading either is audit-logged (`read_pii`).

## Money rules
Each charge snapshots gross, discount, funded amount, tax, currency and terms at enrolment; later programme edits never rewrite it. Currencies are reported
per currency and never summed. A paid charge means the customer paid; it is not presented as an academy payout (the settlement class is
`organisation_receivable` and posts no provider ledger lines). Refunds go through `refundPartial` with an idempotency key. Recurring monthly fees raise one
unpaid charge (and its invoice) a week ahead through the shared subscription renewal and never debit automatically; there is no card-on-file mandate.

## Failure modes
- Offer accepted after expiry: 409 and the seat returns to the waitlist.
- Required agreement outstanding or consent lapsed at enrolment: 409, nothing is written (the transaction rolls back).
- Stale `row_version`: 409 "changed by someone else".
- Duplicate application / retried submit with the same `idempotency_key`: the original is returned.
- Payment for a cancelled charge: the payment service refunds it automatically (existing behaviour).

## Rollback
Migration 100 is additive. To roll back application code, leave the tables in place (they are unused by older code). To remove the feature from the UI only,
revert `apps/app/src/screens/academy.js` and its two imports. Do not drop academy tables: they hold admissions, consent acknowledgements and billing history.

## Residual limitations (explicit)
Trial sessions and the academy timetable belong to Academy OS 2/3; a trial is booked as a status here and will link to a canonical session there, and attendance there will consume pack sessions automatically. Progress and outcome links belong to 3/3. No e-signature provider is integrated (acknowledgements are internal records). No automatic card debit. Invoices, receipts, certificates and enrolment letters are generated. Tuition invoices and receipts are PDFs of the canonical invoice; a branded template can be chosen through the existing document designer. An academy invoice prefix can be chosen once, before the first invoice. Credit notes are issued for refunds made through the payment provider.

## Screens
`apps/app/src/screens/academy.js` is the module inside the organisation workspace (sidebar on tablet/desktop, tabs on a phone): Home (action inbox, programme health, funnel, fees), Admissions (board and table with a decision panel), Programmes (catalogue, step-by-step builder with a payment preview, programme desk), Families (directory and 360), Agreements, Billing (charge actions, desk payments, funding, refunds, invoices and receipts, promo codes), Announcements, Study listing (the existing education desk, unchanged) and Settings (including invoice details). Families and athletes use the `AcademyFamily` screen ("My academy"): needs-attention cards, application tracker, programme browser, a step-by-step application with the exact price, and payments. Notifications open the organisation through the existing `targetFor` deep-link mapping.
