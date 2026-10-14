# Doctor workspace — how it is used (issue #212)

Everything here is a screen over capabilities that already exist (REST / OpenAPI / MCP); see `docs/health.md` for the rules behind each step.
A doctor needs a **verified doctor credential**, and sees a patient's file only while that patient has **shared full access** (Health → Access).

## Where a doctor finds it
* **Home**: a "Doctor workspace" card appears for anyone acting as a doctor (Me → *Acting as* → Doctor).
* **Me**: "Doctor workspace" button. **Health**: the same card above your verification status.

## Doctor journey
1. **Overview** — verification status; counters for appointment requests, results to review (and how many are past their review date), referrals to answer and patients; today's confirmed consultations (→ *Open patient file*); results that need you.
2. **Patients** — people who shared access. *Full access* opens the file; *clearance only* patients cannot be opened.
3. **Patient file** (tabs):
   * **Encounters** — *New encounter* (SOAP or free text, optional appointment, one measurement with unit, and the plain-language visit summary the patient will read). Save a draft → *Mark ready for review* → *Sign*. Signed is final: *Amend* adds a linked correction, *Void* needs a reason.
   * **Allergies & meds** — per kind: state (*On record* / *None reported* / *Unknown*), entries with source and verification. *Confirm*, *Dispute* or *Correct* a patient-reported entry; *Add* your own. Unknown is never shown as "none".
   * **Care plans** — *New plan* (goal + baseline, instructions, review interval, up to four actions with owner/due date/done-when). The patient sees nothing until *Publish to patient*. Open a plan to see actions' state ("Patient says done" → *Confirm done*), patient notes, *Revise* (new draft), *Pause/Resume/Complete*.
   * **Results** — *Request a test* (records it; does not order from a lab). *Add result* on someone's behalf, then *Review latest result* → *Record: patient informed* → *Close*. A result is "reviewed" only after your explicit review; *History* shows who did what.
   * **Referrals** — *New referral* to a doctor/physio here or an outside provider: you write exactly what is shared; the patient must agree first. *Send for patient consent*, *Withdraw*, *Close*.
   * **Fit to play** — *New decision* (cleared / restricted / not cleared, sport, assessed on, valid until, review by, up to three restrictions, private note). Expired decisions read as *expired*; *Withdraw* with a reason.
4. **Results** tab — the review queue across patients (urgent and overdue first). **Referrals** tab — *Received* (acknowledge, accept, decline, book, complete with a return summary) and *Sent by me*.

## Patient journey (Health → My file, plus My records)
* **My records** — visit summaries of signed encounters, with *Mark as read* (the doctor sees "patient has read it").
* **My file → Care plans** — instructions, goals and tasks; *I did this* / *I couldn't*, and *Tell my doctor about a symptom* (not monitored in real time — said on screen).
* **Tests** — plain status ("waiting for your doctor to review it"), add your own result, history.
* **Allergies & meds** — add what you have/take; *I have no known allergies* is an explicit statement; correct your own entries until a doctor reviews them.
* **Referrals** — see exactly what would be shared; *Agree to share* / *Decline*; *Stop sharing* later.
* **Fit to play** — decisions with validity and restrictions.
