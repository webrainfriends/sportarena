-- 219: Referee professional references and endorsements (#1002 REF-R33)
-- Additive only: extends official_portfolio_references (migration 207), adds 3 new tables.
-- Distinct from: official-reputation.js (public testimony / off_testimony),
--                officials-assessments.js (formal private assessments).

-- ------------------------------------------------------------------ extend official_portfolio_references
ALTER TABLE official_portfolio_references
  ADD COLUMN IF NOT EXISTS referee_type            text
    CHECK (referee_type IN ('federation','club','assignor','academy','coach','event_organiser')),
  ADD COLUMN IF NOT EXISTS invite_method           text NOT NULL DEFAULT 'direct'
    CHECK (invite_method IN ('direct','verified_association','secure_link')),
  ADD COLUMN IF NOT EXISTS invite_token            text UNIQUE,
  ADD COLUMN IF NOT EXISTS invite_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS invitee_email_enc       text,
  ADD COLUMN IF NOT EXISTS tenure_from             date,
  ADD COLUMN IF NOT EXISTS tenure_to               date,
  ADD COLUMN IF NOT EXISTS sport_context_enc       text,
  ADD COLUMN IF NOT EXISTS is_confidential         bool NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS consent_given           bool NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS consent_at              timestamptz,
  ADD COLUMN IF NOT EXISTS expiry_date             date,
  ADD COLUMN IF NOT EXISTS is_verified             bool NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verifier_org_id         uuid REFERENCES organisations(id),
  ADD COLUMN IF NOT EXISTS conflict_flag           bool NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS conflict_reason         text CHECK (length(conflict_reason) <= 300),
  ADD COLUMN IF NOT EXISTS moderation_status       text NOT NULL DEFAULT 'none'
    CHECK (moderation_status IN ('none','flagged','cleared','redacted')),
  ADD COLUMN IF NOT EXISTS moderated_by            uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS moderated_at            timestamptz,
  ADD COLUMN IF NOT EXISTS moderation_note         text CHECK (length(moderation_note) <= 500);

CREATE INDEX IF NOT EXISTS opr_invite_token ON official_portfolio_references(invite_token)
  WHERE invite_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS opr_moderation   ON official_portfolio_references(moderation_status)
  WHERE moderation_status <> 'none';
CREATE INDEX IF NOT EXISTS opr_expiry       ON official_portfolio_references(expiry_date)
  WHERE expiry_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS opr_referee_type ON official_portfolio_references(referee_type, user_id);

-- ------------------------------------------------------------------ official_reference_corrections
CREATE TABLE IF NOT EXISTS official_reference_corrections (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id        uuid        NOT NULL REFERENCES official_portfolio_references(id),
  requester_id        uuid        NOT NULL REFERENCES users(id),
  reason_enc          text        NOT NULL,
  proposed_change_enc text,
  status              text        NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','resolved','dismissed')),
  resolved_by         uuid        REFERENCES users(id),
  resolved_at         timestamptz,
  resolve_note        text        CHECK (length(resolve_note) <= 500),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orc_reference ON official_reference_corrections(reference_id, status);
CREATE INDEX IF NOT EXISTS orc_requester ON official_reference_corrections(requester_id);

-- ------------------------------------------------------------------ official_reference_reports
CREATE TABLE IF NOT EXISTS official_reference_reports (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id        uuid        NOT NULL REFERENCES official_portfolio_references(id),
  reporter_id         uuid        NOT NULL REFERENCES users(id),
  reason              text        NOT NULL
    CHECK (reason IN ('self_endorsement','conflict','inaccurate','abusive','spam','other')),
  detail_enc          text,
  status              text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','reviewed','actioned','dismissed')),
  reviewed_by         uuid        REFERENCES users(id),
  reviewed_at         timestamptz,
  review_note         text        CHECK (length(review_note) <= 500),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orr_reference ON official_reference_reports(reference_id, status);
CREATE INDEX IF NOT EXISTS orr_reporter  ON official_reference_reports(reporter_id);
CREATE INDEX IF NOT EXISTS orr_pending   ON official_reference_reports(status)
  WHERE status = 'pending';

-- ------------------------------------------------------------------ official_reference_audit
CREATE TABLE IF NOT EXISTS official_reference_audit (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id  uuid        NOT NULL REFERENCES official_portfolio_references(id),
  actor_id      uuid        REFERENCES users(id),
  action        text        NOT NULL,
  payload       jsonb       NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ora_reference ON official_reference_audit(reference_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ora_actor     ON official_reference_audit(actor_id);
