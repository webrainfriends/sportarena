# Universal registration engine (#575)

One framework for athlete, team, event, competition, membership, course/camp and federation-licence registration.
Code: `apps/api/src/registration-engine.js` (pure rules), `apps/api/src/capabilities/registration-engine.js` (capabilities + file routes),
`apps/api/src/registration-money.js` (instalment payment hook), migration `129_registration_engine.sql`, app screens `screens/registration*.js`.

## Model
- **Programme** (`rx_programmes`): what people register for. `kind` is one of seven; owned by a person, an organisation or an event. Capacity, per-answer quotas,
  waiting list, approval on/off, dependents on/off, deadline window, currency.
- **Version** (`rx_versions`, append-only): form (the platform's question model from `application-forms.js`, minus sponsorship-only budget/references), fee schedule, waivers.
- **Entry** (`rx_entries`): one registration under the version it was filled under. Participant (a dependent when a guardian registers a child) and/or team.
- Satellites: `rx_history` (append-only), `rx_signatures` (append-only), `rx_documents` (hidden, never deleted), `rx_changes`, `rx_instalments`, `rx_discount_uses`.

## Rules (all server-side)
- One live entry per person (or team) per programme; idempotent submit (`idempotency_key`); optimistic `row_version`.
- Seats are held from submission; full programmes waitlist (or refuse when there is no waiting list); freed seats go to the oldest waiting entry that fits its quota.
- Young participants need current guardian consent; guardian-required waivers must be signed by a verified guardian. Signatures record the text hash.
- Fees are quoted once at submission; instalments exist only while an entry holds a seat and are paid through canonical finance (`payments.purpose_type = registration_instalment`, module `registration`).
- Competition programmes: approval re-runs the #477 eligibility decision (registration/roster-list checks excluded, the entry is the registration); a blocking policy refuses with `not_eligible`.
- Confidential answers and change/decision notes are encrypted; staff reads of confidential answers and files, exports and uploads are audit-logged. Outsiders get 404.

## Scenarios covered by tests (`test/registration-engine.test.js`)
Course/camp (quota, waitlist, discount, instalments, payment), membership for a child (guardian waiver, consent revocation hides the child), competition (eligibility gate),
team entry (no approval, no waiting list), licence (uploads, send-back, resubmit, decline).

## Consolidation
Reused: question model + builder (`DefinitionEditor`, `Question` exported from the sponsorship screens), guardian/consent (`youth.js`), payments/finance, encrypted file store, #477 eligibility.
Entry point from the event console's registration tab goes to the engine. Not yet migrated (separate, data-touching steps): #477 roster registrations, academy admissions, sponsorship applications.
