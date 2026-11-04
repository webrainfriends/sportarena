# Academy talent scouting & recruitment journey (#790)

Scout → trial → enrolment for an academy, built on the records that already exist. **Nothing here is a second prospect table, video platform,
trial scheduler or admissions record.** Screens: Organisation → Academy → **Scouting** (and, for a scout, the existing Talent CRM entry sheet).

## Requested feature → source of truth → verified gap → addition
| Requested | Already owns it | Gap | Added |
|---|---|---|---|
| Prospect, evaluations, access grant | Recruiter workspace (#313): `recruiter_list_entries`, `recruiter_evaluations`, `recruiter_access_requests` | no campaign, no academy link | `academy_campaign_entries` (a link: stage, region, source, decision, application) |
| Eligible sport/age/position campaign, assignments | nothing | campaign model | `academy_scouting_campaigns`, `academy_campaign_members`, `academy_campaign_conflicts` |
| Authorised video references | Passport videos (#312), coach-approved, athlete-owned | none for the academy | `academy_campaign_videos`: a link to an approved passport video, readable only while the athlete's grant is live |
| Guardian-controlled contact and access | `youth_consents`, guardian links, live grant check | not applied to the committee view | re-checked on every read, vote, decision and invitation |
| Committee decision | nothing | votes, quorum, log | `academy_committee_votes` (append-only), decision on the entry, `academy_campaign_events` (append-only) |
| Invite to the existing trial/offer | `academy_applications`, academy timetable trial sessions, offers | no source or consent on the application | nullable `source_*` columns on `academy_applications`; the invitation creates or links the canonical application |
| Referral sources, regions, outcomes | Admissions funnel | cuts by source and region | `academy_referral_sources`, `get_academy_scouting_report` |

## How it works
1. **Campaign (8-step brief, saved as a draft after every step):** brief, player profile (birth-year range, positions from the sport's catalogue), territory and referral sources, scouting team, evaluation rubric (weights over the platform's evaluation criteria), safeguarding, committee and pipeline SLAs, review. `launch` runs the readiness check on the server and refuses with the exact blockers.
2. **Scout:** a verified recruiter linked to the academy saves an athlete (they hold a live grant) to their Talent CRM list, evaluates them with the existing evaluation form, and adds the entry to a campaign they are assigned to. The server checks sport, birth year, region and capacity.
3. **Submit to committee:** the scout chooses evaluations (the committee sees an immutable snapshot with its basis and date), whether to release private notes (audit-logged when read) and authorised video links. Minimum evaluations and required evidence bases are enforced.
4. **Committee:** members vote advance / hold / decline (a reason to decline). Votes are append-only; a declared conflict excludes the voter; quorum is required; the outcome is computed from the rule (majority or unanimous); a safeguarding officer's decline stops an advance for a young person. A hold opens a new round.
5. **Invitation:** owner/admin invites into a programme the campaign feeds as a **trial** (the family books on the academy timetable) or an **offer**. The canonical application records the campaign, referral source, region and the consent in force (guardian consent for a young person). If the athlete already has an application it is linked, not duplicated.
6. **Outcomes:** funnel, conversion, median days, by referral source, region (with coverage gaps) and scout (against capacity), SLA overdue counts. Counts only: no athlete is named, in the screen or the CSV.

## Privacy and security
- Server-side authorisation: owner/admin or the campaign owner manage; scouts see their own prospects, regional leads their region, committee members what was submitted; everyone else gets 404.
- A young person's record disappears from the committee the moment the grant or the guardian's consent ends (`access ended`: only the stage and the decision log remain). No vote, decision or invitation is possible then.
- No contact details are returned by any scouting capability. Guardians (not the child) are told about scouting activity, in generic wording.
- Notes are encrypted (`recruiter_evaluations.notes_enc`); reading released notes writes `read_scouting_notes` to the audit log. Birth-year checks read the encrypted date of birth and are audit-logged.
- Nothing is deleted: members are soft-removed, prospects are `withdrawn`, campaigns are `closed`/`archived`, referral sources are archived.

## API / MCP (one definition each, REST + OpenAPI + MCP)
`get_academy_scouting_options`, `list/save_academy_referral_source(s)`, `list/get/create/update_academy_scouting_campaign(s)`, `set_academy_campaign_team`, `launch_academy_scouting_campaign`, `set_academy_scouting_campaign_status`, `list_my_scouting_campaigns`, `add_campaign_prospect`, `list_campaign_prospects`, `get_campaign_prospect`, `get_my_prospect_for_entry`, `list_prospect_video_options`, `submit_prospect_to_committee`, `cast_committee_vote`, `declare_campaign_conflict`, `decide_campaign_prospect`, `invite_campaign_prospect`, `withdraw_campaign_prospect`, `get_academy_scouting_report`, `export_academy_scouting_report`. Extended: `get_academy_application` returns `source`; `list_academy_applications` returns `source_kind`.

## Migration and rollback
`155_academy_scouting.sql` is additive: new tables, nullable columns, no drops, no cascades. To roll back, stop calling the capabilities; the tables keep their history and the `source_*` columns are ignored by every earlier query.

## Known limits
- Evaluations are a scout's own per prospect. A second scout's opinion is a second Talent CRM entry for the same athlete under that scout's own grant; a campaign holds one prospect per athlete, so independent evaluations are not merged. The committee relies on the submitted snapshots plus the trial outcome.
- The brief's benchmarks, events and venues are accepted by the API (`benchmarks`, `event_ids`, `venue_ids`) but have no creation-form control yet.
- Native iOS/Android devices were not available for testing; the web build was checked at phone, tablet and desktop widths.
