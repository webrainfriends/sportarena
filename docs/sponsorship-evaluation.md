# Sponsorship application scoring and evaluation committees (#288)

Extends programs, rounds and applications (#284, #285) **in the same Program screen and the same tables**; an award is still an ordinary
`sponsorships` row, so agreements, obligations, payments and evidence are untouched. A round without a rubric behaves exactly as before.
No consent, payment or delivery is inferred from a score.

## The journey
1. **Rubric** (manager/approver): weighted criteria (weights total exactly 100), scale 1-N, applicant identity *hidden until they consent* or shown, optional scoring deadline. Saved as a draft, then **Open scoring** (needs at least one reviewer). Replacing a draft retires the old one; a rubric that has received its first submitted score is **locked**.
2. **Committee**: pick brand evaluators/managers (search-and-pick). *Reviewers* score; *moderators* also settle disagreement, shortlist and run interviews. Roles are re-read live on every call.
3. **Independent scoring**: each reviewer scores every criterion (draft, then submit). Reviewers never see each other's scores; moderators, managers/approvers and auditors see the summary (average, spread, moderated and final score).
4. **Conflicts**: a reviewer can recuse themselves, a manager can record one for them; ownership of / membership in the target (applicant, athlete, team owner or member, event organiser) is detected automatically. A conflicted reviewer gets 403 on scoring and their score no longer counts. Only a manager can lift a conflict.
5. **Blind review + consent**: while the rubric is anonymous, every staff view (including the existing applications list) shows an alias (`A-XXXXXX`). A manager *asks* the applicant to be identified; only the applicant can grant, deny or later revoke. Awarding a blind application needs a granted consent.
6. **Shortlist and interviews**: received -> shortlisted -> interview -> finalist (and back). Any number of interview rounds, each a scheduled slot (date + time + timezone), a video link (https) or both; the next round can be scheduled once the current one is completed or cancelled. The applicant is notified and sees time, link, location and notes (never outcome or scores).
7. **Moderation**: a moderated total (with reason) replaces the average as the final score; reviewers' scores and earlier moderations stay on record. Disagreement above the rubric's threshold is flagged.
8. **Decision**: award/decline as before, plus (in a scored round) the application must be shortlisted, have at least one submitted score and, if blind, consent. The decision stores a **decision record**: the rubric as scored, the score result and the permitted source references (application, round terms version, program version; target/identity only if consented). `eval_version` makes a decision against a stale view a 409.

## Schema (migration `090_sponsorship_evaluation.sql`, additive)
`sponsorship_rubrics`, `sponsorship_rubric_criteria`, `sponsorship_reviewers`, `sponsorship_conflicts`, `sponsorship_scores`, `sponsorship_moderations`, `sponsorship_interviews`, `sponsorship_identity_consents`, `sponsorship_evaluation_events` (append-only history, no score values), `sponsorship_decision_records`; `sponsorship_applications.stage` (default `received`) and `.eval_version` (default 1). Nothing is dropped, rewritten or deleted; no `ON DELETE CASCADE`; scores are voided, conflicts cleared, rubrics retired.

**Rollback**: deploy the previous code; the new columns have defaults and the new tables are unused by it. **Dependency order**: #284/#285 (programs, rounds, applications) -> this; org roles (#283) supply evaluators. Coordinates with #145 (agreements), #243 (notifications), #64 (evidence); none is required beyond what already exists.

## Capabilities (REST + OpenAPI + MCP from one definition)
`get_round_rubric`, `save_round_rubric`, `activate_round_rubric`, `list_eligible_reviewers`, `add_round_reviewer`, `remove_round_reviewer`, `list_round_evaluation`, `get_application_scoresheet`, `save_application_score`, `declare_application_conflict`, `clear_application_conflict`, `set_application_stage`, `moderate_application`, `schedule_application_interview`, `update_application_interview`, `list_application_interviews`, `list_my_program_interviews`, `request_applicant_identity`, `respond_applicant_identity`, `get_application_history`, `export_round_evaluation`. `decide_program_application` gains `eval_version`; `list_program_applications` redacts blind applicants; `list_my_program_applications` gains `identity_status`. New sponsor action `evaluation` (manager, approver, evaluator, auditor).

## Authorization and confidentiality
Every call loads the round, then checks the caller's live authority over **that brand** (brand-wide roles only); another brand gets 403 on reads, writes and exports. Scores, comments, moderation and the history are never returned to applicants or plain reviewers (own score only). The evaluation export is manager/approver/auditor only, audit-logged, and shows aliases unless the applicant consented. Concurrent saves are serialised under the program/round/application locks (program -> round -> application); a losing writer gets a 409 telling them to reload.

## App
Program screen -> a round -> **Show applications** -> *Evaluation*: rubric editor (live weight total, scale chips, anonymity, scoring deadline picker), committee (search-and-pick, reviewer/moderator chips), stage filters and board (alias, stage, score summary), score sheet (accessible 1-N radio chips, live weighted total, save draft / submit, recuse), interview sheet, history sheet, moderation. Applicants answer the identity request and see their interviews under *My applications*. Loading, empty, denied (403), stale-version (409 with reload) and retryable error states are handled.

## Known limits
* A locked rubric cannot be revised mid-round (create the next round for a different rubric).
* Interview video links are stored and shown, not generated; email/push delivery depends on the configured providers (as for every notification).
* While anonymous, an applicant's free-text pitch is shown as written, so applicants should not put their name in it.
