# Event planning: create, contact, book, budget

Everything an organiser does around an event, as capabilities (REST + OpenAPI + MCP, tag **Event planning**) and in the
app (`Play → Create an event`, then **⚡ Event console → Business** (Requests and Budget) on the event page; counterparts answer in
**More → Event requests**).

## Creating an event
`create_event` takes **one or several sports** (`sports: [...]`). One sport = a normal event. More than one = a
multi-sport programme (one discipline per sport, see [multi-sport-events.md](multi-sport-events.md)). Dates are a
range (calendar picker in the app). `venue_requests: [{ venue_id, sports, message, offer_cents }]` sends a **booking
request to each venue** for the event dates and sports — a venue you run yourself is just set. The app's wizard
(Basics → Sports → When & where → Details) suggests, per sport, only venues that really have courts/grounds for it
(`find_venues_for_sports`, `GET /venue-finder`).

## Contact → quote → finalize
One request model for every counterpart (`event_requests`):

| Kind | Who answers | Finalizing does |
|---|---|---|
| team | team owner / captain / manager | team enters the event (a team invite without a fee completes on accept) |
| coach, volunteer | the person | budget line |
| referee, umpire, judge, scorer, timekeeper, physio, doctor, first aider | the person (needs the matching platform role) | joins the event crew at the agreed rate (+ budget line) |
| venue | venue owner / staff | sets the event venue; budget line |
| supplier | the supplier | budget line (kit, trophies, catering…) |
| sponsor | the sponsor | active sponsorship + income line |
| insurer | the insurer, **in the insurance desk** | handed to the existing insurance quote flow; finalize after accepting a quote there |

Flow: `find_event_partners` → `create_event_request` (offer a price or let them quote; `send:false` keeps a draft) →
recipient `respond_event_request` (accept / quote / decline, with a negotiation thread) → organiser
`finalize_event_request` (agreed amount committed to the budget, effect applied) or `cancel_event_request`.
Recipients see their inbox with `list_my_event_requests`; everyone involved is notified.

## Budget
`get_event_budget`: lines (planned / **committed** = agreed with a counterpart / **paid**), totals and forecast,
net position, contingency %, approved **spend cap** and alerts (over plan, over cap, income not covering spend).
`set_event_budget`, `add_budget_line`, `update_budget_line`, `record_budget_payment` (spend paid or income received),
`void_budget_payment`, `export_event_budget` (CSV). Finalized bookings add their own lines. Payments and lines are
voided or closed, never deleted. The platform records money; it does not move it.

## Tasks and the control room
`generate_event_checklist` creates the standard planning tasks dated back from the start date (repeat-safe; edit,
assign or drop them), `create_event_task`, `update_event_task` (the owner can update status), `list_event_tasks`.
`get_event_plan` shows requests by kind/status, what waits for your finalize, budget position, overdue tasks and what is
missing (venue, insurance, officials, medical cover, budget).

## Data safety
Migration `029_event_planning.sql` is additive. Requests are cancelled, never removed; budget payments are voided with a
reason; tasks are dropped. Nothing is deleted.
