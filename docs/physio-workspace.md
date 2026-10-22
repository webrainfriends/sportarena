# Physio workspace — tracking, reports and suggestions

The physio's counterpart of the coach's performance studio. It sits on the existing treatment plans, exercise library and encounters; nothing is duplicated.
A physio needs a **verified physio credential** and sees a patient only while that patient has **shared full access** (Health → Access). The patient always keeps their own data, even after withdrawing access.

## Where it lives
Health → *Practice* (any account acting as physio or doctor). Tabs: **Overview · Patients · Plans · Exercises · Insights · Services · Offers · Packages · Tax & revenue · Insurance · Compliance**. Patients see their side under Health → *My rehab*.

## The patient file (Patients → a patient)
| Tab | What it does | Capabilities |
| --- | --- | --- |
| **Sessions** | Session notes. These are the same signed *encounters* the doctor workspace uses (draft → ready → signed, amendments, void with a reason, patient-readable visit summary); physios now author them under their own credential. | `create_encounter`, `update_encounter`, `sign_encounter`, `amend_encounter`, `void_encounter`, `list_encounters` |
| **Progress** | Measured readings over time: pain (0–10), range of motion (°), strength (kg), function score (%), single-leg balance (s), swelling (cm). Joint measures need a body region. Each series shows baseline, latest, change and a trend. A wrong reading is *voided with a reason*, never edited or deleted. | `record_physio_outcome`, `void_physio_outcome`, `get_patient_progress` |
| **Goals** | Plain or measured rehab goals (baseline → target, optional date, optional plan). Progress is computed from the readings recorded afterwards. Close as achieved / not met / stopped; closed goals stay as a record. Unshared goals stay with the clinician. | `create_physio_goal`, `update_physio_goal`, `list_physio_goals` |
| **Home exercise** | The patient's own log against the published plan (done / partly / skipped, optional pain and effort). Adherence = days done (+ half for partial) against the days a week the plan asks for. Not monitored live, and the patient is told so. | `log_plan_adherence` (patient), `get_plan_adherence` |
| **Reports** | A draft (period, plan, audience *only me* or *the patient too*, your own narrative). *Preview* shows what would be frozen; *Publish* issues the next immutable, numbered version built on the server from the live records (sessions, outcome changes, goals, adherence). A patient-audience report notifies the patient, who can mark it read. Later changes make a new version; old versions stay readable. | `save_physio_report`, `preview_physio_report`, `publish_physio_report`, `list_physio_reports`, `get_physio_report`, `my_physio_reports`, `mark_physio_report_read` |

## Overview, suggestions and insights
* **Overview** (`get_physio_home`): appointments waiting for you and the next seven days (flagging visits with no note yet), patients / active plans / open goals, compliance, and the most urgent suggestions. If your verification lapses the clinical parts are left out and the screen says why.
* **Suggestions** (`get_physio_suggestions`, `snooze_physio_suggestion`): deterministic prompts with their reasons, built only from your own records for patients who currently share their file. No model, nothing automatic, not clinical advice. Rules: plan review due/overdue · plan not yet read · no home exercise logged / under half of plan · pain reported ≥ 7/10 after home exercise · pain up ≥ 2 points or flat over three readings · goal due soon / overdue / apparently met · all goals achieved · session note missing or left unsigned · no outcome measured for 28 days · no progress report for 30 days. *Not now* hides one for 1–90 days (rows are only ever added).
* **Insights** (`physio_analytics`): visits, patients seen / new / returning, cancellations, session-note completion, plans by status, average home-exercise adherence, outcome change per measure (first vs last reading in the period, patients with two or more readings), goals closed and achieved, reports sent and read. Revenue stays in *Tax & revenue* (`/me/practice-report`).

## Patient side (Health → My rehab → My progress)
Goals the clinician shared (with progress), the patient's readings over time (no clinician notes), a one-tap *Log today's exercises* (also inside each plan), and the reports shared with them.

## Rules that apply to everything here
* Every clinical read/write needs a current verified credential **and** the patient's active full consent, re-checked inside the writing transaction (a withdrawal that commits first blocks the write). Reads and writes are audit-logged.
* Free text (notes, goal titles, closing notes, narratives, report snapshots, adherence notes) is encrypted at rest.
* Nothing is deleted: readings are voided, goals closed, adherence entries appended, report versions immutable (enforced by a database trigger).
* Migration `086_physio_tracking.sql` is additive only.
