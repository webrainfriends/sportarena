-- Event planning: the organiser's outbound requests (invite a team, hire a coach/referee/physio, ask a supplier,
-- venue or insurer for a quote, ask a sponsor), the budget (planned / committed / paid) and the planning tasks.
-- Additive only. Nothing is deleted: requests are cancelled, payments are voided, lines are closed/voided.

-- One request/invitation/RFQ from an event to a counterpart. Recipient answers (accept / quote / decline), the
-- organiser finalizes, and finalizing has an effect (team entry, crew post, sponsorship, budget line).
CREATE TABLE event_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events,
  kind            text NOT NULL CHECK (kind IN ('team','coach','referee','umpire','judge','scorer','timekeeper','physio','doctor','first_aider','volunteer','supplier','venue','insurer','sponsor')),
  recipient_id    uuid REFERENCES users,          -- person to notify / who answers (team owner, venue owner, sponsor owner, the individual…)
  team_id         uuid REFERENCES teams,
  venue_id        uuid REFERENCES venues,
  sponsor_id      uuid REFERENCES sponsors,
  insurer_id      uuid REFERENCES insurers,
  target_name     text NOT NULL,                  -- name shown in lists
  title           text NOT NULL,
  message         text,
  sport_ids       uuid[] NOT NULL DEFAULT '{}',   -- which sports this is for (venues, officials)
  starts_on       date,
  ends_on         date,
  quantity        int CHECK (quantity >= 1),
  offer_cents     bigint CHECK (offer_cents >= 0), -- what the organiser proposes to pay (or, for sponsors, asks for)
  quote_cents     bigint CHECK (quote_cents >= 0), -- what the counterpart quotes
  currency        text NOT NULL DEFAULT 'INR',
  quote_note      text,
  quote_valid_until date,
  status          text NOT NULL DEFAULT 'sent' CHECK (status IN ('draft','sent','quoted','accepted','declined','finalized','cancelled')),
  ref_type        text,                           -- e.g. insurance_quote_request: the request lives in another module
  ref_id          uuid,
  budget_line_id  uuid,
  responded_at    timestamptz,
  finalized_at    timestamptz,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_requests_event ON event_requests (event_id, status);
CREATE INDEX event_requests_recipient ON event_requests (recipient_id, status);
CREATE UNIQUE INDEX event_requests_open ON event_requests (event_id, kind, coalesce(team_id, venue_id, sponsor_id, insurer_id, recipient_id), title)
  WHERE status IN ('draft','sent','quoted','accepted');

CREATE TABLE event_request_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES event_requests,
  sender_id  uuid NOT NULL REFERENCES users,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_request_messages_req ON event_request_messages (request_id, created_at);

-- Budget
CREATE TABLE event_budgets (
  event_id        uuid PRIMARY KEY REFERENCES events,
  currency        text NOT NULL DEFAULT 'INR',
  spend_cap_cents bigint CHECK (spend_cap_cents >= 0),     -- approved ceiling for total expenses
  contingency_pct int NOT NULL DEFAULT 0 CHECK (contingency_pct BETWEEN 0 AND 100),
  notes           text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE event_budget_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events,
  direction       text NOT NULL CHECK (direction IN ('expense','income')),
  category        text NOT NULL CHECK (category IN ('venue','officials','medical','equipment','catering','insurance','marketing','prizes','staff','transport','admin','contingency','sponsorship','entry_fees','tickets','merchandise','other')),
  name            text NOT NULL,
  planned_cents   bigint NOT NULL DEFAULT 0 CHECK (planned_cents >= 0),
  committed_cents bigint NOT NULL DEFAULT 0 CHECK (committed_cents >= 0),   -- agreed with a counterpart (finalized request)
  status          text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','committed','closed','void')),
  request_id      uuid REFERENCES event_requests,
  notes           text,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_budget_lines_event ON event_budget_lines (event_id);
CREATE UNIQUE INDEX event_budget_lines_request ON event_budget_lines (request_id) WHERE request_id IS NOT NULL AND status <> 'void';
CREATE TABLE event_budget_payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  line_id     uuid NOT NULL REFERENCES event_budget_lines,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  paid_on     date NOT NULL DEFAULT current_date,
  method      text CHECK (method IN ('cash','bank','card','upi','cheque','other')),
  reference   text,
  note        text,
  recorded_by uuid REFERENCES users,
  voided_at   timestamptz,
  voided_by   uuid REFERENCES users,
  void_reason text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_budget_payments_line ON event_budget_payments (line_id) WHERE voided_at IS NULL;

-- Planning tasks
CREATE TABLE event_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events,
  title         text NOT NULL,
  category      text NOT NULL DEFAULT 'general' CHECK (category IN ('general','venue','people','officials','medical','equipment','catering','insurance','sponsors','marketing','safety','finance','legal','logistics')),
  owner_id      uuid REFERENCES users,
  due_on        date,
  priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  status        text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','blocked','done','dropped')),
  notes         text,
  request_id    uuid REFERENCES event_requests,
  created_by    uuid REFERENCES users,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_tasks_event ON event_tasks (event_id, status, due_on);
CREATE UNIQUE INDEX event_tasks_title ON event_tasks (event_id, lower(title)) WHERE status <> 'dropped';
