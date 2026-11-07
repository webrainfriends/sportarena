// PS-08: Para-sport UX acceptance suite — conformance matrix, defects lifecycle, release gate.
// One definition → REST + OpenAPI + MCP.
// Scope: tracking only. Para feature screens owned by para-readiness.js, para-learn.js, etc.
// Auth: platform_admin or org-manager for reads/writes; release gate is platform_admin only.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx, many, one } from '../db.js';
import { audit } from '../helpers.js';
import { mustBePlatformAdmin } from '../platform.js';
import { notFound, badRequest } from '../inclusion.js';

const TAG = 'Para UX Conformance';

const JOURNEYS = ['athlete_onboarding','sport_discovery','classification_status',
  'tournament_entry','booking','coach_booking','learning','health','sponsorship','support_person'];
const PLATFORMS = ['ios','ipados','android','web'];
const TECHS = ['voiceover','talkback','keyboard','switch_control','magnification'];
const STATUSES = ['untested','partial','conformant','deferred','not_applicable'];
const SEVERITIES = ['critical','major','minor'];
const DEFECT_STATUSES = ['open','in_progress','resolved','wont_fix'];

// Journeys that MUST be conformant before release
const CRITICAL_JOURNEYS = new Set(['athlete_onboarding','tournament_entry','booking']);

// Redact classification code patterns (e.g. "T11", "F46", "S14", "NPC-CLASS-003")
const CLASS_CODE_RE = /\b([A-Z]{1,3}\d{1,3}(-[A-Z0-9]+)*|NPC[-_][A-Z0-9]+)\b/;

function checkSensitiveText(text) {
  if (!text) return;
  if (CLASS_CODE_RE.test(text)) {
    throw badRequest('Defect description must not contain classification codes or clinical labels. Refer to defect tracking IDs only.');
  }
}

async function requireAdmin(user) {
  await mustBePlatformAdmin(user);
}

async function requireAdminOrManager(c, user) {
  // platform_admin always passes; org managers with any active org also pass
  const isAdmin = await c.query(
    `SELECT 1 FROM users WHERE id=$1 AND (roles @> ARRAY['admin','platform_admin'] OR roles @> ARRAY['manager'])`,
    [user.id]
  );
  if (!isAdmin.rows.length) throw notFound();
}

// ── 1. upsert_conformance_entry ───────────────────────────────────────────────
cap({
  name: 'upsert_conformance_entry', method: 'PUT',
  path: '/para/conformance/:journey/:platform/:tech', tag: TAG,
  summary: 'Record or update a conformance test result for one journey × platform × assistive tech combination.',
  input: z.object({
    journey:      z.enum(JOURNEYS),
    platform:     z.enum(PLATFORMS),
    tech:         z.enum(TECHS),
    status:       z.enum(STATUSES),
    evidence_ref: z.string().url('Must be a URL').optional(),
    notes:        z.string().max(2000).optional(),
  }),
  async handler({ user, input: i }) {
    return tx(async (c) => {
      await requireAdminOrManager(c, user);
      checkSensitiveText(i.notes);
      const existing = (await c.query(
        'SELECT id, row_version FROM para_conformance_entries WHERE journey=$1 AND platform=$2 AND tech=$3',
        [i.journey, i.platform, i.tech]
      )).rows[0];
      let row;
      if (existing) {
        row = (await c.query(
          `UPDATE para_conformance_entries
           SET status=$4, evidence_ref=COALESCE($5, evidence_ref), notes=COALESCE($6, notes),
               tested_by=$7, tested_at=now(), updated_at=now(), row_version=row_version+1
           WHERE journey=$1 AND platform=$2 AND tech=$3
           RETURNING *`,
          [i.journey, i.platform, i.tech, i.status, i.evidence_ref ?? null, i.notes ?? null, user.id]
        )).rows[0];
      } else {
        row = (await c.query(
          `INSERT INTO para_conformance_entries(journey,platform,tech,status,evidence_ref,notes,tested_by,tested_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,now()) RETURNING *`,
          [i.journey, i.platform, i.tech, i.status, i.evidence_ref ?? null, i.notes ?? null, user.id]
        )).rows[0];
      }
      await audit(c, user.id, 'upsert_conformance_entry', 'para_conformance_entries', row.id);
      return row;
    });
  },
});

