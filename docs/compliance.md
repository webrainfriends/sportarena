# Compliance, safeguarding & eligibility (#595)

One platform that says, for a **person, an organisation or an event**, which requirements apply, which are met, which are missing or about to expire, **why**, and what it blocks.
It does not copy what other modules already know: it asks them, live (`src/compliance.js`).

## The model (rules are data, there is no sport- or module-specific engine)
| Table | What it is |
|---|---|
| `comp_requirements` | WHAT is required, owned by a **scope**: `platform` (platform team), `organisation` (owners/admins), `body` (a governing body's administrators and its licensing / registrar roles; compliance and auditors read), `event` (the organiser). Category (qualification, background check status, safeguarding training, safeguarding acknowledgement, federation requirement, event permit, insurance, licence, declaration, conflict of interest, attestation, other), subject (person / organisation / event), method, validity, reminder days, grace, escalation, versioned wording. |
| `comp_obligations` | WHO must meet it: roles / engagements / kinds in the scope (none chosen = everyone), optional sport (any sport in the catalogue), "only adults who coach or manage young people", mandatory or optional, from/until, and what an unmet one **blocks**: `youth_contact`, `registration`, `accreditation`. |
| `comp_records` | What a subject provided: status (`submitted → valid / rejected`, `revoked`, `withdrawn`, `superseded`), issue and expiry dates, `outcome` for a background check (clear / not clear / pending only), reference and declared text **encrypted** (`*_enc`), the requirement version it was made under, `previous_id` for a renewal. |
| `comp_waivers` | A documented, time-boxed (≤ 180 days) exception. The record and the rule are never rewritten. |
| `comp_events` | Append-only history (who, what, when). Never a reference, a number or free text. |
| `comp_reminders` | One row per reminder or escalation actually sent, so sweeps are idempotent. |
| `comp_packs` | Evidence packs for an authorised reviewer: frozen, SHA-256 hashed, expiring, revocable, read-audited. |

**How a requirement is satisfied** (`method`): *evidence* a reviewer approves, a *declaration* made against the exact wording of the current version, or *linked* to a canonical record that is read live and never copied: a platform verification (`verification_cases`), a federation licence (`fed_licences`, via its standing) or a supplier credential (`svc_credentials`, only if somebody checked it). Revoking or expiring it there applies here on the next read.

## States (deterministic)
`met · expiring (inside the reminder window) · grace (expired, inside the grace period) · pending_review · missing · expired · rejected · revoked · waived`.
A mandatory obligation in `missing / expired / rejected / revoked` **blocks**. Decision: `blocked` > `pending` (something awaits a reviewer) > `clear`. Every item carries a plain-language explanation and the next step. A renewal while a record is current keeps the old one valid until the renewal is approved.

## Integrations (no parallel copies)
* **#477 registration & eligibility** (`src/registration.js`): `rules.require_compliance` (default on; no obligations configured = no effect) adds a `compliance` check per obligation that blocks `registration`. Failed = `fail`, awaiting review = `pending`; the decision and the reasons are part of the match-lock snapshot like every other check. Waiving happens in compliance (one mechanism), not as a second registration exception.
* **#481 accreditation** (`src/accreditation.js`): obligations that block `accreditation` stop an application or approval (`blocker`) **and** a badge at the gate (`judge` → `not_eligible`) the moment they lapse.
* **Youth contact** (`src/team-chat.js → mustBeSafeToPost`): an adult on a team that has young members cannot post, attach or run a poll in its chat until every obligation that blocks `youth_contact` is met; **pending counts as not met**. Young people are never restricted by this. Obligations that block youth contact **can never be waived**, and background checks can never be waived either.
* **Org Command Centre** (#573): the Compliance tile counts submissions to review and records expiring or expired in the organisation's and its events' rulebooks, and the decision queue lists the evidence with Approve / Reject calling `decide_compliance_record` (no second approval path).

## Access and sensitive evidence
* The holder, a verified guardian, an organisation's owner/admin and an event's organiser can submit; **nobody decides their own or a record they submitted**.
* A manager sees only the requirements of the scopes they run; the holder, guardian and platform team see everything that applies. Outsiders get a `404`.
* **References** (`read_compliance_reference`): a background check's reference is shown only to the holder and guardian. For other requirements the scope's managers can read it too. Every reveal is in `audit_log` and the history.
* A background check is always confirmed by a reviewer (never a self-declaration), a rejection records only "not clear" and shares no reason.
* Young people are shown as "Protected participant" to anyone who may not see them (`canSeeYouth`), in roll-ups and packs.
* **Evidence packs** carry states and dates only (never references, notes or declared text); name a reader and an expiry (≤ 30 days). Reading is audit-logged, revoking is immediate.

## Reminders and escalation
`src/compliance-sweeps.js` (worker): each record is reminded once per stage (`before:N` for each of the requirement's reminder days, `expired`), then **escalated to the scope's managers** once it has stayed expired for the requirement's escalation period. Persons are reminded together with a young person's guardians; organisations and events via their managers. Linked requirements are reminded by the module that owns them (licence, verification, supplier).

## Policy layer: jurisdiction, precedence, dates, decisions (#568)

One engine, one rulebook, one screen: the policy layer is additive columns and capabilities on the same requirements and obligations; there is no second engine.

- **Classification.** Every requirement is a *legal mandatory*, *regulatory*, *federation mandated*, *contractual*, *organisation policy* or *recommended standard* rule. Platform scope writes laws, regulations and contractual rules; a governing body writes federation rules; organisations and events write policy and standards. A **recommended standard advises and never blocks.** A **law or regulation is pending until a second platform administrator approves it** (the writer cannot), applies to no one while pending, can never be waived, and once approved is not edited (publish a new rule and end the old one).
- **Where and for whom.** An obligation can also name a country, state or province, municipality, governing bodies, competitions, venues, event types and an age band, besides roles and sport. Facts come from live records (the event, venue or organisation address, federation affiliations, a person's age from the audited date of birth read; only the age is kept). A dimension the facts cannot answer makes the rule **unknown** (“cannot be judged yet”), which blocks like a missing mandatory item, never a silent “does not apply”. First jurisdictions offered: IN, US, CA, SG, MY, LK, AU, GB; a pack adds more without code.
- **Precedence.** Rules of one `topic` compete: higher classification, then narrower jurisdiction, then more specific applicability, then the later start date, then the higher version. The losers are shown as overridden, with why. If the winner is unknown, the losers wait too.
- **Dates and history.** `starts_on`/`ends_on` on an obligation are its effective window (a repeal is an end date); `as_of` evaluates the rules of a date, including archived rules and the requirement wording saved by then.
- **Decisions.** Gates for opening an event, starting an event and awarding a tender (plus registration and accreditation) record refused attempts in `comp_decisions`: facts and their sources, every rule with its version and result, waivers used, who and when. Triggers refuse edits, deletes and truncation. `evaluate_compliance` explains deterministically (no AI) and can keep a check. An AI can reword it later; it never decides.
- **Tenders.** A buyer's organisation (or event, or the platform) rules with role *supplier* govern the suppliers it awards to; the supplier answers from the tender (`tender_id`) and `recommend_tender_award` is refused until every awarded supplier is clear.
- **Packs.** `export_compliance_rules` / `import_compliance_rules` move a scope's rulebook as plain data (`sportarena.compliance-rules/1`): validated in full before anything is written, idempotent by code, laws arrive pending.
- **Dashboard.** `list_compliance_gaps` also returns counts by status: compliant, expiring, pending, missing, exception, non-compliant, unknown.

Merged in the port of #568: its separate rules engine, screen and event tab were dropped in favour of this workspace; its distinctive features above were rebuilt on it. Not carried over: future-dated versions of a requirement (use an obligation window instead) and the AI reword step.

## Standard country rulebooks
`list_standard_rulebooks`, `get_standard_rulebook` and `install_standard_rulebook` ship six rules for each of IN, US, CA, SG, MY, LK, AU and GB as jurisdiction packs (event permit, public liability, child-protection checks, safeguarding training, guardian consent for children, event privacy), each anchored to the named instrument and regulator. They install through `import_compliance_rules`, so laws and regulations wait for a second platform administrator, recommended standards only advise, and installing twice changes nothing. Where a duty varies by state or municipality the rule is written for the country; narrow it by writing your own rule for that place. A research anchor and checklist, **not legal advice**; every rule's approval owner is qualified local counsel. Not carried over from the earlier separate engine: AI-drafted rulebook packages (explanations stay deterministic).

## Capabilities (REST + OpenAPI + MCP, one definition each)
`get_compliance_catalogue`, `save_compliance_requirement`, `archive_compliance_requirement`, `list_compliance_requirements`, `save_compliance_obligation`, `get_compliance_status`, `list_compliance_gaps`, `list_compliance_history`, `submit_compliance_record`, `withdraw_compliance_record`, `list_compliance_records`, `decide_compliance_record`, `read_compliance_reference`, `grant_compliance_waiver`, `revoke_compliance_waiver`, `list_compliance_waivers`, `create_compliance_pack`, `list_compliance_packs`, `get_compliance_pack`, `revoke_compliance_pack`. Policy layer: `evaluate_compliance`, `list_compliance_decisions`, `get_compliance_decision`, `approve_compliance_requirement`, `export_compliance_rules`, `import_compliance_rules`.

## App (iOS, iPadOS, Android, web: one React Native codebase)
* **More → Compliance**: *Mine* (what is required of me, grouped Needs action / Awaiting review / Expiring soon / In order, with one next step each) and *Manage* (every scope I run). A guardian opens a young person's from **Family → Compliance**.
* **Organisation → Compliance** and **Event console → Compliance** embed the same workspace for that scope: *Who is short*, *Review queue*, *Rulebook*, *Waivers*, *Evidence packs*. Nothing is a second console.
* Every choice is a control: category, who it is about, method and source are chips; validity and reminder days are chips; grace and escalation are steppers; roles, consequences and sports are pickers; dates use the calendar; reviewers are picked from a people search. Only the name, the wording and references are typed.

## Sports
Sport-agnostic by design: an obligation can target any sport in the catalogue (`test/compliance.test.js` walks every sport). Nothing here scores, rules or schedules a sport, so there is no generic fallback to label.

## Evidence files
Attach a certificate or document to a submission: **PDF, JPEG, PNG, WebP, GIF, Word (.docx, .doc), Excel (.xlsx, .xls), CSV and text**, up to 10 MB each and 5 per record. The type is decided from the bytes (not the name); Office files with macros, external links or ActiveX are refused; a configured malware scanner is honoured (`UPLOAD_SCAN`). Files are AES-256-GCM encrypted on disk (`comp_files`), hidden, never deleted, and every read is in `audit_log` and the history. Only the holder, a guardian or the organisation / event manager can add or hide files, and only while the submission awaits review. The holder and guardian always read them; the scope's managers (reviewers) read them for ordinary requirements. **A background check takes no files**: only a reference, so reviewers see the outcome and never the underlying detail. Evidence packs never contain files. Upload is `POST /compliance/records/:id/files` (JSON `{ file_name, data: base64 }`), download `GET /compliance/records/:id/files/:file_id`, hide `remove_compliance_evidence_file` (MCP); listing is part of `list_compliance_records`.

## Not in scope here
Immigration, medical-clearance and legal advice are not given.
