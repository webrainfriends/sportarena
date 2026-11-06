-- 173_elite_venue_modals.sql
-- Elite academy venue modals: wizard-driven contract, service and timetable fields.
-- Additive only. No DROP, no TRUNCATE, no data loss.

-- ── 1. venue_coach_ties: full contract wizard fields ──────────────────────────
ALTER TABLE venue_coach_ties
  ADD COLUMN IF NOT EXISTS contract_type text CHECK (contract_type IS NULL OR contract_type IN ('staff','independent','visiting_specialist','master_clinician')),
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS end_date date,
  ADD COLUMN IF NOT EXISTS probation_months smallint CHECK (probation_months IS NULL OR probation_months IN (0,1,3,6)),
  ADD COLUMN IF NOT EXISTS notice_period_days int CHECK (notice_period_days IS NULL OR notice_period_days > 0),
  ADD COLUMN IF NOT EXISTS bonus_model text CHECK (bonus_model IS NULL OR bonus_model IN ('none','win_based','milestone','retention')),
  ADD COLUMN IF NOT EXISTS bonus_trigger_enc text,  -- encrypted; plain-text operation description, not personal data
  ADD COLUMN IF NOT EXISTS bonus_per_trigger_cents bigint CHECK (bonus_per_trigger_cents IS NULL OR bonus_per_trigger_cents >= 0),
  ADD COLUMN IF NOT EXISTS max_sessions_per_day smallint CHECK (max_sessions_per_day IS NULL OR max_sessions_per_day BETWEEN 1 AND 24),
  ADD COLUMN IF NOT EXISTS max_students_per_session smallint CHECK (max_students_per_session IS NULL OR max_students_per_session BETWEEN 1 AND 200),
  ADD COLUMN IF NOT EXISTS session_format text CHECK (session_format IS NULL OR session_format IN ('1on1','small_group','group','squad')),
  ADD COLUMN IF NOT EXISTS age_groups text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS performance_levels text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS kit_provided boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS equipment_allocated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS non_compete boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS media_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_period text CHECK (review_period IS NULL OR review_period IN ('monthly','quarterly','biannual')),
  ADD COLUMN IF NOT EXISTS kpi_retention_pct smallint CHECK (kpi_retention_pct IS NULL OR kpi_retention_pct BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS kpi_feedback_min numeric(3,1) CHECK (kpi_feedback_min IS NULL OR kpi_feedback_min BETWEEN 0 AND 5),
  ADD COLUMN IF NOT EXISTS kpi_ranking_lift smallint,
  -- para-sport (operational / coaching only; no classification data stored here — PS-21)
  ADD COLUMN IF NOT EXISTS para_classification_awareness text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS para_adaptive_experience text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS para_comm_adaptations text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS para_guide_role boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS para_equipment_trained boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS internal_note_enc text;  -- venue-admin only; never shared with the coach

-- ── 2. svc_requirements: priority, accessibility, supplier requirements ───────
ALTER TABLE svc_requirements
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'standard' CHECK (priority IN ('critical','high','standard','low')),
  ADD COLUMN IF NOT EXISTS tech_requirements text CHECK (tech_requirements IS NULL OR length(tech_requirements) <= 2000),
  ADD COLUMN IF NOT EXISTS quality_standards text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS accessibility_requirements text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS contract_type text CHECK (contract_type IS NULL OR contract_type IN ('one_off','retainer','season','annual')),
  ADD COLUMN IF NOT EXISTS sla_hours int CHECK (sla_hours IS NULL OR sla_hours > 0),
  ADD COLUMN IF NOT EXISTS payment_terms text CHECK (payment_terms IS NULL OR payment_terms IN ('upfront','half_upfront','on_delivery','net30')),
  ADD COLUMN IF NOT EXISTS min_supplier_experience_years smallint CHECK (min_supplier_experience_years IS NULL OR min_supplier_experience_years >= 0),
  ADD COLUMN IF NOT EXISTS supplier_references_required smallint CHECK (supplier_references_required IS NULL OR supplier_references_required >= 0),
  ADD COLUMN IF NOT EXISTS people_on_site smallint CHECK (people_on_site IS NULL OR people_on_site > 0),
  ADD COLUMN IF NOT EXISTS insurance_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS prior_sports_venue_exp boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS security_clearance boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS para_accessibility_flags text[] NOT NULL DEFAULT '{}';

-- ── 3. schedule_windows: booking rules, eligibility, para-sport flags ─────────
ALTER TABLE schedule_windows
  ADD COLUMN IF NOT EXISTS booking_type text CHECK (booking_type IS NULL OR booking_type IN ('public','members','academy_class','private_coaching','group','event_reserved')),
  ADD COLUMN IF NOT EXISTS min_advance_booking_hours smallint CHECK (min_advance_booking_hours IS NULL OR min_advance_booking_hours >= 0),
  ADD COLUMN IF NOT EXISTS max_advance_booking_days smallint CHECK (max_advance_booking_days IS NULL OR max_advance_booking_days > 0),
  ADD COLUMN IF NOT EXISTS max_bookings_per_member smallint CHECK (max_bookings_per_member IS NULL OR max_bookings_per_member > 0),
  ADD COLUMN IF NOT EXISTS buffer_min smallint CHECK (buffer_min IS NULL OR buffer_min >= 0),
  ADD COLUMN IF NOT EXISTS eligibility_who text CHECK (eligibility_who IS NULL OR eligibility_who IN ('everyone','members','students','staff')),
  ADD COLUMN IF NOT EXISTS membership_tiers text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS age_min smallint CHECK (age_min IS NULL OR age_min >= 0),
  ADD COLUMN IF NOT EXISTS age_max smallint,
  ADD COLUMN IF NOT EXISTS cancellation_policy text CHECK (cancellation_policy IS NULL OR cancellation_policy IN ('flexible','standard','strict','non_refundable')),
  ADD COLUMN IF NOT EXISTS late_cancel_pct smallint CHECK (late_cancel_pct IS NULL OR late_cancel_pct BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS para_accessible_surface boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS para_equipment_on_court boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS para_lowered_net boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS para_guide_slot boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS para_priority text CHECK (para_priority IS NULL OR para_priority IN ('open','para_only','para_priority'));