// ── 2. list_conformance_matrix ────────────────────────────────────────────────
cap({
  name: 'list_conformance_matrix', method: 'GET',
  path: '/para/conformance', tag: TAG,
  summary: 'Return the full conformance matrix (all journeys × platforms × techs), optionally filtered.',
  input: z.object({
    journey:  z.enum(JOURNEYS).optional(),
    platform: z.enum(PLATFORMS).optional(),
    tech:     z.enum(TECHS).optional(),
    status:   z.enum(STATUSES).optional(),
  }),
  async handler({ user, input: i }) {
    return tx(async (c) => {
      await requireAdminOrManager(c, user);
      const wheres = [];
      const params = [];
      if (i.journey)  { params.push(i.journey);  wheres.push(`e.journey=$${params.length}`); }
      if (i.platform) { params.push(i.platform); wheres.push(`e.platform=$${params.length}`); }
      if (i.tech)     { params.push(i.tech);     wheres.push(`e.tech=$${params.length}`); }
      if (i.status)   { params.push(i.status);   wheres.push(`e.status=$${params.length}`); }
      const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
      const rows = await many(
        `SELECT e.*, u.name AS tester_name
         FROM para_conformance_entries e
         LEFT JOIN users u ON u.id=e.tested_by
         ${where} ORDER BY e.journey, e.platform, e.tech`,
        params
      );
      // Synthesise untested entries for missing combinations so callers get a full grid
      const index = new Map(rows.map((r) => [`${r.journey}|${r.platform}|${r.tech}`, r]));
      const grid = [];
      for (const journey of (i.journey ? [i.journey] : JOURNEYS)) {
        for (const platform of (i.platform ? [i.platform] : PLATFORMS)) {
          for (const tech of (i.tech ? [i.tech] : TECHS)) {
            const key = `${journey}|${platform}|${tech}`;
            grid.push(index.get(key) ?? { journey, platform, tech, status: 'untested', id: null });
          }
        }
      }
      return { entries: grid, total: grid.length };
    });
  },
});

// ── 3. get_conformance_summary ────────────────────────────────────────────────
cap({
  name: 'get_conformance_summary', method: 'GET',
  path: '/para/conformance/summary', tag: TAG,
  summary: 'Aggregate counts by status, plus per-journey worst-status rollup for the matrix heat-map.',
  input: z.object({}),
  async handler({ user }) {
    return tx(async (c) => {
      await requireAdminOrManager(c, user);
      const counts = await many(
        `SELECT status, count(*)::int AS n FROM para_conformance_entries GROUP BY status`,
        []
      );
      const byJourney = await many(
        `SELECT journey,
                sum(CASE WHEN status='untested' THEN 1 ELSE 0 END)::int     AS untested,
                sum(CASE WHEN status='partial' THEN 1 ELSE 0 END)::int      AS partial,
                sum(CASE WHEN status='conformant' THEN 1 ELSE 0 END)::int   AS conformant,
                sum(CASE WHEN status='deferred' THEN 1 ELSE 0 END)::int     AS deferred,
                sum(CASE WHEN status='not_applicable' THEN 1 ELSE 0 END)::int AS not_applicable
         FROM para_conformance_entries GROUP BY journey`,
        []
      );
      const openCritical = (await c.query(
        `SELECT count(*)::int AS n FROM para_conformance_defects WHERE severity='critical' AND status IN ('open','in_progress')`,
        []
      )).rows[0].n;
      return { counts, by_journey: byJourney, open_critical_defects: openCritical };
    });
  },
});

