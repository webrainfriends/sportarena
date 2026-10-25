# Sports opportunity marketplace (issue #67)

Trials, paid assignments, volunteering and sponsor calls are **Billboard posts** (`billboard_posts`); applications are the existing recruitment pipeline (`billboard_responses`, stages applied → shortlisted → trial → evaluated → offered → accepted/declined/withdrawn). Nothing parallel was added: no new user, event, payment, verification or case model.

## What a post states
| Field | Meaning |
|---|---|
| `kind` | `match_players`, `team_recruiting`, `coach_wanted`, **`assignment`** (new: scorer, official, volunteer, physio…), `sponsorship_wanted`, `sponsor_call` |
| `opportunity_type` | `trial`, `paid_assignment`, `volunteering`, `sponsorship`, `team_role` (defaults from `kind`) |
| `compensation` | `paid`, `unpaid`, `expenses`, `in_kind`; empty = "Pay not stated" (shown as such) |
| `budget_cents` + `currency` | amount in minor units and its currency (legacy budgets were back-filled to INR) |
| `closes_at` / `starts_at` / `ends_at` | application deadline and the work window |
| `target_type/target_id/target_role` | optional event or game the work is for, and the role (`volunteer`, `referee`, `umpire`, `linesman`, `scorer`, `physio`; managing roles are refused) |
| `required_sections` | passport sections every applicant must share (`video`, `references`, `preferences`, `availability`, `academic`) |
| `verified_applicants_only` | only holders of a current verified badge may apply |

Rules (server side, `src/opportunity.js`): paid work needs an amount and, for a paid assignment, a paying team; unpaid/volunteering carries no amount; sponsorship kinds use the sponsorship type; the event/game must be managed by the poster.

## Applying, evidence, selection
* `respond_to_post` rejects closed, filled and expired posts (`opportunity_closed`, `positions_filled`), missing required sections (`evidence_required`), unverified applicants on verified-only posts (403) and missing role profiles.
* The applicant chooses `shared_sections`; selectors read only those through the existing passport gate (`get_recruitment_application`, audit-logged `read_recruitment_evidence`). `set_application_sharing` changes it while the application is open (never below what the post requires); every change is a history event.
* Accepting (direct `decide_response` or an offer) creates the **canonical engagement**: roster member (`team_members`, engagement type `team_member`), event/game role (`associations`, type `association`) and, for fixed-fee paid assignments, one `team_payouts` row (status `due`) referenced from `billboard_responses.payout_id`. Roster rates stay on `team_members` and flow into the existing fee generation. Everything is recorded as an `engagement` history event; parties are notified by the existing notifications.

## Trust and matching
* Publisher verification: `publisher_verified` / `publisher_badges` on every listed post, filter `verified_publisher`.
* Fraud reporting: an ordinary support case (`open_case`, category `marketplace_report`, link type `billboard_post`).
* Matching (`match_my_opportunities`) includes assignments, skips expired posts, applies verified-only, and returns `compensation` and `pay`.

## Migration and rollback
`108_opportunity_marketplace.sql` is additive: new nullable/defaulted columns, new CHECKs existing rows satisfy, widened (never narrowed) CHECK lists, idempotent back-fills. Rollback: stop using the new columns; nothing was renamed or dropped.

## Operations and limits
* Expiry is evaluated on read/apply (no job): an expired post keeps `status='open'` with `is_expired=true`.
* Sponsor-call acceptance links an event/game role only; funding itself stays in the sponsorship models.
* A paid assignment records the payment as *due* in the team ledger; paying it is done by the existing settlement flow.
* Native iOS/iPadOS/Android builds are verified by `expo export`; on-device testing is manual.
