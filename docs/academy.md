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
| Money | `payments` (`describePurpose`/`fulfil`), `refundPartial`, settlement | tuition charge, instalments | `academy_charges` (snapshot per instalment) + payable `academy_charge` purpose; instalment dates via `addMonths`, exact split via `allocate` |
| Notifications | `notify()`, durable `jobs` | recipient resolver | `recipients()` (guardian vs athlete, de-duplicated) and job `academy.announce` |
| Documents/certificates | branded documents, `credentials` | none used here | reused unchanged (graduation certificates are issued from the education credential flow) |
| Bulk import | `preview_bulk_enrolment` / `commit_bulk_enrolment` | capacity | capacity check added to the same capability |

### Deliberate boundary decisions
- **Education pathways** stay separate: they are admission to an *institution's* programme. Academy programmes are delivered by the organisation itself.
- **Venue plans/passes** are venue-bound (`venue_id NOT NULL`, venue settlement). Rather than add nullable organisation scope to that engine, academy
  packs and monthly fees use `academy_charges` (a pack is a charge plus `org_enrolments.sessions_left`). This keeps venue settlement untouched. Residual
  limitation: there is no shared "membership" object between a venue and an academy.
- **Invoices** are booking-bound (`invoices.reservation_id NOT NULL`). Academy fees are paid and receipted through `payments` (which have a receipt
  trail and refund path) instead of widening the booking invoice constraint. Residual limitation: no numbered tax invoice PDF for tuition yet.
- **Promo codes**: the venue `discounts` table is venue-scoped. Academy discounts are the programme's published sibling / second-programme percentages,
  computed on the server and snapshotted on each charge; scholarship/bursary/sponsor funding is an explicit funded amount. A free-text promo code is not
  provided (it would be a second discount engine).

## What was added
Migration `100_academy_os_programmes_admissions.sql` (additive only): `academy_profiles`, `academy_programmes`, `academy_programme_versions` (append-only),
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
unpaid charge a week ahead and never debit automatically; there is no card-on-file mandate.

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
Trial sessions and the academy timetable belong to Academy OS 2/3; a trial is booked as a status here and will link to a canonical session there. Progress and
outcome links belong to 3/3. No e-signature provider is integrated (acknowledgements are internal records). No automatic card debit. Document generation
for enrolment letters/receipts reuses the branded-documents service only after a template family is enabled; none is added here.

## Screens
`apps/app/src/screens/academy.js` is the module inside the organisation workspace (sidebar on tablet/desktop, tabs on a phone): Home (action inbox, programme health, funnel, fees), Admissions (board and table with a decision panel), Programmes (catalogue, step-by-step builder with a payment preview, programme desk), Families (directory and 360), Agreements, Billing, Announcements, Study listing (the existing education desk, unchanged) and Settings. Families and athletes use the `AcademyFamily` screen ("My academy"): needs-attention cards, application tracker, programme browser, a step-by-step application with the exact price, and payments. Notifications open the organisation through the existing `targetFor` deep-link mapping.