// ── 4. add_conformance_evidence ───────────────────────────────────────────────
cap({
  name: 'add_conformance_evidence', method: 'POST',
  path: '/para/conformance/evidence', tag: TAG,
  summary: 'Attach an evidence URL to an existing conformance entry.',
  input: z.object({
    journey:      z.enum(JOURNEYS),
    platform:     z.enum(PLATFORMS),
    tech:         z.enum(TECHS),
    evidence_ref: z.string().url('Must be a URL'),
  }),
  async handler({ user, input: i }) {
    return tx(async (c) => {
      await requireAdminOrManager(c, user);
      const row = (await c.query(
        `UPDATE para_conformance_entries SET evidence_ref=$4, updated_at=now(), row_version=row_version+1
         WHERE journey=$1 AND platform=$2 AND tech=$3 RETURNING *`,
        [i.journey, i.platform, i.tech, i.evidence_ref]
      )).rows[0];
      if (!row) throw notFound();
      await audit(c, user.id, 'add_conformance_evidence', 'para_conformance_entries', row.id);
      return row;
    });
  },
});

// ── 5. list_conformance_defects ───────────────────────────────────────────────
cap({
  name: 'list_conformance_defects', method: 'GET',
  path: '/para/conformance/defects', tag: TAG,
  summary: 'List conformance defects, optionally filtered by severity or status.',
  input: z.object({
    severity: z.enum(SEVERITIES).optional(),
    status:   z.enum(DEFECT_STATUSES).optional(),
    journey:  z.enum(JOURNEYS).optional(),
    platform: z.enum(PLATFORMS).optional(),
  }),
  async handler({ user, input: i }) {
    return tx(async (c) => {
      await requireAdminOrManager(c, user);
      const wheres = [];
      const params = [];
      if (i.severity) { params.push(i.severity); wheres.push(`d.severity=$${params.length}`); }
      if (i.status)   { params.push(i.status);   wheres.push(`d.status=$${params.length}`); }
      if (i.journey)  { params.push(i.journey);  wheres.push(`d.journey=$${params.length}`); }
      if (i.platform) { params.push(i.platform); wheres.push(`d.platform=$${params.length}`); }
      const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
      const defects = await many(
        `SELECT d.*, u.name AS resolver_name
         FROM para_conformance_defects d
         LEFT JOIN users u ON u.id=d.resolved_by
         ${where} ORDER BY
           CASE d.severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END,
           CASE d.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
           d.created_at DESC`,
        params
      );
      return { defects, total: defects.length };
    });
  },
});

