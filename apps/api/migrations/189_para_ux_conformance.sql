-- PS-08: Para-sport UX acceptance suite — conformance matrix, defects, release gate.
-- Additive only. No DROP/TRUNCATE/rewrite.

CREATE TABLE IF NOT EXISTS para_conformance_entries (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  journey         text        NOT NULL CHECK (journey IN (
                                'athlete_onboarding','sport_discovery','classification_status',
                                'tournament_entry','booking','coach_booking','learning',
                                'health','sponsorship','support_person')),
  platform        text        NOT NULL CHECK (platform IN ('ios','ipados','android','web')),
  tech            text        NOT NULL CHECK (tech IN (
                                'voiceover','talkback','keyboard','switch_control','magnification')),
  status          text        NOT NULL DEFAULT 'untested' CHECK (status IN (
                                'untested','partial','conformant','deferred','not_applicable')),
  evidence_ref    text,
  tested_by       uuid        REFERENCES users(id),
  tested_at       timestamptz,
  notes           text,
  row_version     int         NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(journey, platform, tech)
);

CREATE TABLE IF NOT EXISTS para_conformance_defects (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  journey             text        NOT NULL CHECK (journey IN (
                                    'athlete_onboarding','sport_discovery','classification_status',
                                    'tournament_entry','booking','coach_booking','learning',
                                    'health','sponsorship','support_person')),
  platform            text        NOT NULL CHECK (platform IN ('ios','ipados','android','web')),
  screen              text,
  title               text        NOT NULL,
  severity            text        NOT NULL DEFAULT 'major' CHECK (severity IN ('critical','major','minor')),
  description         text        NOT NULL,
  steps_to_reproduce  text,
  status              text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','wont_fix')),
  resolved_at         timestamptz,
  resolved_by         uuid        REFERENCES users(id),
  resolution_note     text,
  evidence_ref        text,
  wcag_criterion      text,
  row_version         int         NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Additive a11y columns on para_learn_modules (caption/alt-text gap vs para-spectator-accessibility.js which covers media streams, not learning modules)
ALTER TABLE para_learn_modules ADD COLUMN IF NOT EXISTS caption_ref        text;
ALTER TABLE para_learn_modules ADD COLUMN IF NOT EXISTS audio_desc_ref     text;
ALTER TABLE para_learn_modules ADD COLUMN IF NOT EXISTS transcript_ref     text;
ALTER TABLE para_learn_modules ADD COLUMN IF NOT EXISTS a11y_reviewed_at   timestamptz;
ALTER TABLE para_learn_modules ADD COLUMN IF NOT EXISTS a11y_reviewed_by   uuid REFERENCES users(id);

-- Notification sensitivity rules: prevents classification codes / clinical labels leaking into push notification bodies
CREATE TABLE IF NOT EXISTS para_notification_sensitivity_rules (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_type text        NOT NULL,
  field_path        text        NOT NULL,
  action            text        NOT NULL DEFAULT 'redact' CHECK (action IN ('redact','replace','suppress')),
  replacement       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE(notification_type, field_path)
);

-- Default sensitivity rules (additive seed — idempotent)
INSERT INTO para_notification_sensitivity_rules(notification_type, field_path, action, replacement)
VALUES
  ('classification_update', 'payload.class_code',    'replace', 'your classification status'),
  ('classification_update', 'payload.decision_ref',  'redact',  NULL),
  ('para_entry_decision',   'payload.reason',         'redact',  NULL)
ON CONFLICT(notification_type, field_path) DO NOTHING;

CREATE INDEX IF NOT EXISTS para_conformance_entries_journey_idx ON para_conformance_entries(journey);
CREATE INDEX IF NOT EXISTS para_conformance_entries_status_idx  ON para_conformance_entries(status);
CREATE INDEX IF NOT EXISTS para_conformance_defects_severity_idx ON para_conformance_defects(severity, status);
