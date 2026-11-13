-- Fan & Community Feed — moderation, rate limits, audit and promotions (issue #522). Additive only.
-- Existing social_reports (136_social_graph) handles person-level social reports.
-- This adds feed-card-specific reports, rate limits (rolling window per user/action), an
-- immutable audit log and a promotions table for clearly-labelled paid placement.
-- Platform moderators (PLATFORM_ADMIN_EMAILS) have full scope; org moderators are scoped to their org only.

-- Feed-card and comment reports.
CREATE TABLE IF NOT EXISTS feed_reports (
  id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  reporter_id  uuid        NOT NULL REFERENCES users,
  target_kind  text        NOT NULL CHECK (target_kind IN ('feed_card','feed_comment','feed_challenge')),
  target_id    uuid        NOT NULL,
  reason       text        NOT NULL CHECK (reason IN ('harassment','unsafe_content','misinformation','spam','youth_safety','impersonation','other')),
  note_enc     text,       -- encrypted free text from the reporter
  scope_org_id uuid        REFERENCES organisations,   -- set when the reporter is an org moderator
  status       text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed','escalated')),
  decided_by   uuid        REFERENCES users,
  decided_at   timestamptz,
  escalated_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter_id, target_kind, target_id)
);
CREATE INDEX IF NOT EXISTS feed_reports_open   ON feed_reports (status, created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS feed_reports_target ON feed_reports (target_kind, target_id);

-- Rolling-window rate limits: one row per (user, action_kind, window_start).
-- The capability layer checks count < limit before writing; a 429 is returned when over limit.
CREATE TABLE IF NOT EXISTS feed_rate_limits (
  user_id      uuid        NOT NULL REFERENCES users,
  action_kind  text        NOT NULL CHECK (action_kind IN ('comment','reaction','post','report','challenge_entry')),
  window_start timestamptz NOT NULL,   -- truncated to the hour
  count        int         NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, action_kind, window_start)
);
CREATE INDEX IF NOT EXISTS feed_rate_limits_user ON feed_rate_limits (user_id, action_kind, window_start DESC);

-- Immutable audit log: every moderation action is appended here. No updates or deletes.
CREATE TABLE IF NOT EXISTS feed_audit_events (
  id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  action_kind  text        NOT NULL,   -- e.g. 'hide_card', 'restore_card', 'escalate_report', 'verify_evidence'
  actor_id     uuid        NOT NULL REFERENCES users,
  target_kind  text        NOT NULL,
  target_id    text        NOT NULL,
  reason_enc   text,
  context      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_audit_events_actor  ON feed_audit_events (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feed_audit_events_target ON feed_audit_events (target_kind, target_id, created_at DESC);

-- Paid promotions: labelled placement purchased by organisations, applied to specific feed cards.
-- Organic ranking and official results are NEVER affected by payment.
CREATE TABLE IF NOT EXISTS feed_promotions (
  id               uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  promoted_by_org  uuid        NOT NULL REFERENCES organisations,
  card_id          uuid        NOT NULL REFERENCES feed_cards,
  start_at         timestamptz NOT NULL,
  end_at           timestamptz NOT NULL,
  budget_cents     bigint      NOT NULL CHECK (budget_cents > 0),
  impressions      bigint      NOT NULL DEFAULT 0,
  approved_by      uuid        REFERENCES users,
  approved_at      timestamptz,
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','paused','ended','rejected')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS feed_promotions_active ON feed_promotions (start_at, end_at) WHERE status = 'active';
