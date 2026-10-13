-- Sign in with Apple: the stable per-app Apple user id (the id token's "sub"). Additive; nothing existing changes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_sub text;
CREATE UNIQUE INDEX IF NOT EXISTS users_apple_sub_idx ON users (apple_sub) WHERE apple_sub IS NOT NULL;
