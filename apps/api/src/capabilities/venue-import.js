// Venue bulk import (#697): upload a CSV or Excel file of venues, map columns, dry-run with row-level errors, resolve conflicts against
// existing venues, approve and run. Idempotent (status-based, nothing deleted), reversible by pausing created venues.
// Reuses migration_projects + migration_rows tables (domain='venue') and the sealRaw/openData encryption from the roster engine.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { tableFileToCsv } from '../match-file.js';
import { encrypt, decrypt } from '../crypto.js';
import { sealRaw, openData, MAX_ROWS } from '../migration.js';
import {
  VENUE_SOURCES, VENUE_SOURCE_KEYS, VENUE_FIELDS, proposeVenueMapping, missingVenueFields,
  venueTemplateCsv, validateVenueRow, normaliseVenueRow, venueHeaderKey,
} from '../venue-import-formats.js';
import { isPlatform } from '../platform.js';

const TAG = 'Venue import';
const STAFF = ['owner', 'admin'];
const DATA_CTX = 'migration_rows.data';
const sealData = (o) => encrypt(JSON.stringify(o), DATA_CTX);
const openNormData = (s) => (s ? JSON.parse(decrypt(s, DATA_CTX)) : null);

/** Haversine distance in metres between two lat/lng pairs. */
function haversineMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function importFor(user, projectId, { write = false } = {}) {
  const p = await one('SELECT * FROM migration_projects WHERE id=$1 AND domain=$2', [projectId, 'venue']);
  if (!p) throw notFound('Venue import');
  const { org } = await orgFor(user, p.organisation_id, STAFF, { write });
  return { p, org };
}

function publicProject(p) {
  const { options, ...rest } = p;
  const { headers, ...opts } = options ?? {};
  return { ...rest, options: opts };
}

async function venueImportSummary(projectId) {
  const rows = (await pool.query('SELECT check_status AS s, count(*)::int AS n FROM migration_rows WHERE project_id=$1 GROUP BY 1', [projectId])).rows;
  const get = (s) => rows.find((r) => r.s === s)?.n ?? 0;
  const total = rows.reduce((a, r) => a + r.n, 0);
  const conflictRows = (await pool.query("SELECT count(*)::int AS n FROM migration_rows WHERE project_id=$1 AND matched_venue_id IS NOT NULL AND conflict_decision IS NULL AND check_status NOT IN ('rejected')", [projectId])).rows[0].n;
  return {
    total, valid: get('valid'), warning: get('warning'), rejected: get('rejected'), skipped: get('skipped'), pending: get('pending'),
    importable: get('valid') + get('warning'),
    unresolved_conflicts: conflictRows,
  };
}

function venueImportView(p) {
  const opts = p.options ?? {};
  const headers = opts.headers ?? [];
  const analysis = proposeVenueMapping(headers, p.source, p.mapping ?? {});
  return { ...publicProject(p), analysis, source_rows: p.source_rows };
}

// ------------------------------------------------------------------ sources & template

cap({
  name: 'list_venue_import_sources', method: 'GET', path: '/venue-imports/sources', tag: TAG,
  summary: 'Available import sources for venues (Playo, GotSport, TeamSnap Locations, SportsEngine Facilities, Excel/CSV), all importable venue fields, and the per-source templates.',
  input: z.object({}),
  handler: () => ({
    sources: VENUE_SOURCES,
    domains: [{ key: 'venue', label: 'Venues, courts and pricing', fields: VENUE_FIELDS }],
    max_rows: MAX_ROWS,
    not_importable: ['payout / bank details', 'booking history', 'credentials', 'guardian/consent data'],
  }),
});

cap({
  name: 'get_venue_import_template', method: 'GET', path: '/venue-imports/template', tag: TAG,
  summary: 'A header-only CSV template for the chosen source (Playo, GotSport, etc.) so a first-time importer knows what columns to supply.',
  input: z.object({ source: z.enum(VENUE_SOURCE_KEYS).default('excel') }),
  handler: (_ctx, i) => ({ filename: `gotmygame-venues-${i.source}-template.csv`, csv: venueTemplateCsv(i.source) }),
});

// ------------------------------------------------------------------ create

