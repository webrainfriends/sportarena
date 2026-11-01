// Migration & guided onboarding (#514): one framework that moves a spreadsheet, or an export from TeamSnap or SportsEngine, into an
// organisation. Every import follows the same path whatever its source: upload -> map columns -> dry run -> review conflicts -> approve ->
// import in resumable batches -> reconcile -> (governed) rollback. The engine lives in ../migration.js; this file is the REST/OpenAPI/MCP surface.
// Owners and admins only. Rows are personal data: stored as one encrypted blob, shown with the email masked, audit-logged when read.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { toErrorBody } from '../invoke.js';
import { authenticate } from '../auth.js';
import { config } from '../config.js';
import { audit, sportBySlugOrId } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { DOC_LIMITS, readBody } from '../doc-store.js';
import { tableFileToCsv } from '../match-file.js';
import { SOURCES, SOURCE_KEYS, ROSTER_FIELDS, DATE_FORMATS, readTable, proposeMapping, missingFields, templateCsv, maskEmail } from '../migration-formats.js';
import { MAX_ROWS, sealRaw, openData, validateProject, summarise, runProject, rollbackProject, buildReport, assertMappable } from '../migration.js';

const TAG = 'Migration';
const STAFF = ['owner', 'admin'];
const ROLES = ['player', 'captain', 'coach', 'manager', 'physio'];
const OPTIONS = z.object({
  date_format: z.enum(DATE_FORMATS.map((d) => d.value)).optional().describe('how dates of birth are written in the file; never guessed'),
  default_role: z.enum(ROLES).optional().describe('role for rows that have no role column or an empty role'),
  default_team_id: id.optional().describe('an existing team of this organisation for rows that name no team'),
});

/** The project, with the caller's right to run it checked live (404 for outsiders). */
async function projectFor(user, projectId, { write = false } = {}) {
  const p = await one('SELECT * FROM migration_projects WHERE id=$1', [projectId]);
  if (!p) throw notFound('Migration');
  const { org } = await orgFor(user, p.organisation_id, STAFF, { write });
  return { p, org };
}
const publicProject = (p) => ({
  id: p.id, organisation_id: p.organisation_id, domain: p.domain, source: p.source, status: p.status, file_name: p.file_name, sport_id: p.sport_id,
  mapping: p.mapping, options: p.options, mapping_version: p.mapping_version, source_rows: p.source_rows,
  approved_at: p.approved_at, started_at: p.started_at, completed_at: p.completed_at, rolled_back_at: p.rolled_back_at, created_at: p.created_at,
});
const analysis = (p) => ({ ...proposeMapping(p.options.headers ?? [], p.source, p.mapping), headers: p.options.headers ?? [] });
const withoutHeaders = (o) => { const { headers, ...rest } = o; return rest; };
const view = async (p) => ({ ...publicProject({ ...p, options: withoutHeaders(p.options) }), analysis: analysis(p), summary: await summarise(p.id) });

cap({
  name: 'list_migration_sources', method: 'GET', path: '/migrations/sources', tag: TAG,
  summary: 'What can be imported and from where: the sources (TeamSnap, SportsEngine, Excel/CSV), the importable domain (team rosters: people, teams, staff), the canonical fields a column can map to, and the date formats. Column names for the products are the ones their exports usually use, confirmed by a person before anything is checked.',
  input: z.object({}),
  handler: () => ({
    sources: SOURCES, domains: [{ key: 'roster', label: 'People and teams', fields: ROSTER_FIELDS, roles: ROLES }], date_formats: DATE_FORMATS, max_rows: MAX_ROWS,
    not_importable: ['clinical records', 'credentials', 'payments', 'legally significant contracts', 'guardian links and consents'],
  }),
});

cap({
  name: 'get_migration_template', method: 'GET', path: '/migrations/template', tag: TAG,
  summary: 'A header-only CSV template for a source, so a first-time user can fill it in instead of guessing columns.',
  input: z.object({ source: z.enum(SOURCE_KEYS).default('excel') }),
  handler: (_ctx, i) => ({ filename: `gotmygame-${i.source}-people-template.csv`, csv: templateCsv(i.source) }),
});

