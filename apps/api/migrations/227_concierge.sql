-- Sports Concierge: LLM-agnostic conversational assistant with permission-controlled action approval (issue #72).
-- All tables are additive; nothing existing is modified.

-- LLM provider configurations. Keys always come from env vars — never stored here.
CREATE TABLE concierge_provider_configs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider   TEXT NOT NULL CHECK (provider IN ('anthropic','openai','google')),
  model      TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO concierge_provider_configs(provider, model, is_default)
  VALUES ('anthropic', 'claude-sonnet-5-5', true);

-- Conversation sessions. One per user/context pair.
CREATE TABLE concierge_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  title           TEXT,
  context         JSONB NOT NULL DEFAULT '{}',   -- {org_id?, event_id?, sport?}
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ
);
CREATE INDEX ON concierge_sessions(user_id, status, updated_at DESC);

-- Immutable message history. User-typed text is field-encrypted.
CREATE TABLE concierge_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES concierge_sessions(id),
  role         TEXT NOT NULL CHECK (role IN ('user','assistant','tool_result')),
  content_enc  TEXT,                                     -- encrypt(text, 'concierge_messages.content')
  content_hash TEXT,                                     -- sha256 for de-dup; never the plaintext
  tool_calls   JSONB,                                    -- [{name, params_hash, preview, approval_id}]
  tool_results JSONB,                                    -- [{name, redacted_result}] *_enc + PII stripped
  model        TEXT,
  provider     TEXT,
  tokens_in    INT NOT NULL DEFAULT 0,
  tokens_out   INT NOT NULL DEFAULT 0,
  latency_ms   INT,
  seq          BIGINT GENERATED ALWAYS AS IDENTITY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON concierge_messages(session_id, seq);

-- Immutable approval records. Bound to actor, params, price snapshot and expiry.
-- A confirmed approval row cannot be re-used: params_hash + proposal_hash must be unique among pending/approved.
CREATE TABLE concierge_approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES concierge_sessions(id),
  message_id      UUID NOT NULL REFERENCES concierge_messages(id),
  actor_id        UUID NOT NULL REFERENCES users(id),
  capability_name TEXT NOT NULL,
  params_hash     TEXT NOT NULL,     -- sha256(canonicalJson(params))
  proposal        JSONB NOT NULL,    -- price/slot/participants shown to the user
  proposal_hash   TEXT NOT NULL,     -- sha256(JSON.stringify(proposal)) — replay guard
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','expired','replayed','stale')),
  expires_at      TIMESTAMPTZ NOT NULL,   -- created_at + 5 minutes
  decided_at      TIMESTAMPTZ,
  executed_at     TIMESTAMPTZ,
  result          JSONB,                   -- redacted execution result
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON concierge_approvals(params_hash, proposal_hash)
  WHERE status IN ('pending','approved');
CREATE INDEX ON concierge_approvals(session_id, status);
CREATE INDEX ON concierge_approvals(actor_id, status, expires_at);

-- Append-only audit log for every approval lifecycle event.
CREATE TABLE concierge_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES concierge_sessions(id),
  actor_id        UUID NOT NULL REFERENCES users(id),
  event_kind      TEXT NOT NULL CHECK (event_kind IN (
                    'tool_proposed','tool_approved','tool_rejected',
                    'tool_executed','tool_failed','approval_expired',
                    'replay_blocked','stale_blocked')),
  capability_name TEXT NOT NULL,
  params_hash     TEXT NOT NULL,
  approval_id     UUID REFERENCES concierge_approvals(id),
  meta            JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON concierge_audit(session_id, created_at DESC);
CREATE INDEX ON concierge_audit(actor_id, created_at DESC);