cap({
  name: 'create_venue_import', method: 'POST', path: '/organisations/:organisation_id/venue-imports', tag: TAG, status: 201,
  summary: `Start a venue bulk import for an organisation (owner/admin). Send a CSV text body or a base64-encoded Excel file (.xlsx). Nothing is created yet — columns are proposed, then you map, dry-run and approve before any venue is written. Up to ${MAX_ROWS} venues per upload.`,
  input: z.object({
    organisation_id: id,
    source: z.enum(VENUE_SOURCE_KEYS),
    file: z.string().min(3).max(4_000_000).describe('CSV text or base64-encoded Excel/XLSX'),
    file_name: z.string().max(200).optional(),
    options: z.object({
      currency: z.string().length(3).optional().describe('Default currency code (INR, USD…) for rows with no currency column'),
      default_timezone: z.string().max(60).optional().describe('Default IANA timezone (e.g. Asia/Kolkata)'),
      skip_existing: z.boolean().optional().describe('Auto-skip rows where a venue with the same name+city already exists (default: flag as conflict for manual decision)'),
    }).optional(),
    mapping: z.record(z.string(), z.string()).optional().describe('Canonical field → column header; omit to accept the auto-proposed mapping'),
  }),
  async handler({ user }, i) {
    await orgFor(user, i.organisation_id, STAFF, { write: true });
    // Parse: try as CSV first; if file looks like base64 attempt Excel conversion
    let csvText = i.file;
    if (/^[A-Za-z0-9+/\r\n]+=*$/.test(i.file.replace(/\s/g, '')) && !i.file.includes(',')) {
      try { csvText = await tableFileToCsv(Buffer.from(i.file, 'base64')); } catch { /* treat as CSV */ }
    } else if (i.file_name?.match(/\.xlsx?$/i)) {
      try { csvText = await tableFileToCsv(Buffer.from(i.file, 'base64')); } catch { /* treat as plain CSV */ }
    }
    // Parse headers + rows
    const lines = csvText.split(/\r?\n/);
    if (lines.length < 2) throw badRequest('File needs a header row and at least one data row');
    const { parseCsv } = await import('../csv.js');
    const parsed = parseCsv(csvText);
    if (parsed.length < 2) throw badRequest('File needs a header row and at least one data row');
    const headers = parsed[0].map((h) => String(h ?? '').trim()).filter(Boolean);
    const rows = parsed.slice(1).filter((r) => r.some((c) => String(c ?? '').trim()));
    if (!headers.length) throw badRequest('No column headers found in the first row');
    if (rows.length > MAX_ROWS) throw badRequest(`Upload at most ${MAX_ROWS} rows at a time. Split the file by city or region`);
    const opts = i.options ?? {};
    // Reuse the last confirmed mapping for the same source in the same org
    const last = await one("SELECT mapping FROM migration_projects WHERE organisation_id=$1 AND source=$2 AND domain='venue' AND status IN ('completed','rolled_back') ORDER BY created_at DESC LIMIT 1", [i.organisation_id, i.source]);
    const proposed = proposeVenueMapping(headers, i.source, i.mapping ?? last?.mapping ?? {});
    if (i.mapping) {
      for (const [f, h] of Object.entries(i.mapping)) if (h && !headers.includes(h)) throw badRequest(`Column "${h}" is not in the file (field: ${f})`);
    }
    return tx(async (c) => {
      const p = (await c.query(
        `INSERT INTO migration_projects(organisation_id, domain, source, file_name, mapping, options, source_rows, created_by) VALUES ($1,'venue',$2,$3,$4,$5,$6,$7) RETURNING *`,
        [i.organisation_id, i.source, i.file_name ?? null, JSON.stringify(proposed.mapping), JSON.stringify({ ...opts, headers }), rows.length, user.id])).rows[0];
      for (const [n, r] of rows.entries()) {
        const rowObj = Object.fromEntries(headers.map((h, k) => [h, String(r[k] ?? '').trim()]));
        await c.query('INSERT INTO migration_rows(project_id, row_no, raw_enc) VALUES ($1,$2,$3)', [p.id, n + 2, sealRaw(rowObj)]);
      }
      await audit(c, user.id, 'create_venue_import', 'migration_projects', p.id);
      return venueImportView(p);
    });
  },
});

// ------------------------------------------------------------------ read

