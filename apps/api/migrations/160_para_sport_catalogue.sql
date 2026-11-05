-- PS-01 Governed para-sport catalogue (#831). Additive only: new columns/tables, no DROP/TRUNCATE/DELETE, no change to existing rows' meaning.
-- One sports catalogue: para sports are rows of `sports` flagged is_para (and linked to the standard sport they adapt), never a second catalogue.
-- Governing-body verification lives on para_class_versions (#488): source, publisher, scope, approval, rollback, deprecation. Events pin a version with a frozen snapshot.

ALTER TABLE sports
  ADD COLUMN IF NOT EXISTS is_para       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS base_sport_id uuid REFERENCES sports;
CREATE INDEX IF NOT EXISTS sports_para ON sports (is_para) WHERE is_para;

-- 1. One-time import of the para / adaptive sports. Names, flags and programme tags only: no rules, classes or category labels are invented here.
--    programmes: paralympic_summer | paralympic_winter | other_adaptive. Existing rows (boccia, sitting volleyball, wheelchair basketball) are only flagged.
INSERT INTO sports (slug, name, emoji, scoring, category, play_type, programmes) VALUES
 ('para-archery','Para archery','🏹','points','para','individual','{paralympic_summer}'),
 ('para-athletics','Para athletics','🏃','distance','para','individual','{paralympic_summer}'),
 ('para-badminton','Para badminton','🏸','points','para','individual','{paralympic_summer}'),
 ('boccia','Boccia','⚪','points','para','individual','{paralympic_summer}'),
 ('para-canoe','Para canoe','🛶','time','para','individual','{paralympic_summer}'),
 ('para-cycling','Para cycling','🚴','time','para','individual','{paralympic_summer}'),
 ('para-equestrian','Para equestrian','🐎','judged','para','individual','{paralympic_summer}'),
 ('para-judo','Para judo','🥋','combat','para','individual','{paralympic_summer}'),
 ('para-powerlifting','Para powerlifting','🏋️','weight','para','individual','{paralympic_summer}'),
 ('para-rowing','Para rowing','🚣','time','para','individual','{paralympic_summer}'),
 ('para-shooting','Para shooting','🔫','points','para','individual','{paralympic_summer}'),
 ('sitting-volleyball','Sitting volleyball','🏐','sets','para','team','{paralympic_summer}'),
 ('para-swimming','Para swimming','🏊','time','para','individual','{paralympic_summer}'),
 ('para-table-tennis','Para table tennis','🏓','sets','para','individual','{paralympic_summer}'),
 ('para-taekwondo','Para taekwondo','🥋','combat','para','individual','{paralympic_summer}'),
 ('para-triathlon','Para triathlon','🏊','time','para','individual','{paralympic_summer}'),
 ('wheelchair-basketball','Wheelchair basketball','🏀','points','para','team','{paralympic_summer}'),
 ('wheelchair-fencing','Wheelchair fencing','🤺','combat','para','individual','{paralympic_summer}'),
 ('wheelchair-rugby','Wheelchair rugby','🏉','points','para','team','{paralympic_summer}'),
 ('wheelchair-tennis','Wheelchair tennis','🎾','sets','para','individual','{paralympic_summer}'),
 ('goalball','Goalball','🥅','goals','para','team','{paralympic_summer}'),
 ('blind-football','Blind football','⚽','goals','para','team','{paralympic_summer}'),
 ('para-alpine-skiing','Para alpine skiing','⛷️','time','para','individual','{paralympic_winter}'),
 ('para-biathlon','Para biathlon','🎿','time','para','individual','{paralympic_winter}'),
 ('para-cross-country-skiing','Para cross-country skiing','🎿','time','para','individual','{paralympic_winter}'),
 ('para-ice-hockey','Para ice hockey','🏒','goals','para','team','{paralympic_winter}'),
 ('para-snowboard','Para snowboard','🏂','time','para','individual','{paralympic_winter}'),
 ('wheelchair-curling','Wheelchair curling','🥌','points','para','team','{paralympic_winter}'),
 ('para-sailing','Para sailing','⛵','points','para','individual','{other_adaptive}'),
 ('cerebral-palsy-football','Cerebral palsy football','⚽','goals','para','team','{other_adaptive}'),
 ('amputee-football','Amputee football','⚽','goals','para','team','{other_adaptive}'),
 ('para-climbing','Para climbing','🧗','distance','para','individual','{other_adaptive}'),
 ('para-surfing','Para surfing','🏄','judged','para','individual','{other_adaptive}'),
 ('para-dance-sport','Para dance sport','💃','judged','para','individual','{other_adaptive}')
ON CONFLICT (slug) DO NOTHING;

-- flag every para sport (including the three that pre-dated this import) and tag its programme; existing name/emoji/scoring are untouched
WITH para(slug, prog, base) AS (VALUES
 ('para-archery','paralympic_summer','archery'),('para-athletics','paralympic_summer','athletics'),('para-badminton','paralympic_summer','badminton'),('boccia','paralympic_summer',NULL),
 ('para-canoe','paralympic_summer','canoe-sprint'),('para-cycling','paralympic_summer','cycling'),('para-equestrian','paralympic_summer','equestrian'),('para-judo','paralympic_summer','judo'),
 ('para-powerlifting','paralympic_summer','powerlifting'),('para-rowing','paralympic_summer','rowing'),('para-shooting','paralympic_summer','shooting'),('sitting-volleyball','paralympic_summer','volleyball'),
 ('para-swimming','paralympic_summer','swimming'),('para-table-tennis','paralympic_summer','table-tennis'),('para-taekwondo','paralympic_summer','taekwondo'),('para-triathlon','paralympic_summer','triathlon'),
 ('wheelchair-basketball','paralympic_summer','basketball'),('wheelchair-fencing','paralympic_summer','fencing'),('wheelchair-rugby','paralympic_summer','rugby'),('wheelchair-tennis','paralympic_summer','tennis'),
 ('goalball','paralympic_summer',NULL),('blind-football','paralympic_summer','football'),
 ('para-alpine-skiing','paralympic_winter','alpine-skiing'),('para-biathlon','paralympic_winter','biathlon'),('para-cross-country-skiing','paralympic_winter','cross-country-skiing'),
 ('para-ice-hockey','paralympic_winter','ice-hockey'),('para-snowboard','paralympic_winter','snowboarding'),('wheelchair-curling','paralympic_winter','curling'),
 ('para-sailing','other_adaptive','sailing'),('cerebral-palsy-football','other_adaptive','football'),('amputee-football','other_adaptive','football'),
 ('para-climbing','other_adaptive','climbing'),('para-surfing','other_adaptive','surfing'),('para-dance-sport','other_adaptive','dancesport'))
UPDATE sports s SET is_para = true,
       programmes = (SELECT array_agg(DISTINCT x) FROM unnest(s.programmes || ARRAY[p.prog]) x),
       base_sport_id = (SELECT b.id FROM sports b WHERE b.slug = p.base AND b.id <> s.id)
  FROM para p WHERE s.slug = p.slug;

-- 2. Governing-body verification metadata on the existing versioned definition (para_class_versions, #488).
ALTER TABLE para_class_versions
  ADD COLUMN IF NOT EXISTS source_url          text CHECK (source_url IS NULL OR (length(source_url) <= 500 AND source_url ~ '^https?://')),
  ADD COLUMN IF NOT EXISTS publisher           text CHECK (publisher IS NULL OR length(publisher) <= 160),
  ADD COLUMN IF NOT EXISTS scope_countries     text[] NOT NULL DEFAULT '{}',   -- ISO-3166 alpha-2; empty = worldwide
  ADD COLUMN IF NOT EXISTS scope_competitions  text[] NOT NULL DEFAULT '{}',   -- competition names/levels the rule applies to; empty = every competition of the body
  ADD COLUMN IF NOT EXISTS event_categories    text[] NOT NULL DEFAULT '{}',   -- event categories as written in the governing document
  ADD COLUMN IF NOT EXISTS adaptations         text[] NOT NULL DEFAULT '{}',   -- permitted adaptations (equipment, rules, format)
  ADD COLUMN IF NOT EXISTS permitted_roles     text[] NOT NULL DEFAULT '{}',   -- participant/support roles (guide, pusher, caller, assistant...) the rule permits
  ADD COLUMN IF NOT EXISTS classification_required boolean NOT NULL DEFAULT true, -- does THIS governing rule require official classification to compete
  ADD COLUMN IF NOT EXISTS approval_status     text NOT NULL DEFAULT 'draft' CHECK (approval_status IN ('draft','submitted','rejected','approved')),
  ADD COLUMN IF NOT EXISTS submitted_by        uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS submitted_at        timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_reason     text CHECK (rejected_reason IS NULL OR length(rejected_reason) <= 500),
  ADD COLUMN IF NOT EXISTS supersedes_id       uuid REFERENCES para_class_versions,  -- set on a rollback: the earlier version this one restores
  ADD COLUMN IF NOT EXISTS deprecated_at       timestamptz,
  ADD COLUMN IF NOT EXISTS deprecated_reason   text CHECK (deprecated_reason IS NULL OR length(deprecated_reason) <= 500);
-- every version published before this change was approved by publishing
UPDATE para_class_versions SET approval_status = 'approved' WHERE status <> 'draft' AND approval_status = 'draft';

-- the governing-body evidence fields freeze with the version, like its title and source_ref
CREATE OR REPLACE FUNCTION para_version_evidence_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.source_url IS DISTINCT FROM OLD.source_url OR NEW.publisher IS DISTINCT FROM OLD.publisher OR NEW.scope_countries <> OLD.scope_countries
     OR NEW.scope_competitions <> OLD.scope_competitions OR NEW.event_categories <> OLD.event_categories OR NEW.adaptations <> OLD.adaptations
     OR NEW.permitted_roles <> OLD.permitted_roles OR NEW.classification_required <> OLD.classification_required OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id) THEN
    RAISE EXCEPTION 'a published classification version is immutable; publish a new version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS para_version_evidence_guard ON para_class_versions;
CREATE TRIGGER para_version_evidence_guard BEFORE UPDATE ON para_class_versions FOR EACH ROW EXECUTE FUNCTION para_version_evidence_guard();

-- 3. Event discipline: participation context + the pinned governed version, with a frozen snapshot so later rule changes never rewrite the event.
ALTER TABLE event_disciplines
  ADD COLUMN IF NOT EXISTS participation_context text NOT NULL DEFAULT 'standard' CHECK (participation_context IN ('standard','sanctioned','recreational','mixed_ability')),
  ADD COLUMN IF NOT EXISTS para_version_id       uuid REFERENCES para_class_versions,
  ADD COLUMN IF NOT EXISTS para_categories       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS para_snapshot         jsonb,
  ADD COLUMN IF NOT EXISTS para_snapshot_hash    text,
  ADD COLUMN IF NOT EXISTS para_pinned_by        uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS para_pinned_at        timestamptz;

-- 4. The append-only history also records event pins and their changes (widened, never narrowed).
ALTER TABLE para_history DROP CONSTRAINT IF EXISTS para_history_subject_type_check;
ALTER TABLE para_history ADD CONSTRAINT para_history_subject_type_check
  CHECK (subject_type IN ('version','classifier','case','outcome','appeal','external_ref','event_discipline'));
