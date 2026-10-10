# Insurance (SPOR-55, SPOR-130)

One insurance domain: **insurers → plans → quotes → policies → renewals → claims**, with the existing payment flow
(`policy.status = pending_payment` until `create_payment` settles it; see [payments.md](payments.md)).

| Entity | What it holds | Privacy |
|---|---|---|
| `insurers` | name, status, website, verification (`verified_at`, set by the platform team after checking the licence) | licence number encrypted, read only when verifying (audit-logged) |
| `insurance_plans` | normalised terms: cover (individual / team / event), premium, coverage, currency, deductible, waiting period, term range, eligibility (age range, sports), **exclusions**, **conditions**, status `active` / `retired` | public |
| `insurance_policies` | the holder's policy; `terms` is a snapshot of the plan at purchase | policy number and beneficiary encrypted; decrypting is audit-logged |
| `insurance_claims` | amount, incident date, decision, reviewer, reason; history in append-only `insurance_claim_events` | description encrypted; reads audit-logged |

The old free-text `insurer` column is kept. The migration created one insurer per distinct existing name, linked the
existing plans and copied each existing plan's terms onto its policies. No row was changed or removed.

## Discovery (public, no personal data)
* `list_insurance_plans`: filter by cover target, sport, insurer, verified insurer, premium range, minimum cover, term,
  the buyer's age and free text; explicit sorts only (`premium`, `coverage`, `deductible`, `name`), so there is no hidden
  ranking; server-side pagination. Every card has the same shape and always includes exclusions and conditions.
* `compare_insurance_plans`: 2–5 plans side by side, which fields differ and who is best on premium / cover / deductible /
  waiting period. Highlights are informational; exclusions are shown in full.
* `list_insurers`: active insurers with their verification flag.

## Lifecycle
* Admin: `create_insurer`, `verify_insurer`, `create_insurance_plan` (insurer by id or name), `update_insurance_plan`
  (including `status=retired`). Editing or retiring a plan never changes cover already sold.
* `buy_policy` rejects retired plans, terms outside the plan's range, ages outside the limits (the date of birth is read
  only to check this, audit-logged, never returned) and sports the plan does not cover.
* `file_claim`: the total of open, approved and paid claims cannot exceed the cover the policy was bought with; an
  incident date must fall in the policy period and after the waiting period.
* `review_claim`: `submitted → under_review → approved | rejected`, `approved → paid` (a decided claim cannot go back),
  a rejection needs a reason, approvals cannot exceed cover, reviewers cannot review their own claim; every step is
  recorded and the claimant is notified with generic wording.

## Insurers as a role of their own (agency)
An account holding the **`insurer`** role (picked at sign-up or added under Me → Add or remove roles) runs an insurer **desk**
(Me → Insurer desk). SportArena is the marketplace and record-keeper, not the underwriter: insurers set their own terms and prices.

| Step | Capability | Notes |
|---|---|---|
| Onboard | `onboard_insurer`, `get_my_insurer`, `update_my_insurer` | One profile per account: name, headline, regions, sports, website, `accepting_requests`. The licence number is encrypted; the **verified** badge comes from `verify_insurer` (platform team) and is removed again if the licence number changes. Admins can hand an existing profile to an insurer account with `create_insurer.owner_id`. |
| Publish & advertise | `create_insurance_plan`, `update_insurance_plan`, `list_my_insurance_plans` | Insurers only touch their own plans (admins any). `promo_text` / `promo_ends_on` show a labelled **Offer** on the plan card; offers never change search order (sorts stay explicit). Retiring a plan never changes cover already sold. |
| Be found | `list_insurers` (`sport`, `accepting`), `get_insurer` | Public profile with active plans. |
| Run the desk | `get_insurer_summary`, `list_insurer_policies`, `list_claims?as_insurer=true` | Book of business with holder display names only: no beneficiary, no date of birth, no contact data. The policy number is shown in full and every read is audit-logged. |

## Quotes (request → quote → accept → cover)
* **`request_quote`** — a person, the manager of a team or the organiser of an event/tournament asks one insurer (`insurer_id`, or implied by
  `plan_id`) or leaves it **open** to every insurer taking requests. Participants, sport and months are the pricing inputs; the free-text note is
  encrypted and only insurers the request went to can read it. Up to 20 open requests per person.
* **`list_quote_requests`** (`view=mine|inbox`), **`get_quote_request`** — the inbox shows requests addressed to the insurer or open, minus the ones it passed on.
* **`create_quote`** — a priced offer on one of the insurer's **active** plans (premium per month, optional different cover / excess / waiting period,
  valid 1–90 days, a note), either answering a request or offered directly to a person/team/event (`buyer_id`). One live quote per insurer per request;
  `withdraw_quote` to revise. The plan's exclusions and conditions always apply and are shown with the quote.
* **`accept_quote`** — creates the policy on the quoted price and terms (**cover assigned**), re-checking that the buyer still manages the team /
  organises the event and meets the plan's age and sport rules. With a payment provider enabled the policy is `pending_payment` until paid
  (`create_payment`, purpose `insurance_policy`). Other quotes on the request close. `decline_quote`, `cancel_quote_request`, `decline_quote_request` close things without deleting them.