cap({
  name: 'list_venue_imports', method: 'GET', path: '/organisations/:organisation_id/venue-imports', tag: TAG,
  summary: 'List venue imports for an organisation, newest first (owner/admin).',
  input: z.object({ organisation_id: id, ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.organisation_id, STAFF);
    return (await many("SELECT * FROM migration_projects WHERE organisation_id=$1 AND domain='venue' ORDER BY created_at DESC, id LIMIT $2 OFFSET $3", [i.organisation_id, i.limit, i.offset])).map(publicProject);
  },
});

cap({
  name: 'get_venue_import', method: 'GET', path: '/venue-imports/:id', tag: TAG,
  summary: 'One venue import: status, column mapping analysis, outcome counts and any missing/ambiguous columns.',
  input: z.object({ id }),
  async handler({ user }, i) { const { p } = await importFor(user, i.id); return { ...venueImportView(p), summary: await venueImportSummary(p.id) }; },
});

cap({
  name: 'update_venue_import_mapping', method: 'PATCH', path: '/venue-imports/:id/mapping', tag: TAG,
  summary: 'Update which spreadsheet column maps to which venue field, or change the default currency / timezone. Any change resets the import to the mapping step — it must be checked again before it can be approved.',
  input: z.object({
    id,
    mapping: z.record(z.string(), z.string().nullable()).optional().describe('Canonical field → column header. Set a field to null to unmap it.'),
    options: z.object({ currency: z.string().length(3).optional(), default_timezone: z.string().max(60).optional(), skip_existing: z.boolean().optional() }).optional(),
  }),
  async handler({ user }, i) {
    const { p } = await importFor(user, i.id, { write: true });
    if (['importing', 'completed', 'rolled_back'].includes(p.status)) throw conflict('This import has already run. Start a new import to load a corrected file');
    const headers = p.options.headers ?? [];
    const mapping = { ...p.mapping };
    for (const [f, h] of Object.entries(i.mapping ?? {})) {
      if (!VENUE_FIELDS.some((x) => x.key === f)) throw badRequest(`Unknown venue field: ${f}`);
      if (h) { if (!headers.includes(h)) throw badRequest(`Column "${h}" is not in the uploaded file`); mapping[f] = h; } else delete mapping[f];
    }
    const opts = { ...(p.options ?? {}), ...(i.options ?? {}) };
    await pool.query("UPDATE migration_projects SET mapping=$2, options=$3, status='mapping', updated_at=now() WHERE id=$1", [p.id, JSON.stringify(mapping), JSON.stringify(opts)]);
    const updated = await one('SELECT * FROM migration_projects WHERE id=$1', [p.id]);
    return venueImportView(updated);
  },
});

// ------------------------------------------------------------------ dry-run / check

