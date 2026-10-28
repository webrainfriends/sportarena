# Role-based command centres (#562)

One Home for every role. A person holds several roles under one login; the app shows a role switcher and, for the chosen role, the same six sections: **Today, Actions, Calendar, Inbox, Work, Insights** (plus the existing community feed).

## Nothing is copied

Roles, queues and counts are **live projections** over the canonical modules (`src/workspace.js`). The only stored data is the person's own preferences (`workspace_prefs`: active role/scope, default organisation, pinned teams/events/venues/organisations, saved filters). A revoked membership removes the role, its scopes, its queue and any pin the next time anything is read.

| Persona | Held when (live) | Scope | Actions it surfaces |
|---|---|---|---|
| Athlete | `users.roles` has `athlete` | – | squad selections (confirm/decline), team availability for matches in 7 days, follow-ups due |
| Guardian | active `guardian_links` | child | open link requests, children without participation consent; children's selections only while consent is live (each read audited) |
| Coach | role `coach` or active team coach | team | session requests, assigned team tasks |
| Team manager | team owner or active `manager` | team | players who have not answered a selection, unaccepted invitations, team tasks |
| Club / academy / federation admin | active org `owner`/`admin` | organisation | admissions to review, licences awaiting a decision |
| Competition / event manager | role `organizer` or organises an event | event | registrations (accept/reject), due event tasks, crew applications |
| Official | role `referee` or an appointment | – | appointments (accept/decline), crew posts |
| Doctor, Physio | role | – | appointment requests (confirm/decline), overdue follow-ups (no clinical detail is listed) |
| Sponsor | role or sponsor owner/org member | – | proposals to decide, assigned sponsorship tasks |
| Supplier | role or supplier profile membership | supplier profile | invitations to quote, orders needing confirmation |
| Venue operator | role, owner or active staff | venue | due maintenance (mark done), unpaid bookings today |
| Agent / scout | role `recruiter` | – | profile access ending within 14 days |
| Media | active org member of an active media partner | partner | rights licences needing a response |
| Volunteer | an invited/accepted volunteer crew post | – | crew posts (accept/decline) |

"Agent" maps to the platform's recruiter/scout role; there is no separate agent role.

## Reuse (and what was merged)

* **Calendar**: the existing unified schedule (`get_my_sport_schedule` / `HomeSchedule`) limited to the kinds the role cares about.
* **Inbox**: the existing notifications; the new `InboxList` is now the *only* inbox (the Notifications screen shows it too). Deep links are resolved by one server function (`linkFor`) instead of an ad-hoc chain in the screen.
* **Quick actions** call the existing capabilities (`respond_to_selection`, `set_member_availability`, `decide_entry`, `respond_fixture_official`, `respond_event_staff`, `update_appointment`, `update_maintenance`); each action carries the method, path and body, so authorization, validation and audit stay where they already live.
* **Merged**: the Home "Coming up" reminders (`HomeReminders`) became *Today*; the Me → "Acting as" chips became the Home role switcher (switching also sets the matching account role used by the rest of the app).
* **Kept separate on purpose**: *Following* (`spectator_follows`) is for spectator alerts; pins are shortcuts to records you run and are limited to records you already have a role in. `get_dashboard` is unchanged (other screens use it).

## API / MCP

All are capabilities (REST + OpenAPI + MCP): `list_workspace_contexts`, `get_command_centre` (`section`, `role`, `scope_id`), `update_workspace_prefs`, `pin_workspace_item`, `unpin_workspace_item`, `save_workspace_filter`, `delete_workspace_filter`.

Security: the role and scope in a request are checked against live memberships (`403` for a role you do not hold, `404` for a scope that is not yours), pins and filters are validated server-side, clinical queues list only that something is waiting, and a guardian sees a child's selections only with current participation consent (audited as `read_child_schedule`).