* **`send_quote_message`** — an encrypted thread between the requester and one insurer; each insurer sees only its own thread.
* **Tracking** — `insurance_quote_events` is append-only (requested → quote sent → accepted/declined/withdrawn/expired) and is what the app's tracker shows. Quotes
  past their date read as `expired` immediately and are marked so by the maintenance cycle.
* Status maps: request `open → quoted → accepted`, or `cancelled` / `declined`; quote `offered → accepted | declined | withdrawn | expired`.
  A quote sent without a request is a **direct offer**; nothing is bought until the buyer accepts.

## Renewal
`list_policies` returns `days_left`, `renewal_due` (30 days before the end, not yet renewed), `renewed_by` and the number of stored documents; `renewal_due=true` filters.
**`renew_policy`** opens 60 days before the end and stays open 30 days after it: the renewal starts the day after the current policy ends (continuous cover, so
**no new waiting period**) or today if it already lapsed (the plan's waiting period applies again). It is priced on the plan's *current* premium and terms,
can switch to another plan of the same kind, re-checks eligibility, can only be done once per policy (calling it again returns the renewal still awaiting payment)
and links back with `renewed_from`. The maintenance cycle sends holders a reminder **30 days and 7 days** before the end (once each) and the dashboard
shows `policies_to_renew`. Insurers see who has renewed under `list_insurer_policies`.

## Documents (the locker)
`PUT /api/v1/insurance/documents?policy_id|quote_id|claim_id=…&kind=…&title=…` with the raw file as the body; `GET /api/v1/insurance/documents/{id}/file`;
`list_insurance_documents`; `remove_insurance_document`. PDF or JPEG/PNG/WebP/GIF decided from the bytes, up to 10 MB, 50 per policy/quote/claim. Files are
**encrypted at rest** (AES-256-GCM, `src/crypto.js`), readable only by the holder, the insurer that wrote the policy and admins, and every download is audit-logged.
"Removing" a document only sets `removed_at`: the file and the row stay. Claim evidence is added by the claimant; schedules and certificates by either side.

## The marketplace (Billboard) and who can ask
* **Who can ask** (`request_quote`): anyone for themselves; for a **team** any active member (players, coaches, referees on the roster) and its managers; for an
  **event** its organiser (or organisation owner/admin) and active sponsors; for a **venue** its owner and staff. Cover can now be `individual`, `team`, `event` or `venue`.
* **Who decides**: buying, accepting, declining, cancelling and renewing stay with whoever *manages* the team / event / venue (so a player's request is accepted by the
  manager). Quotes, requests and policies for a team, event or venue are visible to its managers (`list_quote_requests`, `list_quotes`, `list_policies`).
* **Open requests are a marketplace**: a request without `insurer_id` is listed to every active insurer that takes requests, **notifies them all** (generic text, no details) and
  appears on the Billboard's Insurance tab through **`list_insurance_market`** (`GET /insurance/market`: cover, subject, sport, city, people, months, quotes so far, your quote;
  never the encrypted note). Any number of insurers can quote; the asker compares them all, can message each one, and accepts one (the rest close).
* **Why is my inbox empty?** `get_insurer_summary.inbox` says whether the profile is active and accepting requests, how many open requests exist, and how many are the insurer's own
  (a login cannot quote its own request). The desk and the Billboard show it as a plain sentence.

## Documents of a team, event or venue
`PUT /api/v1/documents?subject_type=team|event|venue&subject_id=…&kind=…&title=…` (raw file body), `GET /api/v1/documents/{id}/file`, `list_subject_documents`,
`remove_subject_document`, and **`link_insurance_document`** which adds a policy document (schedule, certificate, receipt) to the folder of the team / event / venue the policy covers
without copying it. Managers add and hide; members and sponsors can read. Same rules as the locker: PDF/images from the bytes, 10 MB, encrypted at rest, downloads audit-logged,
hiding only sets `removed_at`. Policy lockers are also readable by the managers of what the policy covers.

## Claims by insurers
The insurer that wrote a policy reads and reviews the claims on it (same state machine and rules as before: ordered moves, a reason to reject, never above the cover,
never your own claim); other insurers cannot see them. Admins keep full access.

## Migration `023_insurance_agency.sql`
Additive only: new columns on `insurers`, `insurance_plans`, `insurance_policies`; new tables for quote requests, quotes, messages, events and documents.
No existing row is changed, dropped or rewritten, and nothing here is ever deleted.

## Migration `027_insurance_marketplace.sql`
Additive: `venue` added to the allowed cover/subject types, `insurance_quote_requests.city`, an index for the open marketplace, and the `subject_documents` table
(soft-delete only). Nothing is dropped, rewritten or deleted.

## Not built yet
Policy cancellation with pro-rata refunds, actual claim payouts (money movement: "paid" is a status, as payouts do not exist yet, see [architecture.md](architecture.md)),
automatic renewal charging, native (iOS/Android) PDF picking and viewing (images work; PDFs are handled in the web app), and a regulator-side licence lookup
(the platform team verifies the licence by hand).
