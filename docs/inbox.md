# Unified Inbox (issue #594)

One inbox for sport-context communication. It lists **team chats** (unchanged, `team_messages`), **notifications** and the conversation types added here: **direct**, **group**, **event channel** and **threads** about a team, event, fixture or registration. The app opens it from the bell (the `Notifications` screen is now titled Inbox, with an Inbox and a Preferences tab). Home shows the same list in short form. No second inbox exists.

## What was reused, merged and added

| Need | Before | Now |
|---|---|---|
| Inbox list | `/notifications`, `/me/team-chats`, Home `InboxList` | `GET /inbox` (`list_inbox`) over all of them; the old capabilities stay and feed it. The Notifications screen's own list and Home's list are merged into the one `InboxBody` component |
| Email, push, WhatsApp, SMS | `notify()` and the comms layer | Reused. Message notifications never carry the text |
| Notification preferences | `get/update_notification_preferences` | Extended with quiet hours and escalation (no new preferences capability) |
| Deep links | `workspace.linkFor` | Reused for notification rows; pushes carry `conversation_id` |
| Team chat features (polls, RSVP, voice) | `team-chat.js` | Unchanged; appears in the inbox as the team channel |

## Rules enforced on the server

* **Who can start**: direct only between people who already share a team, organisation, event or guardian link; no cold messages. A group, event channel or thread needs the person to run that team, event, fixture or registration. Everyone added must be connected to that context.
* **Youth**: two young people never message each other directly; an adult needs the young person to have a verified guardian, a current `contact` consent and the youth-contact compliance gate cleared. Guardians of young members read the conversation read-only (live: revoking the link ends access at once; each read is audit-logged) and are notified as themselves.
* **404, not 403**, for anyone with no standing in a conversation.
* **Text** is encrypted (`conversation_messages.body_enc`). Report notes are encrypted. Hidden messages stay in the database; nothing is deleted anywhere.
* **Attachments** (photo or PDF, recognised from bytes, 10 MB) are stored encrypted and re-authorised on every download: `PUT /conversations/:id/attachments`, `GET /conversation-attachments/:id`. These are plain HTTP routes like team chat media, because a raw file cannot ride the JSON capability router.
* **Delivery and read**: senders and organisers see read counts; for any message they can ask for per-channel delivery counts (never who).
* **Urgent notices** (`requires_ack`): recipients confirm; anyone who has not after their delay (their setting, else the notice's, else 30 minutes) is sent it again as an urgent alert that may use WhatsApp or SMS (`conversation_escalation` maps to the existing emergency template, so it only leaves as a template when the event is known). A young person's guardians are always told. One row per person makes the sweep idempotent.
* **Quiet hours**: push, WhatsApp and SMS are held back; the inbox and email still receive the item. Urgent notices break through unless the person turns that off. The held-back push is not re-sent later: the item waits in the inbox.
* **Moderation**: report (reasons: abuse, harassment, unsafe contact, spam, privacy, other), organiser queue, hide (reversible record), pause a member, remove a member, block a person from direct messages. Reading reports and every moderation action is audit-logged.
* **Search**: titles and messages decrypted for the caller only, across their 1,500 most recent messages, plus team chat and notifications. Hidden messages are not searched.
* **Archive and retention**: a conversation quiet for `retention_days` (default 2 years, 30 days to 10 years) is archived by the worker (live-event conversations are never archived). Archived conversations stay readable and searchable and take no new messages; organisers can reopen them.

## API, OpenAPI, MCP

All in `src/capabilities/inbox.js`: `list_inbox`, `search_inbox`, `list_inbox_contacts`, `list_inbox_contexts`, `start_conversation`, `get_conversation`, `list_conversation_messages`, `send_conversation_message`, `mark_conversation_read`, `acknowledge_notice`, `get_message_delivery`, `add_conversation_members`, `remove_conversation_member`, `update_conversation`, `mute_conversation`, `set_user_block`, `hide_conversation_message`, `report_conversation_message`, `list_moderation_reports`, `resolve_moderation_report`, `silence_conversation_member`. Migration `127_unified_inbox.sql` is additive.

## App

`apps/app/src/screens/inbox.js`: one React Native implementation for iOS, iPadOS, Android and web. Phones: list, then a conversation screen. Tablet and desktop widths: list and conversation side by side. People, teams and events are chosen with the shared pickers, times with the time picker. Targets are at least 44pt and controls have accessibility labels.

## Sports

The inbox is sport-agnostic: it talks about teams, events, fixtures and registrations, which exist for every sport in the catalogue, and contains no scoring or rules logic. No sport uses a fallback and none is a gap.

## Not verifiable here

Live WhatsApp / SMS provider delivery, native-device runs (the iOS and Android bundles compile with `expo export`), and push on real handsets.
