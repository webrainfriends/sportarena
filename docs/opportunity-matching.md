# Explainable opportunity matching (issue #316, part of #310)

A player (or a guardian for a young player) sees open **team posts, events and trials, study programmes and sponsorship calls**
compared with their sport card, recruitment preferences, availability windows and budget. Each result explains itself, rule by rule.
Nothing is stored: matches are computed live from the existing sources, so revoked consent, removed availability or an archived card take
effect on the next call.

## Rules (`apps/api/src/opportunity-match.js`, pure and deterministic)
Each rule returns `match`, `mismatch` or `unknown` (or `na` when it does not apply and is left out). **Unknown is never counted as a match
or a mismatch**; it is listed under `missing` with who can add it (`player` or `organiser`) and where in the app.

| Dimension | Compares | Notes |
|---|---|---|
| sport (eligibility) | the opportunity's sport with the player's cards / preference sports | candidates are only read for sports you play or prefer |
| position | post `positions[]` with card `position` + `positions[]` | team openings only; case-insensitive |
| level | `levels[]` (beginner, amateur, semi_pro, pro) with the card level | all but sponsor calls |
| region | listing region (post region/city, event region/city, institution city + country) with the card region + preference regions | tokens split on `, / ;`; "open to relocation" turns a mismatch into a match. A sponsor program's regions are a hard rule when the player's region is known (as in `assertCanApply`) |
| availability | the start date (post, event, intake) with the player's non-removed windows (`trial`/`visit`/`start`, weekdays) | trial events need a trial window; study uses start/visit; sponsor calls have a deadline instead |
| cost | event entry fee / programme fee with the player's budget | same currency only, **never converted**; an unstated programme fee is unknown, not free; team posts and sponsor calls cost the player nothing |
| eligibility | age band (`min_age`/`max_age`) with the player's age, registration deadline, and for sponsor calls: athlete targets, verified-only, minors not accepted | any failing eligibility rule makes the result `ineligible` |

`score` = weight of matched rules / weight of known rules (sport 3, eligibility 3, position 2, level 2, region 1.5, availability 1.5, cost 1);
`null` when nothing could be checked. `fit` is `strong` (>=75), `possible` (>=50), `weak`, `unknown` or `ineligible`.
Order: fit group, score, soonest date, id. Each kind reads its newest 200 candidates; `pool_full` lists kinds that hit the cap.

## Endpoints (REST + OpenAPI + MCP, tag `Opportunities`; all read scope)
- `GET /me/opportunity-matches` `kinds=team_opening,competition,study,sponsor` `sport_profile_id` `on_behalf_of` `include_ineligible` `limit/offset`
  -> `{ subject_id, total, hidden_ineligible, profile_gaps[], gaps[], pool_full[], items[] }`
- `GET /me/opportunity-matches/{kind}/{id}` -> one full explanation (`rules[]`, `missing[]`)
- `GET /me/opportunity-matches/export` -> `{ filename, rows, csv }`, audit-logged (`export_opportunity_matches`)

## Privacy, youth and consent
- Matches are private to the player; no passport/recruiter section or notification carries them.
- `on_behalf_of` needs a verified guardian link (`requireGuardian`). For a young player the API checks current `recruitment_sharing` consent
  on **every** call, including detail and export; otherwise `409 guardian_consent_required`. Sponsor calls refuse minor athletes.
- A guardian reading a child's date of birth for the age rule is audit-logged (`read_dob_for_matching`). Invitation-only sponsor calls appear only for invitees.

## Schema (`migrations/106_opportunity_matching.sql`, additive; rollback = leave the unused columns)
- `billboard_posts`: `positions text[]`, `levels text[]`, `region`, `min_age`, `max_age`
- `events`: `levels text[]`, `region`, `min_age`, `max_age`
- `programmes`: `levels text[]`, `min_age`, `max_age`
- `recruitment_preferences`: `budget_cents`, `budget_currency` (kept when left out of `POST /me/recruitment-preferences`, cleared with null)
Existing rows keep empty values, which the matcher reports as missing data (organiser side).

## Where the data is entered (existing forms, extended)
Billboard post form and event creation (positions, levels, region, age), programme form in admissions (levels, age), "What I'm looking for"
(budget). The player screen is **Opportunities for me** (More wheel, athlete quick actions, and a guardian's family page).
