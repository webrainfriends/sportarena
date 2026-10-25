# Education pathways

A new athlete learns a sport, finds colleges and academies that teach it, asks them questions, joins, and shows what they earn.
An institution's admissions team answers, shares brochures, routes people to its website, announces to those who agreed, introduces
people to sponsors and issues certificates and badges.

**An institution is an ordinary organisation** ([organisations.md](organisations.md)) of kind `college`, `university`, `academy` or
`school`. Its admissions team are the organisation's `owner` and `admin` members (membership is checked live, so removing someone
cuts access at once). There is no separate "college" account. In the app: **Organisations → (your institution) → Admissions**.

## Athlete journey (app: More → Learn & study)

| Step | Capability |
|---|---|
| Read the rules of a sport (sections with a cited source; added by the platform team, empty until then) | `list_sport_rules` · `save_sport_rule` / `update_sport_rule` (admin) |
| Search courses, certifications, diplomas and degrees by sport, level, how taught, country, city | `search_programmes` · `get_programme` |
| Find colleges/academies | `search_institutions` · `get_institution` |
| Get contact details (signed-in only, each read audit-logged) | `get_institution_contact` |
| Ask a question, optionally consenting to announcements and/or sponsor introductions | `create_enquiry` |
| Follow the conversation, reply, change consents, withdraw | `list_my_enquiries` · `get_enquiry` · `send_enquiry_message` · `update_enquiry_consent` · `withdraw_enquiry` |
| Choose which certificates show on the profile; check a certificate | `list_my_credentials` · `set_credential_visibility` · `verify_credential` |

Contact between the two sides goes **through the platform**: replies notify the other side in-app, by push and by email (their own
notification switches apply). The athlete's email and phone are never shown to the institution. Young people cannot enquire on their
own (a parent or guardian does it for them).

## Discover, save and review (app: Learn & study → Explore / Saved)

| Step | Capability |
|---|---|
| Sports and region pre-filled from your sport profiles (change either; "Any sport" and "General sports" are options; several sports and several countries can be chosen) | `get_study_context` |
| AI lists universities, colleges and academies with courses, certifications, diplomas and degrees: contacts, admissions process, entry requirements, fees and intakes | `discover_study_options` |
| Open an AI-suggested institution or course | `get_study_institution` · `get_study_programme` |
| Save an institution or course (listed or AI-suggested) with a stage, deadline and notes; move it along; remove it (kept, restorable) | `save_to_bucket` · `update_bucket_item` · `list_bucket` |
| Rate and review an institution or a course (one review system for the whole platform) | `write_testimonial` · `list_testimonials` with subject type `institution`, `programme`, `study_institution`, `study_programme` |

AI suggestions are stored in a shared catalogue (`study_institutions`, `study_programmes`), always shown as **unverified**, and cached for 30 days per
sports+places question (8 fresh searches per person per hour). The model is told not to invent ratings or reviews: ratings come only from
platform users' reviews. A review from someone whose enquiry reached admitted/enrolled is flagged as an enrolled student. Staff of a listed
institution cannot review it. Search endpoints accept `region` (city or country), `sports` (comma list), `general=true` (programmes not tied to one sport) and `countries` (comma list) and return `rating` and `reviews`.

## Institution journey (Admissions tab)

| Step | Capability |
|---|---|
| Write the public listing; list it in the directory (needs a contact email or website). Email and phone are encrypted | `get_institution_profile` · `save_institution_profile` |
| Publish programmes (multi-sport, fee + currency, next intake, apply link); archive when they stop | `create_programme` · `update_programme` · `list_org_programmes` |
| Brochures (https links), attached to a programme or general | `add_brochure` · `update_brochure` · `list_brochures` |
| Review enquiries by stage, programme, sport, assignee or name | `list_org_enquiries` · `get_admissions_summary` |
| Communicate, share a brochure, route to the website | `send_enquiry_message` (with `brochure_id`) · `refer_enquiry_to_website` |
| Facilitate joining: `new → in_conversation → referred → applied → admitted → enrolled` (or `declined` / `closed`), assignable to a colleague; the athlete is told at each step | `update_enquiry_status` |
| Announce to everyone who consented (filter by programme, sport, stage; `dry_run` shows who gets it and who is skipped) | `broadcast_to_enquirers` · `list_broadcasts` |
| Introduce an enquirer to a sponsor | `link_enquiry_sponsor` · `withdraw_sponsor_link` · (sponsor) `list_sponsor_introductions` |
| Issue / withdraw a certificate or badge to an **enrolled** person | `issue_credential` · `revoke_credential` · `list_org_credentials` |

## Consent and privacy rules

* **Two separate consents**, both off by default and withdrawable any time by the athlete: `comms_consent` (announcements) and
  `sponsor_consent` (sponsor introductions). Replying inside a conversation the athlete started never needs consent.
* Broadcasts never reach people without `comms_consent`, nor withdrawn enquiries. The result reports how many were skipped for
  lack of consent. A send reaches at most 1000 people; narrow it with filters.
* A sponsor introduction needs `sponsor_consent`. The sponsor sees the athlete's handle, institution, programme and note, no
  contact details, and can then send a normal sponsorship offer (`propose_sponsorship`) even if the athlete's general
  "open to sponsors" switch is off. The athlete still accepts or declines. Withdrawing consent withdraws the introductions.
* Message text is encrypted at rest (`enquiry_messages.body_enc`); every time admissions staff open an enquiry it is audit-logged.
  Notification text for replies is generic (email leaves the system in clear text); announcements include their body because the
  recipient agreed to receive them.
