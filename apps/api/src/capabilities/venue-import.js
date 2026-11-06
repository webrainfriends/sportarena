// Venue bulk import capability (#697): import venues from Playo, GotSport, TeamSnap, SportsEngine, Excel or CSV.
// Follows the same project lifecycle as migrations.js: upload -> map -> check (dry run) -> approve -> run -> (rollback).
// Every raw row is field-encrypted at rest. Conflicts (same name+city as an existing venue) are flagged and require
// explicit per-row resolution before the project can be approved.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { tableFileToCsv } from '../match-file.js';
import { MAX_ROWS, sealRaw, openData } from '../migration.js';
import {
  VENUE_SOURCES, VENUE_SOURCE_KEYS, VENUE_FIELDS,
  proposeVenueMapping, missingVenueFields, venueTemplateCsv,
  validateVenueRow, normaliseVenueRow,
} from '../venue-import-formats.js';
import { parseCsv } from '../csv.js';

const TAG = 'Venue import';
const STAFF = ['owner', 'admin'];
const SEAL_CTX = 'migration_rows.data';

// seal normalised data under the data context
const sealData = (obj) => sealRaw(obj); // reuse sealRaw; both use same crypto.encrypt path

/** Load a venue-domain project; throw 404 if not found or if the caller is not a member of the owning organisation. */
async function projectFor(user, projectId, { write = false } = {}) {
  const p = await one("SELECT * FROM migration_projects WHERE id=$1 AND domain='venue'", [projectId]);
  if (!p) throw notFound('Import project');
  const { org } = await orgFor(user, p.organisation_id, STAFF, { write });
  return { p, org };
}

function publicProject(p) {
  const { headers, ...optRest } = p.options ?? {};
  return {
    id: p.id,
    organisation_id: p.organisation_id,
    domain: p.domain,
    source: p.source,
    status: p.status,
    file_name: p.file_name,
    source_rows: p.source_rows,
    mapping: p.mapping,
    options: optRest,
    approved_at: p.approved_at,
    started_at: p.started_at,
    completed_at: p.completed_at,
    rolled_back_at: p.rolled_back_at,
    created_at: p.created_at,
  };
}

async function summarise(projectId) {
  const rows = (await pool.query(
    "SELECT check_status, count(*)::int AS n FROM migration_rows WHERE project_id=$1 GROUP BY 1",
    [projectId],
  )).rows;
  const acc = { valid: 0, warning: 0, rejected: 0, pending: 0, total: 0, conflicts: 0 };
  for (const r of rows) {
    acc[r.check_status] = (acc[r.check_status] ?? 0) + r.n;
    acc.total += r.n;
  }
  // Count rows with matched_venue_id (conflicts)
  const cRow = await pool.query(
    "SELECT count(*)::int AS n FROM migration_rows WHERE project_id=$1 AND matched_venue_id IS NOT NULL",
    [projectId],
  );
  acc.conflicts = cRow.rows[0].n;
  return acc;
}

cap({
  name: 'list_venue_import_sources', method: 'GET', path: '/venue-imports/sources', tag: TAG,
  summary: 'The importable venue sources (Playo, GotSport, TeamSnap, Excel, CSV), field catalogue, and row limit.',
  input: z.object({}),
  handler: () => ({
    sources: VENUE_SOURCES,
    fields: VENUE_FIELDS,
    max_rows: MAX_ROWS,
    domains: [{ key: 'venue', label: 'Venues and facilities' }],
  }),
});

cap({
  name: 'get_venue_import_template', method: 'GET', path: '/venue-imports/template', tag: TAG,
  summary: 'Download a header-only CSV template for the given source (Playo column names, GotSport column names, etc.).',
  input: z.object({ source: z.enum(VENUE_SOURCE_KEYS).default('excel') }),
  handler: (_ctx, i) => ({
    filename: `gotmygame-${i.source}-venues-template.csv`,
    csv: venueTemplateCsv(i.source),
  }),
});

