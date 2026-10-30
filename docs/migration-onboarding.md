# Migration and guided onboarding (#514)

Two things that make it quick to start on Gotmygame: **bring your people across** from TeamSnap, SportsEngine or a spreadsheet, and a **guided setup** per persona that walks an empty account to a first live transaction.

Both are API-first: every action is a capability (REST + OpenAPI + MCP from one definition) and the app only calls it. The same flow works on iOS, iPadOS, Android and web.

## Bring your people across

One shared path for every source, owners and admins of the organisation only:

`upload → map columns → dry run → review conflicts → approve → import in batches → reconcile → (governed) rollback`

| Capability | What it does |
|---|---|
| `list_migration_sources` | Sources, the importable domain, the fields a column can map to, date formats, and what is never imported |
| `get_migration_template` | A header-only CSV for TeamSnap, SportsEngine or Excel |
| `PUT /migrations/extract` | Reads a CSV, TSV, Excel (.xlsx) or Word table in memory (never stored, no AI) and returns CSV text |
| `create_migration` | Stores the rows encrypted and proposes the column mapping. Writes nothing else |
| `update_migration_mapping` | Changes columns, date format, default role or team, or the sport for new teams. Sends the import back to be checked again |
| `check_migration` | The dry run: valid, warnings, rejected, duplicates, identity conflicts, teams that would be created |
| `list_migration_rows` | Rows with outcome and reasons (names visible to owners/admins and audit-logged, emails masked) |
| `review_migration_row` | Settles an identity conflict: *same person* or *skip* |
| `approve_migration` | Refused while rows are unchecked, a conflict is unreviewed, or nothing is importable |
| `run_migration` | Imports in batches of 100, each its own transaction. Safe to repeat |
| `get_migration_report` | Row-level reconciliation: created, linked, skipped, failed, waiting, unresolved |
| `rollback_migration` | Withdraws what is still untouched; keeps anything a person has accepted |

### Rules the server enforces

* **A person is matched on email only.** Names never match, merge or create anyone. Rows with no usable email are rejected.
* **Identity conflicts are explicit.** An email that already belongs to an account with a different first name, or that appears twice in a file with different names, is a conflict. Approval is blocked until a person confirms or skips each one.
* **Date formats are chosen, never guessed.** `04/05/2012` means different days in different countries, so the file's format is a setting, and an unreadable date rejects the row.
* **Young people are never fabricated.** A person under 18 needs a guardian email. An import never creates a guardian link or a consent. The stricter of the file and the account applies: a row that says under 18 for an account with no date of birth waits (`awaiting_consent`) until the account carries a date of birth and a guardian has consented.
* **People are invited, not added.** Everyone is invited to their team and accepts. People not on the platform yet are invited when they register with the same email (the invitation appears under their team invitations).
* **Idempotent and resumable.** One live link per organisation, domain and person-and-team key. Uploading the same file again, retrying, or resuming after an interruption never invites anyone twice. Finished rows are never repeated; rows waiting on a sign-up, consent or a failed attempt are retried on the next run.
* **Rollback never destroys history.** Unanswered invitations are withdrawn (status `left`), teams the import created that have no people or games are archived. Anyone who accepted, and any team in use, is kept and reported. Rows are kept; links are released so a corrected file can be imported.
* **Personal data is encrypted.** Each row is stored as one encrypted blob; only the blind-indexed email is searchable. Reading rows and reports is audit-logged. Reports mask emails.
* **Nothing is deleted.** The migration adds tables only, with no `ON DELETE CASCADE`.

### Sources and column names

TeamSnap and SportsEngine are matched by the column names their exports usually use. These are a starting point, not a promise: the person confirms the mapping on the *Columns* step and can point any column at any field. Excel and Google Sheets use our template or any sheet with a header row.

### Importable today, and what is not

| Domain | Status |
|---|---|
| People and team rosters (people, teams, staff roles, jersey numbers, guardian emails) | **Built** (this change) |
| Programmes, cohorts and enrolments | Not on this framework yet. Existing `preview_bulk_enrolment` / `commit_bulk_enrolment` stay the path until a domain is added |
| Fees and opening balances | Not built |
| Venues, resources, hours and rates | Not built |
| Memberships and packages | Not built |
| Event participants and teams | Not built |
| Supplier and customer directories | Not built |
| Clinical records, credentials, payments, legally significant contracts, guardian links and consents | **Never** through generic mapping |

### Inventory of existing imports

`target entity → existing import path → supported format → validation / idempotency → gap → reusable extension`

| Target | Existing path | Format | Validation and idempotency | Gap | Extension |
|---|---|---|---|---|---|
| A player's match history | `import_matches` (`/me/matches/import`) and `PUT /me/matches/extract` | CSV/JSON text; extract reads CSV, TSV, Excel, Word, PDF, photo (AI for the last two) | `dry_run`; all-or-nothing; skips date + opponent + competition already logged | Personal, not organisational; no mapping step | Excel/CSV reading is now `tableFileToCsv` in `match-file.js`, shared with migrations |
| Cohort enrolments | `preview_bulk_enrolment` / `commit_bulk_enrolment` | CSV text (handle or email, consent) | Preview; all-or-nothing; skips already enrolled; registered people and guardian consent only | No mapping, no Excel, no reconciliation report | A future domain on the migration framework |
| Race entrants, chips and reads | `/races/:id/(entrants\|chips\|reads)/import` | CSV | Race-specific | Event-day timing data, not onboarding | Left as is |
| Commercial price book | `commercial_admin_import` | CSV | Platform admin only | Platform data | Left as is |
| Calendar events | `add_calendar_import` | ICS feed | Sync, not migration | Busy time, not entities | Left as is |

## Guided setup

`get_launch_checklist` returns the ordered steps for a persona and `set_launch_persona` stores which persona you chose and whether the Home card is hidden. Progress is **never stored**: every step is derived from the real records (organisation details, members, teams, programmes, seasons, imports, venues, courts, hours, rates, bookings, events, fixtures), so it cannot disagree with them and nothing is ticked by hand. Steps point at the screen that does the work; the checklist creates nothing.

| Persona | Steps |
|---|---|
| Academy | workspace → legal name and tax number → contact → staff → first programme → season → **bring your people across** → first fee |
| Club, school or college | workspace → legal name and tax number → contact → staff → first team → season → **bring your people across** → first event |
| Venue | venue → courts → opening hours → hourly rates → first booking |
| Event organiser | event → open for entries → first games scheduled |
| Coach | coach profile → team → invite players |

Not yet covered: payment-provider configuration and notification-channel steps, because there is no per-organisation record for them to derive from.

## In the app

* **Home** shows a *Get set up* card (until finished or hidden) that opens the next step.
* **Get set up** (`Setup`) is the full checklist, with a persona picker and, for organisation personas, an organisation picker.
* **Import people** (`Migrate`) is the importer. It opens from the checklist and from the organisation's *People* tab.

## Sports

Roster import is sport-agnostic: people, teams and roles do not depend on a sport's scoring model. A sport is chosen only when the file names teams that do not exist yet, and any sport in the catalogue is accepted.
