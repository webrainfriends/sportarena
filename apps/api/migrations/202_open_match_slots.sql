-- REF-R14: Open match self-assignment (#1006).
-- Organisers publish per-fixture-role open slots; eligible officials browse, claim (instant-confirm
-- or apply for organiser approval) and join a waitlist. All additive — no existing tables modified.

-- ── (a) Open match slots ───────────────────────────────────────────────────
-- One row per fixture × role. status moves draft→open→full/closed/cancelled.
-- `filled` is maintained atomically by the claim / approve / cancel handlers.
CREATE TABLE IF NOT EXISTS open_match_slots (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id              uuid        NOT NULL REFERENCES fixtures(id),
  event_id                uuid        NOT NULL REFERENCES events(id),
  role                    text        NOT NULL
                            CHECK (role IN (
                              'referee','umpire','linesman','scorer',
                              'video_assistant_referee','fourth_official','reserve_assistant_referee',
                              'shot_clock_operator','timekeeper','goal_line_official','technical_official',
                              'chair_umpire','match_commissioner','technical_delegate','starter','marshal'
                            )),
  min_grade               text,
  min_grade_rank          integer,
  required_credentials    jsonb       NOT NULL DEFAULT '[]',
  min_experience_months   integer     NOT NULL DEFAULT 0 CHECK (min_experience_months >= 0),
  reporting_min           integer     NOT NULL DEFAULT 0 CHECK (reporting_min >= 0),
  fee_minor               bigint      CHECK (fee_minor >= 0),
  fee_currency            text,
  pay_direction           text        NOT NULL DEFAULT 'organiser_pays'
                            CHECK (pay_direction IN ('organiser_pays','official_invoices')),
  approval_mode           text        NOT NULL DEFAULT 'instant'
                            CHECK (approval_mode IN ('instant','approval')),
  allow_waitlist          boolean     NOT NULL DEFAULT true,
  slots                   integer     NOT NULL DEFAULT 1 CHECK (slots > 0 AND slots <= 50),
  filled                  integer     NOT NULL DEFAULT 0 CHECK (filled >= 0),
  notes                   text,
  private_notes_enc       text,
  application_deadline    timestamptz,
  status                  text        NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','open','full','closed','cancelled')),
  published_at            timestamptz,
  published_by            uuid        REFERENCES users(id),
  closed_at               timestamptz,
  closed_by               uuid        REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fixture_id, role),
  CHECK (filled <= slots)
);

CREATE INDEX IF NOT EXISTS open_match_slots_fixture ON open_match_slots(fixture_id, status);
CREATE INDEX IF NOT EXISTS open_match_slots_event   ON open_match_slots(event_id, status);
CREATE INDEX IF NOT EXISTS open_match_slots_open    ON open_match_slots(status, application_deadline)
  WHERE status = 'open';

-- ── (b) Open slot applications ────────────────────────────────────────────
-- One row per official per slot. Status flow:
--   pending    → approved / rejected / withdrawn
--   waitlisted → approved (auto-promote) / withdrawn
--   approved   → cancelled
CREATE TABLE IF NOT EXISTS open_slot_applications (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id               uuid        NOT NULL REFERENCES open_match_slots(id),
  user_id               uuid        NOT NULL REFERENCES users(id),
  status                text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected',
                                            'waitlisted','withdrawn','cancelled')),
  fixture_official_id   uuid        REFERENCES fixture_officials(id),
  fee_snapshot          jsonb,
  eligibility_snapshot  jsonb,
  conflict_summary      jsonb,
  apply_note_enc        text,
  waitlist_position     integer     CHECK (waitlist_position > 0),
  applied_at            timestamptz NOT NULL DEFAULT now(),
  decided_at            timestamptz,
  decided_by            uuid        REFERENCES users(id),
  decision_note_enc     text,
  withdrawn_at          timestamptz,
  UNIQUE (slot_id, user_id)
);

CREATE INDEX IF NOT EXISTS osa_slot_status ON open_slot_applications(slot_id, status);
CREATE INDEX IF NOT EXISTS osa_user_status ON open_slot_applications(user_id, status);
CREATE INDEX IF NOT EXISTS osa_waitlist    ON open_slot_applications(slot_id, waitlist_position)
  WHERE status = 'waitlisted';

-- ── (c) Application history (append-only) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS open_slot_application_history (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid        NOT NULL REFERENCES open_slot_applications(id),
  actor_id        uuid        REFERENCES users(id),
  from_status     text,
  to_status       text        NOT NULL,
  reason          text,
  at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS osa_hist_app ON open_slot_application_history(application_id, at DESC);
