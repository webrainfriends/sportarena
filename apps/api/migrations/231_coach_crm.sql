-- Migration 231: Coach Business CRM (issue #517)
-- Lead/enquiry funnel, trial workflow, lifecycle dashboard, retention analytics,
-- campaigns, remote video review service, business team assignments.
-- Additive only — no DROP, no TRUNCATE, no rewriting existing data.

-- ─── coach_crm_leads ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coach_crm_leads (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id             uuid        NOT NULL REFERENCES users(id),
  athlete_id           uuid        REFERENCES users(id),
  athlete_name_enc     text,
  stage                text        NOT NULL DEFAULT 'new_lead'
                         CHECK (stage IN ('new_lead','contacted','trial_offered','trial_booked',
                                          'trial_completed','proposal_offered','won','lost','nurture')),
  source_kind          text        NOT NULL DEFAULT 'manual_entry'
                         CHECK (source_kind IN ('marketplace_enquiry','billboard_response',
                                                'referral','academy_team_context','manual_entry')),
  source_ref_id        uuid,
  campaign_ref         text,
  owner_id             uuid        REFERENCES users(id),
  next_action_on       date,
  loss_reason          text        CHECK (loss_reason IN ('price','timing','chose_other_coach',
                                     'location','no_response','changed_mind','not_eligible','other')),
  loss_note_enc        text,
  marketing_consent    boolean     NOT NULL DEFAULT false,
  sport_id             uuid        REFERENCES sports(id),
  created_by           uuid        NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz,
  row_version          int         NOT NULL DEFAULT 1,
  CONSTRAINT coach_crm_leads_identity CHECK (
    (athlete_id IS NOT NULL AND athlete_name_enc IS NULL) OR
    (athlete_id IS NULL AND athlete_name_enc IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS coach_crm_leads_coach_stage
  ON coach_crm_leads(coach_id, stage) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS coach_crm_leads_athlete
  ON coach_crm_leads(athlete_id) WHERE athlete_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS coach_crm_leads_owner
  ON coach_crm_leads(owner_id) WHERE owner_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS coach_crm_leads_next_action
  ON coach_crm_leads(coach_id, next_action_on) WHERE archived_at IS NULL AND next_action_on IS NOT NULL;

-- ─── coach_crm_lead_events ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coach_crm_lead_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      uuid        NOT NULL REFERENCES coach_crm_leads(id),
  action       text        NOT NULL,
  from_stage   text,
  to_stage     text,
  actor_id     uuid        NOT NULL REFERENCES users(id),
  note_enc     text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_crm_lead_events_lead
  ON coach_crm_lead_events(lead_id, created_at DESC);

-- ─── coach_crm_lead_communications ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coach_crm_lead_communications (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id          uuid        NOT NULL REFERENCES coach_crm_leads(id),
  actor_id         uuid        NOT NULL REFERENCES users(id),
  kind             text        NOT NULL
                     CHECK (kind IN ('note','call','meeting','email','message','trial_offer',
                                     'trial_outcome','proposal_sent','proposal_response','decision')),
  summary_enc      text        NOT NULL,
  follow_up_on     date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  idempotency_key  text        UNIQUE
);
CREATE INDEX IF NOT EXISTS coach_crm_lead_comms_lead
  ON coach_crm_lead_communications(lead_id, created_at DESC);

-- ─── coach_crm_trials ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coach_crm_trials (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id              uuid        REFERENCES coach_crm_leads(id),
  coach_id             uuid        NOT NULL REFERENCES users(id),
  athlete_id           uuid        REFERENCES users(id),
  athlete_name_enc     text,
  sport_id             uuid        REFERENCES sports(id),
  rate_card_id         uuid        REFERENCES coach_rate_cards(id),
  scheduled_on         date        NOT NULL,
  starts_at            timestamptz,
  duration_min         int,
  location_note_enc    text,
  price_cents          bigint      NOT NULL DEFAULT 0,
  currency             text        NOT NULL DEFAULT 'GBP',
  discount_pct         int         NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  status               text        NOT NULL DEFAULT 'offered'
                         CHECK (status IN ('offered','booked','attended','no_show','cancelled','converted')),
  payment_status       text        NOT NULL DEFAULT 'not_required'
                         CHECK (payment_status IN ('not_required','awaiting_payment','paid','refunded')),
  hire_id              uuid        REFERENCES coach_hires(id),
  attendance_note_enc  text,
  follow_up_on         date,
  won_hire_id          uuid        REFERENCES coach_hires(id),
  won_package_id       uuid        REFERENCES coach_package_purchases(id),
  won_subscription_id  uuid        REFERENCES coach_subscriptions(id),
  created_by           uuid        NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz,
  row_version          int         NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS coach_crm_trials_coach
  ON coach_crm_trials(coach_id, scheduled_on DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS coach_crm_trials_lead
  ON coach_crm_trials(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS coach_crm_trials_athlete
  ON coach_crm_trials(athlete_id) WHERE athlete_id IS NOT NULL;

-- ─── coach_crm_staff_assignments ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coach_crm_staff_assignments (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      uuid        REFERENCES coach_crm_leads(id),
  trial_id     uuid        REFERENCES coach_crm_trials(id),
  staff_id     uuid        NOT NULL REFERENCES users(id),
  role         text        NOT NULL DEFAULT 'handler'
                 CHECK (role IN ('handler','observer')),
  assigned_by  uuid        NOT NULL REFERENCES users(id),
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT coach_crm_staff_target CHECK (
    (lead_id IS NOT NULL AND trial_id IS NULL) OR
    (lead_id IS NULL AND trial_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS coach_crm_staff_lead
  ON coach_crm_staff_assignments(lead_id) WHERE lead_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS coach_crm_staff_member
  ON coach_crm_staff_assignments(staff_id) WHERE archived_at IS NULL;

-- ─── coach_crm_campaigns ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coach_crm_campaigns (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id         uuid        NOT NULL REFERENCES users(id),
  name             text        NOT NULL,
  kind             text        NOT NULL
                     CHECK (kind IN ('programme_announcement','availability_slots',
                                     'package_renewal','clinic_camp','re_engagement','general')),
  status           text        NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','scheduled','sending','sent','cancelled')),
  audience_filter  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  use_case_key     text        NOT NULL,
  template_vars    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at     timestamptz,
  sent_at          timestamptz,
  recipient_count  int         NOT NULL DEFAULT 0,
  delivered_count  int         NOT NULL DEFAULT 0,
  created_by       uuid        NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,
  row_version      int         NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS coach_crm_campaigns_coach
  ON coach_crm_campaigns(coach_id, created_at DESC) WHERE archived_at IS NULL;

-- ─── coach_crm_campaign_recipients ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coach_crm_campaign_recipients (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       uuid        NOT NULL REFERENCES coach_crm_campaigns(id),
  user_id           uuid        NOT NULL REFERENCES users(id),
  status            text        NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','sent','suppressed','failed')),
  suppressed_reason text,
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_crm_campaign_recipients_campaign
  ON coach_crm_campaign_recipients(campaign_id, status);
CREATE INDEX IF NOT EXISTS coach_crm_campaign_recipients_user
  ON coach_crm_campaign_recipients(user_id);

-- ─── coach_video_review_requests ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coach_video_review_requests (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id                  uuid        NOT NULL REFERENCES users(id),
  athlete_id                uuid        NOT NULL REFERENCES users(id),
  sport_id                  uuid        REFERENCES sports(id),
  rate_card_id              uuid        REFERENCES coach_rate_cards(id),
  hire_id                   uuid        REFERENCES coach_hires(id),
  package_purchase_id       uuid        REFERENCES coach_package_purchases(id),
  observation_id            uuid        NOT NULL,
  title                     text        NOT NULL,
  brief_enc                 text        NOT NULL,
  feedback_enc              text,
  feedback_given_at         timestamptz,
  timestamps_json           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  assignments_json          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status                    text        NOT NULL DEFAULT 'awaiting_upload'
                               CHECK (status IN ('awaiting_upload','uploaded','under_review',
                                                 'review_complete','acknowledged','archived')),
  submitted_at              timestamptz,
  completed_at              timestamptz,
  athlete_acknowledged_at   timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  archived_at               timestamptz,
  row_version               int         NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS coach_video_review_coach
  ON coach_video_review_requests(coach_id, created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS coach_video_review_athlete
  ON coach_video_review_requests(athlete_id, created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS coach_video_review_hire
  ON coach_video_review_requests(hire_id) WHERE hire_id IS NOT NULL;

-- ─── updated_at / row_version triggers ───────────────────────────────────────
CREATE OR REPLACE FUNCTION coach_crm_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); NEW.row_version = OLD.row_version + 1; RETURN NEW; END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['coach_crm_leads','coach_crm_trials','coach_crm_campaigns','coach_video_review_requests'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'stamp_' || t AND tgrelid = t::regclass) THEN
      EXECUTE format('CREATE TRIGGER stamp_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION coach_crm_stamp()', t, t);
    END IF;
  END LOOP;
END;
$$;