// ── 6. upsert_conformance_defect ──────────────────────────────────────────────
cap({
  name: 'upsert_conformance_defect', method: 'PUT',
  path: '/para/conformance/defects/:defect_id?', tag: TAG,
  summary: 'Create or update a para accessibility defect.',
  input: z.object({
    defect_id:          id.optional(),
    journey:            z.enum(JOURNEYS),
    platform:           z.enum(PLATFORMS),
    screen:             z.string().max(120).optional(),
    title:              z.string().min(5).max(200),
    severity:           z.enum(SEVERITIES),
    description:        z.string().min(10).max(3000),
    steps_to_reproduce: z.string().max(3000).optional(),
    evidence_ref:       z.string().url().optional(),
    wcag_criterion:     z.string().max(20).optional(),
  }),
  async handler({ user, input: i }) {
    return tx(async (c) => {
      await requireAdminOrManager(c, user);
      checkSensitiveText(i.description);
      checkSensitiveText(i.steps_to_reproduce);
      let row;
      if (i.defect_id) {
        row = (await c.query(
          `UPDATE para_conformance_defects
           SET journey=$2, platform=$3, screen=$4, title=$5, severity=$6, description=$7,
               steps_to_reproduce=$8, evidence_ref=$9, wcag_criterion=$10,
               updated_at=now(), row_version=row_version+1
           WHERE id=$1 AND status NOT IN ('resolved','wont_fix')
           RETURNING *`,
          [i.defect_id, i.journey, i.platform, i.screen ?? null, i.title, i.severity,
           i.description, i.steps_to_reproduce ?? null, i.evidence_ref ?? null, i.wcag_criterion ?? null]
        )).rows[0];
        if (!row) throw notFound();
      } else {
        row = (await c.query(
          `INSERT INTO para_conformance_defects
             (journey,platform,screen,title,severity,description,steps_to_reproduce,evidence_ref,wcag_criterion)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [i.journey, i.platform, i.screen ?? null, i.title, i.severity, i.description,
           i.steps_to_reproduce ?? null, i.evidence_ref ?? null, i.wcag_criterion ?? null]
        )).rows[0];
      }
      await audit(c, user.id, 'upsert_conformance_defect', 'para_conformance_defects', row.id);
      return row;
    });
  },
});

// ── 7. resolve_conformance_defect ─────────────────────────────────────────────
cap({
  name: 'resolve_conformance_defect', method: 'POST',
  path: '/para/conformance/defects/:defect_id/resolve', tag: TAG,
  summary: 'Mark a defect resolved or wont_fix, with a mandatory resolution note.',
  input: z.object({
    defect_id:       id,
    status:          z.enum(['resolved','wont_fix']),
    resolution_note: z.string().min(10).max(2000),
  }),
  async handler({ user, input: i }) {
    return tx(async (c) => {
      await requireAdminOrManager(c, user);
      checkSensitiveText(i.resolution_note);
      const row = (await c.query(
        `UPDATE para_conformance_defects
         SET status=$2, resolution_note=$3, resolved_by=$4, resolved_at=now(),
             updated_at=now(), row_version=row_version+1
         WHERE id=$1 AND status IN ('open','in_progress')
         RETURNING *`,
        [i.defect_id, i.status, i.resolution_note, user.id]
      )).rows[0];
      if (!row) throw notFound();
      await audit(c, user.id, 'resolve_conformance_defect', 'para_conformance_defects', row.id);
      return row;
    });
  },
});

// ── 8. get_conformance_release_gate ──────────────────────────────────────────
cap({
  name: 'get_conformance_release_gate', method: 'GET',
  path: '/para/conformance/release-gate', tag: TAG,
  summary: 'Evaluate the para-sport accessibility release gate. Returns pass/fail + blocking items.',
  input: z.object({}),
  async handler({ user }) {
    return tx(async (c) => {
      await requireAdmin(user);
      // Blocker 1: any critical-severity defect still open/in_progress
      const critDefects = await many(
        `SELECT id, journey, platform, title, severity, status FROM para_conformance_defects
         WHERE severity='critical' AND status IN ('open','in_progress') ORDER BY created_at`,
        []
      );
      // Blocker 2: critical journeys with untested status on any platform
      const untestedCritical = await many(
        `WITH all_critical AS (
           SELECT j, p
           FROM unnest($1::text[]) j, unnest($2::text[]) p
         ),
         tested AS (
           SELECT DISTINCT journey, platform FROM para_conformance_entries
           WHERE status NOT IN ('untested','not_applicable')
         )
         SELECT a.j AS journey, a.p AS platform
         FROM all_critical a
         LEFT JOIN tested t ON t.journey=a.j AND t.platform=a.p
         WHERE t.journey IS NULL`,
        [Array.from(CRITICAL_JOURNEYS), PLATFORMS]
      );
      const blockers = [
        ...critDefects.map((d) => ({ type: 'critical_defect', ...d })),
        ...untestedCritical.map((u) => ({ type: 'untested_critical_journey', ...u })),
      ];
      return {
        passes: blockers.length === 0,
        blocker_count: blockers.length,
        blockers,
        critical_defect_count: critDefects.length,
        untested_critical_count: untestedCritical.length,
        evaluated_at: new Date().toISOString(),
      };
    });
  },
});
