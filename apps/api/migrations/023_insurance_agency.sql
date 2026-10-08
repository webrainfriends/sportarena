-- Insurance as a segment of its own: insurers run their own desk (profile, plans, offers), people request and track quotes,
-- accepted quotes become policies, policies renew, and the paperwork is kept with the policy.
-- Additive only: nothing existing is changed, dropped or rewritten, and nothing here is ever deleted (rows are retired with a status
-- or removed_at; the event logs are append-only).

-- An insurer can now be run by a SportArena account holding the `insurer` role.
ALTER TABLE insurers
  ADD COLUMN owner_id           uuid REFERENCES users,
  ADD COLUMN headline           text,
  ADD COLUMN regions            text[]  NOT NULL DEFAULT '{}',      -- where they sell (free text, e.g. city or country)
  ADD COLUMN sports             text[]  NOT NULL DEFAULT '{}',      -- sport slugs they specialise in; empty = all
  ADD COLUMN accepting_requests boolean NOT NULL DEFAULT true,      -- false: hidden from "request a quote" but plans stay visible
  ADD COLUMN updated_at         timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX insurers_owner ON insurers (owner_id) WHERE owner_id IS NOT NULL;

-- Advertising: a labelled offer on a plan (shown as an offer, never used to rank results).
ALTER TABLE insurance_plans
  ADD COLUMN promo_text     text,
  ADD COLUMN promo_ends_on  date;

-- Policies: where they came from and renewal bookkeeping.
ALTER TABLE insurance_policies
  ADD COLUMN quote_id            uuid,                                     -- FK added below (quotes are created after)
  ADD COLUMN renewed_from        uuid REFERENCES insurance_policies,
  ADD COLUMN renewal_notice_days int;                                      -- the last reminder sent: 30 or 7 days before the end
CREATE UNIQUE INDEX insurance_policies_renewed_from ON insurance_policies (renewed_from) WHERE renewed_from IS NOT NULL;
CREATE INDEX insurance_policies_ends ON insurance_policies (ends_on) WHERE status = 'active';

-- A request for a quote: for yourself, a team you manage or an event/tournament you organise.
-- insurer_id NULL = open to every insurer that accepts requests; plan_id is set when asked from a plan card.
CREATE TABLE insurance_quote_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id  uuid NOT NULL REFERENCES users,
  insurer_id    uuid REFERENCES insurers,
  plan_id       uuid REFERENCES insurance_plans,
  cover_for     text NOT NULL CHECK (cover_for IN ('individual','team','event')),
  subject_id    uuid NOT NULL,                                -- yourself, the team or the event
  months        int  NOT NULL DEFAULT 12 CHECK (months BETWEEN 1 AND 36),
  participants  int  CHECK (participants > 0),                -- squad size / expected entrants: what insurers price on
  sport         text,                                         -- sport slug
  message_enc   text,                                         -- free text can contain health details: encrypted
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','quoted','accepted','cancelled','declined')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX insurance_quote_requests_requester ON insurance_quote_requests (requester_id, created_at DESC);
CREATE INDEX insurance_quote_requests_inbox ON insurance_quote_requests (status, insurer_id);

-- An insurer passing on a request (the request itself stays open for other insurers).
CREATE TABLE insurance_request_declines (
  request_id uuid NOT NULL REFERENCES insurance_quote_requests,
  insurer_id uuid NOT NULL REFERENCES insurers,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, insurer_id)
);

-- A quote: an insurer's priced offer on one of its plans, valid until a date. request_id NULL = offered directly to a person.
CREATE TABLE insurance_quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    uuid REFERENCES insurance_quote_requests,
  insurer_id    uuid NOT NULL REFERENCES insurers,
  plan_id       uuid NOT NULL REFERENCES insurance_plans,
  buyer_id      uuid NOT NULL REFERENCES users,
  cover_for     text NOT NULL CHECK (cover_for IN ('individual','team','event')),
  subject_id    uuid NOT NULL,
  months        int  NOT NULL CHECK (months BETWEEN 1 AND 36),
  premium_cents bigint NOT NULL CHECK (premium_cents >= 0),     -- per month, like plans
  coverage_cents bigint NOT NULL CHECK (coverage_cents > 0),
  deductible_cents bigint NOT NULL DEFAULT 0 CHECK (deductible_cents >= 0),
  waiting_period_days int NOT NULL DEFAULT 0 CHECK (waiting_period_days >= 0),
  currency      text NOT NULL,
  note          text,                                           -- what the insurer wants the buyer to know (public to the buyer only)
  valid_until   date NOT NULL,
  status        text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','accepted','declined','withdrawn','expired')),
  policy_id     uuid REFERENCES insurance_policies,
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX insurance_quotes_buyer ON insurance_quotes (buyer_id, created_at DESC);
CREATE INDEX insurance_quotes_insurer ON insurance_quotes (insurer_id, status, created_at DESC);
CREATE INDEX insurance_quotes_request ON insurance_quotes (request_id);
ALTER TABLE insurance_policies ADD CONSTRAINT insurance_policies_quote_fk FOREIGN KEY (quote_id) REFERENCES insurance_quotes;

-- Messages between the requester and one insurer about a request.
CREATE TABLE insurance_request_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES insurance_quote_requests,
  insurer_id  uuid NOT NULL REFERENCES insurers,
  sender_id   uuid NOT NULL REFERENCES users,
  body_enc    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX insurance_request_messages_thread ON insurance_request_messages (request_id, insurer_id, created_at);

-- The tracker: every step of a request or quote, append-only. actor NULL = the platform (e.g. a quote expiring).
CREATE TABLE insurance_quote_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid REFERENCES insurance_quote_requests,
  quote_id    uuid REFERENCES insurance_quotes,
  insurer_id  uuid REFERENCES insurers,
  actor_id    uuid REFERENCES users,
  action      text NOT NULL,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (request_id IS NOT NULL OR quote_id IS NOT NULL)
);
CREATE INDEX insurance_quote_events_request ON insurance_quote_events (request_id, created_at);
CREATE INDEX insurance_quote_events_quote ON insurance_quote_events (quote_id, created_at);
CREATE FUNCTION insurance_quote_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'insurance_quote_events is append-only'; END $$;
CREATE TRIGGER insurance_quote_events_append_only BEFORE UPDATE OR DELETE ON insurance_quote_events FOR EACH ROW EXECUTE FUNCTION insurance_quote_events_guard();

-- Insurance documents: schedules, certificates, receipts, claim evidence. Files are encrypted at rest and never deleted
-- (removed_at hides a document). Exactly one of policy / quote / claim says what it belongs to.
CREATE TABLE insurance_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id    uuid REFERENCES insurance_policies,
  quote_id     uuid REFERENCES insurance_quotes,
  claim_id     uuid REFERENCES insurance_claims,
  kind         text NOT NULL CHECK (kind IN ('policy_schedule','certificate','receipt','quote','claim_evidence','other')),
  title        text NOT NULL,
  content_type text NOT NULL,
  file_name    text NOT NULL,
  size_bytes   bigint NOT NULL,
  sha256       text NOT NULL,                                 -- of the plain file, so a copy can be checked
  uploaded_by  uuid NOT NULL REFERENCES users,
  removed_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(policy_id, quote_id, claim_id) = 1)
);
CREATE INDEX insurance_documents_policy ON insurance_documents (policy_id) WHERE removed_at IS NULL;
CREATE INDEX insurance_documents_quote ON insurance_documents (quote_id) WHERE removed_at IS NULL;
CREATE INDEX insurance_documents_claim ON insurance_documents (claim_id) WHERE removed_at IS NULL;
