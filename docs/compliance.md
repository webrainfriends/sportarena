# Compliance, policy & evidence engine (#568)

One reusable engine judges **procurement, event permits, federation eligibility, accreditation, youth safeguarding and privacy** rules.
Rules are data, never code in a module. A jurisdiction pack is a set of rules, so a new country needs no code fork. First designed for
India, USA, Canada, Singapore, Malaysia, Sri Lanka, Australia and the UK; any ISO country works the same way.

It is a checklist of what the rules ask and what a person has verified. It is **not legal advice** and never asserts legal compliance.

## Reuse, no duplicates
| Need | Where it already lives | What the engine does |
|---|---|---|
| Federation rules (#68 / #475) | Federation console (`fed_policies`, versioned, effective-dated) | Reads them as *federation mandated* rules (`registration` → guardian consent under 18, `competition_entry` → licensed players). Not authored a second time. |
| Eligibility (#477) | `registration.js` match-day decision | Adds the engine's rules as extra checks (`policy:<key>`); no rule written = no change. |
| Procurement (#460) | Tender zone | `recommend_tender_award` is gated for the tender and every supplier in the scenario. Supplier credentials are read live as evidence. |
| Accreditation (#481) | `accreditation.js` | `approveRow` is gated; an automatic approval that the rules stop waits as *submitted*. |
| Event permits | Event | Opening a draft and starting an event are gated. |
| Licences, guardian consent | Federation licences, `youth.js` | Read live as evidence, never copied. |
| Audit | `audit_log`, encryption in `crypto.js` | Reused. Reference numbers and reasons are encrypted; DOB reads are logged and only the age is kept. |

## Model
* `cmp_rules` (stable key, domains, topic) → immutable `cmp_rule_versions` (classification, country / state / municipality, applicability
  by federation, competition, organisation, venue, event type, sport, role, age; effective-from / to; source; approval owner; evidence
  requirements; waivable). Draft → approved or withdrawn; nothing is edited or deleted (database triggers). A *repeal* ends a rule.
* Classifications: legal mandatory, regulatory, federation mandated, contractual, organisation policy, recommended standard.
  Platform admin writes laws, regulations and recommended standards (a law needs a second approver); an organisation owner/admin writes its policies and contracts;
  laws and regulations can never be waivable.
* `cmp_evidence` (permit, licence, declaration, certificate, training, insurance, background check, signed document, approval), filed for a
  person, organisation, event, venue, tender or supplier. Filed for an event: its organiser reviews it and it counts there. Without an event: the platform team reviews it, it counts everywhere.
  Nobody reviews their own filing. Only a declaration (the holder's own statement) counts without review. An upload is never proof.
* `cmp_exceptions`: a named person waives one waivable rule for one holder, up to a year, with a reason; revocable; never for yourself.
* `cmp_decisions` (append-only): facts and their sources, every rule with its exact version and per-requirement result, evidence and exceptions used, trigger, actor, time. Blocked attempts are recorded too.

## Precedence and effective dates
1. Per rule, the highest **approved** version whose window contains the as-of date is used (as-of defaults to the event / tender start, else today). Past dates give the text of that time; history is kept.
2. A rule applies when every dimension it names matches. A dimension the facts cannot answer makes it **unknown**, never silently "does not apply".
3. Rules of the same **topic** compete: higher classification, then narrower jurisdiction, then more specific applicability, then later effective date, then higher version. Rules of different topics add up. A higher-ranked unknown rule is never skipped.
4. Result per rule: applies / does not apply / unknown / exception required, with status compliant, expiring, pending, missing, exception or non-compliant.
5. A gate stops on missing, pending, non-compliant or unknown for any rule except recommended standards. No rule in force = no effect.

## AI
`explain_compliance` builds the explanation from the engine's result; an optional AI step may reword it, never decides, receives no names, and the text always says a human reviewer decides.

## Surfaces
REST + OpenAPI + MCP from `capabilities/compliance-*.js` (catalogue, rules, versions, packs, evidence, review queue, exceptions, evaluate, explain, event dashboard, decisions).
App (iOS, iPadOS, Android, web): event console → **Compliance** tab (dashboard, review queue, audit trail) and **More → Compliance** (rules in force, rule wizard, my evidence).

## Not covered
No jurisdiction pack content ships: rules are written and approved by people. Evidence holds a link or note rather than an uploaded file.
