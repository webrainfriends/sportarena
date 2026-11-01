# Communities and moderated activity sharing (issue #66)

Local and sport communities with owners and moderators, invitations and visibility rules; posts, comments and shares of verified achievements; cursor-paged feeds; one report → decision → appeal path; block, mute and youth safeguards enforced the same way for REST, OpenAPI and MCP.

## What was reused, merged and added

| Need | Before | Now |
|---|---|---|
| Follow, friends, requests, guardian approval, privacy | #695 `src/social.js`, `capabilities/social.js`, `Network` screen | **Unchanged and reused.** The profile (`Person`) now offers follow / friend / message / mute / report / block through the same capabilities |
| Block and mute | `user_blocks`, `social_mutes`, `severSocial()` | Reused. Every community read, invitation, join and comment checks them in both directions |
| Posts, comments, reactions, media | `market_posts`, `market_comments`, `market_reactions`, `market_media`, `PUT /market/media` | **The same tables** (`community_id`, `body_enc`, `hidden_at`…). Community rows never appear in the public marketplace |
| Achievement shares | `/me/activity-feed` projected from canonical records | A share stores only a reference; the item is re-projected on every read, so a reversed record shows as "no longer available" |
| Reports | `social_reports` (people, activity items) | Widened to community posts and comments; **one queue** (`GET /social/reports`) with reasoned decisions. Message and testimonial reports stay where they are decided and are listed read-only with `source=all` |
| Appeals | none | A support case (`moderation_appeal`) linked to the decision through `moderation_appeals`; no second case system |
| Notification choices | `muted_kinds` | Grouped switches (`social_categories`) over the same list; no new preference store |
| Message rate limit | global HTTP limiter only | Per person per hour (`MESSAGES_PER_HOUR`, default 300), counted separately from other actions |
| Retention | conversations archive after `retention_days` | Community posts and comments are archived after `COMMUNITY_RETENTION_DAYS` (default 730, `0` keeps everything) |

New tables: `communities`, `community_members`, `community_invitations`, `moderation_appeals` (`migrations/139_communities.sql`). Added columns are nullable or defaulted.

## Rules enforced on the server

* **Visibility**: `public` (any signed-in person reads), `private` (listed, content for members only), `hidden` (not listed, a 404 to everyone but members and invitees). Everything an outsider may not read is a **404, never a 403**, on the feed, posts, comments, members and media downloads, over REST and MCP.
* **Joining**: `open` joins at once, `request` waits for the owner or a moderator, `invite` is by invitation only. Joining twice is harmless; a person removed by a moderator cannot rejoin on their own.
* **Roles**: the owner appoints moderators and archives the community; moderators approve requests, silence (5 minutes to 30 days) and remove members, and remove posts with a reason the author is told. Nobody can change the owner.
* **Blocks**: a block in either direction removes the other person's posts and comments, hides them from member lists, rejects invitations and join requests (404), blocks commenting and reporting across the block. Mutes hide posts without telling anyone.
* **Young people**: cannot start communities; are never members of an adults-only community (the default); join an `audience=all` community only by invitation, only while a guardian link with the `social` scope is live (checked on every read, so a revoked guardian removes access at once); are listed to the owner and moderators only; never share achievements publicly.
* **Posts**: text is encrypted (`body_enc`); photos reuse the market upload (type sniffed from the bytes, size limits, malware hook) and are downloadable only by people who may read that community; removing a post hides it (`hidden_at` / `archived_at`), nothing is deleted.
* **Rate limits** per person per hour: posts 30, comments 120, invitations 30, joins 30, communities 10 created, reports 60, messages 300 → HTTP 429.
* **Reports**: one per reporter and target (reporting again updates the reason); you can only report what you can read. Reporters' notes are encrypted and never shown in the queue. Reading the reported text is opt-in (`include_content=true`) and audit-logged.
* **Decisions**: outcome `hidden`, `warned`, `silenced` or `dismissed` with a required reason (encrypted). The platform admin decides any report; an owner or moderator only their community's, never one that involves themselves. The reporter is told it was reviewed; the person concerned is told the outcome and how to appeal. Every decision is audit-logged.
* **Appeals**: only the person concerned, once per decision, within 14 days, as a support case the platform team answers (`/me/cases`). `overturn_moderation_decision` (platform admin) restores the content and tells the person.

## API, OpenAPI, MCP

`src/capabilities/communities.js`: `create_community`, `list_communities`, `get_community`, `update_community`, `archive_community`, `join_community`, `leave_community`, `list_community_members`, `decide_community_member`, `invite_to_community`, `list_my_community_invitations`, `respond_community_invitation`, `post_to_community`, `list_community_feed`, `remove_community_post`.
Extended: `report_social`, `list_social_reports`, `decide_social_report`, `overturn_moderation_decision` (`social.js`); `appeal_moderation_decision` (`cases.js`); `list_market_comments` (cursor `after`), `add_market_comment`, `react_market_post`, `get_market_post` (community access); `update_notification_preferences` / `get_notification_preferences` (`social_categories`).
Feeds are cursor-paged: pass `next` back as `before`; order is `created_at DESC, id DESC` with microsecond-precision cursors, so a post arriving between pages never causes a skip or a repeat.

## App

`screens/communities.js` (one React Native implementation for iOS, iPadOS, Android and web): `Communities` (discover / mine / invitations, search, start a community), `CommunityDetail` (feed, composer with photos and achievement share, comments, members, moderator tools), `Appeal`. Entry: the Home feed's **Communities** button; profile actions on `Person`; notification switches in the Notification settings. All text goes through `t()` in the 11 language packs plus English (machine-drafted, `reviewed: false` until a native speaker signs off).

## Configuration and failure modes

| Setting | Default | Effect |
|---|---|---|
| `MESSAGES_PER_HOUR` | 300 | Per-person message cap; over it → 429 "try again in a little while" |
| `COMMUNITY_RETENTION_DAYS` | 730 | Posts / comments older than this are archived by the worker; content under an open report is kept; `0` disables |

* A notification that cannot be stored never rolls back a join, post or decision (it is retried by the notification job).
* If a shared achievement's record is reversed, the post stays and shows the share as unavailable.
* Archiving a community hides it for everyone; members, posts and reports are kept.

## Rollback

Deploy the previous release. Every column added is nullable or defaulted and every table is new, so the old code ignores them; nothing is dropped. The two widened CHECK constraints (`market_posts.kind`, `social_reports.target_type`) only allow more values.

## Sports

Communities, posts and shares are sport-agnostic. A share references a canonical record (an approved result, an award, a hosted game, a rating move, a streak), which exists for every sport in the catalogue; no sport has a fallback and none is a gap. The share card names the sport from the record.

## Residual limitations

* Direct messages stay in the unified inbox (#594); there is no separate community chat.
* Videos can be attached to market posts but community posts accept photos only.
* The unified queue lists message and testimonial reports read-only; they are decided in their own screens.
* Translations are machine-drafted and unreviewed.
