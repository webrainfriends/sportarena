-- Tools > Scoring & Game Tracking (#416). Additive only: nothing here changes or removes existing data.
-- Tracking sheets are an authoring/capture layer. They never write to fixtures, match_events or score_sheets themselves:
-- a linked sheet becomes a result_proposal, and only after review is it handed to the existing score-sheet lifecycle.

-- Reusable layouts. The scoring rules stay in code/events (scoring/rulesets.js); a template only references them.
CREATE TABLE IF NOT EXISTS tracking_sheet_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id        uuid NOT NULL REFERENCES sports,
  variant         text NOT NULL DEFAULT '',
  scope           text NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal','organisation','event')),
  owner_user_id   uuid REFERENCES users,
  organisation_id uuid REFERENCES organisations,
  event_id        uuid REFERENCES events,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  current_version int NOT NULL DEFAULT 0,
  draft           jsonb NOT NULL DEFAULT '{}',
  origin          text NOT NULL DEFAULT 'user' CHECK (origin IN ('user','ai')),
  best_of         int,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracking_templates_owner ON tracking_sheet_templates(owner_user_id, status);

-- Immutable published versions. Platform starters are derived from the governed built-in rulesets and materialised here
-- (once per distinct layout) the first time a sheet is started, so every sheet pins exactly what it was created from.
CREATE TABLE IF NOT EXISTS tracking_sheet_template_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     uuid REFERENCES tracking_sheet_templates,
  sport_id        uuid NOT NULL REFERENCES sports,
  variant         text NOT NULL DEFAULT '',
  version         int NOT NULL DEFAULT 1,
  origin          text NOT NULL DEFAULT 'platform' CHECK (origin IN ('platform','user','ai')),
  name            text NOT NULL,
  layout          jsonb NOT NULL,
  ruleset         jsonb NOT NULL,
  ruleset_hash    text NOT NULL,
  layout_hash     text NOT NULL,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sport_id, variant, layout_hash)
);
CREATE OR REPLACE FUNCTION tracking_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'published tracking template versions are immutable'; END $$;
DROP TRIGGER IF EXISTS tracking_version_immutable ON tracking_sheet_template_versions;
CREATE TRIGGER tracking_version_immutable BEFORE UPDATE OR DELETE ON tracking_sheet_template_versions
  FOR EACH ROW EXECUTE FUNCTION tracking_version_immutable();

