# Coach marketplace

One flow for athletes and coaches: **find or post → compare → book → pay → track → review**. Everything is a capability
(`apps/api/src/capabilities/hire.js`, `coach-market.js`), so REST, OpenAPI and MCP behave the same as the app.

## Athlete
* **Find a coach** — `GET /coaches` filters by sport, name/speciality, city, in-person/online, max hourly rate, minimum rating, verified credential and
  "has open hours"; sorts by rating, rate, most sessions or name. `GET /coaches/:id` is the public profile (about, sports and rates, rating
  breakdown, reviews, sessions coached, weekly hours).
* **Book** — `GET /coaches/:id/slots` returns real open start times from the coach's weekly hours minus sessions already requested/confirmed.
  `POST /hires` enforces the grid when the coach published hours, and refuses coaches who are not taking new athletes. A coach with no hours
  gets a proposed time instead.
* **Post a request** — `POST /coach-requests` (sport, goal, level, delivery, city, hourly budget, sessions per week, preferred days, start date).
  Coaches of that sport are notified. `GET /coach-requests/:id` shows every answer with rate, first session, rating, verification and sessions coached.
  `POST /coach-responses/:id/decision` accepts (creates the hire, declines the other answers) or declines. `POST /coach-requests/:id/close` closes it.
* **Track** — `GET /coaching/overview` (upcoming sessions, sessions waiting for payment, sessions to review, answers waiting, what you owe and have booked)
  and `GET /coaching/payments` (ledger with paid/refunded dates).
* **Review** — `POST /hires/:id/review`: one 1–5 review per completed session, written by the athlete who booked it.

## Coach
* `POST /me/coach-profile`, `POST /me/coach-availability` (weekly hours in your own time zone; replaced windows are kept as history).
* `GET /coach-requests` (board, default only your sports) → `POST /coach-requests/:id/respond` (rate, first session, message; answering again
  edits it) → `POST /coach-responses/:id/withdraw`.
* An accepted answer is already agreed by the coach, so **paying confirms the session** (`payments/service.js` `fulfil`); a hire booked directly still
  needs the coach to confirm after payment.
* `GET /coaching/overview` (coach side: to confirm, upcoming, earned vs awaiting payment, rating, unanswered reviews, open requests) and
  `GET /coaching/payments?as=coach`. Reply to a review once with `POST /coach-reviews/:id/reply`.

## Rules
* Minors cannot post requests or appear in coach search; at most 5 open requests per athlete.
* Nothing is deleted: closed/filled requests, declined/withdrawn answers and replaced hours stay as history.
* Only the athlete of a completed session can review it; ratings come from `coach_reviews` only.
* With no payment provider configured, sessions are `not_required` and shown as "pay direct"; they confirm without payment.

Migration: `031_coach_marketplace.sql` (additive).

## Coach business tools (`coach-business.js`, migration `032_coach_business.sql`)
* **Rate cards** — `POST/PATCH/GET /coach/rate-cards`: a named price for one kind of work. Audience `individual | group | team | event`, unit `hour | session | day | month | package`, per-person pricing, headcount limits, trial offers. Retired cards are archived, never deleted. `POST /hires` with `rate_card_id` takes price, length and audience from the card; team bookings need a team the booker manages, event bookings the organiser.
* **Specialisations** — `POST/GET/DELETE(archive) /coach/specialisations`; shown on the profile, searchable, and used to group reports.
* **Contracts & commitments** — `POST/GET/PATCH /coach/commitments`, `POST /coach/commitments/:id/log`. A weekly pattern or one-off date; occurrences are computed, what happened is logged (delivered / skipped / cancelled). They appear in `/coach/calendar`, block athlete booking and open-slot search, and creating one reports clashes with existing sessions.
* **Testimonials** — coaches write testimonials for athletes they actively coach (`/coach/athletes/:id/testimonial`), ask for a review once per completed session, and pin up to three reviews.
* **Analytics & statement** — `GET /coach/analytics` (income, sessions, hours, clients, repeat rate, ratings, cancellations, request win rate, utilisation of open hours, breakdowns by month / client type / sport / rate card / specialisation) and `GET /coach/report` (CSV statement).
* **Discoverability** — a posted coach request is also a Community card (`market_posts.coach_request_id`, kind `wanted`) and appears under Open positions → Coaching requests. Any signed-in person can open it; if they are not yet a coach for that sport the page offers "Coach <sport>", which adds the sport profile and the coach role.

## Venues for coaching (`venue-sessions.js`, migration `033_venue_sessions.sql`)
Either the coach or the athlete can book a court and attach the coaching/training session(s) to it. A *session* is a coach hire or a training-plan session; the link (`session_venue_links`) points a session at one line of a venue reservation. Many sessions may share a line; a session has one live venue; a link that stops applying is released, never deleted.
* **Recurring coaching** — `POST /hires/series`: a weekly pattern (weekdays, every N weeks, until a date or for N sessions), custom extra dates and skipped dates. One hire per date (`coach_hires.series_id`), each confirmed/paid separately. `preview: true` checks every date and prices the series; `on_conflict` skips unbookable dates (default) or refuses the lot.
* **Court for sessions** — `POST /training/venues/quote` and `/book`: any selection of sessions (one, a series, bulk or custom) + a court (or a different court per session) + optional set-up/clean-up buffers → one reservation with a line per session, each session linked. Conflicts are reported per session and skipped or refused (`on_conflict`). The other party is told.
* **Attach to an existing booking** — `POST /training/venues/attach` (a session must fit inside the booked time; without `sessions` every matching session of yours is attached). `DELETE /training/venues/links/:id` detaches without cancelling the booking.
* **Recurring court bookings** — `POST /reservations/recurring` (+ `/quote`): a pattern or custom dates at the same venue-local time, up to 60 dates, one reservation; `attach_sessions` picks up your sessions that fall inside.
* **Visibility** — `GET /training/venues/board` (sessions needing a court vs held); `venue` on `/coach/calendar`, `/coaching/overview`, `/hires` and the athlete schedule; `sessions` on every reservation view (the venue team sees the coaching on its bookings). Cancelling a hire releases its link.