cap({
  name: 'create_venue_import', method: 'POST', path: '/venue-imports', tag: TAG, status: 201,
  summary: `Upload a venue list (CSV or Excel) to begin a bulk import. Nothing is created until the project is approved and run. Up to ${MAX_ROWS} rows.`,
  input: z.object({
    organisation_id: id,
    source: z.enum(VENUE_SOURCE_KEYS),
    file: z.string().min(4).describe('Base64-encoded file bytes, or raw CSV text'),
    file_name: z.string().max(200),
    options: z.object({
      currency: z.string().max(10).optional().describe('Default currency when rows omit it'),
      default_timezone: z.string().max(60).optional().describe('Default timezone when rows omit it'),
      skip_existing: z.boolean().optional().describe('Auto-skip rows that conflict with an existing venue'),
    }).optional(),
  }),
  async handler({ user }, i) {
    await orgFor(user, i.organisation_id, STAFF, { write: true });

    // Decode file — accept base64 or raw CSV; pass through Excel converter if needed
    let csv = i.file;
    try {
      const decoded = Buffer.from(i.file, 'base64').toString('utf-8');
      // If the decoded string is printable text (not garbled), use it
      if (/^[\x09\x0a\x0d\x20-\x7e -�]/.test(decoded.slice(0, 20))) csv = decoded;
    } catch {}
    // Convert Excel/TSV to CSV if necessary
    csv = tableFileToCsv ? (tableFileToCsv(csv, i.file_name) ?? csv) : csv;

    const rows = parseCsv(csv);
    if (!rows || rows.length < 2) throw badRequest('The file must have a header row and at least one data row');
    if (rows.length - 1 > MAX_ROWS) throw badRequest(`Upload at most ${MAX_ROWS} rows. Split the file by region or facility type`);

    const headers = rows[0];
    const dataRows = rows.slice(1);

    return tx(async (c) => {
      const p = (await c.query(
        `INSERT INTO migration_projects(organisation_id, domain, source, file_name, mapping, options, source_rows, status, created_by)
         VALUES ($1,'venue',$2,$3,$4,$5,$6,'uploaded',$7) RETURNING *`,
        [
          i.organisation_id, i.source, i.file_name,
          JSON.stringify(proposeVenueMapping(headers, i.source, {}).mapping),
          JSON.stringify({ ...(i.options ?? {}), headers }),
          dataRows.length, user.id,
        ],
      )).rows[0];

      for (const [n, row] of dataRows.entries()) {
        const rowObj = Object.fromEntries(headers.map((h, k) => [h, String(row[k] ?? '').trim()]));
        await c.query(
          "INSERT INTO migration_rows(project_id, row_no, raw_enc, check_status) VALUES ($1,$2,$3,'pending')",
          [p.id, n + 2, sealRaw(rowObj)],
        );
      }
      await audit(c, user.id, 'create_venue_import', 'migration_projects', p.id);
      return publicProject(p);
    });
  },
});

cap({
  name: 'get_venue_import', method: 'GET', path: '/venue-imports/:id', tag: TAG,
  summary: 'A venue import project: status, proposed column mapping, ambiguous/unmapped columns, and row-level outcome counts.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id);
    return {
      ...publicProject(p),
      analysis: proposeVenueMapping(p.options.headers ?? [], p.source, p.mapping),
      summary: await summarise(p.id),
    };
  },
});

cap({
  name: 'update_venue_import_mapping', method: 'PATCH', path: '/venue-imports/:id/mapping', tag: TAG,
  summary: 'Set which column holds which canonical venue field. Resets status to uploaded so the project must be checked again.',
  input: z.object({
    id,
    mapping: z.record(z.string(), z.string()),
    options: z.record(z.string(), z.any()).optional(),
  }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    if (!['uploaded', 'checked'].includes(p.status)) throw conflict('The import has already been approved or is running');
    const missing = missingVenueFields(i.mapping);
    if (missing.length) throw badRequest(`Map required columns first: ${missing.join(', ')}`);
    const updated = (await pool.query(
      `UPDATE migration_projects SET mapping=$2, options=options || $3::jsonb, status='uploaded', updated_at=now() WHERE id=$1 RETURNING *`,
      [i.id, JSON.stringify(i.mapping), JSON.stringify(i.options ?? {})],
    )).rows[0];
    await audit(pool, user.id, 'update_venue_import_mapping', 'migration_projects', i.id);
    return publicProject(updated);
  },
});