CREATE TABLE IF NOT EXISTS tracking_sheets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                 text NOT NULL UNIQUE,
  template_version_id uuid NOT NULL REFERENCES tracking_sheet_template_versions,
  owner_id            uuid NOT NULL REFERENCES users,
  sport_id            uuid NOT NULL REFERENCES sports,
  mode                text NOT NULL DEFAULT 'standalone' CHECK (mode IN ('standalone','linked')),
  fixture_id          uuid REFERENCES fixtures,
  context_type        text CHECK (context_type IN ('academy_session','coach_session','team','event')),
  context_id          uuid,
  title               text,
  labels              jsonb NOT NULL DEFAULT '{}',
  notes               text,
  status              text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','archived')),
  provenance          text NOT NULL DEFAULT 'live' CHECK (provenance IN ('live','upload','import')),
  manual_totals       jsonb,
  rows                jsonb NOT NULL DEFAULT '[]',
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  client_key          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (mode = 'standalone' OR fixture_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS tracking_sheets_client_key ON tracking_sheets(owner_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS tracking_sheets_owner ON tracking_sheets(owner_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS tracking_sheets_fixture ON tracking_sheets(fixture_id) WHERE fixture_id IS NOT NULL;

-- Entry history. Append-only: an undo voids the entry (kept, with who/why), it never deletes it.
CREATE TABLE IF NOT EXISTS tracking_sheet_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id    uuid NOT NULL REFERENCES tracking_sheets,
  seq         int NOT NULL,
  kind        text NOT NULL,
  side        text CHECK (side IN ('home','away')),
  period      int,
  label       text,
  payload     jsonb NOT NULL DEFAULT '{}',
  client_key  text,
  recorded_by uuid NOT NULL REFERENCES users,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  voided_at   timestamptz,
  voided_by   uuid REFERENCES users,
  void_reason text,
  UNIQUE (sheet_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS tracking_entries_client_key ON tracking_sheet_entries(sheet_id, client_key) WHERE client_key IS NOT NULL;

-- Uploaded completed sheets. The original file is kept encrypted (doc-store) as evidence; extracted values are untrusted until reviewed.
CREATE TABLE IF NOT EXISTS tracking_sheet_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users,
  sheet_id      uuid REFERENCES tracking_sheets,
  sheet_ref     text,
  sport_id      uuid REFERENCES sports,
  file_name     text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    int NOT NULL,
  sha256        text NOT NULL,
  state         text NOT NULL DEFAULT 'extracted' CHECK (state IN ('extracted','needs_manual','confirmed','discarded')),
  extracted     jsonb,
  reviewed      jsonb,
  confidence    jsonb NOT NULL DEFAULT '{}',
  warnings      jsonb NOT NULL DEFAULT '[]',
  provider      text NOT NULL DEFAULT 'none',
  created_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_at  timestamptz,
  UNIQUE (owner_id, sha256)
);

-- Governed per-event approval policy for result proposals; null = the default for the event kind (resolved in code).
ALTER TABLE events ADD COLUMN IF NOT EXISTS result_approval_policy jsonb;

CREATE TABLE IF NOT EXISTS result_proposals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id       uuid NOT NULL REFERENCES fixtures,
  event_id         uuid NOT NULL REFERENCES events,
  sheet_id         uuid NOT NULL REFERENCES tracking_sheets,
  import_id        uuid REFERENCES tracking_sheet_imports,
  submitted_by     uuid NOT NULL REFERENCES users,
  state            text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','under_review','changes_requested','rejected','approved','applied','withdrawn','superseded','disputed')),
  round            int NOT NULL DEFAULT 1,
  home_is          text NOT NULL DEFAULT 'home' CHECK (home_is IN ('home','away')),
  payload          jsonb NOT NULL,
  policy           jsonb NOT NULL,
  ruleset_hash     text NOT NULL,
  template_version_id uuid NOT NULL REFERENCES tracking_sheet_template_versions,
  base_snapshot    jsonb NOT NULL,
  applied_score_sheet_id uuid REFERENCES score_sheets,
  applied_by       uuid REFERENCES users,
  applied_at       timestamptz,
  override_reason  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- one live proposal per sheet and fixture: a repeated submit or upload cannot create a second one
CREATE UNIQUE INDEX IF NOT EXISTS result_proposals_open ON result_proposals(fixture_id, sheet_id)
  WHERE state IN ('proposed','under_review','changes_requested','approved','disputed');
CREATE INDEX IF NOT EXISTS result_proposals_fixture ON result_proposals(fixture_id, created_at DESC);

CREATE TABLE IF NOT EXISTS result_proposal_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id     uuid NOT NULL REFERENCES result_proposals,
  round           int NOT NULL,
  reviewer_id     uuid NOT NULL REFERENCES users,
  resolved_role   text NOT NULL,
  requirement_key text NOT NULL,
  decision        text NOT NULL CHECK (decision IN ('approve','reject','changes_requested','dispute')),
  comment         text,
  override        boolean NOT NULL DEFAULT false,
  at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, round, requirement_key, reviewer_id)
);
CREATE INDEX IF NOT EXISTS result_reviews_proposal ON result_proposal_reviews(proposal_id, round, at);

-- Reviews are history: never edited or deleted.
CREATE OR REPLACE FUNCTION result_review_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'result proposal reviews are append-only'; END $$;
DROP TRIGGER IF EXISTS result_review_append_only ON result_proposal_reviews;
CREATE TRIGGER result_review_append_only BEFORE UPDATE OR DELETE ON result_proposal_reviews
  FOR EACH ROW EXECUTE FUNCTION result_review_append_only();
