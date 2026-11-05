-- PS-03: Consented athlete accessibility and operational accommodations
-- Additive only. Extends academy_accommodation_shares with per-event context and purpose.
-- Adds athlete contact preferences, staff checklist tracking, and correction requests.

-- 1. Extend shares: event context, purpose, context tag (backwards-compatible: all nullable/defaulted)
ALTER TABLE academy_accommodation_shares
  ADD COLUMN IF NOT EXISTS context         text NOT NULL DEFAULT 'academy' CHECK (context IN ('academy','event')),
  ADD COLUMN IF NOT EXISTS event_id        uuid REFERENCES events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS purpose         text,
  ADD COLUMN IF NOT EXISTS purpose_key     text CHECK (purpose_key IN ('competition_day','training_session','transport','arrival','other'));

CREATE INDEX IF NOT EXISTS idx_acc_shares_event ON academy_accommodation_shares(event_id) WHERE event_id IS NOT NULL;

-- 2. Athlete accessible contact & arrival preferences (encrypted PII)
CREATE TABLE IF NOT EXISTS athlete_contact_preferences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_mode    text NOT NULL DEFAULT 'app' CHECK (contact_mode IN ('app','email','sms','bsl_interpreter')),
  alt_contact_name_enc  text,
  alt_contact_phone_enc text,
  arrival_instructions_enc text,
  entry_point_enc  text,
  updated_by      uuid REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(athlete_id)
);

-- 3. Staff accommodation checklist items (per need-key per share per session/event)
CREATE TABLE IF NOT EXISTS accommodation_checklist_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id        uuid NOT NULL REFERENCES academy_accommodation_shares(id) ON DELETE CASCADE,
  athlete_id      uuid NOT NULL REFERENCES users(id),
  organisation_id uuid NOT NULL,
  session_id      uuid,
  event_id        uuid,
  need_key        text NOT NULL,
  arranged_at     timestamptz,
  arranged_by     uuid REFERENCES users(id),
  arrangement_note text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(share_id, need_key, COALESCE(session_id::text,''), COALESCE(event_id::text,''))
);

CREATE INDEX IF NOT EXISTS idx_checklist_session ON accommodation_checklist_items(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checklist_event   ON accommodation_checklist_items(event_id)   WHERE event_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checklist_share   ON accommodation_checklist_items(share_id);

-- 4. Data subject correction requests
CREATE TABLE IF NOT EXISTS accommodation_correction_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id      uuid NOT NULL REFERENCES users(id),
  description_enc text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_review','resolved','closed')),
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES users(id),
  resolution_note_enc text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_corr_requests_athlete ON accommodation_correction_requests(athlete_id);
