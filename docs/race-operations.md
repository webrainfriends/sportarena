# Mass-participation race & meet operations (issue #487)

Road races, cross-country, cycling and triathlon-style stage events, swimming meets and any other timed event that needs bib/chip numbers, start
waves, checkpoints, split timing and thousands of results. Everything is a capability, so the same operations are REST routes, OpenAPI operations and
MCP tools (tag **Race operations**). In the app it is the **Race day** tab of the event console (`Event → Race day`), a per-race timing desk
(`RaceDesk`) and a public results page (`RaceLive`) for iOS, iPadOS, Android and the web.

## Extension / reuse matrix

A race is **not** a second event platform. It is an existing multi-sport discipline with the extra race-day facts that did not exist before.

| Need | Reused from `main` (not duplicated) | Added by #487 |
|---|---|---|
| Event, organiser, status, crew access | `events`, `eventAccess` / `organizerOnly`, `event_staff` (`invite_event_staff`, `list_event_staff`, `release_event_staff`) | Roles `timekeeper`, `starter` run the desk; `judge`, `referee`, `umpire` are chief officials |
| Race = a timed discipline | `event_disciplines` (`setup_race` creates one or converts an individual discipline), `event_programmes` (created if missing) | `race_setups` marks it, `race_policies` pins versioned rules |
| Athlete identity | `event_participants` (with or without an account), `users`, youth / guardian rules (`YOUTH_SQL`, `hasConsent`, `guardiansOf`) | none: no person data is copied |
| Registration (entry) | `discipline_nominations` is the entry; self-entry reuses guardian consent | `race_entrants` extends the nomination (category, wave, tag state, source, external reference) |
| Entry payment | existing event payment flows | none (entry fees are not re-implemented) |
| Official result | `event_sessions` / `event_session_entries` (the canonical result session, then `finalize_discipline`, points, certificates) | Published results are written to it; derived versions live in `race_results` |
| Provenance & verification (#58) | provenance on every publication (sources, imports, reads, approvals) | `race_publications.provenance`, immutable snapshots |
| Sport rules (#68) | policy is versioned and pinned the same way local rules are | `race_policies` (time basis, duplicate window, tie rule, extra statuses) |
| Disputes / protests | canonical `cases` (`open_case`, `case_events`, `case_messages`) | `race_protests` links the case to the entrant and result version |
| Notifications | `notify` + durable `notify.retry` jobs | wave and correction messages |
| Venues, sports, MCP/OpenAPI | `sports`, `cap()` registry | 56 capabilities |

## What it covers

1. **Entrants.** `import_race_entrants` (JSON or CSV, 5,000 rows per call, dry run first). The registration system's `external_ref` makes imports idempotent: an
   entrant already imported is reported unchanged, never duplicated or overwritten. Rows match existing participants by that reference or an account
   `user_handle`; a name that looks like an existing person is reported as a *possible duplicate* instead of creating a second person (`confirm_distinct`
   overrides). Guests need the policy flag `allow_guests`. `add_race_entrant`, `enter_race` (self-entry, guardian consent for young accounts), `list_race_entrants`
   (bib order, keyset cursor), `get_race_entrant`, `update_race_entrant`. Withdrawal uses the existing `withdraw_nomination`.
2. **Bibs and chips.** A bib is unique within the policy scope (this race or the whole event), a chip is unique across the event. `assign_race_tag`,
   `reissue_race_tag` (lost / damaged / wrong; same-number reprints; `effective_at` for a mid-race swap), `release_race_tag` (lost / damaged without a replacement),
   `auto_assign_race_bibs` (dry run), `import_race_chips`, `get_race_bib_code` (QR payload `SA1:<race>:<bib>`, no personal data) and `find_race_entrant` (bib, chip, QR or name).
   A reissue closes the old tag and opens a new one on the **same entrant**, so it can never create a second entrant or a duplicate result. The first holder of a tag
   holds it from the beginning, so a tag recorded late still explains the reads it made; a re-used reference starts when it is re-assigned.
3. **Waves.** `create_race_wave`, `update_race_wave`, `assign_race_wave` (≤ 500 per call), `auto_assign_race_waves` (seed / category / fill, dry run), `record_wave_gun`.
   Capacity is enforced on the server under a row lock; category-reserved waves refuse other categories; every move closes the old place (history kept), is logged
   and notifies the entrant (and the guardians of a young account holder).
4. **Course and checkpoints.** `create_race_course` (draft), `publish_race_course`, `list_race_courses`: ordered start / split / lap / finish checkpoints with
   distance, which read counts (`first` / `last`) and an optional cutoff. A published version is immutable (database trigger); the next change is a new version, and each
   result and cutoff finding records the version it used. Competition timing metadata only, not navigation.
5. **Timing ingestion.** `create_race_source`, `import_race_reads` (JSON or CSV, 5,000 rows per call in the app; the API accepts up to 20,000), `record_manual_read`. Every raw read
   keeps its source, device, observed time, import time, sequence/reference and raw row, and cannot be edited or deleted (trigger). Re-importing the same file or overlapping
   files stores each read once. A declared clock offset on a source is added when reconciling; the raw time is never changed.
6. **Reconciliation.** `reconcile_race` is deterministic, idempotent and resumable (`after` cursor). Duplicate reads inside the window count once by the checkpoint's read
   rule; a missing read stays missing (never invented); out-of-order, conflicting, negative-time and unattributable reads become exceptions; chips swapped mid-race resolve by the
   time window each was held; a read of a retired chip is flagged, not counted. Gun time, net (chip) time, split and segment times are derived and **never** substituted: if the
   policy clock cannot be computed (e.g. no start read for a net-time race) the result is flagged for an official decision, not silently ranked on the other clock. Each change is
   a new `race_results` version; unchanged results write nothing; after a final publication late evidence opens a review exception instead of rewriting the result.
7. **Race status.** `set_race_status`: DNS, DNF, DQ, cutoff and sport-configured statuses (`extra_statuses`) with a source (official, timing, medical, protest, entrant,
   organiser) and a written reason (encrypted at rest, audit-logged when read). DNS is refused when timing shows the entrant started; DNF needs start evidence; DQ, cutoff
   and reinstatement need a chief official. A governed status is never overridden by a later read (a conflict is raised). `close_out_race` settles everyone still unresolved
   (DNS / DNF) in one governed, dry-run-first step.
8. **Cutoffs.** `list_race_cutoffs`, `review_race_cutoff`. `missed` means a read after the limit; `no_evidence` means the checkpoint was never read and is **not** a confirmed
   failure: confirming it needs an official's own observation. Findings keep the course and policy version.
9. **Corrections and protests.** `propose_race_correction` (manual read, void / restore / link a read, time adjustment or penalty, rank on gun time, status change, accept
   recomputed results), `decide_race_correction` (chief official; a different person from the proposer under the default four-eyes policy), `withdraw_race_correction`,
   `list_race_corrections`. Approving applies it through the same rules as the original action, recomputes that entrant as a **new** result version and notifies them. Protests
   are canonical dispute cases (`file_race_protest` → `open_case`) routed to the race officials; `decide_race_protest` upholds only with an approved correction and resolves
   the case with the reason on its public timeline.
10. **Classifications and awards.** `publish_race_results` computes overall, declared-gender, declared-category and club/team ranks and, for final and corrected
    publications, the awards (`get_race_awards`), from the pinned policy and explicit fields only. Ties share a place by default (`tie_rule: share`) or are separated by the earlier
    finish read (`earlier_crossing`); equal reads stay tied. An entrant with no declared gender is simply absent from a gender classification; a gendered category refuses a
    mismatched or undeclared gender. Nothing is inferred from a name, a photo or a profile. Team scoring (`team_scoring`) sums the best N times and leaves out clubs with fewer
    than N finishers.
11. **Public experience.** `get_race_live`, `search_race_public`, `get_race_public_results` (public, only when the organiser switched the page on). They read the latest
    publication only, labelled provisional / final / corrected with the time it was published; approved splits only when the race publishes them and the result is not flagged
    for review. Names appear only when the race allows names **and** the entrant agreed **and** the entrant is not a young account holder; otherwise a bib only. No contact, medical or
    youth data is ever part of the payload (tested).
12. **Operational dashboard.** `get_race_desk`: readiness (missing bibs, unassigned or lost chips, unplaced entrants), wave capacity and gun status, reads per checkpoint,
    handled duplicate reads, missing reads, the finish queue, open exceptions, DNS/DNF/DQ/cutoff counts, pending cutoff reviews, corrections and protests, publication status,
    whether results are out of date, and a prioritised to-do list.
13. **Scale and resilience.** See below.

## Who can do what

| Role | Can |
|---|---|
| Organiser (and organisation owners/admins) | everything: policy, categories, waves, courses, sources, entrant import, bibs, exports |
| Chief official (accepted crew with role judge / referee / umpire) | approve corrections, DQ, cutoff and reinstatement, review cutoffs, decide protests, publish, close out |
| Timing crew (timekeeper, starter, scorer) | import reads, manual reads, reconcile, assign/reissue tags, DNS / DNF, propose corrections, resolve routine exceptions |
| Entrant (or guardian of a young entrant) | enter, see their own entry, file a protest, search the public page |
| Anyone else | public page only; every other race route answers `404` so ids cannot be probed |

Authorization, validation, encryption and audit are enforced in the capabilities, never only in the screen.

## Files and layouts (offline / file-based workflows)

Timing files and entry lists are plain CSV with a header row (or the same fields as JSON). Importing is idempotent, so a file can be re-sent after a dropped connection, an
organiser can import the same export twice, and late files can arrive at any time (results are marked out of date until the next reconciliation).

* Entrants: `external_ref, full_name, gender, grade, club, user_handle, category, wave, bib, chip, seed_s, name_public, confirm_distinct`
* Chips: `bib, chip`
* Reads: `chip, bib, checkpoint, observed_at, ref, sequence, device` (`observed_at` is an ISO-8601 instant with offset; `ref` is the reader's own record id when it has one)

## Load targets (measured, not promised beyond)

Measured by the PostgreSQL test `a realistic high-volume race` on one node (PostgreSQL 16, sandbox, single API process; numbers vary with hardware):

| Field | Entrants | Reads | Entrant import | Read import | Full reconciliation | Final publish |
|---|---|---|---|---|---|---|
| CI default | 5,000 | 20,000 (4 files) | ~1.6 s | ~2 s | ~1.7 s (5 resumable batches) | ~0.9 s |
| Measured once (`RACE_LOAD_N=25000`) | 25,000 | 100,000 (4 files) | ~10.5 s | ~10.6 s | ~8.2 s | ~3.8 s |

All large operations are set-based SQL in bounded chunks (entrant import 5,000 rows per call, reads 20,000 per call, reconciliation batches of 100–5,000 with a cursor, lists
and exports at most 200 / 5,000 rows per page with keyset cursors). Bulk loads run `ANALYZE` so the next query is planned on real statistics (without it the first reconciliation
of a large race was ~15× slower). **Documented support is up to 25,000 entrants and 100,000 reads per race on a single node; larger fields have not been measured and are not claimed.**
Live results are produced by publishing provisional snapshots; the public page polls (about every 20 s). It is not a streaming service.

## Data safety

Migration `116_race_operations.sql` is additive (new tables, indexes and trigger functions). Raw reads, imports, read marks, policy versions, publications, published results,
awards, status history and the race log are append-only by trigger; result versions can only be marked superseded; published courses are immutable. Nothing is deleted or
rewritten: tags are closed, waves places are ended, results are superseded, voids and links are new marks, corrections are new versions. No `ON DELETE CASCADE`.

## Explicit blockers (not simulated)

* **No timing-hardware or vendor integration is provided or claimed** (MYLAPS, RaceResult, ChronoTrack, Timing-Ninja, reader SDKs, photo-finish systems, GPS trackers). Integrations are
  `file_import` (the layout above) and `manual`. The vendor or device name on a source is only a label. A tested adapter is required before any vendor is named as supported.
* No live push from readers: files or exports are imported; the public page polls.
* Entry fees are not collected here; use the event's existing payment flows.
* Relay legs and rolling/individual-pursuit starts are not modelled; a wave has one gun time.
* A checkpoint code is read once per entrant; multi-lap events define each lap as its own checkpoint.
