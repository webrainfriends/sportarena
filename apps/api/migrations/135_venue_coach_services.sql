-- Venue + coach services, part 1: a tie-up between a venue and a coach, and a shared roster of coaching slots.
-- Either side proposes; the other side agrees, amends (a counter-proposal), or rejects; either side can cancel.
-- Additive only. Nothing is deleted: a finished tie or slot keeps its row and its history.

CREATE TABLE IF NOT EXISTS venue_coach_ties (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id       uuid NOT NULL REFERENCES venues,
  coach_id       uuid NOT NULL REFERENCES users,
  kind           text NOT NULL CHECK (kind IN ('staff','independent')),
  status         text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','agreed','rejected','cancelled')),
  proposed_by    text NOT NULL CHECK (proposed_by IN ('venue','coach')),   -- whose turn it is not: the other side answers
  pay_model      text NOT NULL DEFAULT 'revenue_share' CHECK (pay_model IN ('revenue_share','flat_fee','staff')),
  share_bp       int CHECK (share_bp BETWEEN 0 AND 10000),                -- the coach's share of a coached session, in basis points
  flat_fee_cents bigint CHECK (flat_fee_cents >= 0),
  sport_ids      uuid[] NOT NULL DEFAULT '{}',
  note_enc       text,
  row_version    int NOT NULL DEFAULT 1,
  created_by     uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  decided_by     uuid REFERENCES users,
  ended_at       timestamptz
);
-- one live (open or agreed) tie per venue and coach
CREATE UNIQUE INDEX IF NOT EXISTS venue_coach_ties_live ON venue_coach_ties (venue_id, coach_id) WHERE status IN ('proposed','agreed');
CREATE INDEX IF NOT EXISTS venue_coach_ties_coach ON venue_coach_ties (coach_id, status);

CREATE TABLE IF NOT EXISTS venue_coach_slots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tie_id        uuid REFERENCES venue_coach_ties,                          -- null for an ad-hoc request with no standing tie
  venue_id      uuid NOT NULL REFERENCES venues,
  coach_id      uuid NOT NULL REFERENCES users,
  sport_id      uuid REFERENCES sports,
  resource_id   uuid REFERENCES resources,                                 -- the court, when one is fixed
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','agreed','rejected','cancelled','expired')),
  proposed_by   text NOT NULL CHECK (proposed_by IN ('venue','coach')),
  price_cents   bigint CHECK (price_cents >= 0),
  note_enc      text,
  block_id      uuid,                                                      -- the venue_blocks batch that holds the court while the slot is agreed
  series_id     uuid,                                                      -- slots proposed together
  row_version   int NOT NULL DEFAULT 1,
  created_by    uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS venue_coach_slots_venue ON venue_coach_slots (venue_id, starts_at) WHERE status IN ('proposed','agreed');
CREATE INDEX IF NOT EXISTS venue_coach_slots_coach ON venue_coach_slots (coach_id, starts_at) WHERE status IN ('proposed','agreed');
-- append-only history of every move on a tie or a slot
CREATE TABLE IF NOT EXISTS venue_coach_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('tie','slot')),
  subject_id   uuid NOT NULL,
  action       text NOT NULL CHECK (action IN ('propose','amend','agree','reject','cancel','expire')),
  actor_id     uuid REFERENCES users,
  side         text CHECK (side IN ('venue','coach')),
  from_status  text,
  to_status    text,
  detail       jsonb,
  reason_enc   text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS venue_coach_events_subject ON venue_coach_events (subject_type, subject_id, at);
