# Sponsorship application forms (#286)

Configurable application forms for the funding programs and rounds from #284. They extend the existing application record
(`sponsorship_applications`, the #67-style application) instead of adding a parallel system. A round without a form keeps the
original pitch + amount application unchanged.

## Model (migration `089_sponsorship_application_forms.sql`, additive)
| Table / column | Purpose |
|---|---|
| `sponsorship_forms` | A form of a program (name, `row_version`, `archived_at`). |
| `sponsorship_form_versions` | Immutable published versions: `definition` jsonb + `sha256`. |
| `sponsorship_rounds.form_id/form_version` | The version a round is pinned to (null = plain application). |
| `sponsorship_applications` + `form_id, form_version, answers, confidential_enc, budget, refs_enc, idempotency_key, correction_idempotency_key, receipt_no, submitted_at, row_version, updated_at` | The answers an applicant gave, under the exact form version. `requested_cents` may be empty only while `draft`. New statuses `draft`, `returned`. |
| `sponsorship_application_events` | Append-only trail: submitted, correction_requested, corrected, withdrawn. |
| `sponsorship_application_files` | Encrypted uploads, scoped to one application and one form question, hidden (`removed_at`), never deleted. |
| `sponsorship_applicant_profiles` | Reusable applicant details (encrypted), prefilled into questions with the same `profile_key`. |

Nothing is dropped or rewritten. The status CHECK and the "one live application per round and target" partial index are replaced by wider
equivalents (they now include `draft`/`returned`); existing rows are untouched. Rollback = deploy the previous code; the new tables and
nullable columns are simply unused.

## Form definition
Sections of questions. Types: `text`, `longtext`, `number`, `money`, `date`, `choice`, `multi`, `yesno`, `file`, `budget` (one), `references` (one).
Each question can be `required`, `confidential` (stored encrypted, staff reads audit-logged), carry a `profile_key`, and a `when`
condition (`eq`, `ne`, `in`, `filled` on an *earlier* question). Hidden answers are dropped. Rules live in `apps/api/src/application-forms.js`
(server, authoritative) and are mirrored for live show/hide in `apps/app/src/application-forms.js`.

## Capabilities (REST + OpenAPI + MCP from one definition)
Builder (brand manager/approver; read for others): `create_sponsorship_form`, `publish_sponsorship_form_version` (stale `version` → 409),
`archive_sponsorship_form`, `list_sponsorship_forms`, `get_sponsorship_form`, `set_round_form`.
Applicant: `get_round_application_form`, `save_application_draft`, `submit_application`, `get_program_application`, `submit_application_correction`,
`get_applicant_profile`, `set_applicant_profile`, `remove_application_file`. Brand staff: `request_application_correction`, `export_program_applications`.
Binary: `PUT /program-applications/{id}/files?field=KEY&name=FILE` (raw PDF/photo) and `GET /application-files/{id}`.

## States and invariants
`draft → submitted → (returned → submitted)* → awarded | declined`, `withdrawn` from draft/submitted/returned. Awarding/declining needs `submitted`.
- **Exact version:** a draft is pinned to the round's form version when started and keeps it. A changed round pin gives `409 stale_form_version`
  on save/submit; `rebase=true` carries matching answers to the new version. A submitted application always shows the version it was filled under.
- **Retries:** `submit_application` and `submit_application_correction` require an `idempotency_key`; the row is locked, so concurrent or repeated
  calls return the same receipt (`replayed: true`) and never file twice. The key is unique per applicant.
- **Resume:** one draft per round + target; saves replace the whole draft and need the draft `version` (stale → 409). Unsent edits (never confidential
  answers) are also mirrored on the device.
- **Corrections:** staff name the questions and a reason; the applicant may change only those (others → 403); previous open values are kept in the event.
- **Confidential uploads:** type sniffed from bytes, 10 MB, per-question and per-application caps, encrypted at rest, access re-derived on every download
  (applicant, or program staff once submitted; everyone else 404); staff reads are audited.
- **Isolation:** reads, writes and exports resolve the program's brand through `programFor`/`sponsorAccess`; outsiders get 403/404. Drafts are invisible to brands.
- **Consent:** references are stored only; `may_contact` records consent and nothing is sent automatically. Applications for athletes under the age of
  independence stay blocked (`assertCanApply`, shared with the plain flow).

## Dependency order and boundaries
#284 programs/rounds → this issue. Awards still create ordinary sponsorships (#145 agreements). Passport/evidence (#64), settlement (#71), email (#243) and
branded documents (#249) are not touched: receipts are in-app (notification + receipt number); no payment, consent or delivery is inferred.

## Limits
No email provider is involved (receipts are notifications); files are limited to PDF/photos; form conditions can only look at earlier questions.
