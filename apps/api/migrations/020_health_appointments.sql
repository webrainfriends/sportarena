-- Health appointments: payment, follow-ups and external (third-party) booking. All additive.
-- Payment: appointments become a payable purpose (same hosted-checkout flow as coach hires).
ALTER TABLE payments DROP CONSTRAINT payments_purpose_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_type_check CHECK (purpose_type IN ('shop_order','coach_hire','insurance_policy','venue_invoice','wallet_topup','gift_card','venue_plan','appointment'));

ALTER TABLE appointments
  ADD COLUMN fee_cents      bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  ADD COLUMN currency       text,
  ADD COLUMN payment_status text NOT NULL DEFAULT 'not_required' CHECK (payment_status IN ('not_required','unpaid','paid','refunded')),
  ADD COLUMN mode           text NOT NULL DEFAULT 'in_person' CHECK (mode IN ('in_person','remote')),
  -- bookings made on the provider's own system: only the minimum is stored (never credentials)
  ADD COLUMN source               text NOT NULL DEFAULT 'sportarena' CHECK (source IN ('sportarena','external')),
  ADD COLUMN external_provider    text,
  ADD COLUMN external_reference   text,
  ADD COLUMN external_url         text,
  ADD COLUMN external_sync_status text CHECK (external_sync_status IN ('linked','synced','stale','error')),
  ADD COLUMN external_synced_at   timestamptz;
-- the same external booking can only ever be one SportArena appointment
CREATE UNIQUE INDEX appointments_external_ref ON appointments (provider_id, external_provider, external_reference) WHERE external_reference IS NOT NULL;

-- Providers who book through another site say where; this is public discovery data.
ALTER TABLE provider_profiles
  ADD COLUMN external_provider    text,
  ADD COLUMN external_booking_url text;

-- Follow-ups agreed at an appointment. instruction_summary is what the athlete is told; details_enc is sensitive, encrypted
-- and readable only by the athlete or by a provider with an active full consent. Clinical notes stay in medical_records.
CREATE TABLE appointment_followups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES appointments,
  athlete_id     uuid NOT NULL REFERENCES users,
  provider_id    uuid NOT NULL REFERENCES users,
  status         text NOT NULL DEFAULT 'due' CHECK (status IN ('due','booked','done','cancelled')),
  due_on         date NOT NULL,
  window_end     date,
  instruction_summary text NOT NULL,
  details_enc    text,
  booked_appointment_id uuid REFERENCES appointments,
  reminder_sent_at timestamptz,
  completed_at   timestamptz,
  closed_by      uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end IS NULL OR window_end >= due_on)
);
CREATE INDEX followups_athlete ON appointment_followups (athlete_id, status, due_on);
CREATE INDEX followups_provider ON appointment_followups (provider_id, status, due_on);
CREATE INDEX followups_reminders ON appointment_followups (due_on) WHERE status = 'due' AND reminder_sent_at IS NULL;

-- reminders for confirmed appointments (follow-up reminders use appointment_followups.reminder_sent_at)
ALTER TABLE appointments ADD COLUMN reminded_at timestamptz;