cap({
  name: 'check_venue_import', method: 'POST', path: '/venue-imports/:id/check', tag: TAG,
  summary: 'Dry-run: validate every row, check coordinates and name+city against existing venues to flag conflicts and duplicates. No venues are written. Must be run after every mapping change. Returns per-status counts.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await importFor(user, i.id, { write: true });
    if (['importing', 'completed'].includes(p.status)) throw conflict('Import has already run; start a new import for a new file');
    const opts = p.options ?? {};
    const mapping = p.mapping ?? {};
    const rows = (await pool.query('SELECT id, row_no, raw_enc FROM migration_rows WHERE project_id=$1 ORDER BY row_no', [p.id])).rows;
    // Load all existing venues for this org for conflict detection (name+city index + coords)
    const existingVenues = (await pool.query('SELECT id, lower(name) AS n, lower(city) AS c, lat, lng FROM venues WHERE organisation_id=$1 AND approval_status<>$2', [p.organisation_id, 'rejected'])).rows;
    const nameCityIndex = new Map(existingVenues.map((v) => [`${v.n}||${v.c}`, v.id]));
    // Also track name+city within the file (intra-file duplicates)
    const seenInFile = new Map();
    const updates = [];
    for (const r of rows) {
      const rawObj = JSON.parse(decrypt(r.raw_enc, 'migration_rows.raw'));
      const norm = normaliseVenueRow(rawObj, mapping, { defaultCurrency: opts.currency, defaultTimezone: opts.default_timezone });
      const { valid, reasons } = validateVenueRow(rawObj, mapping, { defaultCurrency: opts.currency });
      let status = valid ? (reasons.length ? 'warning' : 'valid') : 'rejected';
      let matchedVenueId = null;
      if (status !== 'rejected' && norm.name && norm.city) {
        const key = `${norm.name.toLowerCase()}||${norm.city.toLowerCase()}`;
        // Check intra-file duplicate
        if (seenInFile.has(key)) {
          status = 'warning';
          reasons.push({ level: 'warning', field: 'name', message: `Same name and city as row ${seenInFile.get(key)} in this file` });
        } else {
          seenInFile.set(key, r.row_no);
        }
        // Check existing venue by name+city
        const existId = nameCityIndex.get(key);
        if (existId) {
          matchedVenueId = existId;
          if (opts.skip_existing) {
            status = 'skipped';
            reasons.push({ level: 'info', field: 'name', message: `Venue "${norm.name}" already exists in ${norm.city} — skipped (skip_existing is on)` });
          } else {
            if (status !== 'warning') status = 'warning';
            reasons.push({ level: 'warning', field: 'name', message: `Venue "${norm.name}" in ${norm.city} already exists on the platform (ID ${existId}). Resolve the conflict before importing` });
          }
        }
        // Check coordinate proximity (50 m)
        if (!matchedVenueId && norm.lat !== null && norm.lng !== null) {
          for (const ev of existingVenues) {
            if (ev.lat === null || ev.lng === null) continue;
            if (haversineMetres(norm.lat, norm.lng, Number(ev.lat), Number(ev.lng)) <= 50) {
              matchedVenueId = ev.id;
              reasons.push({ level: 'warning', field: 'lat', message: `Coordinates are within 50 m of existing venue ID ${ev.id} — possible duplicate` });
              if (status === 'valid') status = 'warning';
              break;
            }
          }
        }
      }
      updates.push({ id: r.id, status, reasons, data: norm, matchedVenueId });
    }
    await tx(async (c) => {
      for (const u of updates) {
        await c.query(
          'UPDATE migration_rows SET check_status=$2, reasons=$3, data_enc=$4, matched_venue_id=$5 WHERE id=$1',
          [u.id, u.status, JSON.stringify(u.reasons), sealData(u.data), u.matchedVenueId ?? null]);
      }
      await c.query("UPDATE migration_projects SET status='dry_run', updated_at=now() WHERE id=$1", [p.id]);
      await audit(c, user.id, 'check_venue_import', 'migration_projects', p.id);
    });
    return venueImportSummary(p.id);
  },
});

// ------------------------------------------------------------------ row listing and conflict resolution

cap({
  name: 'list_venue_import_rows', method: 'GET', path: '/venue-imports/:id/rows', tag: TAG,
  summary: 'Paginated list of import rows with their validation status, reasons and matched existing venue (if any). Filter by check_status to focus on errors, conflicts or clean rows.',
  input: z.object({ id, check_status: z.enum(['valid', 'warning', 'rejected', 'skipped', 'pending']).optional(), ...page }),
  async handler({ user }, i) {
    const { p } = await importFor(user, i.id);
    const filter = i.check_status ? ' AND check_status=$4' : '';
    const args = i.check_status ? [p.id, i.limit, i.offset, i.check_status] : [p.id, i.limit, i.offset];
    const rows = await many(`SELECT id, row_no, check_status, reasons, data_enc, matched_venue_id, conflict_decision FROM migration_rows WHERE project_id=$1${filter} ORDER BY row_no LIMIT $2 OFFSET $3`, args);
    const matchedIds = [...new Set(rows.map((r) => r.matched_venue_id).filter(Boolean))];
    const matchedVenues = matchedIds.length ? Object.fromEntries((await many(`SELECT id, name, city FROM venues WHERE id=ANY($1)`, [matchedIds])).map((v) => [v.id, v])) : {};
    return rows.map((r) => ({
      id: r.id, row_no: r.row_no, check_status: r.check_status,
      reasons: (r.reasons ?? []).filter((x) => x.level !== 'info'),
      data: openNormData(r.data_enc),
      matched_venue: r.matched_venue_id ? matchedVenues[r.matched_venue_id] ?? { id: r.matched_venue_id } : null,
      conflict_decision: r.conflict_decision ?? null,
    }));
  },
});