cap({
  name: 'create_migration', method: 'POST', path: '/organisations/:id/migrations', tag: TAG, status: 201,
  summary: `Start moving people and teams into an organisation (owner/admin). Send the file as CSV text (use the extract upload for Excel). Nothing is created yet: the file is stored encrypted, columns are proposed from the source's usual names, and you review the mapping, run check_migration (dry run) and approve before anything is written. Up to ${MAX_ROWS} rows.`,
  input: z.object({
    id, domain: z.enum(['roster']).default('roster'), source: z.enum(SOURCE_KEYS), csv: z.string().min(3).max(2_000_000), file_name: z.string().max(200).optional(),
    sport: z.string().max(60).optional().describe('sport slug or id: needed only when the file names teams that do not exist yet'),
    options: OPTIONS.optional(), mapping: z.record(z.string(), z.string()).optional().describe('canonical field -> column header; omit to accept the proposal'),
  }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF, { write: true });
    const { headers, rows } = readTable(i.csv);
    if (!headers.length || !rows.length) throw badRequest('The file needs a header row and at least one data row');
    if (rows.length > MAX_ROWS) throw badRequest(`Upload at most ${MAX_ROWS} rows at a time. Split the file by team or season`);
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    if (i.options?.default_team_id && !(await one('SELECT 1 FROM teams WHERE id=$1 AND organisation_id=$2 AND archived_at IS NULL', [i.options.default_team_id, i.id]))) throw notFound('Team');
    // the last mapping used for this source in this organisation is the best first guess (a reusable template without a new table)
    const last = await one("SELECT mapping FROM migration_projects WHERE organisation_id=$1 AND source=$2 AND status IN ('completed','reconciliation') ORDER BY created_at DESC LIMIT 1", [i.id, i.source]);
    const proposed = proposeMapping(headers, i.source, i.mapping ?? last?.mapping ?? {});
    if (i.mapping) assertMappable(headers, i.mapping);
    return tx(async (c) => {
      const p = (await c.query(
        `INSERT INTO migration_projects(organisation_id, domain, source, file_name, sport_id, mapping, options, source_rows, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [i.id, i.domain, i.source, i.file_name ?? null, sport?.id ?? null, JSON.stringify(proposed.mapping), JSON.stringify({ date_format: 'DD/MM/YYYY', default_role: 'player', ...i.options, headers }), rows.length, user.id])).rows[0];
      for (const [n, r] of rows.entries()) {
        await c.query('INSERT INTO migration_rows(project_id, row_no, raw_enc) VALUES ($1,$2,$3)', [p.id, n + 2, sealRaw(Object.fromEntries(headers.map((h, k) => [h, String(r[k] ?? '').trim()]).filter(([h]) => h)))]);
      }
      await audit(c, user.id, 'create_migration', 'migration_projects', p.id);
      return view(p);
    });
  },
});

cap({
  name: 'list_migrations', method: 'GET', path: '/organisations/:id/migrations', tag: TAG,
  summary: 'Imports of an organisation, newest first (owner/admin).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF);
    return (await many('SELECT * FROM migration_projects WHERE organisation_id=$1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset])).map((p) => publicProject({ ...p, options: withoutHeaders(p.options) }));
  },
});

cap({
  name: 'get_migration', method: 'GET', path: '/migrations/:id', tag: TAG,
  summary: 'One import: its status, column mapping and what is missing, ambiguous or unmapped, and the outcome counts so far.',
  input: z.object({ id }),
  async handler({ user }, i) { const { p } = await projectFor(user, i.id); return view(p); },
});

cap({
  name: 'update_migration_mapping', method: 'PATCH', path: '/migrations/:id', tag: TAG,
  summary: 'Change which column means what, the date format, default role or team, or the sport used for new teams. Any change sends the import back to the mapping step: it must be checked and approved again.',
  input: z.object({ id, mapping: z.record(z.string(), z.string().nullable()).optional(), options: OPTIONS.optional(), sport: z.string().max(60).nullable().optional() }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    if (['importing', 'completed', 'rolled_back_partially'].includes(p.status)) throw conflict('This import has already run. Start a new import for a corrected file');
    const headers = p.options.headers ?? [];
    const mapping = { ...p.mapping };
    for (const [f, h] of Object.entries(i.mapping ?? {})) {
      if (!ROSTER_FIELDS.some((x) => x.key === f)) throw badRequest(`Unknown field ${f}`);
      if (h) mapping[f] = h; else delete mapping[f];
    }
    assertMappable(headers, mapping);
    const sport = i.sport === undefined ? undefined : i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    if (i.options?.default_team_id && !(await one('SELECT 1 FROM teams WHERE id=$1 AND organisation_id=$2 AND archived_at IS NULL', [i.options.default_team_id, p.organisation_id]))) throw notFound('Team');
    return tx(async (c) => {
      const u = (await c.query(
        `UPDATE migration_projects SET mapping=$2, options=options || $3::jsonb, sport_id=CASE WHEN $4::boolean THEN $5::uuid ELSE sport_id END, status='mapping', mapping_version=mapping_version+1, approved_by=NULL, approved_at=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
        [i.id, JSON.stringify(mapping), JSON.stringify(i.options ?? {}), sport !== undefined, sport?.id ?? null])).rows[0];
      await c.query("UPDATE migration_rows SET check_status='pending', reasons='[]' WHERE project_id=$1 AND commit_status IS NULL", [i.id]);
      await audit(c, user.id, 'update_migration_mapping', 'migration_projects', i.id);
      return view(u);
    });
  },
});

