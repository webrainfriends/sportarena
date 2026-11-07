// Venue bulk import capability (#697): import venues from Playo, GotSport, TeamSnap, SportsEngine, Excel or CSV.
// Follows the same project lifecycle as migrations.js: upload -> map -> check (dry run) -> approve -> run -> (rollback).
// Every raw row is field-encrypted at rest. Conflicts (same name+city as an existing venue) are flagged and require
// explicit per-row resolution before the project can be approved.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { tableFileToCsv } from '../match-file.js';
import { blindIndex } from '../crypto.js';
import { MAX_ROWS, seal, openRaw, openData, sealRaw } from '../migration.js';
import {
  VENUE_SOURCES, VENUE_SOURCE_KEYS, VENUE_FIELDS,
  proposeVenueMapping, missingVenueFields, venueTemplateCsv,
  validateVenueRow, normaliseVenueRow,
} from '../venue-import-formats.js';
import { parseCsv } from '../csv.js';
import { approvalsOn, isPlatform } from '../platform.js';
import { validTimezone } from '../booking/time.js';
import { isSupportedCurrency } from '../currency.js';

const TAG = 'Venue import';
const STAFF = ['owner', 'admin'];
const DATA_CTX = 'migration_rows.data';
const FIELD_KEYS = VENUE_FIELDS.map((f) => f.key);
const RESOURCE_KINDS = ['court', 'ground', 'pool', 'track', 'room', 'equipment', 'table', 'lane', 'rink', 'range', 'studio', 'other'];

// A venue project moves through uploaded -> checked -> approved -> running -> completed (-> rolled_back); migration 178 allows these
// values on the shared migration_projects table.
const EDITABLE = ['uploaded', 'checked'];
const sealData = (obj) => seal(obj, DATA_CTX);

/** Load a venue-domain project; 404 if it does not exist or the caller is not staff of the owning organisation. */
async function projectFor(user, projectId, { write = false } = {}) {
  const p = await one("SELECT * FROM migration_projects WHERE id=$1 AND domain='venue'", [projectId]);
  if (!p) throw notFound('Import project');
  const { org } = await orgFor(user, p.organisation_id, STAFF, { write });
  return { p, org };
}

function publicProject(p) {
  return {
    id: p.id,
    organisation_id: p.organisation_id,
    domain: p.domain,
    source: p.source,
    status: p.status,
    file_name: p.file_name,
    source_rows: p.source_rows,
    mapping: p.mapping,
    options: p.venue_import_opts ?? {},
    approved_at: p.approved_at,
    started_at: p.started_at,
    completed_at: p.completed_at,
    rolled_back_at: p.rolled_back_at,
    created_at: p.created_at,
  };
}

async function summarise(projectId, db = pool) {
  const rows = (await db.query('SELECT check_status, count(*)::int AS n FROM migration_rows WHERE project_id=$1 GROUP BY 1', [projectId])).rows;
  const acc = { valid: 0, warning: 0, rejected: 0, pending: 0, conflict: 0, duplicate: 0, skipped: 0, total: 0, conflicts: 0, resolved: 0 };
  for (const r of rows) {
    acc[r.check_status] = (acc[r.check_status] ?? 0) + r.n;
    acc.total += r.n;
  }
  const c = (await db.query(
    `SELECT count(*) FILTER (WHERE matched_venue_id IS NOT NULL AND check_status<>'rejected')::int AS conflicts,
            count(*) FILTER (WHERE matched_venue_id IS NOT NULL AND check_status<>'rejected' AND conflict_decision IS NOT NULL)::int AS resolved
       FROM migration_rows WHERE project_id=$1`, [projectId])).rows[0];
  acc.conflicts = c.conflicts;
  acc.resolved = c.resolved;
  return acc;
}

/** Stored reasons never carry a person's data, but the normalised row does: open it only for reads that are audit-logged. */
const rowData = (r) => {
  if (!r.data_enc) return null;
  try { return openData(r.data_enc); } catch { return null; }
};

