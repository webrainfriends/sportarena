-- Player recruitment pipeline (issue #314). Extends billboard_responses (the Billboard application) instead of adding a parallel table.
-- Additive only: new columns with safe defaults, new tables, one CHECK widened (never narrowed), an idempotent backfill. Nothing is dropped or rewritten.
-- Rollback: stop using the new columns/tables; legacy `status` is kept in sync so the old Billboard behaviour is unchanged.

-- 'withdrawn' joins pending|accepted|declined (widening a CHECK, existing rows stay valid)
ALTER TABLE billboard_responses DROP CONSTRAINT IF EXISTS billboard_responses_status_check;
ALTER TABLE billboard_responses ADD CONSTRAINT billboard_responses_status_check CHECK (status IN ('pending','accepted','declined','withdrawn'));

ALTER TABLE billboard_responses
  ADD COLUMN IF NOT EXISTS stage            text NOT NULL DEFAULT 'applied' CHECK (stage IN ('applied','shortlisted','trial','evaluated','offered','accepted','declined','withdrawn')),
  ADD COLUMN IF NOT EXISTS row_version      int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS stage_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS source_kind      text CHECK (source_kind IS NULL OR source_kind IN ('passport','video','profile','other')),
  ADD COLUMN IF NOT EXISTS source_ref_enc   text,                                   -- the applicant's evidence link (https), encrypted; decrypting is audit-logged
  ADD COLUMN IF NOT EXISTS applied_by       uuid REFERENCES users,                  -- the guardian who applied for a young person (null = the applicant)
  ADD COLUMN IF NOT EXISTS idempotency_key  text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80),
  ADD COLUMN IF NOT EXISTS trial_at         timestamptz,
  ADD COLUMN IF NOT EXISTS trial_venue_id   uuid REFERENCES venues,
  ADD COLUMN IF NOT EXISTS trial_note       text CHECK (trial_note IS NULL OR length(trial_note) <= 200);
CREATE INDEX IF NOT EXISTS billboard_responses_stage ON billboard_responses (post_id, stage, created_at, id);
CREATE INDEX IF NOT EXISTS billboard_responses_responder ON billboard_responses (responder_id, created_at DESC, id);

-- backfill: the legacy status maps to the matching stage (idempotent; only rows still at the default are touched)
UPDATE billboard_responses SET stage = status WHERE status IN ('accepted','declined','withdrawn') AND stage = 'applied';

-- every stage change, trial, evaluation, offer and withdrawal is an immutable event (who, when, from -> to)
CREATE TABLE IF NOT EXISTS recruitment_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id     uuid NOT NULL REFERENCES billboard_responses,
  kind            text NOT NULL CHECK (kind IN ('applied','stage','trial','evaluation','offer','offer_response','offer_expired','withdrawn','legacy_decision')),
  from_stage      text,
  to_stage        text,
  actor_id        uuid REFERENCES users,
  note            text CHECK (note IS NULL OR length(note) <= 500),
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recruitment_events_response ON recruitment_events (response_id, created_at, id);
-- a retried request carries the same key and is answered from the first result
CREATE UNIQUE INDEX IF NOT EXISTS recruitment_events_idem ON recruitment_events (response_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
DROP TRIGGER IF EXISTS recruitment_events_ao ON recruitment_events;
CREATE TRIGGER recruitment_events_ao BEFORE UPDATE OR DELETE ON recruitment_events FOR EACH ROW EXECUTE FUNCTION academy_append_only();

-- versioned offers: a new version supersedes the previous one; older versions stay readable
CREATE TABLE IF NOT EXISTS recruitment_offers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id uuid NOT NULL REFERENCES billboard_responses,
  version     int NOT NULL CHECK (version >= 1),
  role        text NOT NULL CHECK (role IN ('player','coach')),
  rate_cents  int CHECK (rate_cents IS NULL OR rate_cents >= 0),
  rate_unit   text CHECK (rate_unit IS NULL OR rate_unit IN ('match','hour','month','season')),
  starts_on   date,
  note        text CHECK (note IS NULL OR length(note) <= 500),
  deadline_at timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','declined','superseded','expired','withdrawn')),
  created_by  uuid REFERENCES users,
  decided_by  uuid REFERENCES users,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (response_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS recruitment_offers_one_open ON recruitment_offers (response_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS recruitment_offers_deadline ON recruitment_offers (deadline_at) WHERE status = 'open';

-- trial evaluations: the rating is visible to staff only; the notes are encrypted and reads are audit-logged
CREATE TABLE IF NOT EXISTS recruitment_evaluations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id uuid NOT NULL REFERENCES billboard_responses,
  rating      int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  notes_enc   text,
  trial_at    timestamptz,
  author_id   uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recruitment_evaluations_response ON recruitment_evaluations (response_id, created_at, id);

-- backfill an 'applied' event for existing applications so every timeline starts somewhere (idempotent)
INSERT INTO recruitment_events (response_id, kind, to_stage, actor_id, created_at)
SELECT r.id, 'applied', 'applied', r.responder_id, r.created_at FROM billboard_responses r
 WHERE NOT EXISTS (SELECT 1 FROM recruitment_events e WHERE e.response_id = r.id AND e.kind = 'applied');
