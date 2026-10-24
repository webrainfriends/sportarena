# Sponsor home and the offer builder (#309)

One place to make a sponsorship offer and one home for sponsors and recipients. Everything reuses the existing domain
capabilities (`propose_sponsorship`, `preview_sponsorship_schedule`, `get_sponsorship`, `get_sponsorship_summary`); no second ledger,
no second identity, no parallel console.

## App
* **Sponsor home** (the former "Sponsors" screen, `Sponsors` route). A "Needs you" list (offers to answer, payments to confirm,
  endorsements to review, overdue and upcoming dues, offers waiting for a reply), committed cash **per currency** (confirmed
  received; reported-but-unconfirmed shown apart), valuations of goods/services/endorsements labelled *an estimate, not cash*,
  then the deals list and the existing links (programs, calls, portfolio, reports, budgets). Loading, empty, denied and
  retry states use the shared components.
* **New offer** (`SponsorOffer` route), four steps: *Who* (brand, then athlete / team / event / organisation / group via
  search-and-pick), *What* (any mix of cash, goods, funded service and endorsement lines; once / weekly / monthly / quarterly /
  custom dates; period on the calendar), *Terms* (objectives, deliverables, message, optional authorized budget) and *Review*
  (the exact dated schedule from `POST /sponsorship-schedule/preview`, i.e. the same function that creates the dues).
  Endorsement lines carry the **rights**: channels, placement, approval criteria, asset usage, exclusivity.
* This replaced the monthly-only athlete form, the event "Propose a deal" form and the organisation/group finder form, and the
  separate athlete search on the old screen (one place to make an offer). Introductions and guardian-authorized athletes open the
  same builder pre-filled with the athlete. Merged without losing data: they all called `POST /sponsorships`.
* **Recipient**: the agreement screen now shows objectives, deliverables and endorsement rights, a banner that nothing is assumed
  paid, **Accept** (exact version; athletes choose whether to show the sponsor publicly) and **Decline** with a reason. Offers on
  versioned agreements are answered there (the list shows *Review & answer*); a stale version gives a 409 and reloads the latest.

## Safety rules the UI follows
* Sending an offer never moves money; payments are *reported* until the recipient confirms them (copy on review, on the success
  screen and on the recipient's accept step).
* Currencies are never added together; estimates are never counted as cash.
* The server is the authority on every rule (period, month-end clamp, remainder on the last instalment, ownership, tenant scope).
  The app only spots missing fields so the person is told before the review step.

## API / schema changes (additive)
| Change | Detail |
|---|---|
| `sponsorships.client_ref` (migration `101_sponsor_offer_builder.sql`) | nullable; unique per `(proposed_by, client_ref)`. |
| `propose_sponsorship` `client_ref` input | re-sending the same reference returns the offer already made (`replayed: true`) instead of a second one: safe retry after a timeout or double tap. The app keeps the reference after a lost connection and renews it after a server answer. |
| `get_sponsorship_summary` | adds `offers_to_answer`, `offers_awaiting_reply`, `totals` (per currency: committed, confirmed, reported-unverified) and `estimated_not_cash`; scoped exactly like the existing counts. |

Rollback: deploy the previous code; the column is unused. Nothing was dropped, rewritten or deleted; existing agreements, privacy
defaults and financial history are untouched.

## Tests
`apps/api/test/sponsor-offer-builder.test.js` (PostgreSQL integration: mixed offer to an event, preview equals the dues the
server creates, recipient preview equals sponsor preview, idempotent send incl. concurrency and a different person using the
same reference, invalid schedule refused with nothing created, home summary on both sides and for a stranger, stale-version
acceptance 409) and `apps/api/test/sponsor-offer-lines.test.js` (form-state to API conversion).

Screens: `docs/ux/sponsor-offer-*.png`.

## Remaining limitations
Online payment and notification delivery depend on the configured providers (unchanged). Native (iOS/Android) builds were not
run here; the screens are the same React Native components exercised on web.