cap({
  name: 'check_venue_import', method: 'POST', path: '/venue-imports/:id/check', tag: TAG,
  summary: 'Dry run. Validates every row against the confirmed mapping, checks for existing venues with the same name+city, and reports errors, warnings and conflicts. Writes nothing outside this project.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    if (!['uploaded', 'checked'].includes(p.status)) throw conflict('The import has already been approved or is running');
    const missing = missingVenueFields(p.mapping ?? {});
    if (missing.length) throw badRequest(`Map required columns first: ${missing.join(', ')}`);

    const rows = (await pool.query(
      'SELECT id, row_no, raw_enc FROM migration_rows WHERE project_id=$1 ORDER BY row_no',
      [p.id],
    )).rows;

    for (const row of rows) {
      const rawObj = sealRaw === openData ? openData(row.raw_enc) : (() => {
        try { return JSON.parse(require('../crypto.js').decrypt(row.raw_enc, 'migration_rows.raw')); } catch { return openData(row.raw_enc); }
      })();

      // Use openData alias: raw stored with sealRaw, which uses RAW context
      const raw = (() => {
        const { decrypt } = require('../crypto.js');
        try { return JSON.parse(decrypt(row.raw_enc, 'migration_rows.raw')); } catch {}
        try { return JSON.parse(decrypt(row.raw_enc, 'migration_rows.data')); } catch {}
        return {};
      })();

      const normalised = normaliseVenueRow(raw, p.mapping, {
        defaultTimezone: p.options?.default_timezone,
        defaultCurrency: p.options?.currency,
      });
      const { reasons } = validateVenueRow(raw, p.mapping, { defaultCurrency: p.options?.currency });

      let matched_venue_id = null;
      if (normalised.name && normalised.city) {
        const existing = (await pool.query(
          "SELECT id FROM venues WHERE lower(name)=lower($1) AND lower(city)=lower($2) AND active LIMIT 1",
          [normalised.name, normalised.city],
        )).rows[0];
        if (existing) {
          matched_venue_id = existing.id;
          reasons.push({ field: 'name', level: 'warning', message: `Venue with same name+city exists (${existing.id}). Confirm overwrite or choose keep_existing.` });
        }
      }

      const check_status = reasons.some((r) => r.level === 'error') ? 'rejected'
        : reasons.length ? 'warning' : 'valid';
      const data_enc = sealData(normalised);

      await pool.query(
        `UPDATE migration_rows SET check_status=$2, reasons=$3::jsonb, data_enc=$4, matched_venue_id=$5, updated_at=now() WHERE id=$1`,
        [row.id, check_status, JSON.stringify(reasons), data_enc, matched_venue_id],
      );
    }

    await pool.query("UPDATE migration_projects SET status='checked', updated_at=now() WHERE id=$1", [p.id]);
    await audit(pool, user.id, 'check_venue_import', 'migration_projects', p.id);
    return summarise(p.id);
  },
});

cap({
  name: 'list_venue_import_rows', method: 'GET', path: '/venue-imports/:id/rows', tag: TAG,
  summary: 'Paginated rows of a venue import with their validation outcome, reasons, conflict decisions and normalised data.',
  input: z.object({
    id,
    check_status: z.enum(['valid', 'warning', 'rejected', 'pending']).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id);
    const filter = i.check_status ? ' AND check_status=$4' : '';
    const params = [p.id, i.limit, i.offset, ...(i.check_status ? [i.check_status] : [])];
    const rows = (await pool.query(
      `SELECT * FROM migration_rows WHERE project_id=$1${filter} ORDER BY row_no LIMIT $2 OFFSET $3`,
      params,
    )).rows;
    const total = (await pool.query(
      `SELECT count(*)::int AS n FROM migration_rows WHERE project_id=$1${filter}`,
      [p.id, ...(i.check_status ? [i.check_status] : [])],
    )).rows[0].n;

    const { decrypt } = await import('../crypto.js');
    const items = rows.map((r) => {
      let data = null;
      if (r.data_enc) {
        try { data = JSON.parse(decrypt(r.data_enc, 'migration_rows.raw')); } catch {}
        if (!data) try { data = JSON.parse(decrypt(r.data_enc, 'migration_rows.data')); } catch {}
      }
      return {
        id: r.id,
        row_no: r.row_no,
        check_status: r.check_status,
        reasons: r.reasons ?? [],
        conflict_decision: r.conflict_decision,
        matched_venue_id: r.matched_venue_id,
        commit_status: r.commit_status,
        data,
      };
    });
    return { items, total, page: Math.floor(i.offset / i.limit) + 1, per_page: i.limit };
  },
});