cap({
  name: 'check_migration', method: 'POST', path: '/migrations/:id/check', tag: TAG,
  summary: 'Dry run. Reads every row through the same rules the real import uses and reports valid rows, warnings, rejected rows with reasons, duplicates (in the file and from earlier imports), identity conflicts a person must review, and teams that would be created. Writes nothing outside this import. Repeat it any time.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    if (!['mapping', 'validation', 'dry_run', 'approved'].includes(p.status)) throw conflict('This import has already run');
    const miss = missingFields(p.mapping);
    if (miss.length) throw badRequest(`Map these columns first: ${miss.map((f) => ROSTER_FIELDS.find((x) => x.key === f).label).join(', ')}`);
    if (p.status === 'approved') await pool.query("UPDATE migration_projects SET status='mapping', approved_by=NULL, approved_at=NULL WHERE id=$1", [i.id]);
    const summary = await validateProject(i.id, user.id);
    return { ...(await view(await one('SELECT * FROM migration_projects WHERE id=$1', [i.id]))), summary };
  },
});

cap({
  name: 'list_migration_rows', method: 'GET', path: '/migrations/:id/rows', tag: TAG,
  summary: 'Rows of an import with their outcome and reasons. Names are shown to owners/admins (audit-logged); emails are masked.',
  input: z.object({ id, status: z.enum(['pending', 'valid', 'warning', 'rejected', 'duplicate', 'conflict', 'skipped']).optional(), ...page }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id);
    const rows = await many(
      `SELECT id, row_no, check_status, reasons, review, commit_status, data_enc FROM migration_rows WHERE project_id=$1 AND ($2::text IS NULL OR check_status=$2) ORDER BY row_no LIMIT $3 OFFSET $4`, [p.id, i.status ?? null, i.limit, i.offset]);
    await audit(null, user.id, 'read_migration_rows', 'migration_projects', p.id);
    return rows.map(({ data_enc, ...r }) => {
      const d = data_enc ? openData(data_enc) : null;
      return { ...r, person: d ? { name: [d.first_name, d.last_name].filter(Boolean).join(' '), email: maskEmail(d.email), team: d.team, role: d.role, youth: d.youth } : null };
    });
  },
});

cap({
  name: 'review_migration_row', method: 'POST', path: '/migrations/:id/rows/:row_id/review', tag: TAG,
  summary: 'Settle an identity conflict: confirm that the row is the person the email belongs to, or skip the row. Nothing is ever merged automatically. Check the import again afterwards.',
  input: z.object({ id, row_id: id, decision: z.enum(['confirmed', 'skipped']) }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    if (!['dry_run', 'mapping', 'validation'].includes(p.status)) throw conflict('This import is already approved or has run');
    const r = await one("UPDATE migration_rows SET review=$3, reviewed_by=$4, check_status=CASE WHEN $3='skipped' THEN 'skipped' ELSE check_status END WHERE id=$2 AND project_id=$1 AND check_status='conflict' RETURNING id, row_no, review", [i.id, i.row_id, i.decision, user.id]);
    if (!r) throw notFound('Conflict row');
    await audit(null, user.id, 'review_migration_row', 'migration_projects', i.id);
    return r;
  },
});

