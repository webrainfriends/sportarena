# Para-sport classification & eligibility (#488)

A competition class is an **administrative sporting classification, not a medical diagnosis**. SportArena holds the minimum a competition needs
(class, status, dates, issuing authority, decision reference, rules version) and keeps the workflow and any supporting evidence apart from it.
Clinical records and diagnosis stay in Health or approved external systems; nothing here duplicates them (the `para_*` tables have no
diagnosis, impairment, medication or treatment columns, and a test asserts it).

## Source-of-truth and privacy matrix

| Data | Source of truth | Stored in | Who can read it |
|---|---|---|---|
| Class definitions (codes, rules, panel size, review rule, appeal window) | The governing body's own document, cited in `source_ref` | `para_class_versions`, `para_classes` (immutable once published) | Everyone (published); the body's governance staff also see drafts |
| Classifier credential (scope, classes, grade, validity) | The issuing governing body | `para_classifiers` (credential number encrypted) | The classifier, the body's governance staff |
| Case workflow (stage, appointment, panel, history) | Authority + assigned classifiers | `para_cases`, `para_case_panel`, `para_history` | Athlete / verified guardian, assigned live classifiers, the body's governance staff (workflow only) |
| Requester note, supporting evidence, review grounds | The athlete / guardian / external authority | `para_cases.note_enc`, `para_evidence`, `para_appeals.grounds_enc` (AES-256-GCM, context-bound) | Athlete / verified guardian and assigned live panel / reviewer **only**. Every read is audit-logged. Never body staff, coaches, organisers, sponsors, media, referees, doctors or administrators |
| Competition-facing outcome | The authorised classifier decision | `para_outcomes` (immutable; superseded, never edited) | Athlete / guardian, issuing body's staff; competitions consume it through eligibility |
| External authority reference | The external authority (stable ID, provenance) | `para_external_refs` (ID encrypted + blind-indexed) | The body's governance staff; the athlete sees it |
| Eligibility snapshot | Derived at lock time | `reg_snapshots.checks[].source` (class, status, version, decision ref) | Event staff (existing rules) |

Youth: a verified guardian acts for the young athlete; a current `medical` guardian consent is required before a case or evidence exists and
is re-checked on each new evidence item.

## Rules the code enforces

- **Only a live credential decides.** `liveClassifier()` reads `para_classifiers` on every decision (status, validity dates, sport/discipline, class scope,
  body still governs the sport) inside the deciding transaction. Coach, doctor, referee, administrator or a clinical credential never substitutes.
- **Panel.** The published version sets how many independent decisions are needed; members cannot see each other's decision before issue; only the lead issues; disagreement blocks.
- **Immutable history.** Published versions, outcomes and `para_history` cannot be edited or deleted (database triggers). A new decision supersedes the live outcome
  prospectively; `outcomeAt()` reproduces what was in force at any instant.
- **Review / protest / appeal.** Deadline from the version, one open request per decision, independent reviewer (not on the original panel), upholding issues a new outcome.
- **Eligibility.** `registration.js` adds a live `classification` check. With `classification_mode: governed` only the authorised outcome counts; an organiser cannot type an athlete into a class.
  `external_reference` (default, keeps existing set-ups working) also accepts a second-officer-verified external reference, then the manual audited dependency. `allowed_classes` restricts the competition's classes.
  `lockFixtureEligibility` stores the outcome id, class, status, version and decision reference in the snapshot.
- **External references** are matched by the authority's stable ID (blind index), never by name; a different athlete for the same ID is a conflict; they stay unverified until a second officer verifies.
- **AI boundary.** No capability calls a model. `copilots.js` already refuses classification text; AI may not infer a class, a disability or eligibility, or read evidence.
- **API tokens.** Evidence/case/outcome/appeal capabilities are `clinical`-scoped; governance and external references are `admin`-scoped.

## Sport coverage

Para classification is **governed per sport by the governing body's published definition**. `GET /para/coverage` (`para_sport_coverage`) walks the whole sports catalogue:
a sport with a published version is `governed`; every other sport is labelled **gap** ("No governing definition published — classification unavailable") and no case can be opened for it.
No definitions are seeded or invented: each body transcribes its own rules (with the source cited). Sport families therefore each use their own governing rulebook rather than a generic default.

## Open blockers

- **#483 governed data exchange is not built.** External classifications are *reference-only*: recorded with stable ID and provenance, verified by a second officer.
  Signed/automatic ingestion and reconciliation feeds remain open until #483 lands.
- Native iOS/Android device runs were not performed (web, iOS and Android bundles export successfully; UX was verified on the web build at phone, tablet and desktop widths).
- Translations: the section and status vocabulary is translated for the 11 language packs (`reviewed: false`); longer explanatory strings fall back to English until a native speaker signs them off.
