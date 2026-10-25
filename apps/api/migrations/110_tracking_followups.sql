-- Tools > Scoring & Game Tracking follow-ups (#416). Additive only: nothing here changes or removes existing data.

-- Result of the optional virus scan of an uploaded sheet: clean, unavailable (scanner configured but unreachable) or not_scanned (no scanner configured).
ALTER TABLE tracking_sheet_imports ADD COLUMN IF NOT EXISTS scan_status text NOT NULL DEFAULT 'not_scanned' CHECK (scan_status IN ('not_scanned','clean','unavailable'));

-- Templates can also be shared with a team or presented for an event (structure only: a template never carries match data).
ALTER TABLE tracking_sheet_templates ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams;
ALTER TABLE tracking_sheet_templates DROP CONSTRAINT IF EXISTS tracking_sheet_templates_scope_check;
ALTER TABLE tracking_sheet_templates ADD CONSTRAINT tracking_sheet_templates_scope_check CHECK (scope IN ('personal','organisation','team','event'));
CREATE INDEX IF NOT EXISTS tracking_templates_team ON tracking_sheet_templates(team_id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tracking_templates_event ON tracking_sheet_templates(event_id) WHERE event_id IS NOT NULL;

-- Heat, field and race sheets can be proposed as the result of a real session of a multi-sport programme (event_sessions). A proposal
-- targets either a fixture or a session, never both, and goes through the same review rounds, reviews and policy as a game result.
ALTER TABLE result_proposals ALTER COLUMN fixture_id DROP NOT NULL;
ALTER TABLE result_proposals ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES event_sessions;
ALTER TABLE result_proposals DROP CONSTRAINT IF EXISTS result_proposals_target;
ALTER TABLE result_proposals ADD CONSTRAINT result_proposals_target CHECK ((fixture_id IS NOT NULL) <> (session_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS result_proposals_open_session ON result_proposals(session_id, sheet_id)
  WHERE session_id IS NOT NULL AND state IN ('proposed','under_review','changes_requested','approved','disputed');
CREATE INDEX IF NOT EXISTS result_proposals_session ON result_proposals(session_id, created_at DESC) WHERE session_id IS NOT NULL;
ALTER TABLE tracking_sheets ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES event_sessions;
ALTER TABLE tracking_sheets DROP CONSTRAINT IF EXISTS tracking_sheets_check;
ALTER TABLE tracking_sheets ADD CONSTRAINT tracking_sheets_check CHECK (mode = 'standalone' OR fixture_id IS NOT NULL OR session_id IS NOT NULL);