cap({
  name: 'approve_migration', method: 'POST', path: '/migrations/:id/approve', tag: TAG,
  summary: 'Approve the checked file for import. Refused while any row is unchecked, any identity conflict is unreviewed, or nothing is importable. Records who approved and the mapping version approved.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    if (p.status !== 'dry_run') throw conflict('Run the check first, and approve it before anything changes');
    const s = await summarise(i.id);
    if (s.pending) throw conflict('Some rows have not been checked. Check the import again', s);
    if (s.conflict) throw conflict(`${s.conflict} identity conflict${s.conflict === 1 ? '' : 's'} still to review`, s);
    if (!s.importable) throw conflict('No row can be imported. Fix the file or the mapping and check again', s);
    const u = await one("UPDATE migration_projects SET status='approved', approved_by=$2, approved_at=now(), updated_at=now() WHERE id=$1 AND status='dry_run' RETURNING *", [i.id, user.id]);
    await audit(null, user.id, 'approve_migration', 'migration_projects', i.id);
    return view(u);
  },
});

cap({
  name: 'run_migration', method: 'POST', path: '/migrations/:id/run', tag: TAG,
  summary: 'Import the approved rows in batches. Everyone is invited to their team and accepts; people not on the platform yet are invited when they register with that email. Safe to call again after an interruption, or later to retry rows waiting for a sign-up, consent or a failed attempt: finished rows are never repeated.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    if (!['approved', 'importing', 'reconciliation', 'completed'].includes(p.status)) throw conflict('Approve the checked import first');
    if (p.status === 'completed' && !p.approved_at) throw conflict('Approve the checked import first');
    const done = await runProject(i.id, user);
    return { project: await view(done ?? (await one('SELECT * FROM migration_projects WHERE id=$1', [i.id]))), report: await buildReport(done ?? p, user.id) };
  },
});

cap({
  name: 'get_migration_report', method: 'GET', path: '/migrations/:id/report', tag: TAG,
  summary: 'The reconciliation report: source rows, valid, rejected, duplicates, invited, waiting for a sign-up or consent, skipped, failed, teams created and every unresolved row with its reason (emails masked).',
  input: z.object({ id }),
  async handler({ user }, i) { const { p } = await projectFor(user, i.id); return buildReport(p, user.id); },
});

cap({
  name: 'rollback_migration', method: 'POST', path: '/migrations/:id/rollback', tag: TAG,
  summary: 'Withdraw what an import created and nobody has used: invitations still unanswered are withdrawn and teams the import created that have no people or games are archived. Anyone who already accepted, and any team in use, is kept and reported. Nothing is deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    const r = await rollbackProject(p.id, user.id);
    return { ...r, report: await buildReport(await one('SELECT * FROM migration_projects WHERE id=$1', [i.id]), user.id) };
  },
});

/** PUT /api/v1/migrations/extract — the raw file (CSV, TSV, Excel, a Word table) in, CSV text out. Read in memory, never stored, no AI. */
export function migrationFileRouter() {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 20 : 1000, standardHeaders: true, legacyHeaders: false });
  r.put('/migrations/extract', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) { res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required' } }); return; }
      if (Number(req.headers['content-length'] ?? 0) > DOC_LIMITS.bytes) { res.status(413).json({ error: { code: 'too_large', message: `Files can be up to ${DOC_LIMITS.bytes / 2 ** 20} MB` } }); return; }
      const buf = await readBody(req);
      if (!buf.length) throw badRequest('Empty upload');
      const t = tableFileToCsv(buf);
      res.json({ ...t, headers: readTable(t.csv).headers.filter(Boolean) });
    } catch (e) {
      req.resume();
      const { status, code, message, details } = toErrorBody(e);
      res.status(status).json({ error: { code, message, details } });
    }
  });
  return r;
}
