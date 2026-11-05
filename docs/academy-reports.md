# Academy report packs: governed branded PDFs (issue #807)

One governed flow for the academy's branded PDFs. A pack is **drafted** (by a person or a schedule), **reviewed and approved by a different person**,
**issued** as the encrypted PDF row of the shared document stack, delivered through canonical notifications, and can be **revoked**. Draft and issued
versions are immutable; a correction is a new version. Screen: **Organisation → Academy → Reports**. Families and athletes read issued reports in **My academy**.

## Requested feature → source of truth → verified gap → minimal extension
| Requested | Existing source of truth | Verified gap | Extension (additive) |
|---|---|---|---|
| Development / assessment report | `generate_academy_progress_report`, `progressFor()` (athlete-safe) | Issued in one step; no review | Same snapshot, now also available through the review flow (`kind=progress`) |
| Term report | none | New | `termSnapshot()` = progress view + attendance in the term + school band where the athlete/guardian shared it (`academicSection`, never grades); family `academy_term_report` |
| Board management pack | `generate_academy_management_review`, `executiveHome()` | Issued in one step | Same snapshot through the review flow (`kind=management`) |
| P&L pack | `generate_academy_finance_pack`, `pnl()`, `ageing()` | Issued in one step | Same snapshot through the review flow (`kind=finance`) |
| Campus quality pack | `academy_branches`, `pnl({branchId})`, `staffingExceptions()` | New | `campusSnapshot()` (people with n<3 suppressed, delivery, staffing, attendance, finance per branch); family `academy_campus_quality` |
| Data basis, currency, period, evidence versions, gaps, issuers, role redactions | scattered in snapshots | Not shown or stored | Frozen with each pack: `basis`, `evidence` (source, records, latest), `gaps`, `audience` |
| Draft → review → approve → issue/revoke history | `generated_documents` (append-only) | No workflow | `academy_report_packs` (+ append-only `academy_report_pack_events`); the PDF stays a `generated_documents` row (no second renderer or document table) |
| Scheduled drafts | `sponsor-report-schedules` pattern, worker | None for academy | `academy_report_schedules`, `draftDueReports()` in the worker: drafts only, built under the creator's **live** authority, idempotent |
| Guardian-safe delivery | `notify()`, `guardiansOf()`, `requireGuardian()` | No academy report notice | `issued` and `revoked` notices to the verified guardian (young athlete) or the adult athlete; **no figures in any message** |

## Model (migration 159, additive)
`academy_report_schedules`, `academy_report_packs` (status `draft|in_review|approved|issued|revoked|superseded`, frozen `snapshot`, `snapshot_sha`, `basis`, `evidence`, `gaps`,
`audience`, `approved_by <> author_id` CHECK), `academy_report_pack_events` (append-only). Triggers: the snapshot, basis, evidence, gaps, kind, subject, period and author never
change; rows are never deleted; an issued, revoked or superseded pack cannot be reopened. Rollback: the migration only adds objects; leaving it applied is harmless, and
nothing existing is altered (the only touched shared object is the two new `family` values, which are plain text).

## API (capabilities → REST + OpenAPI + MCP)
`get_academy_report_hub`, `search_academy_report_subjects`, `create_academy_report_pack`, `new_academy_report_pack_version`, `list_academy_report_packs`, `get_academy_report_pack`,
`submit_academy_report_pack`, `review_academy_report_pack`, `issue_academy_report_pack`, `revoke_academy_report_pack`, `list_my_academy_reports`,
`create_academy_report_schedule`, `list_academy_report_schedules`, `update_academy_report_schedule`. Binary: `GET /branded-documents/academy-pack/:id/draft` (DRAFT-stamped PDF,
never stored, audit-logged) and the existing `GET /branded-documents/:id/file`. The three one-step generate endpoints and `list_academy_pack_documents` (now also `term`, `campus`) are unchanged.

## Rules enforced on the server
* **Four-eyes.** The person who drafted a pack cannot approve it (API check and DB constraint). Approving a pack that has gaps needs `acknowledge_gaps`.
* **Who may do what.** Draft: owner/admin; the athlete's own coach for athlete reports; owner/admin/finance for the finance pack. Review, issue, revoke: owner/admin only.
* **Guardians and athletes** see only an *issued or withdrawn athlete report* of their own (or their child's), never a draft, finance, management or campus pack; other people get 404.
* **Redactions.** Athlete reports never carry finance, clinical or welfare notes, coach-private notes or staff-private feedback; term reports never print school grades; management and campus packs suppress counts under three and print legal only as a count; the finance pack carries no coaching or clinical data.
* **Revoke.** The file stops opening at once for the athlete, guardian and coach (owner/admin keep it for the record); the recipients are told, history is kept. A revoked pack's file is never returned as a "duplicate" of a new issue.
* **Live access.** Every download re-checks the role, coach scope or guardian link. Every draft read, draft PDF, issue and revoke is audit-logged.
* **Figures.** Nothing is recalculated: the snapshot functions the screens already share produce them, so the PDF and the screen match the source projections. A figure that cannot be known is "Not available", never zero. Currencies are never added together.

## Coverage and limits
* **Sports.** The packs are sport-agnostic wrappers over per-sport pathway, assessment and official-result records that already exist for every catalogue sport; this feature adds no scoring model, so no sport falls back to a silent default. Per-sport figures appear in the athlete reports only as those source records.
* **Languages.** All screen text is in the 12 packs (`arp.*`, machine-drafted, `reviewed: false`). The PDF content is English: the built-in PDF fonts cannot draw Indic or Urdu text and such names are refused with a clear error rather than garbled (set `DOC_FONT_REGULAR` to enable other scripts).
* **Not built:** e-signature, email delivery of the PDF (the notice is in-app/push per the user's own notification settings and the PDF is opened securely in the app), per-section redaction editing on the template, PDF/UA.
* **Platforms.** One React Native codebase; the web build was verified at phone, tablet and desktop widths. Native iOS, iPadOS and Android builds were not run on a device in this environment.
