# Sport Integrity & Anti-Doping Administration (#489)

A tightly controlled administrative domain for governing bodies. SportArena is **not** a laboratory, a medical record or an investigator. It never infers a violation, interprets a result, scores a person, decides guilt or sanction severity, or advises on testing. A referral, an allegation or a pending test is never presented as a finding.

One home: the **Integrity** tab of Federation Home (visible only to the body's integrity officers and owners/admins). The person concerned uses **My integrity** (More wheel) and the case screen. Nothing was added next to the federation console; the existing Federation Home, role model, evidence conventions, eligibility check (#477) and generic notifications are reused.

## Who may see what (legal / privacy / source-of-truth matrix)

| Information | Source of truth | Integrity officer / owner-admin | Case panel / reviewer (that one case) | Person concerned (or verified guardian) | Everyone else (platform admin, coach, sponsor, media, club, other bodies, ancestors) |
|---|---|---|---|---|---|
| Case, summary, history | SportArena (`int_cases`, append-only `int_events`) | full, audited | full / read-only, audited | status, deadlines, decisions as recorded, own responses; **not** the summary or internal detail | 404 |
| Testing reference (code, authority, time, context, status, result category) | The authoritative anti-doping organisation. Stored encrypted, exactly as supplied | full, audited | none | none (a case never exposes it to them) | 404 |
| Custody handoffs | The source. Append-only, with the source's identifier; SportArena is not the chain-of-custody authority | full | none | none | 404 |
| Therapeutic-use exemption (reference, authority, status, validity, scope, last verified) | The issuing authority. Minimum projection only | full, audited | none | own status and validity, not the reference | 404 |
| Diagnosis, medication, rationale, clinical papers, analytical values | Health or the external authority | **not stored** (no column exists; unknown fields are rejected) | – | – | – |
| Decision (reference, authority, outcome, dates) | The deciding body / panel | full | full / read-only | as recorded | 404 |
| Active sporting sanction | Integrity decision, read live by eligibility | yes | yes | yes | only "Suspended until <date>" in competition eligibility, no case, category or source |
| Appeal grounds / ruling | SportArena | full | full | own | 404 |
| Education completion | SportArena (links an existing programme) | counts and who is outstanding, no score | – | own | 404 |
| Declarations (conflict / betting interest) | The declarant | full, audited, hidden after the retention date | – | own | 404 |

## Rules the server enforces

- **Access** is read live on every call. Officers hold the `integrity` body role (or own/admin the body's organisation). A platform admin has no standing here. A panel member or reviewer is granted one case, revocable at once. The person concerned cannot sit on their own case.
- **Tokens**: every integrity capability is pinned to the `admin` scope, which only platform admins can mint, so no API or agent token reaches integrity. Only a signed-in session does (REST, OpenAPI and MCP behave identically, 404 for outsiders).
- **References are administrative.** Entered by hand they stay `unverified` until a *second* officer confirms them. Replays of the same source record are idempotent (blind-indexed identity); changed content is a new revision that supersedes the old; tombstones keep the record. Signed automatic ingestion is **blocked** until the data-exchange layer (#483) and an agreement with the authority exist, and the UI says so.
- **Lifecycle** engine is fixed (received, under review, response due, decision pending, decided, closed, suspended, deferred, withdrawn); the body sets deadlines and the names of the states per category.
- **Decisions** are recorded by a person with the exact reference and source. Amendments, appeal outcomes and reversals are new rows that supersede; nothing is rewritten or deleted (database triggers refuse deletes).
- **Sporting sanction handoff.** Competition eligibility asks `activeSportingSanction()` (src/integrity.js) and shows only "Suspended until". Amendment, reversal or an overturned appeal lifts it with nothing to clean up. The suspension rules themselves are not duplicated here.
- **Appeals** are lodged by the person concerned or their guardian, reviewed by someone who did not make the original decision; upheld / dismissed / reduced / overturned / remitted. No AI path exists.
- **Notices** are generic ("Update on a governance matter", no category, no person, no substance) to the person and, for a young person, their verified guardians. No integrity detail reaches a push preview.
- **Declarations** exist only where the body defines a betting/conflict category; they carry a purpose and a retention date, and past it the content is no longer shown.
- **Reporting** is counts of work (open cases, overdue steps, references awaiting second review, sanction handoff state, education currency, open appeals). No ranking and no risk score.
- **Out of scope and absent**: test-evasion guidance, substance advice, diagnosis, autonomous sanctioning, whereabouts tracking, bulk export.

## Capabilities (REST + OpenAPI + MCP from one definition, `apps/api/src/capabilities/integrity-*.js`)

Categories, sources, cases (open / list / get / transition / respond), case access, testing references (record / list / custody), exemptions (record / list), review and tombstone, decisions, appeals (lodge / rule), education (save / assign / complete / list), declarations (submit / withdraw / list), my integrity, report.

## Honest gaps

- **Disciplinary domain (#479) is not built yet.** Until it exists, the sporting sanction lives in the integrity decision and is consumed live by eligibility; when #479 lands, point `activeSportingSanction()` at its sanction table. The handoff acceptance criterion is therefore only met against the eligibility consumer.
- **Federation data exchange (#483) is not built**, and no anti-doping organisation feed, credentials or agreement exist. Nothing is simulated.
- Appeals run in the integrity workflow, not in the generic support-case queue, so the platform support team never sees an integrity matter. Appeal windows are not enforced because no policy defines one yet.
- Tested on the web build at phone, tablet and desktop widths; not run on a physical iOS, iPadOS or Android device.