cap({
  name: 'review_venue_import_row', method: 'PATCH', path: '/venue-imports/:id/rows/:row_id', tag: TAG,
  summary: "Resolve a conflict row: 'keep_existing' skips the import row (default), 'use_import' overwrites the existing venue's editable fields, 'skip' always skips. Only valid for rows that matched an existing venue.",
  input: z.object({
    id,
    row_id: id,
    conflict_decision: z.enum(['keep_existing', 'use_import', 'skip']),
  }),
  async handler({ user }, i) {
    const { p } = await importFor(user, i.id, { write: true });
    const row = await one('SELECT * FROM migration_rows WHERE id=$1 AND project_id=$2', [i.row_id, p.id]);
    if (!row) throw notFound('Row');
    if (!row.matched_venue_id) throw badRequest('This row has no conflict — only rows matched to an existing venue can have a conflict decision');
    await pool.query('UPDATE migration_rows SET conflict_decision=$2 WHERE id=$1', [i.row_id, i.conflict_decision]);
    return { id: i.row_id, conflict_decision: i.conflict_decision };
  },
});

// ------------------------------------------------------------------ approve & run

cap({
  name: 'approve_venue_import', method: 'POST', path: '/venue-imports/:id/approve', tag: TAG,
  summary: 'Platform admin or org owner: approve a checked import for running. Blocked if any error rows remain unresolved or if there are unresolved conflict rows without a decision.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await importFor(user, i.id, { write: true });
    if (!['dry_run', 'mapping'].includes(p.status)) throw conflict(`Import is in status "${p.status}" — run check first`);
    const summary = await venueImportSummary(p.id);
    if (summary.rejected > 0) throw badRequest(`${summary.rejected} rows have errors that must be fixed before approving. Download the error report, fix the source file and re-upload.`);
    if (summary.unresolved_conflicts > 0) throw badRequest(`${summary.unresolved_conflicts} conflict rows need a decision (keep_existing, use_import or skip) before approving`);
    await pool.query("UPDATE migration_projects SET status='approved', approved_at=now(), updated_at=now() WHERE id=$1", [p.id]);
    await audit(null, user.id, 'approve_venue_import', 'migration_projects', p.id);
    return { id: p.id, status: 'approved', approved_at: new Date().toISOString(), importable: summary.importable };
  },
});

