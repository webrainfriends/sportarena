-- Account security (issue #60, gap 1d): email verification, password recovery tokens, TOTP MFA with recovery codes.
-- Additive only. Nothing is deleted or overwritten: a replaced/disabled MFA factor is kept with disabled_at + reason.

-- Existing accounts stay NULL (their email was never verified; we do not claim otherwise). Login does not require it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

-- One-time secrets, stored only as SHA-256 hashes. purpose: email_verify | password_reset | mfa_login (short-lived login challenge).
CREATE TABLE account_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users,
  purpose    text NOT NULL CHECK (purpose IN ('email_verify','password_reset','mfa_login')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  attempts   int NOT NULL DEFAULT 0,       -- wrong-code guesses against an mfa_login challenge
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_tokens_user_idx ON account_tokens (user_id, purpose, created_at DESC);

-- TOTP factor (RFC 6238). secret_enc is field-encrypted (src/crypto.js). enabled_at NULL = set-up started, not confirmed yet.
CREATE TABLE user_mfa (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users,
  secret_enc      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  enabled_at      timestamptz,
  disabled_at     timestamptz,
  disabled_reason text,                    -- superseded | user | admin_reset
  last_step       bigint NOT NULL DEFAULT 0 -- highest accepted 30s time step: a code cannot be replayed
);
CREATE UNIQUE INDEX user_mfa_one_live ON user_mfa (user_id) WHERE disabled_at IS NULL;

CREATE TABLE mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mfa_id     uuid NOT NULL REFERENCES user_mfa,
  user_id    uuid NOT NULL REFERENCES users,
  code_hash  text NOT NULL UNIQUE,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_recovery_user_idx ON mfa_recovery_codes (user_id);

-- A session that completed a second factor (at sign-in, or by step-up with verify_mfa).
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;
