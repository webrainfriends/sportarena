# Sponsorship programs, public calls and invitations

Programs and rounds (#284) are the single home for funding calls. #285 turns them into **public sponsorship calls** and
**invitation-only calls** without a second model: same `sponsorship_programs`, `sponsorship_rounds`, `sponsorship_applications`,
and an award is still an ordinary `sponsorships` row (with `program_id`, `round_id`, `application_id`), so agreements,
obligations, payments and evidence stay where they are. No consent or payment is inferred from an application or an award.

## What changed (migration `089_sponsorship_calls.sql`, additive)
| Table / column | Purpose |
|---|---|
| `sponsorship_programs.visibility` (`public` default, `invitation_only`) | who can see/search/apply. All existing programs are backfilled `public`. |
| `sponsorship_rounds.timezone`, `closes_time`, `opens_at`, `closes_at` | deadline = an instant: `opens_on` 00:00 .. `closes_on` at `closes_time` (default end of that day) in an IANA timezone. Existing rounds are backfilled to their old UTC day window; readers fall back to the dates when an instant is missing. |
| `sponsorship_program_faqs` | FAQs per program, versioned (`row_version`), archived never deleted. |
| `sponsorship_invitations` | one live invitation per program + target (`event`/`team`/`athlete`); statuses `invited`, `viewed`, `applied`, `declined`, `revoked`. |
| `sponsorship_applications.invitation_id` | the invitation an application came through. |

Rollback: deploy the previous code. New columns have defaults, new tables are unused by it, nothing was dropped or rewritten.

## Capabilities (REST + OpenAPI + MCP from one definition)
| Capability | Who | Notes |
|---|---|---|
| `list_funding_opportunities` (`GET /funding-opportunities`) | public | open calls only; filters `sport`, `region`, `q` (also searches FAQs), `invited`, `sort=newest|closing_soon`; deterministic pagination. Invitation-only calls are never listed except to the signed-in invitee. Budget never exposed. |
| `get_funding_opportunity` (`GET /funding-opportunities/:id`) | public | program page with rounds (state, deadline instant + timezone), FAQs, your invitations, `can_apply`. A private call is **404** for everyone except invitees and brand staff (same as an unknown id). |
| `create/update_sponsorship_program` | brand manager/approver | `visibility`; stale `version` -> 409. |
| `create/update_program_round`, `schedule_program_rounds` | brand manager/approver | `closes_time`, `timezone`; unknown timezone -> 400. |
| `apply_to_program_round` | owner of target | deadline checked **on the server, under the round lock, with `clock_timestamp()`** -> 409 `closed`; invitation-only requires a live invitation for that exact target, otherwise 404. Youth athletes still blocked. |
| `invite_to_program`, `list_program_invitations`, `revoke_program_invitation` | brand manager/approver (read: any brand-wide sponsor role) | athlete invitees must have opted in (or be institution-introduced with consent), respect `verified_sponsors_only`; people under the independence age and the brand's own staff cannot be invited. Partial success: refused targets come back in `skipped` with the reason. |
| `decline_program_invitation` | invitee | accepting = applying. |
| `upsert_program_faq`, `archive_program_faq` | brand manager/approver | version-checked. |

## Authorization and tenant isolation
Brand capabilities load the program, then check `sponsorAccess` for that brand (brand-wide roles only); another brand gets 403 on
reads, writes, invitations, FAQ edits and the awards export. The export is audit-logged. Invitees can only see/decline their own invitations.

## Notifications
`sponsorship_invitation` (invited, withdrawn, declined; invitations made on a draft are announced at publish), `sponsorship_call`
(24h deadline reminder to un-responded invitees; "call closed, N applications waiting" to brand staff). Both are idempotent through
`dedupe_key`; the worker step is `sponsor_calls` (`sendCallNotices` in `apps/api/src/sponsorship-calls.js`).

## App journey
`FundingOpportunities` (search, region, sport, sort, "Invited to me", my applications) -> `SponsorCall` (page, deadlines in the round's timezone, FAQ accordion, apply sheet, closed/denied/stale states) ; brand side `SponsorProgram` gains visibility, deadline time + timezone pickers, an Invitations section (search-and-pick athletes/teams/events) and an FAQ editor, with a stale-version banner.

## Recovery and known limits
* A deadline edited into the past closes the round immediately; an erroneous invitation can be revoked until the invitee applies.
* Email/push delivery depends on the configured providers (as for every notification).
* Invitations are per target, not per organisation; there is no bulk import.