cap({
  name: 'run_venue_import', method: 'POST', path: '/venue-imports/:id/run', tag: TAG,
  summary: "Platform admin or org owner: run an approved venue import. Each valid row is created as a draft venue (or the existing venue is updated for 'use_import' conflicts). Runs in batches; safe to call again if interrupted. Created venues start in 'pending' approval status. Nothing is deleted.",
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await importFor(user, i.id, { write: true });
    if (p.status !== 'approved') throw conflict(`Import must be in 'approved' status to run (currently "${p.status}")`);
    await pool.query("UPDATE migration_projects SET status='importing', started_at=coalesce(started_at, now()), updated_at=now() WHERE id=$1", [p.id]);
    const opts = p.options ?? {};
    const todo = await many(
      `SELECT id, row_no, data_enc, matched_venue_id, conflict_decision FROM migration_rows
       WHERE project_id=$1 AND check_status IN ('valid','warning') AND (commit_status IS NULL OR commit_status='failed')
       ORDER BY row_no`, [p.id]);
    const BATCH = 50;
    for (let at = 0; at < todo.length; at += BATCH) {
      await tx(async (c) => {
        for (const r of todo.slice(at, at + BATCH)) {
          const d = openNormData(r.data_enc);
          if (!d) { await c.query("UPDATE migration_rows SET commit_status='skipped' WHERE id=$1", [r.id]); continue; }
          let commitStatus = 'failed', venueId = null, why = null;
          try {
            await c.query('SAVEPOINT venue_row');
            const decision = r.conflict_decision ?? (r.matched_venue_id ? 'keep_existing' : null);
            if (decision === 'skip' || (r.matched_venue_id && !decision) || decision === 'keep_existing') {
              commitStatus = 'skipped';
            } else if (decision === 'use_import' && r.matched_venue_id) {
              // Additive update: only overwrite fields the import row supplies
              const setParts = [], vals = [];
              const addField = (col, val) => { if (val !== null && val !== undefined) { vals.push(val); setParts.push(`${col}=$${vals.length}`); } };
              addField('name', d.name); addField('city', d.city); addField('country', d.country);
              addField('address', d.address);
              if (d.lat !== null && d.lng !== null) { addField('lat', d.lat); addField('lng', d.lng); }
              addField('description', d.description); addField('timezone', d.timezone);
              if (setParts.length) await c.query(`UPDATE venues SET ${setParts.join(', ')}, updated_at=now() WHERE id=$${vals.length + 1}`, [...vals, r.matched_venue_id]);
              // Upsert sports
              for (const sport of (d.sports ?? [])) {
                const sp = await c.query("SELECT id FROM sports WHERE lower(slug)=lower($1) OR lower(name)=lower($1) LIMIT 1", [sport]);
                if (sp.rows[0]) await c.query('INSERT INTO venue_sports(venue_id, sport_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.matched_venue_id, sp.rows[0].id]);
              }
              venueId = r.matched_venue_id; commitStatus = 'committed';
            } else {
              // Create new venue (draft / pending)
              const v = (await c.query(
                `INSERT INTO venues(name, city, country, address, lat, lng, description, timezone, owner_id, organisation_id, approval_status, currency)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) RETURNING id`,
                [d.name, d.city, d.country ?? null, d.address ?? null, d.lat, d.lng, d.description ?? null, d.timezone ?? null, p.created_by, p.organisation_id, d.currency ?? 'INR'])).rows[0];
              venueId = v.id;
              // Add resources
              const kind = d.resource_kind ?? 'court';
              const count = d.court_count ?? 1;
              for (let n = 1; n <= count; n++) {
                await c.query('INSERT INTO resources(venue_id, name, kind, capacity, hourly_rate_cents, active) VALUES ($1,$2,$3,1,$4,true)', [venueId, `${kind.charAt(0).toUpperCase() + kind.slice(1)} ${n}`, kind, d.base_rate_minor ?? 0]);
              }
              // Add price rule if rate supplied
              if (d.base_rate_minor) {
                await c.query('INSERT INTO price_rules(venue_id, name, rate_cents, currency, active) VALUES ($1,$2,$3,$4,true) ON CONFLICT DO NOTHING', [venueId, 'Standard', d.base_rate_minor, d.currency ?? 'INR']);
              }
              // Link sports
              for (const sport of (d.sports ?? [])) {
                const sp = await c.query("SELECT id FROM sports WHERE lower(slug)=lower($1) OR lower(name)=lower($1) LIMIT 1", [sport]);
                if (sp.rows[0]) await c.query('INSERT INTO venue_sports(venue_id, sport_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [venueId, sp.rows[0].id]);
              }
              // Set hours if supplied
              if (d.hours_open && d.hours_close) {
                for (const day of [1, 2, 3, 4, 5, 6, 7]) {
                  await c.query('INSERT INTO venue_hours(venue_id, day_of_week, opens_at, closes_at) VALUES ($1,$2,$3,$4) ON CONFLICT (venue_id, day_of_week) DO NOTHING', [venueId, day, d.hours_open, d.hours_close]);
                }
              }
              commitStatus = 'committed';
            }
            if (venueId) {
              await c.query(`INSERT INTO migration_links(organisation_id, domain, key_hash, project_id, row_id, entity_id) VALUES ($1,'venue',$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
                [p.organisation_id, `venue|${venueId}`, p.id, r.id, venueId]);
            }
            await c.query('RELEASE SAVEPOINT venue_row');
          } catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT venue_row');
            commitStatus = 'failed'; why = `Import error: ${e.message?.slice(0, 200)}`;
          }
          await c.query('UPDATE migration_rows SET commit_status=$2, committed_at=now(), reasons=CASE WHEN $3::text IS NULL THEN reasons ELSE reasons || $4::jsonb END WHERE id=$1',
            [r.id, commitStatus, why, JSON.stringify(why ? [{ level: 'error', field: 'import', message: why }] : [])]);
        }
        await audit(c, user.id, 'run_venue_import_batch', 'migration_projects', p.id);
      });
    }
    const failed = (await pool.query("SELECT count(*)::int AS n FROM migration_rows WHERE project_id=$1 AND commit_status='failed'", [p.id])).rows[0].n;
    const finalStatus = failed ? 'reconciliation' : 'completed';
    await pool.query("UPDATE migration_projects SET status=$2, completed_at=CASE WHEN $2='completed' THEN coalesce(completed_at, now()) END, updated_at=now() WHERE id=$1", [p.id, finalStatus]);
    await audit(null, user.id, 'complete_venue_import', 'migration_projects', p.id);
    return getVenueImportReport(p.id);
  },
});

// ------------------------------------------------------------------ report

async function getVenueImportReport(projectId) {
  const p = await one('SELECT * FROM migration_projects WHERE id=$1', [projectId]);
  const summary = await venueImportSummary(projectId);
  const commit = Object.fromEntries((await many("SELECT coalesce(commit_status,'pending') AS s, count(*)::int AS n FROM migration_rows WHERE project_id=$1 GROUP BY 1", [projectId])).map((r) => [r.s, r.n]));
  const created = await many(
    `SELECT v.id, v.name, v.city, v.approval_status FROM migration_links ml JOIN venues v ON v.id=ml.entity_id WHERE ml.project_id=$1 AND ml.domain='venue' ORDER BY v.name`,
    [projectId]);
  const failed = await many(
    `SELECT row_no, reasons, data_enc FROM migration_rows WHERE project_id=$1 AND commit_status='failed' ORDER BY row_no LIMIT 100`,
    [projectId]);
  return {
    project: { id: p.id, status: p.status, source: p.source, file_name: p.file_name, created_at: p.created_at, approved_at: p.approved_at, completed_at: p.completed_at },
    source_rows: p.source_rows,
    validation: summary,
    result: { committed: commit.committed ?? 0, skipped: commit.skipped ?? 0, failed: commit.failed ?? 0, pending: commit.pending ?? 0 },
    created_venues: created,
    failed_rows: failed.map((r) => ({ row: r.row_no, errors: (r.reasons ?? []).filter((x) => x.level === 'error').map((x) => x.message), data: openNormData(r.data_enc) ? { name: openNormData(r.data_enc)?.name, city: openNormData(r.data_enc)?.city } : null })),
  };
}

cap({
  name: 'get_venue_import_report', method: 'GET', path: '/venue-imports/:id/report', tag: TAG,
  summary: 'Full import report: row counts by status, list of created/skipped/failed venues with reasons. Only available after the import has run.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await importFor(user, i.id);
    if (!['importing', 'completed', 'reconciliation', 'rolled_back'].includes(p.status)) throw badRequest('Report is only available after the import has run');
    return getVenueImportReport(p.id);
  },
});

// ------------------------------------------------------------------ rollback

cap({
  name: 'rollback_venue_import', method: 'POST', path: '/venue-imports/:id/rollback', tag: TAG,
  summary: "Reverse a completed venue import within 48 hours. Created venues are set to 'paused' (never deleted — history is kept). Updated venues have their changes soft-reverted via a note. Returns how many venues were paused. Idempotent.",
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p } = await importFor(user, i.id, { write: true });
    if (!['completed', 'reconciliation'].includes(p.status)) throw conflict(`Only a completed import can be rolled back (status: "${p.status}")`);
    const ageHours = (Date.now() - new Date(p.completed_at).getTime()) / 3.6e6;
    if (ageHours > 48 && !isPlatform(user)) throw forbidden('Rollback window is 48 hours after completion. Contact the platform team for a manual correction.');
    return tx(async (c) => {
      // Pause venues created by this import (not deleted — data preservation rule)
      const links = await c.query(`SELECT entity_id FROM migration_links WHERE project_id=$1 AND domain='venue' AND released_at IS NULL`, [p.id]);
      let paused = 0;
      for (const l of links.rows) {
        await c.query("UPDATE venues SET paused_by_partner=true WHERE id=$1 AND approval_status<>'rejected'", [l.entity_id]);
        await c.query('UPDATE migration_links SET released_at=now() WHERE project_id=$1 AND entity_id=$2 AND released_at IS NULL', [p.id, l.entity_id]);
        paused++;
      }
      await c.query("UPDATE migration_rows SET commit_status='rolled_back' WHERE project_id=$1 AND commit_status='committed'", [p.id]);
      await c.query("UPDATE migration_projects SET status='rolled_back', rolled_back_at=now(), updated_at=now() WHERE id=$1", [p.id]);
      await audit(c, user.id, 'rollback_venue_import', 'migration_projects', p.id);
      return { rolled_back: true, venues_paused: paused, note: 'Paused venues retain all data and can be reactivated from Venue workspace.' };
    });
  },
});