const minutesOf = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Decode an upload: base64 (what the app sends, and the only way to carry .xlsx) or raw CSV text. */
function decodeFile(file, encoding) {
  const compact = file.replace(/\s+/g, '');
  const looksBase64 = compact.length >= 4 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
  const asBase64 = encoding === 'base64' || (encoding === 'auto' && looksBase64);
  return Buffer.from(file, asBase64 ? 'base64' : 'utf8');
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
    file: z.string().min(4).max(14_000_000).describe('The file: base64-encoded bytes (CSV or .xlsx), or raw CSV text'),
    encoding: z.enum(['auto', 'base64', 'text']).default('auto').describe('How `file` is encoded. The app always sends base64.'),
    file_name: z.string().max(200),
    options: z.object({
      currency: z.string().length(3).optional().describe('Default currency when rows omit it'),
      default_timezone: z.string().max(60).refine(validTimezone, 'Unknown IANA time zone, e.g. Asia/Kolkata').optional().describe('Default timezone when rows omit it'),
      skip_existing: z.boolean().optional().describe('Auto-keep the existing venue for rows that match one'),
    }).optional(),
  }),
  async handler({ user }, i) {
    await orgFor(user, i.organisation_id, STAFF, { write: true });
    const options = { ...(i.options ?? {}) };
    if (options.currency) {
      options.currency = options.currency.toUpperCase();
      if (!isSupportedCurrency(options.currency)) throw badRequest(`Unsupported currency ${options.currency}`);
    }

    const { csv } = tableFileToCsv(decodeFile(i.file, i.encoding));
    const rows = parseCsv(csv);
    if (!rows || rows.length < 2) throw badRequest('The file must have a header row and at least one data row');
    if (rows.length - 1 > MAX_ROWS) throw badRequest(`Upload at most ${MAX_ROWS} rows. Split the file by region or facility type`);

    const headers = rows[0].map((h) => String(h ?? '').trim());
    const dataRows = rows.slice(1).filter((r) => r.some((v) => String(v ?? '').trim()));
    if (!dataRows.length) throw badRequest('The file must have a header row and at least one data row');

    return tx(async (c) => {
      const p = (await c.query(
        `INSERT INTO migration_projects(organisation_id, domain, source, file_name, mapping, options, venue_import_opts, source_rows, status, created_by)
         VALUES ($1,'venue',$2,$3,$4,$5,$6,$7,'uploaded',$8) RETURNING *`,
        [
          i.organisation_id, i.source, i.file_name,
          JSON.stringify(proposeVenueMapping(headers, i.source, {}).mapping),
          JSON.stringify({ headers }), JSON.stringify(options),
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
      return { ...publicProject(p), headers };
    });
  },
});

cap({
  name: 'get_venue_import', method: 'GET', path: '/venue-imports/:id', tag: TAG,
  summary: 'A venue import project: status, the file headers, the proposed column mapping, ambiguous/unmapped columns, and row-level outcome counts.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id);
    const headers = p.options?.headers ?? [];
    return {
      ...publicProject(p),
      headers,
      analysis: proposeVenueMapping(headers, p.source, p.mapping),
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
    options: z.object({
      currency: z.string().length(3).optional(),
      default_timezone: z.string().max(60).refine(validTimezone, 'Unknown IANA time zone, e.g. Asia/Kolkata').optional(),
      skip_existing: z.boolean().optional(),
    }).optional(),
  }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    if (!EDITABLE.includes(p.status)) throw conflict('The import has already been approved or is running');
    const headers = p.options?.headers ?? [];
    for (const [field, header] of Object.entries(i.mapping)) {
      if (!FIELD_KEYS.includes(field)) throw badRequest(`Unknown venue field "${field}"`);
      if (!headers.includes(header)) throw badRequest(`Column "${header}" is not in the uploaded file`);
    }
    const opts = { ...(i.options ?? {}) };
    if (opts.currency) {
      opts.currency = opts.currency.toUpperCase();
      if (!isSupportedCurrency(opts.currency)) throw badRequest(`Unsupported currency ${opts.currency}`);
    }
    const updated = (await pool.query(
      `UPDATE migration_projects SET mapping=$2, venue_import_opts=venue_import_opts || $3::jsonb, status='uploaded', mapping_version=mapping_version+1, updated_at=now()
        WHERE id=$1 AND status IN ('uploaded','checked') RETURNING *`,
      [i.id, JSON.stringify(i.mapping), JSON.stringify(opts)],
    )).rows[0];
    if (!updated) throw conflict('The import has already been approved or is running');
    await audit(pool, user.id, 'update_venue_import_mapping', 'migration_projects', i.id);
    return { ...publicProject(updated), headers };
  },
});

