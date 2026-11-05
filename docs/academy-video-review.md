# Academy video review & coach feedback (#793)

Academy OS P1 / Gap 13. Coaches link an athlete's **shared library clip** to an academy session, a curriculum objective, a coach observation,
an assessment and a **shared development action**; athletes and guardians watch and reply; consent, expiry and revocation are enforced on every read.

## Source of truth (nothing is duplicated)
| Need | Owner | What this feature adds |
|---|---|---|
| Clip bytes, links, visibility, takedown | Player video library (`passport_videos`, #317/#565) | Nothing. No storage, encoding or annotation service. |
| Development action | Academy development plan (`academy_dev_interventions`, kind `video_review`, #785) | `new_action` creates one in the athlete's active plan; `intervention_id` links an existing one. |
| Youth media consent | `youth_consents` purpose `media` (`hasConsent`) | Evaluated **live** on every list, view and playback request. |
| Session, cohort, objectives | `academy_sessions`, `academy_session_objectives` | Referenced by `session_id` / `objective_key`. |
| This feature | `academy_clip_links`, `academy_clip_annotations` (migration `159`) | A governed reference + encrypted coach note/annotations + review state. |

## API (REST + OpenAPI + MCP, one definition each: `apps/api/src/capabilities/academy-video.js`)
`list_academy_linkable_clips`, `link_academy_clip`, `list_academy_clips`, `get_academy_clip`, `update_academy_clip`,
`add_academy_clip_annotation`, `remove_academy_clip_annotation`, `revoke_academy_clip`, `respond_academy_clip_review`, `list_my_academy_clips`,
plus the gated binary route `GET /academy/clip-links/:id/file`.

## Access gate (re-evaluated on every request)
Blocked with a reason (`revoked`, `expired`, `unshared`, `consent_withdrawn`) and **no video**; the link, notes and action are kept. A new consent
restores viewing. Viewers: coaching staff (owner/admin/manager see all; coaches only their own groups or links they made), the athlete (only when the
link is athlete-visible), and a verified guardian. Anyone else gets `404`. Coach notes, annotations and replies are encrypted at rest; views, plays,
links, revocations and replies are audit-logged.

## UX placement (no new workspace)
Session → **Video** tab; Progress → **Video feedback** (coach queue); Family portal → Progress → **Video to review**. Capture/upload hands off to the
session workspace and the athlete's own video library. A weak connection shows a labelled retry state; captured clips stay on the device.

## Migration & rollback
`159_academy_video_review.sql` is additive (two tables, indexes). Rollback = deploy the previous build; the tables only hold references and are never dropped.

## Languages & platforms
All `vr.*` strings exist in English and the 11 packs (machine-drafted, `reviewed: false` until native speakers sign off). iOS, iPadOS, Android and web share
one React Native screen file (`apps/app/src/screens/academy-video.js`); native-device playback and capture could not be run in CI.
