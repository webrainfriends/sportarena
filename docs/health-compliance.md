# Doctors module: country health-privacy compliance

The doctors module (appointments, consent, records, encounters, care plans, results, referrals, clearances and event medical logs) follows the health-data
rules of **eleven countries**: United States, United Kingdom, Canada, UAE, India, Singapore, Malaysia, China (mainland), Japan, Australia and New Zealand.

> **This is an engineering baseline, not legal advice.** `src/health/regimes.js` records, per country, the public law, the regulator, the national medical
> association/council code, how health data is classed, consent, minors, retention, breach clocks, patient-rights response time, cross-border and telehealth
> rules, so the product *behaves* correctly and *shows* the right notice. The operator must have counsel confirm each country (and any state/province
> rules, e.g. US state laws, Canadian provincial acts, Australian state records acts) before processing real patient data of that country. The
> figures that need confirming first are the retention years, the unfixed ("as soon as practicable") breach clocks, and the UAE/China localisation answers.

## What was missing, and what changed

Existing → gap → change (all additive; nothing converted, narrowed or deleted — see "Data is never deleted" below).

| Concern | Before | Now |
|---|---|---|
| Which country's rules apply | nothing (only a free-text credential jurisdiction) | `set_my_health_region`: the person picks one of the eleven, reads and accepts a versioned notice; append-only history |
| Where data lives | not stated | `get_my_health_privacy` / `list_health_regimes` state where the deployment stores data (`HEALTH_HOSTING_REGIONS`, else guessed from `KMS_REGION`); a patient in a country that allows hosting abroad must **agree to the transfer**; UAE and China (health data must stay in-country) are **refused** unless the deployment is hosted there |
| Sharing with a provider in another country | consent only | `grant_medical_access` needs `cross_border_ack` when the provider's verified registration country differs or is unrecorded; refused outright for in-country regimes; the countries and the acknowledgement are stored on the grant |
| Telehealth | any mode | A patient with a country chosen can book a **remote** visit only with a provider registered in the same country (all eleven require a local licence) |
| Patient rights | access to own records, revoke consent | Rights requests with the country's response time: access, copy, correction, restriction, objection, deletion, accounting of disclosures, withdraw consent, complaint; due date, overdue flag, append-only history, platform-team queue |
| Accounting of disclosures | the audit log existed, not readable by the patient | `list_health_disclosures`: who opened/added/signed/reviewed their data (records, consultations, care plans, results, referrals, fit-to-play, follow-ups, exercise plans **and the event medical log**), when, never the content |
| Right of access / portability | none | `export_my_health_data`: one JSON of everything the patient is entitled to, audit-logged. Runs as a plain patient, so a doctor's own export never contains their patients' data |
| Breach handling | none | Platform-team breach register: each affected country starts a clock for the regulator and for the individuals; notices recorded (case number / text people read) or assessed not required with a reason; cannot close with open notices; affected people see only the notice text |
| UX | two stacked tab bars on Health (merge artefact), no privacy surface | One tab bar, a **Privacy** tab (all roles) with a country hero, rights, requests with countdowns, downloads, disclosures, notices, country rules; platform-team requests queue and breach register |

## Countries at a glance

Retention is the *minimum* the platform treats as the floor; Gotmygame keeps health data longer because it never deletes it. `—` = no fixed legal clock; the platform's own target applies (shown as "our target").

| | Core law | Regulator / medical body | Breach clock (regulator) | Rights answer | Records kept ≥ | Data stays in country? |
|---|---|---|---|---|---|---|
| 🇺🇸 US | HIPAA + state laws | HHS OCR; AMA Code of Medical Ethics | 60 days | 30 days | 10 y (state law) | no (notice) |
| 🇬🇧 UK | UK GDPR, DPA 2018 | ICO; GMC / BMA | 72 h | 30 days | 8 y (adults) | no (transfer notice) |
| 🇨🇦 Canada | PIPEDA + provincial health acts | OPC & provincial; CMA / CMPA | — (72 h target) | 30 days | 10 y | no (notice) |
| 🇦🇪 UAE | ICT Health Law 2/2019, PDPL | MOHAP / DHA / DOH | — (24 h target) | 30 days | 25 y | **yes** |
| 🇮🇳 India | DPDP Act 2023 + Rules, Telemedicine Guidelines | Data Protection Board; NMC / IMA | 72 h | 30 days | 3 y | no (notice) |
| 🇸🇬 Singapore | PDPA, Healthcare Services Act | PDPC / MOH; SMC | 72 h | 30 days | 6 y | no (notice) |
| 🇲🇾 Malaysia | PDPA 2010 (2024 amendments) | PDP Commissioner / MOH; MMC / MMA | 72 h | 21 days | 7 y | no (notice) |
| 🇨🇳 China | PIPL, DSL, medical-records measures | CAC / NHC; CMA | — (24 h target) | 15 days | 15 y outpatient | **yes** |
| 🇯🇵 Japan | APPI (special care-required info) | PPC / MHLW; JMA | 120 h preliminary | 30 days | 5 y | no (consent naming the country) |
| 🇦🇺 Australia | Privacy Act + NDB scheme, state records acts | OAIC; AHPRA / Medical Board | — (72 h target) | 30 days | 7 y | no (APP 8) |
| 🇳🇿 New Zealand | Privacy Act 2020, Health Information Privacy Code | Privacy Commissioner; MCNZ / NZMA | 72 h | 28 days | 10 y | no (IPP 12) |