cap({
  name: 'review_venue_import_row', method: 'PATCH', path: '/venue-imports/:id/rows/:row_id', tag: TAG,
  summary: 'Set how to resolve a conflict row: keep_existing (skip import row), use_import (overwrite existing venue), or skip.',
  input: z.object({
    id,
    row_id: id,
    conflict_decision: z.enum(['keep_existing', 'use_import', 'skip']),
  }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    const row = (await pool.query(
      'SELECT * FROM migration_rows WHERE id=$1 AND project_id=$2',
      [i.row_id, p.id],
    )).rows[0];
    if (!row) throw notFound('Import row');
    if (!row.matched_venue_id && i.conflict_decision !== 'skip') throw badRequest('conflict_decision only applies to rows with a matched venue');
    const updated = (await pool.query(
      'UPDATE migration_rows SET conflict_decision=$2, updated_at=now() WHERE id=$1 RETURNING *',
      [i.row_id, i.conflict_decision],
    )).rows[0];
    return {
      id: updated.id, row_no: updated.row_no, check_status: updated.check_status,
      conflict_decision: updated.conflict_decision, matched_venue_id: updated.matched_venue_id,
    };
  },
});

cap({
  name: 'approve_venue_import', method: 'POST', path: '/venue-imports/:id/approve', tag: TAG,
  summary: 'Approve the import for running. Fails if any rows are still rejected or if conflicts are unresolved.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    if (p.status !== 'checked') throw conflict('Run a dry-run check before approving');
    const rejected = (await pool.query(
      "SELECT count(*)::int AS n FROM migration_rows WHERE project_id=$1 AND check_status='rejected'",
      [p.id],
    )).rows[0].n;
    if (rejected > 0) throw badRequest(`${rejected} rejected row${rejected > 1 ? 's' : ''} must be resolved before approval. Fix the source file and re-upload.`);
    const unresolved = (await pool.query(
      "SELECT count(*)::int AS n FROM migration_rows WHERE project_id=$1 AND matched_venue_id IS NOT NULL AND conflict_decision IS NULL AND check_status<>'rejected'",
      [p.id],
    )).rows[0].n;
    if (unresolved > 0) throw badRequest(`${unresolved} conflict${unresolved > 1 ? 's' : ''} must be resolved (keep_existing, use_import or skip) before approval`);
    const updated = (await pool.query(
      "UPDATE migration_projects SET status='approved', approved_at=now(), approved_by=$2, updated_at=now() WHERE id=$1 RETURNING *",
      [p.id, user.id],
    )).rows[0];
    await audit(pool, user.id, 'approve_venue_import', 'migration_projects', p.id);
    return publicProject(updated);
  },
});