* Certificates: shown on the public profile (`get_person → credentials`) and on passport links that include them
  (`show_credentials`, on by default for new links; existing links are unchanged) only while issued, unexpired and left visible by
  the holder. `verify_credential` by code works for anyone and shows the holder's name only if they left it visible.
  An institution is not (yet) platform-verified: a credential proves who issued it, not that the platform vouches for them.

## Data that is kept

Migrations `061_education_pathways.sql` and `073_study_discovery.sql` are additive (it widens the allowed organisation kinds and adds tables and one passport
column). Programmes, brochures, rules and sports on a programme are archived or marked removed, never deleted; enquiries are
closed or withdrawn; credentials are revoked with the reason kept. There is no seed data: rules, institutions and programmes
start empty and are entered by the platform team and the institutions.

## Pathway plan (issue #335)

The **My plan** tab of *Learn & study sport* turns the saved list into a planning workspace. It replaces the old *Saved* tab (one feature, one place): the bucket list is now its **Targets** section, so every existing saved item, stage and note is kept. Migration `108_pathway_planning.sql` is additive only (new tables, one new column, widened CHECK lists; no `DROP`, no cascade).

| Part | Where it lives | What it adds |
|---|---|---|
| Targets | `study_bucket` (existing) | `team` targets; stages `offered`, `enrolled`, `declined`; `row_version` (stale edits → 409); every stage change is logged; listed institutions show the status of the athlete's own enquiry |
| Goals | `pathway_goals` | built by picking, not typing (`get_pathway_goal_options`): a sport metric from the governed catalogue or the athlete's per-match figures (unit, direction, range and step from the catalogue; the start is the athlete's own current value, approved results never blended with self-logged), an academic measure with its real scale (GPA 4/10, %, SAT, ACT, IELTS, TOEFL, credits) or a yes/no milestone. Suggested targets go in the good direction (beat your best; a cohort median only when ≥5 comparable players exist). A goal on a result metric follows the athlete's best figure by itself (`current_source: live`); notes encrypted |
| Deadlines | `pathway_deadlines` + live reads | own dates, plus (read, never copied) target application dates, trial bookings, offer replies, scholarship dates; one reminder per deadline (`notificationCycle`), re-armed when the date moves |
| Scholarships | `pathway_scholarships`, `pathway_scholarship_items` | requirement checklist; evidence is *linked* from academic evidence, issued credentials, approved coach references/videos or results and labelled self-reported / issued / approved; removed or revoked evidence stops counting |
| Offers | `pathway_offers` | tuition + other − scholarship = net, one currency per offer; comparison groups by currency and period and **never converts**; offers are labelled *entered by you, not verified*; one accepted offer per target; decisions are idempotent and move the target |
| Outcomes | `pathway_events` (append-only trigger) | full history of stage changes, offers, scholarships, goals |
| Sharing | `pathway_shares` | share chosen sections with a coach; checked live on every read |

**Endpoints** (all capabilities, so REST + OpenAPI + MCP): `get_my_pathway`, `get_pathway_goal_options`, `list/add/update_pathway_goal(s)`, `list/add/update_pathway_deadline(s)`, `list/add/update_pathway_scholarship(s)`, `add/remove_scholarship_requirement`, `attach/detach_scholarship_evidence`, `list/add/update_pathway_offer(s)`, `compare_pathway_offers`, `decide_pathway_offer`, `get_pathway_outcomes`, `share_pathway`, `list_pathway_shares`, `revoke_pathway_share`, `list_shared_pathways`, `get_shared_pathway`, `export_pathway`, `export_shared_pathway`. `save_to_bucket`/`update_bucket_item`/`list_bucket` keep their paths and gain the extra targets, stages and `row_version`.

**Permissions and consent**
- Everything under `/me/pathway` is the athlete's own. A verified guardian passes `athlete_id` to act for a young person (`403` otherwise). A young person acting alone needs the guardian's current `recruitment` consent to *accept* an offer and `recruitment_sharing` consent to share; the guardian is told when they decide for the child.
- A coach reads a plan only through a live share: not revoked, not expired, the coach still coaches the athlete, and for a young person `recruitment_sharing` consent still holds and the coach may still see them. Otherwise the answer is `404`, so existence is not leaked. Revoking (athlete, guardian or coach), ending the coaching relationship or withdrawing consent cuts access on the next request, including exports. Each coach read and export is audit-logged.
- Free text the athlete types (notes, conditions, decision notes) is encrypted (`*_enc`) and never appears in what a coach sees or exports; evidence content and enquiry messages are never shared, only titles and provenance. Sharing is to a named coach (not a bearer link), so there is no link to leak or to outlive a revocation; the recruitment passport links are unchanged.

**Failure behaviour**: invalid input → `400`; not yours / not found → `404`; stale `row_version` → `409 stale_version`; missing guardian consent → `409 guardian_consent_required`; duplicates (same goal, deadline, scholarship, offer, share) return the existing row; deciding the same way twice is a no-op.

**Recovery / rollback**: nothing is deleted anywhere; removal sets `removed_at`/`revoked_at`. To roll back, stop using the new tables and columns; the old bucket list keeps working because its columns, ids and statuses are unchanged.

**Operations**: no new configuration. Deadline reminders run inside the existing notification cycle.

**Platforms**: one Expo / React Native codebase serves iOS, iPadOS, Android and web; the plan uses only shared components (sheets, calendar picker, steppers, chips) and `Share` (native) / download (web) for CSV. It was exercised in a browser at phone (390 px) and tablet (1180 px) widths by `scripts/e2e/pathway-plan-journey.mjs`; it has not been run on a physical iOS or Android device from this environment.
