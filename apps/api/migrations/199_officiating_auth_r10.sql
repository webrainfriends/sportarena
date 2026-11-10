-- REF-R10: Officiating authorization, privacy and audit
-- Additive only — no drops, no data loss.

-- (a) Track which assignor placed a crew invitation
ALTER TABLE fixture_officials
  ADD COLUMN IF NOT EXISTS assignor_delegated_by uuid REFERENCES users(id);

-- (b) Assignor grant: organiser delegates invite rights to a neutral assignor per event
CREATE TABLE IF NOT EXISTS official_assignor_grants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id),
  assignor_id  uuid NOT NULL REFERENCES users(id),
  granted_by   uuid NOT NULL REFERENCES users(id),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  revoke_note  text CHECK (revoke_note IS NULL OR length(revoke_note) <= 300),
  UNIQUE (event_id, assignor_id)
);
CREATE INDEX IF NOT EXISTS assignor_grants_event  ON official_assignor_grants(event_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS assignor_grants_person ON official_assignor_grants(assignor_id) WHERE revoked_at IS NULL;

-- (c) Offline pack revocation log — push record so the app drops stale cached packs
CREATE TABLE IF NOT EXISTS scorer_pack_revocations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_official_id uuid NOT NULL REFERENCES fixture_officials(id),
  user_id             uuid NOT NULL REFERENCES users(id),
  fixture_id          uuid NOT NULL REFERENCES fixtures(id),
  reason              text NOT NULL CHECK (reason IN ('released','withdrawn','cancelled','suspended')),
  revoked_at          timestamptz NOT NULL DEFAULT now(),
  notified_at         timestamptz
);
CREATE INDEX IF NOT EXISTS pack_revocations_user ON scorer_pack_revocations(user_id, revoked_at DESC);
