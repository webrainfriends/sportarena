-- One authority model for sponsor brands (#347). Sponsor representatives (#282) become the only people who act for a brand
-- that has a sponsor entity; the organisation-staff path (#283) is folded into it. Purely additive and backwards-compatible:
--   * the role list is WIDENED (nothing narrowed), a nullable department scope and a `source` are added;
--   * every brand that was run through an organisation (sponsors.organisation_id, no entity yet) gets an 'organization' entity
--     linked to that organisation, and its active staff are copied in as representatives (source='organisation');
--   * organisation_members, sponsors.organisation_id and every other row stay exactly as they were; no DELETE, DROP or CASCADE.
-- Organisation membership changes keep source='organisation' representatives in step inside the same transaction (sponsor-team-sync.js),
-- so removing a person from the organisation still ends their sponsor access immediately.
-- Rollback = deploy the previous code: the old resolver ignores the new columns and rows.

ALTER TABLE sponsor_representatives DROP CONSTRAINT IF EXISTS sponsor_representatives_role_check;
ALTER TABLE sponsor_representatives ADD CONSTRAINT sponsor_representatives_role_check
  CHECK (role IN ('owner','admin','manager','approver','finance','legal','evaluator','auditor','portfolio_manager','viewer'));

-- department scope (organization sponsors only): NULL = every department
ALTER TABLE sponsor_representatives ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES org_departments;
-- 'manual' = invited on the sponsor team; 'organisation' = mirrored from the linked organisation's staff
ALTER TABLE sponsor_representatives ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','organisation'));
-- staff_sync: the linked organisation's staff are mirrored into this entity's team. Only set when an owner/admin links the organisation
-- (or, for the migration, where the organisation already ran the brand); an older identity-only link never grants anyone access.
ALTER TABLE sponsor_entities ADD COLUMN IF NOT EXISTS staff_sync boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS sponsor_entities_organisation ON sponsor_entities(organisation_id) WHERE organisation_id IS NOT NULL;

-- 1. a dedicated entity for every organisation that runs brands without one
INSERT INTO sponsor_entities(sponsor_type, legal_name, organisation_id, created_by, staff_sync)
SELECT 'organization', o.name, o.id, o.created_by, true
  FROM organisations o
 WHERE EXISTS (SELECT 1 FROM sponsors s WHERE s.organisation_id = o.id AND s.entity_id IS NULL);

-- 2. attach those brands to it
UPDATE sponsors s SET entity_id = (SELECT e.id FROM sponsor_entities e WHERE e.organisation_id = s.organisation_id AND e.staff_sync ORDER BY e.created_at, e.id LIMIT 1)
 WHERE s.entity_id IS NULL AND s.organisation_id IS NOT NULL;

-- 3. mirror the staff: organisation role -> representative role (coach/staff carry no sponsor role). A department-scoped owner/admin
--    only ever acted as a scoped manager, so they stay a scoped manager.
INSERT INTO sponsor_representatives(entity_id, user_id, role, status, invited_by, joined_at, department_id, source)
SELECT e.id, m.user_id,
       CASE WHEN m.role IN ('owner','admin') AND m.department_id IS NOT NULL THEN 'manager' ELSE m.role END,
       'active', m.invited_by, coalesce(m.joined_at, now()), m.department_id, 'organisation'
  FROM sponsor_entities e
  JOIN organisation_members m ON m.organisation_id = e.organisation_id AND m.status = 'active'
 WHERE e.staff_sync
   AND m.role IN ('owner','admin','manager','finance','evaluator','legal','approver','auditor')
   AND NOT EXISTS (SELECT 1 FROM sponsor_representatives r WHERE r.entity_id = e.id AND r.user_id = m.user_id AND r.status IN ('invited','active'));

-- 4. the brand's owner always acted as its owner: keep that for the migrated brands (a weaker mirrored role is raised to manager)
INSERT INTO sponsor_representatives(entity_id, user_id, role, status, joined_at, source)
SELECT DISTINCT s.entity_id, s.owner_id, 'owner', 'active', now(), 'manual'
  FROM sponsors s JOIN sponsor_entities e ON e.id = s.entity_id
 WHERE e.staff_sync
   AND NOT EXISTS (SELECT 1 FROM sponsor_representatives r WHERE r.entity_id = s.entity_id AND r.user_id = s.owner_id AND r.status IN ('invited','active'));
UPDATE sponsor_representatives r SET role = 'manager', department_id = NULL
  FROM sponsors s JOIN sponsor_entities e ON e.id = s.entity_id
 WHERE r.entity_id = s.entity_id AND r.user_id = s.owner_id AND r.status = 'active' AND r.source = 'organisation'
   AND e.staff_sync AND (r.role NOT IN ('owner','admin','manager') OR r.department_id IS NOT NULL);