cap({
  name: 'check_venue_import', method: 'POST', path: '/venue-imports/:id/check', tag: TAG,
  summary: 'Dry run. Validates every row against the confirmed mapping (an incomplete mapping rejects every row and lists `missing_fields`), checks for existing venues with the same name+city (listed, paused or awaiting approval), and reports errors, warnings and conflicts. Writes nothing outside this project.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    if (!EDITABLE.includes(p.status)) throw conflict('The import has already been approved or is running');
    // an incomplete mapping is not an error here: every row is reported as rejected (name and city are required), so the person sees why
    const missing = missingVenueFields(p.mapping ?? {});
    const opts = p.venue_import_opts ?? {};

    const known = new Set((await pool.query('SELECT slug, lower(name) AS lname FROM sports')).rows.flatMap((s) => [s.slug, s.lname]));
    const rows = (await pool.query('SELECT id, row_no, raw_enc FROM migration_rows WHERE project_id=$1 ORDER BY row_no', [p.id])).rows;
    const seen = new Set();

    await tx(async (c) => {
      for (const row of rows) {
        let raw;
        try { raw = openRaw(row.raw_enc) ?? {}; } catch { raw = {}; }
        const normalised = normaliseVenueRow(raw, p.mapping, { defaultTimezone: opts.default_timezone, defaultCurrency: opts.currency });
        const { reasons } = validateVenueRow(raw, p.mapping, { defaultCurrency: opts.currency });
        // missing optional extras (coordinates, hours) are advice, not a reason to hold a row back
        for (const r of reasons) if (r.level === 'warning' && /^No /.test(r.message)) r.level = 'info';

        if (normalised.timezone && !validTimezone(normalised.timezone)) {
          reasons.push({ field: 'timezone', level: 'warning', message: `Time zone "${normalised.timezone}" is not recognised: UTC will be used` });
        }
        for (const sp of normalised.sports) {
          if (!known.has(sp) && !known.has(sp.replace(/\s+/g, '-'))) reasons.push({ field: 'sports', level: 'warning', message: `Sport "${sp}" is not in the catalogue: the courts will be created without a sport` });
        }

        let matched = null;
        let status;
        if (normalised.name && normalised.city) {
          const key = `${normalised.name.toLowerCase()}|${normalised.city.toLowerCase()}`;
          if (seen.has(key)) {
            reasons.push({ field: 'name', level: 'warning', message: 'The same name and city appear earlier in this file: this row will be skipped' });
            status = 'duplicate';
          }
          seen.add(key);
          matched = (await c.query(
            'SELECT id FROM venues WHERE lower(name)=lower($1) AND lower(city)=lower($2) ORDER BY active DESC, created_at LIMIT 1',
            [normalised.name, normalised.city],
          )).rows[0]?.id ?? null;
          if (matched) reasons.push({ field: 'name', level: 'warning', message: 'A venue with the same name and city already exists. Keep it, fill its blank details from this row, or skip the row.' });
        }

        if (reasons.some((r) => r.level === 'error')) status = 'rejected';
        else if (!status) status = matched ? 'conflict' : reasons.some((r) => r.level === 'warning') ? 'warning' : 'valid';

        await c.query(
          `UPDATE migration_rows SET check_status=$2, reasons=$3::jsonb, data_enc=$4, matched_venue_id=$5,
                  conflict_decision=CASE WHEN $5::uuid IS NULL THEN NULL
                                         WHEN $5::uuid IS NOT DISTINCT FROM matched_venue_id THEN conflict_decision
                                         WHEN $6::boolean THEN 'keep_existing' END
            WHERE id=$1`,
          [row.id, status, JSON.stringify(reasons), sealData(normalised), matched, !!opts.skip_existing],
        );
      }
      await c.query("UPDATE migration_projects SET status='checked', updated_at=now() WHERE id=$1", [p.id]);
      await audit(c, user.id, 'check_venue_import', 'migration_projects', p.id);
    });
    return { ...(await summarise(p.id)), missing_fields: missing };
  },
});

