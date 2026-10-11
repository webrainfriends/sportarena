# Coaching marketplace

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
