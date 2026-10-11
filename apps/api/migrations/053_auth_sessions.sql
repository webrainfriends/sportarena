-- Revocable server-side sessions and rotating refresh tokens (issue #60, gap 1b). Additive only; no deletes, no cascades.
-- A session is also the refresh-token "family": reuse of an already-rotated refresh token revokes the whole session.
CREATE TABLE auth_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text,          -- logout | logout_all | revoked | password_changed | refresh_reuse | expired
  user_agent     text,
  ip             text
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id, created_at DESC);

CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES auth_sessions,
  token_hash   text NOT NULL UNIQUE,   -- sha256 of the secret; the secret is shown once
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,            -- set when rotated; presenting it again = reuse = compromise
  replaced_by  uuid REFERENCES refresh_tokens
);
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id);