cap({
  name: 'list_venue_import_rows', method: 'GET', path: '/venue-imports/:id/rows', tag: TAG,
  summary: 'Paginated rows of a venue import with their validation outcome, reasons, conflict decisions and normalised data. Reading the normalised data is audit-logged.',
  input: z.object({
    id,
    check_status: z.enum(['valid', 'warning', 'rejected', 'pending', 'conflict', 'duplicate', 'skipped']).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id);
    const filter = i.check_status ? ' AND check_status=$2' : '';
    const fparams = [p.id, ...(i.check_status ? [i.check_status] : [])];
    const rows = (await pool.query(
      `SELECT * FROM migration_rows WHERE project_id=$1${filter} ORDER BY row_no LIMIT $${fparams.length + 1} OFFSET $${fparams.length + 2}`,
      [...fparams, i.limit, i.offset],
    )).rows;
    const total = (await pool.query(`SELECT count(*)::int AS n FROM migration_rows WHERE project_id=$1${filter}`, fparams)).rows[0].n;
    await audit(pool, user.id, 'read_venue_import_rows', 'migration_projects', p.id);

    const items = rows.map((r) => ({
      id: r.id,
      row_no: r.row_no,
      check_status: r.check_status,
      reasons: r.reasons ?? [],
      conflict_decision: r.conflict_decision,
      matched_venue_id: r.matched_venue_id,
      commit_status: r.commit_status,
      data: rowData(r),
    }));
    return { items, total, page: Math.floor(i.offset / i.limit) + 1, per_page: i.limit };
  },
});

cap({
  name: 'review_venue_import_row', method: 'PATCH', path: '/venue-imports/:id/rows/:row_id', tag: TAG,
  summary: 'Set how to resolve a conflict row: keep_existing (leave the venue as it is), use_import (fill the existing venue\'s blank details from the row; only for venues of this organisation) or skip.',
  input: z.object({
    id,
    row_id: id,
    conflict_decision: z.enum(['keep_existing', 'use_import', 'skip']),
  }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    if (!EDITABLE.includes(p.status)) throw conflict('The import has already been approved or is running');
    const row = (await pool.query('SELECT * FROM migration_rows WHERE id=$1 AND project_id=$2', [i.row_id, p.id])).rows[0];
    if (!row) throw notFound('Import row');
    if (!row.matched_venue_id && i.conflict_decision !== 'skip') throw badRequest('conflict_decision only applies to rows with a matched venue');
    if (i.conflict_decision === 'use_import') {
      const v = await one('SELECT organisation_id FROM venues WHERE id=$1', [row.matched_venue_id]);
      if (!v || (v.organisation_id !== p.organisation_id && !isPlatform(user))) throw forbidden('Only venues that belong to this organisation can be updated by an import. Keep the existing venue or skip the row.');
    }
    const updated = (await pool.query('UPDATE migration_rows SET conflict_decision=$2 WHERE id=$1 RETURNING *', [i.row_id, i.conflict_decision])).rows[0];
    await audit(pool, user.id, 'review_venue_import_row', 'migration_projects', p.id);
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
    const rejected = (await pool.query("SELECT count(*)::int AS n FROM migration_rows WHERE project_id=$1 AND check_status='rejected'", [p.id])).rows[0].n;
    if (rejected > 0) throw badRequest(`${rejected} rejected row${rejected > 1 ? 's' : ''} must be resolved before approval. Fix the source file and re-upload.`);
    const unresolved = (await pool.query(
      "SELECT count(*)::int AS n FROM migration_rows WHERE project_id=$1 AND matched_venue_id IS NOT NULL AND conflict_decision IS NULL AND check_status NOT IN ('rejected','duplicate')",
      [p.id],
    )).rows[0].n;
    if (unresolved > 0) throw badRequest(`${unresolved} conflict${unresolved > 1 ? 's' : ''} must be resolved (keep_existing, use_import or skip) before approval`);
    const updated = (await pool.query(
      "UPDATE migration_projects SET status='approved', approved_at=now(), approved_by=$2, updated_at=now() WHERE id=$1 AND status='checked' RETURNING *",
      [p.id, user.id],
    )).rows[0];
    if (!updated) throw conflict('Run a dry-run check before approving');
    await audit(pool, user.id, 'approve_venue_import', 'migration_projects', p.id);
    return publicProject(updated);
  },
});

