-- Backfill (#781): every existing academy branch becomes a campus, keeping its identity, dates, venues, programmes and manager. Idempotent (re-running
-- adds nothing), additive, and the branch rows are untouched, so branch reports are exactly as before. Runs after 154_campus_hierarchy.sql.

-- 1. one campus per branch (an archived branch becomes an archived campus; a duplicate code is left off the later campus)
INSERT INTO org_units(organisation_id, kind, name, code, city, status, valid_from, created_by, created_at, archived_at, legacy_branch_id)
SELECT b.organisation_id, 'campus', b.name,
       CASE WHEN b.code IS NOT NULL AND row_number() OVER (PARTITION BY b.organisation_id, lower(b.code) ORDER BY b.created_at, b.id) = 1 THEN b.code END,
       b.city, CASE WHEN b.archived_at IS NULL THEN 'active' ELSE 'archived' END, coalesce(b.opened_on, b.created_at::date), b.created_by, b.created_at, b.archived_at, b.id
  FROM academy_branches b WHERE NOT EXISTS (SELECT 1 FROM org_units u WHERE u.legacy_branch_id = b.id);
UPDATE academy_branches b SET unit_id = u.id FROM org_units u WHERE u.legacy_branch_id = b.id AND b.unit_id IS NULL;

-- 2. one change set per organisation, so the move is recorded (and can be reviewed under Transfers > Change log)
INSERT INTO org_unit_changes(organisation_id, kind, reason, effective_on, summary, performed_by)
SELECT b.organisation_id, 'adopt', 'Branches became campuses', CURRENT_DATE, jsonb_build_object('source', 'academy_branches', 'kind', 'adopt'), (array_agg(b.created_by ORDER BY b.created_at, b.id))[1]
  FROM academy_branches b
 WHERE NOT EXISTS (SELECT 1 FROM org_unit_changes ch WHERE ch.organisation_id = b.organisation_id AND ch.summary ->> 'source' = 'academy_branches')
 GROUP BY b.organisation_id;

-- 3. venues of live branches (a venue listed by two branches goes to the earliest; the branch row keeps its full list)
INSERT INTO org_unit_links(unit_id, unit_kind, object_type, object_id, effective_from, change_id, linked_by)
SELECT DISTINCT ON (v.venue_id) u.id, 'campus', 'venue', v.venue_id, u.valid_from, ch.id, b.created_by
  FROM academy_branches b JOIN org_units u ON u.legacy_branch_id = b.id
  JOIN org_unit_changes ch ON ch.organisation_id = b.organisation_id AND ch.summary ->> 'source' = 'academy_branches'
  CROSS JOIN LATERAL unnest(b.venue_ids) AS v(venue_id)
 WHERE b.archived_at IS NULL AND EXISTS (SELECT 1 FROM venues x WHERE x.id = v.venue_id)
   AND NOT EXISTS (SELECT 1 FROM org_unit_links l WHERE l.object_type = 'venue' AND l.object_id = v.venue_id AND l.unit_kind = 'campus' AND l.effective_to IS NULL)
 ORDER BY v.venue_id, b.created_at, b.id;

-- 4. programmes of live branches
INSERT INTO org_unit_links(unit_id, unit_kind, object_type, object_id, effective_from, change_id, linked_by)
SELECT u.id, 'campus', 'programme', p.id, u.valid_from, ch.id, b.created_by
  FROM academy_programmes p JOIN academy_branches b ON b.id = p.branch_id AND b.archived_at IS NULL JOIN org_units u ON u.legacy_branch_id = b.id
  JOIN org_unit_changes ch ON ch.organisation_id = b.organisation_id AND ch.summary ->> 'source' = 'academy_branches'
 WHERE NOT EXISTS (SELECT 1 FROM org_unit_links l WHERE l.object_type = 'programme' AND l.object_id = p.id AND l.unit_kind = 'campus' AND l.effective_to IS NULL);

-- 5. the branch manager becomes the campus director
INSERT INTO org_unit_roles(unit_id, user_id, role, inherit, valid_from, granted_by)
SELECT u.id, b.manager_id, 'director', true, u.valid_from, b.created_by
  FROM academy_branches b JOIN org_units u ON u.legacy_branch_id = b.id
 WHERE b.manager_id IS NOT NULL AND b.archived_at IS NULL
   AND EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id = b.organisation_id AND m.user_id = b.manager_id AND m.status = 'active')
   AND NOT EXISTS (SELECT 1 FROM org_unit_roles r WHERE r.unit_id = u.id AND r.user_id = b.manager_id AND r.role = 'director' AND r.ended_at IS NULL);
