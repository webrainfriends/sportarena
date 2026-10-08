# Insurance (SPOR-55, SPOR-130)

One insurance domain: **insurers → plans → policies → claims**, with the existing payment flow
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

## Not built yet
Policy cancellation/renewal with pro-rata refunds, and actual claim payouts (money movement): "paid" is a status, as
payouts do not exist yet (see [architecture.md](architecture.md)).