cap({
  name: 'run_venue_import', method: 'POST', path: '/venue-imports/:id/run', tag: TAG,
  summary: 'Run the approved import: create new venues, courts and opening hours, fill blank details of existing venues where use_import was chosen, and link rows to venues. Idempotent: rows already imported are never imported twice and re-running a completed import does nothing.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    if (p.status === 'completed') return { created: 0, updated: 0, skipped: 0, failed: 0, pending_review: 0, total: 0, message: 'Already completed' };
    if (!['approved', 'running'].includes(p.status)) throw conflict('The import must be approved before it can run');
    const claimed = await pool.query("UPDATE migration_projects SET status='running', started_at=COALESCE(started_at, now()), updated_at=now() WHERE id=$1 AND status IN ('approved','running') RETURNING id", [p.id]);
    if (!claimed.rowCount) throw conflict('The import must be approved before it can run');

    const rows = (await pool.query(
      "SELECT * FROM migration_rows WHERE project_id=$1 AND check_status NOT IN ('rejected','duplicate') AND commit_status IS DISTINCT FROM 'committed' ORDER BY row_no",
      [p.id],
    )).rows;

    const sportRows = (await pool.query('SELECT id, slug, lower(name) AS lname FROM sports')).rows;
    const sportId = (name) => sportRows.find((s) => s.slug === name || s.lname === name || s.slug === name.replace(/\s+/g, '-'))?.id ?? null;
    const review = approvalsOn() && !isPlatform(user);
    const out = { created: 0, updated: 0, skipped: 0, failed: 0, pending_review: 0 };

    for (const row of rows) {
      const decision = row.conflict_decision;
      if (decision === 'skip' || decision === 'keep_existing' || (row.matched_venue_id && !decision)) {
        out.skipped++;
        await pool.query("UPDATE migration_rows SET commit_status='skipped' WHERE id=$1", [row.id]);
        continue;
      }
      const d = rowData(row);
      try {
        if (!d) throw new Error('The checked data for this row is missing: run the check again');
        const outcome = await tx(async (c) => {
          const cur = (await c.query('SELECT commit_status FROM migration_rows WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
          if (cur?.commit_status === 'committed') return 'done';
          let venueId; let kind;
          if (decision === 'use_import' && row.matched_venue_id) {
            const v = (await c.query('SELECT id, organisation_id FROM venues WHERE id=$1 FOR UPDATE', [row.matched_venue_id])).rows[0];
            if (!v || (v.organisation_id !== p.organisation_id && !isPlatform(user))) throw new Error('This venue does not belong to the organisation: it was left unchanged');
            // non-destructive: only blank details are filled in, nothing the venue already has is replaced
            await c.query(
              `UPDATE venues SET
                 description=COALESCE(NULLIF(description,''), $2),
                 address=COALESCE(NULLIF(address,''), $3),
                 country=COALESCE(NULLIF(country,''), $4),
                 phone=COALESCE(NULLIF(phone,''), $5),
                 email=COALESCE(NULLIF(email,''), $6),
                 latitude=COALESCE(latitude, $7),
                 longitude=COALESCE(longitude, $8)
               WHERE id=$1`,
              [v.id, d.description ?? null, d.address ?? null, d.country ?? null, d.phone ?? null, d.email ?? null,
                (d.lat !== null && d.lng !== null) ? d.lat : null, (d.lat !== null && d.lng !== null) ? d.lng : null],
            );
            venueId = v.id; kind = 'updated';
          } else {
            const tz = d.timezone && validTimezone(d.timezone) ? d.timezone : 'UTC';
            const currency = isSupportedCurrency(d.currency) ? d.currency : 'INR';
            const hasCoords = d.lat !== null && d.lng !== null;
            const v = (await c.query(
              `INSERT INTO venues(name, city, country, address, latitude, longitude, description, timezone, currency, email, phone, amenities,
                                  owner_id, organisation_id, approval_status, active)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
              [d.name, d.city, d.country ?? null, d.address ?? null, hasCoords ? d.lat : null, hasCoords ? d.lng : null, d.description ?? null,
                tz, currency, d.email ?? null, d.phone ?? null, d.amenities ?? [], p.created_by, p.organisation_id,
                review ? 'pending' : 'approved', !review],
            )).rows[0];
            venueId = v.id; kind = 'created';

            // courts / resources, spread across the venue's catalogued sports
            const ids = (d.sports ?? []).map(sportId).filter(Boolean);
            const rk = String(d.resource_kind ?? 'court').toLowerCase().replace(/\s+/g, '_');
            const resKind = RESOURCE_KINDS.includes(rk) ? rk : 'other';
            for (let n = 1; n <= (d.court_count ?? 0); n++) {
              await c.query(
                'INSERT INTO resources(venue_id, name, kind, sport_id, capacity, hourly_rate_cents, active) VALUES ($1,$2,$3,$4,1,$5,true)',
                [venueId, `${resKind.charAt(0).toUpperCase() + resKind.slice(1)} ${n}`, resKind, ids.length ? ids[(n - 1) % ids.length] : null, d.base_rate_minor ?? 0],
              );
            }
            const open = minutesOf(d.hours_open); const close = minutesOf(d.hours_close);
            if (open !== null && close !== null && close > open && close <= 1440) {
              for (let wd = 0; wd <= 6; wd++) await c.query('INSERT INTO venue_hours(venue_id, weekday, opens_min, closes_min) VALUES ($1,$2,$3,$4)', [venueId, wd, open, close]);
            }
            await c.query("INSERT INTO migration_created(project_id, entity_kind, entity_id) VALUES ($1,'venue',$2) ON CONFLICT DO NOTHING", [p.id, venueId]);
          }

          // the link makes the import idempotent per organisation (live links are unique on organisation + key)
          await c.query(
            `INSERT INTO migration_links(organisation_id, domain, key_hash, project_id, row_id) VALUES ($1,'venue',$2,$3,$4)
             ON CONFLICT (organisation_id, domain, key_hash) WHERE released_at IS NULL DO NOTHING`,
            [p.organisation_id, blindIndex(`venue|${d.name}|${d.city}`), p.id, row.id],
          );
          await c.query("UPDATE migration_rows SET commit_status='committed', committed_at=now() WHERE id=$1", [row.id]);
          return kind;
        });
        if (outcome === 'created') { out.created++; if (review) out.pending_review++; } else if (outcome === 'updated') out.updated++;
      } catch (err) {
        await pool.query(
          "UPDATE migration_rows SET commit_status='failed', reasons=COALESCE(reasons,'[]'::jsonb) || $2::jsonb WHERE id=$1",
          [row.id, JSON.stringify([{ field: 'run', level: 'error', message: String(err.message ?? err).slice(0, 300) }])],
        );
        out.failed++;
      }
    }

    await pool.query("UPDATE migration_projects SET status='completed', completed_at=now(), updated_at=now() WHERE id=$1", [p.id]);
    await audit(pool, user.id, 'run_venue_import', 'migration_projects', p.id);
    return { ...out, total: rows.length, status: 'completed' };
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
      'SELECT commit_status, count(*)::int AS n FROM migration_rows WHERE project_id=$1 AND commit_status IS NOT NULL GROUP BY 1',
      [p.id],
    )).rows;
    const commit_summary = { committed: 0, skipped: 0, failed: 0, rolled_back: 0 };
    for (const r of commitRows) commit_summary[r.commit_status] = (commit_summary[r.commit_status] ?? 0) + r.n;
    return { project: publicProject(p), summary, commit_summary };
  },
});

cap({
  name: 'rollback_venue_import', method: 'POST', path: '/venue-imports/:id/rollback', tag: TAG,
  summary: 'Soft-rollback a completed import within 48 hours: pauses every venue this import created. No venue is deleted, and venues that already existed (including ones whose blanks were filled) are not paused.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await projectFor(user, i.id, { write: true });
    if (p.status !== 'completed') throw conflict('Only a completed import can be rolled back');
    const age = Date.now() - new Date(p.completed_at).getTime();
    if (age > 48 * 60 * 60 * 1000) throw badRequest('Rollback window has passed (48 hours after completion)');

    const ids = (await pool.query("SELECT entity_id FROM migration_created WHERE project_id=$1 AND entity_kind='venue'", [p.id])).rows.map((r) => r.entity_id);

    await tx(async (c) => {
      if (ids.length) await c.query('UPDATE venues SET active=false, paused_by_partner=true WHERE id=ANY($1::uuid[])', [ids]);
      await c.query("UPDATE migration_links SET released_at=now() WHERE project_id=$1 AND domain='venue' AND released_at IS NULL", [p.id]);
      await c.query("UPDATE migration_rows SET commit_status='rolled_back' WHERE project_id=$1 AND commit_status='committed'", [p.id]);
      await c.query("UPDATE migration_projects SET status='rolled_back', rolled_back_at=now(), updated_at=now() WHERE id=$1 AND status='completed'", [p.id]);
      await audit(c, user.id, 'rollback_venue_import', 'migration_projects', p.id);
    });
    return { paused: ids.length };
  },
});
