-- Referee reporting extract (#88 follow-up). Additive only. An optional fee and payment status on an official assignment (recorded by the organiser,
-- confirmed or disputed by the official; money settled through #71 stays there), structured post-match feedback with a right of reply, and the
-- frozen, fingerprinted PDF extract a referee owns and may share by revocable link.
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS fee_minor bigint CHECK (fee_minor IS NULL OR fee_minor >= 0);
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS fee_currency text CHECK (fee_currency IS NULL OR fee_currency ~ '^[A-Z]{3}$');
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS pay_status text NOT NULL DEFAULT 'none' CHECK (pay_status IN ('none','agreed','due','paid','disputed'));
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS pay_updated_at timestamptz;
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS pay_updated_by uuid REFERENCES users(id);
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS pay_confirmed_at timestamptz;

CREATE TABLE IF NOT EXISTS fixture_official_pay_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_official_id uuid NOT NULL REFERENCES fixture_officials(id),
  actor_id            uuid NOT NULL REFERENCES users(id),
  fee_minor           bigint,
  fee_currency        text,
  from_status         text NOT NULL,
  to_status           text NOT NULL,
  note                text CHECK (note IS NULL OR length(note) <= 300),
  at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixture_official_pay_log_fo ON fixture_official_pay_log(fixture_official_id, at);

-- Feedback about an official on one match, from a team manager or the event organiser. Fixed criteria, never one overall score; the author is not shown to the official.
CREATE TABLE IF NOT EXISTS official_feedback (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_official_id uuid NOT NULL REFERENCES fixture_officials(id),
  fixture_id          uuid NOT NULL REFERENCES fixtures(id),
  author_id           uuid NOT NULL REFERENCES users(id),
  capacity            text NOT NULL CHECK (capacity IN ('team_official','event_official')),
  team_id             uuid REFERENCES teams(id),
  ratings             jsonb NOT NULL,
  comment_enc         text,
  status              text NOT NULL DEFAULT 'published' CHECK (status IN ('published','contested','hidden')),
  moderation_reason   text CHECK (moderation_reason IS NULL OR length(moderation_reason) <= 500),
  moderated_by        uuid REFERENCES users(id),
  moderated_at        timestamptz,
  contest_reason      text CHECK (contest_reason IS NULL OR length(contest_reason) <= 500),
  reply_enc           text,
  replied_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fixture_official_id, author_id)
);
CREATE INDEX IF NOT EXISTS official_feedback_fo ON official_feedback(fixture_official_id, status);

CREATE TABLE IF NOT EXISTS official_extracts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  sport_id     uuid REFERENCES sports(id),
  period_from  date NOT NULL,
  period_to    date NOT NULL,
  sha256       text NOT NULL,
  file_name    text NOT NULL,
  size_bytes   int NOT NULL,
  pages        int NOT NULL,
  counts       jsonb NOT NULL DEFAULT '{}',
  client_key   text CHECK (client_key IS NULL OR length(client_key) BETWEEN 8 AND 80),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_key)
);
CREATE INDEX IF NOT EXISTS official_extracts_user ON official_extracts(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS official_extract_shares (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extract_id   uuid NOT NULL REFERENCES official_extracts(id),
  recipient_id uuid NOT NULL REFERENCES users(id),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS official_extract_shares_live ON official_extract_shares(extract_id, recipient_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS official_extract_shares_recipient ON official_extract_shares(recipient_id, expires_at);

-- The brand kit (logo, name, colours) an event uses on its documents, including the referee's closure reports. Chosen by the organiser from kits they may use.
ALTER TABLE events ADD COLUMN IF NOT EXISTS brand_kit_id uuid REFERENCES brand_kits(id);