cap({
  name: 'run_venue_import', method: 'POST', path: '/venue-imports/:id/run', tag: TAG,
  summary: 'Run the approved import: create new venues and resources, overwrite existing venues where use_import was chosen, link rows to entities. Idempotent: re-running a completed import does nothing.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    if (p.status === 'completed') {
      return { created: 0, skipped: 0, failed: 0, total: 0, message: 'Already completed' };
    }
    if (p.status !== 'approved') throw conflict('The import must be approved before it can run');

    await pool.query("UPDATE migration_projects SET status='running', started_at=now() WHERE id=$1", [p.id]);

    const rows = (await pool.query(
      "SELECT * FROM migration_rows WHERE project_id=$1 AND check_status<>'rejected' ORDER BY row_no",
      [p.id],
    )).rows;

    const { decrypt } = await import('../crypto.js');
    let created = 0, skipped = 0, failed = 0;

    for (const row of rows) {
      if (row.conflict_decision === 'skip') { skipped++; continue; }
      if (row.conflict_decision === 'keep_existing') { skipped++; continue; }

      let normalised = null;
      if (row.data_enc) {
        try { normalised = JSON.parse(decrypt(row.data_enc, 'migration_rows.raw')); } catch {}
        if (!normalised) try { normalised = JSON.parse(decrypt(row.data_enc, 'migration_rows.data')); } catch {}
      }
      if (!normalised) { failed++; continue; }

      try {
        await tx(async (c) => {
          let entity_id;
          if (row.conflict_decision === 'use_import' && row.matched_venue_id) {
            // Update existing venue (non-destructive: only fill in blank fields)
            await c.query(
              `UPDATE venues SET
                description=COALESCE(NULLIF($2,''), description),
                address=COALESCE(NULLIF($3,''), address),
                latitude=COALESCE($4, latitude),
                longitude=COALESCE($5, longitude),
                updated_at=now()
               WHERE id=$6`,
              [null, normalised.description, normalised.address, normalised.lat, normalised.lng, row.matched_venue_id],
            );
            entity_id = row.matched_venue_id;
          } else {
            // Create new venue
            const v = (await c.query(
              `INSERT INTO venues(name, city, country, address, latitude, longitude, description, timezone, sports, active, owner_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10) RETURNING id`,
              [
                normalised.name, normalised.city, normalised.country ?? null, normalised.address ?? null,
                normalised.lat ?? null, normalised.lng ?? null, normalised.description ?? null,
                normalised.timezone ?? null, JSON.stringify(normalised.sports ?? []), p.created_by,
              ],
            )).rows[0];
            entity_id = v.id;

            // Create resources / courts
            const count = normalised.court_count ?? 0;
            const kind = (normalised.resource_kind ?? 'court').toLowerCase().replace(/\s+/g, '_');
            for (let n = 1; n <= count; n++) {
              await c.query(
                `INSERT INTO resources(venue_id, name, kind, capacity, hourly_rate_cents, currency, active)
                 VALUES ($1,$2,$3,1,$4,$5,true)`,
                [entity_id, `${kind.charAt(0).toUpperCase() + kind.slice(1)} ${n}`, kind, normalised.base_rate_minor ?? 0, normalised.currency ?? 'INR'],
              );
            }
          }

          // Record the link for idempotency and rollback
          await c.query(
            `INSERT INTO migration_links(domain, project_id, row_id, organisation_id, entity_id, key_hash)
             VALUES ('venue',$1,$2,$3,$4,$5)
             ON CONFLICT (domain, project_id, row_id) DO NOTHING`,
            [p.id, row.id, p.organisation_id, entity_id, `vi_${p.id}_${row.id}`],
          );
          await c.query(
            "UPDATE migration_rows SET commit_status='committed', updated_at=now() WHERE id=$1",
            [row.id],
          );
          created++;
        });
      } catch (err) {
        await pool.query(
          "UPDATE migration_rows SET commit_status='failed', reasons=reasons::jsonb || $2::jsonb, updated_at=now() WHERE id=$1",
          [row.id, JSON.stringify([{ field: 'run', level: 'error', message: err.message ?? String(err) }])],
        );
        failed++;
      }
    }

    await pool.query(
      "UPDATE migration_projects SET status='completed', completed_at=now(), updated_at=now() WHERE id=$1",
      [p.id],
    );
    await audit(pool, user.id, 'run_venue_import', 'migration_projects', p.id);
    return { created, skipped, failed, total: rows.length };
  },
});

cap({
  name: 'get_venue_import_report', method: 'GET', path: '/venue-imports/:id/report', tag: TAG,
  summary: 'Post-run summary: overall status, row-level outcome counts, and commit breakdown.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id);
    const summary = await summarise(p.id);
    const commitRows = (await pool.query(
      "SELECT commit_status, count(*)::int AS n FROM migration_rows WHERE project_id=$1 AND commit_status IS NOT NULL GROUP BY 1",
      [p.id],
    )).rows;
    const commit_summary = { committed: 0, skipped: 0, failed: 0, rolled_back: 0 };
    for (const r of commitRows) commit_summary[r.commit_status] = (commit_summary[r.commit_status] ?? 0) + r.n;
    return { project: publicProject(p), summary, commit_summary };
  },
});

cap({
  name: 'rollback_venue_import', method: 'POST', path: '/venue-imports/:id/rollback', tag: TAG,
  summary: 'Soft-rollback a completed import within 48 hours: pauses every venue created by this import. No venue is deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    if (p.status !== 'completed') throw conflict('Only a completed import can be rolled back');
    const age = Date.now() - new Date(p.completed_at).getTime();
    if (age > 48 * 60 * 60 * 1000) throw badRequest('Rollback window has passed (48 hours after completion)');

    const links = (await pool.query(
      "SELECT entity_id FROM migration_links WHERE domain='venue' AND project_id=$1",
      [p.id],
    )).rows.map((r) => r.entity_id);

    if (links.length) {
      await pool.query(
        'UPDATE venues SET paused_by_partner=true, updated_at=now() WHERE id=ANY($1::uuid[])',
        [links],
      );
    }
    await pool.query(
      "UPDATE migration_rows SET commit_status='rolled_back', updated_at=now() WHERE project_id=$1 AND commit_status='committed'",
      [p.id],
    );
    await pool.query(
      "UPDATE migration_projects SET status='rolled_back', rolled_back_at=now(), updated_at=now() WHERE id=$1",
      [p.id],
    );
    await audit(pool, user.id, 'rollback_venue_import', 'migration_projects', p.id);
    return { paused: links.length };
  },
});
