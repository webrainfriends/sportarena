-- Sign in with Google: the Google account id (the ID token's `sub`) is stored on the user; additive, nothing existing changes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users (google_sub) WHERE google_sub IS NOT NULL;
