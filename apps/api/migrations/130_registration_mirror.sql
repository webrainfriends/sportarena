-- Registration engine consolidation, stage A (#575 follow-up). Additive only: nothing is dropped, rewritten or deleted.
-- Every competition roster registration (#477, reg_registrations) and every academy admission (academy_applications) becomes a read-only MIRROR entry in the
-- universal engine (rx_*), kept in step by triggers in the SAME transaction as the legacy write, and backfilled once below with the very same functions
-- (so live rows and backfilled rows cannot differ). The legacy tables stay the writer until stage B (docs/registration-consolidation.md).
-- A trigger can never break a legacy write: failures are downgraded to a warning and show up in the parity report (get_registration_mirror_report).
-- Sponsorship applications are deliberately NOT mirrored: they are applications for money from a sponsor, not a participant's registration.
-- Rollback: drop the triggers (the mirror rows are derived data and are simply ignored).

ALTER TABLE rx_programmes ADD COLUMN IF NOT EXISTS legacy_type text;
ALTER TABLE rx_programmes ADD COLUMN IF NOT EXISTS legacy_id uuid;
ALTER TABLE rx_entries    ADD COLUMN IF NOT EXISTS legacy_type text;
ALTER TABLE rx_entries    ADD COLUMN IF NOT EXISTS legacy_id uuid;
ALTER TABLE rx_history    ADD COLUMN IF NOT EXISTS legacy_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS rx_programmes_legacy ON rx_programmes (legacy_type, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rx_entries_legacy ON rx_entries (legacy_type, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rx_history_legacy ON rx_history (legacy_id) WHERE legacy_id IS NOT NULL;

-- the engine also needs to be able to show a suspended / expired registration (the constraint is widened, never narrowed)
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'rx_entries_status_check' AND conrelid = 'rx_entries'::regclass;
  IF d IS NOT NULL AND position('suspended' IN d) = 0 THEN
    ALTER TABLE rx_entries DROP CONSTRAINT rx_entries_status_check;
    EXECUTE 'ALTER TABLE rx_entries ADD CONSTRAINT rx_entries_status_check ' || replace(d, '''cancelled''::text]', '''cancelled''::text, ''suspended''::text, ''expired''::text]');
  END IF;
END $$;

-- one live NATIVE entry per person: mirror rows follow their own legacy rules and must not collide with them (index definitions only, no data)
DROP INDEX IF EXISTS rx_entries_live_person;
CREATE UNIQUE INDEX rx_entries_live_person ON rx_entries (programme_id, participant_id, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE participant_id IS NOT NULL AND legacy_id IS NULL AND status NOT IN ('rejected','withdrawn','cancelled');
DROP INDEX IF EXISTS rx_entries_live_team;
CREATE UNIQUE INDEX rx_entries_live_team ON rx_entries (programme_id, team_id)
  WHERE participant_id IS NULL AND legacy_id IS NULL AND status NOT IN ('rejected','withdrawn','cancelled');

-- ---------------------------------------------------------------- status maps (one definition, used by the mirror and by the parity report)
CREATE OR REPLACE FUNCTION rx_map_roster_status(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE s WHEN 'registered' THEN 'approved' ELSE s END $$;   -- submitted, under_review, rejected, withdrawn, suspended, expired keep their names
CREATE OR REPLACE FUNCTION rx_map_academy_stage(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE s
    WHEN 'enquiry' THEN 'draft' WHEN 'trial_requested' THEN 'draft' WHEN 'trial_booked' THEN 'draft' WHEN 'trial_completed' THEN 'draft' WHEN 'application_draft' THEN 'draft'
    WHEN 'submitted' THEN 'submitted' WHEN 'under_review' THEN 'under_review' WHEN 'offered' THEN 'under_review' WHEN 'waitlisted' THEN 'waitlisted'
    WHEN 'offer_accepted' THEN 'approved' WHEN 'enrolled' THEN 'approved' WHEN 'declined' THEN 'rejected' WHEN 'withdrawn' THEN 'withdrawn' WHEN 'cancelled' THEN 'withdrawn'
    WHEN 'expired' THEN 'expired' ELSE 'under_review' END $$;

-- ---------------------------------------------------------------- mirror functions
-- A mirrored programme is closed (nobody registers through the engine for it) and carries an empty published version so entries can be shown.
CREATE OR REPLACE FUNCTION rx_mirror_programme(p_type text, p_id uuid, p_kind text, p_title text, p_owner uuid, p_org uuid, p_event uuid, p_sport text, p_currency text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE pid uuid;
BEGIN
  INSERT INTO rx_programmes(kind, title, owner_id, organisation_id, event_id, sport, status, waitlist, needs_approval, allow_dependents, currency, current_version, legacy_type, legacy_id)
  VALUES (p_kind, left(p_title, 160), p_owner, p_org, p_event, p_sport, 'closed', false, true, true, p_currency, 1, p_type, p_id)
  ON CONFLICT (legacy_type, legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET title = EXCLUDED.title, organisation_id = EXCLUDED.organisation_id, updated_at = now()
  RETURNING id INTO pid;
  INSERT INTO rx_versions(programme_id, version, form, fees, waivers, sha256, published_by)
  VALUES (pid, 1, '{"sections":[]}', '{}', '[]', md5(p_type || p_id::text), p_owner) ON CONFLICT DO NOTHING;
  RETURN pid;
END $$;

CREATE OR REPLACE FUNCTION rx_mirror_roster(r reg_registrations) RETURNS void LANGUAGE plpgsql AS $$
DECLARE ev events; pid uuid;
BEGIN
  SELECT * INTO ev FROM events WHERE id = r.event_id;
  pid := rx_mirror_programme('event_registration', ev.id, 'competition', ev.name, ev.organizer_id, ev.organisation_id, ev.id, NULL, 'USD');
  INSERT INTO rx_entries(programme_id, version, submitted_by, participant_id, team_id, status, receipt_no, submitted_at, decided_at, decided_by, created_at, updated_at, legacy_type, legacy_id)
  VALUES (pid, 1, r.submitted_by, r.user_id, r.team_id, rx_map_roster_status(r.status), r.registration_no, r.created_at, r.decided_at, r.decided_by, r.created_at, now(), 'roster_registration', r.id)
  ON CONFLICT (legacy_type, legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET status = EXCLUDED.status, team_id = EXCLUDED.team_id, receipt_no = EXCLUDED.receipt_no,
    decided_at = EXCLUDED.decided_at, decided_by = EXCLUDED.decided_by, row_version = rx_entries.row_version + 1, updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION rx_mirror_academy(a academy_applications) RETURNS void LANGUAGE plpgsql AS $$
DECLARE pr academy_programmes; org organisations; pid uuid;
BEGIN
  SELECT * INTO pr FROM academy_programmes WHERE id = a.programme_id;
  SELECT * INTO org FROM organisations WHERE id = a.organisation_id;
  pid := rx_mirror_programme('academy_programme', pr.id, 'course', pr.title, org.created_by, pr.organisation_id, NULL, pr.sport, 'GBP');
  INSERT INTO rx_entries(programme_id, version, submitted_by, participant_id, status, submitted_at, decided_at, created_at, updated_at, legacy_type, legacy_id)
  VALUES (pid, 1, a.applicant_id, a.athlete_id, rx_map_academy_stage(a.stage),
          CASE WHEN a.stage NOT IN ('enquiry','trial_requested','trial_booked','trial_completed','application_draft') THEN a.created_at END,
          CASE WHEN a.stage IN ('declined','offer_accepted','enrolled') THEN a.updated_at END, a.created_at, now(), 'academy_application', a.id)
  ON CONFLICT (legacy_type, legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET status = EXCLUDED.status, decided_at = EXCLUDED.decided_at,
    row_version = rx_entries.row_version + 1, updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION rx_mirror_history(p_type text, p_legacy_id uuid, p_entry_legacy_id uuid, p_action text, p_from text, p_to text, p_actor uuid, p_at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE eid uuid;
BEGIN
  SELECT id INTO eid FROM rx_entries WHERE legacy_type = p_type AND legacy_id = p_entry_legacy_id;
  IF eid IS NULL THEN RETURN; END IF;
  INSERT INTO rx_history(entry_id, action, from_status, to_status, actor_id, created_at, legacy_id)
  VALUES (eid, p_action, p_from, p_to, p_actor, p_at, p_legacy_id) ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING;
END $$;

-- ---------------------------------------------------------------- triggers (a failure here is a warning, never a failed legacy write)
CREATE OR REPLACE FUNCTION rx_trg_roster() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN PERFORM rx_mirror_roster(NEW);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'rx mirror (roster %) failed: %', NEW.id, SQLERRM; END;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION rx_trg_roster_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN PERFORM rx_mirror_history('roster_registration', NEW.id, NEW.registration_id, NEW.action, rx_map_roster_status(NEW.from_status), rx_map_roster_status(coalesce(NEW.to_status, NEW.from_status)), NEW.actor_id, NEW.created_at);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'rx mirror (roster history %) failed: %', NEW.id, SQLERRM; END;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION rx_trg_academy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN PERFORM rx_mirror_academy(NEW);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'rx mirror (academy %) failed: %', NEW.id, SQLERRM; END;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION rx_trg_academy_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN PERFORM rx_mirror_history('academy_application', NEW.id, NEW.application_id, 'stage_' || NEW.to_stage, rx_map_academy_stage(NEW.from_stage), rx_map_academy_stage(NEW.to_stage), NEW.actor_id, NEW.created_at);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'rx mirror (academy history %) failed: %', NEW.id, SQLERRM; END;
  RETURN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rx_mirror_roster') THEN
    CREATE TRIGGER rx_mirror_roster AFTER INSERT OR UPDATE ON reg_registrations FOR EACH ROW EXECUTE FUNCTION rx_trg_roster(); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rx_mirror_roster_history') THEN
    CREATE TRIGGER rx_mirror_roster_history AFTER INSERT ON reg_history FOR EACH ROW EXECUTE FUNCTION rx_trg_roster_history(); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rx_mirror_academy') THEN
    CREATE TRIGGER rx_mirror_academy AFTER INSERT OR UPDATE ON academy_applications FOR EACH ROW EXECUTE FUNCTION rx_trg_academy(); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rx_mirror_academy_history') THEN
    CREATE TRIGGER rx_mirror_academy_history AFTER INSERT ON academy_application_events FOR EACH ROW EXECUTE FUNCTION rx_trg_academy_history(); END IF;
END $$;

-- ---------------------------------------------------------------- one-time, idempotent backfill of everything that already exists (reads legacy rows, writes only rx_*)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM reg_registrations ORDER BY created_at, id LOOP PERFORM rx_mirror_roster(r); END LOOP;
  FOR r IN SELECT * FROM reg_history ORDER BY created_at, id LOOP
    PERFORM rx_mirror_history('roster_registration', r.id, r.registration_id, r.action, rx_map_roster_status(r.from_status), rx_map_roster_status(coalesce(r.to_status, r.from_status)), r.actor_id, r.created_at);
  END LOOP;
  FOR r IN SELECT * FROM academy_applications ORDER BY created_at, id LOOP PERFORM rx_mirror_academy(r); END LOOP;
  FOR r IN SELECT * FROM academy_application_events ORDER BY created_at, id LOOP
    PERFORM rx_mirror_history('academy_application', r.id, r.application_id, 'stage_' || r.to_stage, rx_map_academy_stage(r.from_stage), rx_map_academy_stage(r.to_stage), r.actor_id, r.created_at);
  END LOOP;
END $$;
