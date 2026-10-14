-- Doctor workspace (issue #212, slice 2c): referrals between doctors, physios and external providers. Additive only.
-- A referral shares only the items the referring doctor selected, only after the athlete consents to THIS referral, and only while it is live.
-- Status for an external recipient is never fabricated: the platform cannot know that another clinic accepted or completed care.
CREATE TABLE IF NOT EXISTS clinical_referrals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     uuid NOT NULL REFERENCES users,
  from_provider_id uuid NOT NULL REFERENCES users,
  to_provider_id uuid REFERENCES users,
  external_recipient text,
  reason_enc     text NOT NULL,
  requested_action_enc text,
  shared_enc     text NOT NULL,            -- JSON [{label,text}] chosen by the referring doctor: the whole of what the recipient may read
  urgency        text NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine','priority','urgent')),
  expires_at     timestamptz,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','acknowledged','accepted','declined','booked','completed','closed','withdrawn')),
  consent        text NOT NULL DEFAULT 'pending' CHECK (consent IN ('pending','granted','declined')),
  consent_at     timestamptz,
  appointment_id uuid REFERENCES appointments,
  return_summary_enc text,
  version        int NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((to_provider_id IS NULL) <> (external_recipient IS NULL)),
  CHECK (to_provider_id IS NULL OR to_provider_id <> from_provider_id),
  CHECK (external_recipient IS NULL OR status IN ('draft','sent','closed','withdrawn'))
);
CREATE INDEX IF NOT EXISTS clinical_referrals_patient ON clinical_referrals (athlete_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS clinical_referrals_from ON clinical_referrals (from_provider_id, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS clinical_referrals_to ON clinical_referrals (to_provider_id, status, created_at DESC, id) WHERE to_provider_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS clinical_referral_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL REFERENCES clinical_referrals,
  actor_id    uuid NOT NULL REFERENCES users,
  action      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clinical_referral_events_ref ON clinical_referral_events (referral_id, created_at, id);
CREATE OR REPLACE FUNCTION clinical_referral_events_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'clinical_referral_events is append-only' USING ERRCODE = 'check_violation'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS clinical_referral_events_append_only ON clinical_referral_events;
CREATE TRIGGER clinical_referral_events_append_only BEFORE UPDATE OR DELETE ON clinical_referral_events FOR EACH ROW EXECUTE FUNCTION clinical_referral_events_append_only();
