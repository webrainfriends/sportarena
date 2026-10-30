# Role-driven mobile workspace (issue #599)

The app opens on what the signed-in person does, not on the platform's modules. One React Native codebase, the same on iOS, iPadOS,
Android and the web; phone gets a bottom bar, tablet and desktop a floating bar and a two-column Home.

## Navigation
Bottom bar: **Home · Calendar · More (centre swivel) · Workbench · Profile**. The Inbox is the button at the top right, beside the account button.

| Tab | What it is | Where it comes from |
| --- | --- | --- |
| Home | today, what needs me, headline numbers, fast actions, role/organisation switch | `GET /me/role-workspace` |
| Calendar | the existing agenda (`Schedule`, section `agenda`): matches, sessions, duty, bookings, health, other calendars | unchanged |
| Workbench (route `Work`) | the one page of the active role: its queue (most urgent first) and fast actions, with the role's own screen (coach, official, venue, sponsor ...) below. Replaces the separate Work tab and Workspace tile | `GET /me/role-workspace` |
| Inbox | every notification; a tap opens the record using the same mapping as a tapped push | `GET /notifications` |
| Profile | roles, security, device lock, settings | unchanged (`Me`) |

Explore, the community feed (`Community`) and the player studio stay reachable from Home, the Workbench and the More swivel; nothing was removed.
Switching role (or organisation) is the chip row on Home and the Workbench. It uses the session's `activeRole`, the same one the tools wheel sets.

## API
`get_my_workspace` — `GET /me/role-workspace?role=` (REST, OpenAPI and MCP from one definition, `apps/api/src/capabilities/workspace.js`).
It owns no data: it composes `coach_home`, `get_officials_home`, `list_my_selections`, `list_my_staff_assignments`,
`venue_operations_overview`, `list_my_venues` and the event/accreditation counts, so each source's own permissions, consent and
encryption rules still decide what is shown. Read-only. A role the caller does not hold is refused (403); `admin` and `platform_admin`
are never listed, switchable or accepted.

Response: `role`, `roles[]`, `organisations[]`, `unread`, `summary[]`, `today[]`, `work[]` (each item has `target` and, where a single tap
is enough, `quick[]` answers that call the owning endpoint), `actions[]` (each has `target`, and `camera` / `disabled` where relevant),
`generic`, `unavailable[]`, `as_of`.

| Role | Native workspace | Fast actions |
| --- | --- | --- |
| Athlete | yes | availability, show my pass (QR), log a match, find a game; confirm / decline selections and event-role offers in one tap |
| Coach | yes | take attendance, my sessions, my athletes, coaching requests; the coach home inbox as the queue |
| Event manager (organizer) | yes | event console, scan at the gate (opens on today's event), approvals, create event; pending entries / badges / open positions |
| Official (referee) | yes | assignments, availability, pending requests, match-day console; accept / decline / acknowledge in one tap |
| Venue operator | yes | today at the venue, check people in, venue checks (maintenance), front desk; overdue / urgent jobs, expiring insurance |
| Sponsor, physio, doctor, supplier, insurer, lawyer, recruiter | **labelled generic** | their own home screen + find a game; no queue is composed yet |

## Poor connectivity
The last good workspace stays on screen with an **offline** notice. One-tap answers go through the retry outbox (`outbox.js`): each write
carries a `client_key`, a retry after a dropped connection is harmless, a refusal (400–499) is shown and dropped, and when the queue
empties the workspace is read again so the server's answer wins. The outbox is deliberately **in memory only** (see its header): queued
answers survive a weak signal, not closing the app, and are emptied on sign-out.

## Device and session security
* Sessions, signed-in devices, two-step verification and "sign out everywhere" already live in Account security.
* **Device lock** (native only): Face ID / fingerprint / device passcode after 30 s in the background and on a cold start. Turning it on needs
  one successful check; the lock screen always offers **Sign out instead**. The choice is kept in the platform keychain. Not offered on the web.

## Deep links
`sportarena://<kind>/<id>` and `sportarena://open?target=<kind:id>` open the same screens as a tapped push (`push.js parseTarget`);
https links open the app only for hosts listed in `EXPO_PUBLIC_APP_HOSTS`. Anything that is not the app's own scheme or a listed host is ignored.