## How the rules are applied

* **Opt-in per person, no behaviour change otherwise.** A person with no chosen country behaves exactly as before (tested). Choosing one turns on the checks below.
* **Provider country** comes from the provider's current *approved, unexpired* verification case `jurisdiction` (country code or name — `UK`, `India`, `AU-NSW` all resolve). Unrecorded or unsupported = unknown.
* **Grant** (`grant_medical_access`): same country → unchanged. Different/unknown → HTTP 409 `cross_border_ack_required` until the patient sends `cross_border_ack: true`; in-country regimes → 409 `cross_border_blocked`. Stored: `patient_regime`, `provider_regime`, `cross_border_ack_at` on the grant, plus an append-only `health_privacy_events` row.
* **Telehealth** (`book_appointment`, `mode: remote`): known different country, or an in-country regime with an unknown provider country → 400 with the country's licensing rule.
* **Restriction / deletion / withdrawal.** The platform never deletes health data. Fulfilling one of these in the queue **revokes every active grant** (or the named provider's), kept in history, and the answer must say what is retained and why. The patient can also revoke any time under Access.
* **Breach clocks.** `breachClocks()` gives each (country, audience) a `due_at` where law fixes hours, otherwise only the platform's `target_at`. The register shows `overdue_legal`, `overdue_target`, `pending`, `sent`, `not_required`.
* **Event coverage data.** Event medical logs are included in the participant's disclosures and export, and `event_coverage` is a breach scope with an `event_id`. They stay encrypted, audit-logged and under the same retention floor.

## Data is never deleted

Migration `070_health_privacy_compliance.sql` is additive (new tables, nullable columns, one index on `audit_log`). The new tables refuse `DELETE`; the two history tables also refuse `UPDATE`. Changing country keeps every earlier choice. Closing a breach or a request keeps it.

## Capabilities (REST + OpenAPI + MCP)

| Capability | Who | Scope |
|---|---|---|
| `list_health_regimes` | public | read |
| `get_my_health_privacy`, `set_my_health_region` | signed-in | clinical |
| `create_health_privacy_request`, `list_my_health_privacy_requests`, `withdraw_health_privacy_request` | signed-in | clinical |
| `list_health_disclosures`, `export_my_health_data`, `list_my_health_notices` | signed-in | clinical |
| `list_health_privacy_queue`, `resolve_health_privacy_request` | admin | admin |
| `report_health_breach`, `list_health_breaches`, `update_health_breach` | admin | admin |

## Configuration

* `HEALTH_HOSTING_REGIONS` — comma list of countries (codes or names) the deployment stores health data in, e.g. `SG` or `AE,IN`. Unset = guessed from `KMS_REGION` (`ap-southeast-1` → Singapore). This must reflect where the database, backups and media really are.
* Existing: `CLINICAL_JURISDICTIONS` (credential allow-list), `CLINICAL_GRACE_DAYS`, `MFA_ENFORCE` (doctors/physios/admins need two-step verification in production).

## UX (Health → Privacy)

Country hero (law, hosting status, notice version) with *Download my data* and *Who has seen my data*; a country picker showing which countries are stored here, abroad, or unavailable until locally hosted; *Your rights* (what is a legal right in that country vs. discretionary); *My requests* with countdowns and the answer; cross-border shares; breach notices; and the full country rules in plain words. The platform team gets *Requests* and *Breaches* below. The Health banner now links straight to it.

## Not in this change (deliberately)

* **Guardian-filed requests** for minors (guardians can already manage consent under `docs/guardians.md`; filing a rights request on a child's behalf is a follow-up).
* **Automatic regulator filing** — the register records and times notices; a person submits them.
* **Per-state/province rules** (US states, Canadian provinces, Australian states) beyond the national baseline.
* **Sector accreditation** (HIPAA BAAs with vendors, UAE/China hosting contracts, DPIAs) — organisational, not code.
* **Hosting itself.** The product refuses in-country regimes it cannot honour; actually hosting in the UAE or China is an infrastructure decision.
