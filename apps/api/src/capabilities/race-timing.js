// Race operations (issue #487), part 2: timing. Raw evidence in (provider-neutral batch files, manual official reads), deterministic reconciliation
// into versioned derived results, governed race status (DNS/DNF/DQ/cutoff), cutoff review, auditable corrections and protests.
// Raw reads are append-only and never edited; everything derived is a new version that records the policy and course it was computed under.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { capabilities, cap, id } from '../registry.js';
import { tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { guardianLink } from '../youth.js';
import { decrypt } from '../crypto.js';
import { reconcileEntrant, computeKeys, digestOf, sha, stableJson, parseCsv, governedStatuses, encodeCursor, decodeCursor, STAFF_CHIEF } from '../race.js';
import {
  TAG, ACTIVE_ENTRY, serial, lockRace, raceCtx, raceLog, sealReason, openReason, loadEntrant, notifyEntrants, NO_ACCESS,
} from './race-setup.js';

const dt = z.string().datetime({ offset: true });
const CP = /^[A-Z0-9_-]{1,16}$/;
const TS = (col) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const chunk = (a, n) => { const out = []; for (let k = 0; k < a.length; k += n) out.push(a.slice(k, k + n)); return out; };
const reason = z.string().trim().min(5).max(300);

export const isFinalised = async (c, disciplineId) => (await c.query("SELECT 1 FROM race_publications WHERE discipline_id=$1 AND label IN ('final','corrected') LIMIT 1", [disciplineId])).rowCount > 0;

/** True when evidence or configuration changed after the last reconciliation, so the derived results may be out of date. */
export async function resultsStale(c, disciplineId) {
  const r = (await c.query(
    `WITH last AS (SELECT max(created_at) AS at FROM race_runs WHERE discipline_id=$1)
     SELECT (SELECT at FROM last) IS NULL AS never,
            greatest(
              (SELECT max(imported_at) FROM race_reads WHERE discipline_id=$1),
              (SELECT max(created_at) FROM race_read_marks WHERE discipline_id=$1),
              (SELECT max(greatest(created_at, coalesce(to_at, created_at))) FROM race_assignments WHERE discipline_id=$1),
              (SELECT max(updated_at) FROM race_waves WHERE discipline_id=$1 AND gun_at IS NOT NULL),
              (SELECT max(coalesce(published_at, created_at)) FROM race_courses WHERE discipline_id=$1 AND status='published'),
              (SELECT max(decided_at) FROM race_corrections WHERE discipline_id=$1 AND state='approved'),
              (SELECT max(l.created_at) FROM race_status_log l JOIN race_entrants e ON e.id=l.entrant_id WHERE e.discipline_id=$1 AND l.source <> 'timing')
            ) > (SELECT at FROM last) AS stale,
            (SELECT rules_digest FROM race_runs WHERE discipline_id=$1 ORDER BY created_at DESC LIMIT 1) AS ran_with,
            (SELECT rules FROM race_policies WHERE discipline_id=$1 ORDER BY version DESC LIMIT 1) AS rules`, [disciplineId])).rows[0];
  if (r.never) return true;
  return !!r.stale || (r.ran_with !== null && r.ran_with !== computeKeys(r.rules));
}

// ---------------------------------------------------------------- timing sources

cap({
  name: 'create_race_source', method: 'POST', path: '/races/:id/sources', tag: TAG, status: 201,
  summary: 'Register where timing data comes from: chip reads, checkpoint scans, finish-line system export, a batch file or the officials\' manual reads. Integrations are `file_import` (CSV/JSON in the platform\'s documented layout) or `manual`; a vendor or device name is only a label. No hardware or vendor API integration is claimed until a tested adapter exists. A declared clock offset is added to observed times when reconciling; the raw record is never changed.',
  input: z.object({
    id, name: z.string().trim().min(1).max(80), kind: z.enum(['chip_reads', 'checkpoint_scan', 'manual_official', 'batch_file', 'finish_system']), integration: z.enum(['file_import', 'manual']).default('file_import'),
    provider_label: z.string().max(80).optional(), device_ref: z.string().max(80).optional(), clock_offset_ms: z.number().int().min(-3_600_000).max(3_600_000).default(0),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await raceCtx(c, user, i.id, 'chief');
      try {
        const row = (await c.query('INSERT INTO race_sources(discipline_id, name, kind, integration, provider_label, device_ref, clock_offset_ms, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [i.id, i.name, i.kind, i.integration, i.provider_label ?? null, i.device_ref ?? null, i.clock_offset_ms, user.id])).rows[0];
        await raceLog(c, { discipline_id: i.id, subject: 'import', subject_id: row.id, action: 'source_created', after: { name: row.name, kind: row.kind, clock_offset_ms: row.clock_offset_ms }, actor_id: user.id });
        return row;
      } catch (e) { if (e.code === '23505') throw conflict('A source with that name already exists'); throw e; }
    });
  },
});

cap({
  name: 'retire_race_source', method: 'POST', path: '/race-sources/:id/retire', tag: TAG,
  summary: 'Retire a timing source (e.g. a failed reader). Its recorded reads stay as evidence; it just takes no new imports.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM race_sources WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!s) throw NO_ACCESS('Source');
      await raceCtx(c, user, s.discipline_id, 'chief');
      return (await c.query('UPDATE race_sources SET retired_at=coalesce(retired_at, now()) WHERE id=$1 RETURNING *', [i.id])).rows[0];
    });
  },
});

async function publishedCourse(c, disciplineId, { need = true } = {}) {
  const course = (await c.query("SELECT * FROM race_courses WHERE discipline_id=$1 AND status='published'", [disciplineId])).rows[0];
  if (!course) { if (need) throw conflict('Publish the course (checkpoints) first'); return null; }
  const checkpoints = (await c.query('SELECT * FROM race_checkpoints WHERE course_id=$1 ORDER BY seq', [course.id])).rows;
  return { course, checkpoints };
}

// ---------------------------------------------------------------- ingesting raw reads (idempotent)

const readRow = z.object({
  chip: z.string().trim().max(40).optional(), bib: z.string().trim().max(40).optional(), checkpoint: z.string().trim().toUpperCase().regex(CP, 'checkpoint code'),
  observed_at: dt, ref: z.string().trim().max(80).optional(), sequence: z.string().trim().max(40).optional(), device: z.string().trim().max(80).optional(),
}).refine((r) => r.chip || r.bib, { message: 'a chip or a bib is needed', path: ['chip'] });

cap({
  name: 'import_race_reads', method: 'POST', path: '/races/:id/reads/import', tag: TAG,
  summary: 'Import raw timing reads from one source: chip reads, checkpoint scans, manual official reads or a finish-system export, as JSON rows or CSV text (columns chip, bib, checkpoint, observed_at, ref, sequence, device). Up to 20000 rows per call. Idempotent: importing the same file again, or overlapping files, stores each read once (by the source\'s `ref` or a hash of the record), and every stored read keeps its source, device, observed time, import time and raw row. Late imports are accepted any time; they mark results stale and never change an official result by themselves.',
  input: z.object({
    id, source_id: id, label: z.string().max(120).optional(), dry_run: z.boolean().default(false), csv: z.string().max(5_000_000).optional(),
    rows: z.array(z.record(z.string(), z.unknown())).max(20000).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await raceCtx(c, user, i.id, 'timing');
      await lockRace(c, i.id);
      const src = (await c.query('SELECT * FROM race_sources WHERE id=$1 AND discipline_id=$2', [i.source_id, i.id])).rows[0];
      if (!src) throw notFound('Source');
      if (src.retired_at) throw conflict('That source is retired');
      let rows = i.rows ?? [];
      if (i.csv) { try { rows = parseCsv(i.csv, { maxRows: 20000 }); } catch (e) { throw badRequest(e.message); } }
      if (!rows.length) throw badRequest('Send `rows` or `csv`');
      const hash = sha(i.csv ?? stableJson(rows));
      const done = (await c.query('SELECT * FROM race_imports WHERE source_id=$1 AND content_hash=$2', [src.id, hash])).rows[0];
      if (done) return { already_imported: true, import_id: done.id, received: done.rows_received, accepted: done.rows_accepted, duplicate: done.rows_duplicate, rejected: done.rows_rejected, rejects: done.rejects };
      const { checkpoints } = await publishedCourse(c, i.id);
      const codes = new Set(checkpoints.map((x) => x.code));
      const rejects = [], good = [], seen = new Set();
      let duplicate = 0;
      rows.forEach((r0, k) => {
        const bad = (message) => rejects.push({ row: k + 1, message });
        const p = readRow.safeParse(Object.fromEntries(Object.entries(r0).filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([key, v]) => [key === 'checkpoint_code' ? 'checkpoint' : key, typeof v === 'number' ? String(v) : v])));
        if (!p.success) return bad(p.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`).join('; '));
        const v = p.data;
        if (!codes.has(v.checkpoint)) return bad(`Unknown checkpoint ${v.checkpoint} (course has ${[...codes].join(', ')})`);
        const key = v.ref ?? sha([v.chip ?? '', v.bib ?? '', v.checkpoint, new Date(v.observed_at).toISOString(), v.device ?? '', v.sequence ?? ''].join('|')).slice(0, 40);
        if (seen.has(key)) { duplicate++; return; }
        seen.add(key);
        good.push({ key, v, raw: v });
      });
      let accepted = 0;
      const importId = randomUUID();
      if (i.dry_run) {
        const have = new Set();
        for (const part of chunk([...seen], 5000)) for (const r of (await c.query('SELECT dedupe_key FROM race_reads WHERE source_id=$1 AND dedupe_key = ANY($2)', [src.id, part])).rows) have.add(r.dedupe_key);
        return { dry_run: true, received: rows.length, will_accept: good.length - have.size, duplicate: duplicate + have.size, rejected: rejects.length, rejects: rejects.slice(0, 200) };
      }
      for (const part of chunk(good, 5000)) {
        const r = await c.query(
          `INSERT INTO race_reads(discipline_id, source_id, import_id, dedupe_key, chip_ref, bib_ref, checkpoint_code, observed_at, sequence, device, origin, raw, entered_by)
           SELECT $1, $2, $3, k, chip, bib, cp, obs, seq, dev, 'import', raw, $4
             FROM unnest($5::text[], $6::text[], $7::text[], $8::text[], $9::timestamptz[], $10::text[], $11::text[], $12::jsonb[]) AS t(k, chip, bib, cp, obs, seq, dev, raw)
           ON CONFLICT (source_id, dedupe_key) DO NOTHING RETURNING id`,
          [i.id, src.id, importId, user.id, part.map((x) => x.key), part.map((x) => x.v.chip ?? null), part.map((x) => x.v.bib ?? null), part.map((x) => x.v.checkpoint), part.map((x) => x.v.observed_at),
            part.map((x) => x.v.sequence ?? null), part.map((x) => x.v.device ?? src.device_ref ?? null), part.map((x) => JSON.stringify(x.raw))]);
        accepted += r.rowCount;
        duplicate += part.length - r.rowCount;
      }
      if (accepted >= 500) await c.query('ANALYZE race_reads'); // a bulk load must not be planned on empty-table statistics
      await c.query('INSERT INTO race_imports(id, discipline_id, source_id, content_hash, label, rows_received, rows_accepted, rows_duplicate, rows_rejected, rejects, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [importId, i.id, src.id, hash, i.label ?? null, rows.length, accepted, duplicate, rejects.length, JSON.stringify(rejects.slice(0, 200)), user.id]);
      await raceLog(c, { discipline_id: i.id, subject: 'import', subject_id: importId, action: 'reads_imported', after: { source: src.name, received: rows.length, accepted, duplicate, rejected: rejects.length }, actor_id: ctx.user.id });
      return { already_imported: false, import_id: importId, received: rows.length, accepted, duplicate, rejected: rejects.length, rejects: rejects.slice(0, 200) };
    });
  },
});

async function manualSource(c, ctx) {
  const have = (await c.query("SELECT * FROM race_sources WHERE discipline_id=$1 AND kind='manual_official' AND integration='manual' AND retired_at IS NULL ORDER BY created_at LIMIT 1", [ctx.d.id])).rows[0];
  if (have) return have;
  return (await c.query("INSERT INTO race_sources(discipline_id, name, kind, integration, provider_label, created_by) VALUES ($1,'Official manual reads','manual_official','manual','Timing desk',$2) RETURNING *", [ctx.d.id, ctx.user.id])).rows[0];
}

async function insertManualRead(c, ctx, entrant, { checkpoint, observed_at, origin, dedupe, actor }) {
  const src = await manualSource(c, ctx);
  const bib = (await c.query("SELECT ref FROM race_assignments WHERE entrant_id=$1 AND kind='bib' AND state='active'", [entrant.id])).rows[0]?.ref ?? `E:${entrant.id.slice(0, 8)}`;
  const read = (await c.query(
    `INSERT INTO race_reads(discipline_id, source_id, dedupe_key, bib_ref, checkpoint_code, observed_at, origin, raw, entered_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [ctx.d.id, src.id, dedupe ?? `manual:${randomUUID()}`, bib, checkpoint, observed_at, origin, JSON.stringify({ entrant_id: entrant.id, checkpoint, observed_at }), actor])).rows[0];
  await c.query("INSERT INTO race_read_marks(discipline_id, read_id, kind, entrant_id, actor_id) VALUES ($1,$2,'link',$3,$4)", [ctx.d.id, read.id, entrant.id, actor]);
  return read;
}

cap({
  name: 'record_manual_read', method: 'POST', path: '/race-entrants/:id/manual-reads', tag: TAG, status: 201,
  summary: 'A timing official records a read by hand (stopwatch, spotter, chip failure) for one entrant at a checkpoint. It is stored as official-manual evidence, attributed to the official, and attached to the entrant. After results are final, use a governed correction instead.',
  input: z.object({ id, checkpoint: z.string().trim().toUpperCase().regex(CP), observed_at: dt.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await loadEntrant(c, i.id);
      const ctx = await raceCtx(c, user, e.discipline_id, 'timing');
      await lockRace(c, e.discipline_id);
      if (await isFinalised(c, e.discipline_id)) throw conflict('Results are final; propose a governed correction (manual_read)');
      const { checkpoints } = await publishedCourse(c, e.discipline_id);
      if (!checkpoints.some((x) => x.code === i.checkpoint)) throw badRequest(`Unknown checkpoint ${i.checkpoint}`);
      const read = await insertManualRead(c, ctx, e, { checkpoint: i.checkpoint, observed_at: i.observed_at ?? new Date().toISOString(), origin: 'manual_official', actor: user.id });
      await raceLog(c, { discipline_id: e.discipline_id, entrant_id: e.id, subject: 'entrant', subject_id: read.id, action: 'manual_read', after: { checkpoint: i.checkpoint, observed_at: read.observed_at }, actor_id: user.id });
      return read;
    });
  },
});

// ---------------------------------------------------------------- reconciliation

const CHIP_MATCH = `r.chip_ref IS NOT NULL AND a.kind='chip' AND lower(r.chip_ref)=lower(a.ref)`;
const BIB_MATCH = `r.chip_ref IS NULL AND a.kind='bib' AND a.discipline_id=r.discipline_id AND lower(r.bib_ref)=lower(a.ref)`;
const EFF = "r.observed_at + s.clock_offset_ms * interval '1 millisecond'";
const WINDOW = `a.from_at <= ${EFF} AND (a.to_at IS NULL OR a.to_at > ${EFF})`;
const AT_MS = `round(extract(epoch from ${EFF}) * 1000)::bigint`;

/** Reads that belong to nobody: a chip/bib no entrant ever held, or a retired tag read after it was retired. Each opens one exception on the read; links, voids and reissues clear it. */
async function flagUnattributed(c, disciplineId, eventId, actorId) {
  const rows = (await c.query(
    `WITH links AS (SELECT DISTINCT ON (read_id) read_id FROM race_read_marks WHERE discipline_id=$1 AND kind='link' ORDER BY read_id, created_at DESC, id DESC),
          voids AS (SELECT read_id FROM (SELECT DISTINCT ON (read_id) read_id, kind FROM race_read_marks WHERE discipline_id=$1 AND kind IN ('void','restore') ORDER BY read_id, created_at DESC, id DESC) v WHERE kind='void')
     SELECT r.id, r.chip_ref, r.bib_ref, r.checkpoint_code,
            EXISTS (SELECT 1 FROM race_assignments a WHERE a.event_id=$2 AND ((${CHIP_MATCH}) OR (${BIB_MATCH}))) AS ever_held
       FROM race_reads r JOIN race_sources s ON s.id=r.source_id
      WHERE r.discipline_id=$1
        AND NOT EXISTS (SELECT 1 FROM links l WHERE l.read_id=r.id)
        AND NOT EXISTS (SELECT 1 FROM voids v WHERE v.read_id=r.id)
        AND NOT EXISTS (SELECT 1 FROM race_assignments a WHERE a.event_id=$2 AND ((${CHIP_MATCH}) OR (${BIB_MATCH})) AND ${WINDOW})`, [disciplineId, eventId])).rows;
  const keep = rows.map((r) => r.id);
  await c.query(
    `UPDATE race_exceptions SET state='resolved', resolution='auto_cleared', resolved_at=now()
      WHERE discipline_id=$1 AND entrant_id IS NULL AND state='open' AND kind IN ('unknown_chip','stale_chip') AND NOT (read_id = ANY($2))`, [disciplineId, keep]);
  for (const part of chunk(rows, 2000)) await c.query(
    `INSERT INTO race_exceptions(discipline_id, read_id, kind, checkpoint_code, detail)
     SELECT $1, rid, k, cp, d::jsonb FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[]) AS t(rid, k, cp, d)
     ON CONFLICT (discipline_id, read_id, kind) WHERE state='open' AND entrant_id IS NULL DO NOTHING`,
    [disciplineId, part.map((r) => r.id), part.map((r) => (r.ever_held ? 'stale_chip' : 'unknown_chip')), part.map((r) => r.checkpoint_code),
      part.map((r) => JSON.stringify({ chip: r.chip_ref, bib: r.bib_ref }))]);
  return rows.length;
}

/**
 * Recompute derived results for a page of entrants (or a given list) from the raw reads. Deterministic: the same evidence, policy and course always give the same
 * result digest, and an unchanged digest writes nothing, so re-running (or resuming) a reconciliation is safe. After a final publication nothing is rewritten
 * unless `force` is set by an approved correction; late evidence then opens a review exception instead.
 */
export async function reconcileBatch(c, ctx, { after = null, limit = 2000, entrantIds = null, force = false, actorId = null } = {}) {
  const d = ctx.d;
  const pc = await publishedCourse(c, d.id);
  const finalised = await isFinalised(c, d.id);
  const ents = (await c.query(
    `SELECT e.id, e.race_status, e.status_locked, w.gun_at FROM race_entrants e JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id LEFT JOIN race_waves w ON w.id=e.wave_id
      WHERE e.discipline_id=$1 AND ${ACTIVE_ENTRY} AND ${entrantIds ? 'e.id = ANY($2)' : '($2::uuid IS NULL OR e.id > $2)'} ORDER BY e.id LIMIT ${entrantIds ? 100000 : limit + 1}`, [d.id, entrantIds ?? after])).rows;
  const more = !entrantIds && ents.length > limit;
  if (more) ents.pop();
  if (!ents.length) return { entrants: 0, changed: 0, unchanged: 0, open_exceptions: 0, next: null, reads_seen: 0 };
  const ids = ents.map((e) => e.id);
  const q = serial(c);
  const [attr, linkedAway, voided, current, corr] = await Promise.all([
    q.query(
      `SELECT r.id, r.checkpoint_code AS code, a.entrant_id, ${AT_MS} AS at FROM race_assignments a JOIN race_reads r ON r.discipline_id=$1 AND ((${CHIP_MATCH}) OR (${BIB_MATCH})) JOIN race_sources s ON s.id=r.source_id
        WHERE a.entrant_id = ANY($2) AND ${WINDOW}
       UNION ALL
       SELECT r.id, r.checkpoint_code, l.entrant_id, ${AT_MS} FROM (SELECT DISTINCT ON (read_id) read_id, entrant_id FROM race_read_marks WHERE discipline_id=$1 AND kind='link' ORDER BY read_id, created_at DESC, id DESC) l
         JOIN race_reads r ON r.id=l.read_id JOIN race_sources s ON s.id=r.source_id WHERE l.entrant_id = ANY($2)`, [d.id, ids]).then((r) => r.rows),
    q.query("SELECT read_id, entrant_id FROM (SELECT DISTINCT ON (read_id) read_id, entrant_id FROM race_read_marks WHERE discipline_id=$1 AND kind='link' ORDER BY read_id, created_at DESC, id DESC) l", [d.id]).then((r) => new Map(r.rows.map((x) => [x.read_id, x.entrant_id]))),
    q.query("SELECT read_id FROM (SELECT DISTINCT ON (read_id) read_id, kind FROM race_read_marks WHERE discipline_id=$1 AND kind IN ('void','restore') ORDER BY read_id, created_at DESC, id DESC) v WHERE kind='void'", [d.id]).then((r) => new Set(r.rows.map((x) => x.read_id))),
    q.query('SELECT id, entrant_id, version, digest FROM race_results WHERE entrant_id = ANY($1) AND superseded_at IS NULL', [ids]).then((r) => new Map(r.rows.map((x) => [x.entrant_id, x]))),
    q.query("SELECT entrant_id, kind, payload FROM race_corrections WHERE entrant_id = ANY($1) AND state='approved' AND kind IN ('adjustment','use_gun_time')", [ids]).then((r) => r.rows),
  ]);
  const readsBy = new Map(ids.map((x) => [x, []]));
  const seen = new Set();
  for (const r of attr) {
    const owner = linkedAway.get(r.id);
    if (owner && owner !== r.entrant_id) continue; // an official linked this read to someone else
    if (voided.has(r.id)) continue;
    const key = `${r.id}|${r.entrant_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    readsBy.get(r.entrant_id).push({ id: r.id, code: r.code, at: Number(r.at) });
  }
  const adj = new Map(), useGun = new Set();
  for (const k of corr) { if (k.kind === 'adjustment') adj.set(k.entrant_id, (adj.get(k.entrant_id) ?? 0) + Number(k.payload.ms)); else useGun.add(k.entrant_id); }

  const writes = [], statusChanges = [], cutoffRows = [], want = [];
  let changed = 0, held = 0, readsSeen = 0;
  for (const e of ents) {
    const reads = readsBy.get(e.id);
    readsSeen += reads.length;
    const r = reconcileEntrant({ checkpoints: pc.checkpoints, reads, gunAt: e.gun_at ? new Date(e.gun_at).getTime() : null, rules: ctx.rules, adjustmentMs: adj.get(e.id) ?? 0, useGun: useGun.has(e.id) });
    const finalStatus = e.status_locked ? e.race_status : r.status;
    if (e.status_locked && ((e.race_status === 'dns' && r.status !== 'registered') || (['dnf', 'cutoff'].includes(e.race_status) && r.status === 'finished'))) {
      r.exceptions.push({ kind: 'status_conflict', checkpoint_code: null, detail: { status: e.race_status, timing: r.status } });
    }
    const digest = digestOf({ core: r.digest, finalStatus, rk: computeKeys(ctx.rules), cv: pc.course.version });
    const cur = current.get(e.id);
    for (const x of r.exceptions) if (x.kind !== 'duplicate_read') want.push({ entrant_id: e.id, ...x });
    if (cur?.digest === digest) continue;
    if (cur && finalised && !force) {
      held++;
      want.push({ entrant_id: e.id, kind: 'needs_review', checkpoint_code: null, detail: { reason: 'late evidence after final results; propose a governed correction (recompute) to accept it' } });
      continue;
    }
    changed++;
    writes.push({ entrant_id: e.id, version: (cur?.version ?? 0) + 1, race_status: finalStatus, start_at: r.start_at, finish_at: r.finish_at, gun_at: r.gun_at, gun_time_ms: r.gun_time_ms, net_time_ms: r.net_time_ms,
      adjustment_ms: r.adjustment_ms, official_time_ms: r.official_time_ms, basis_used: r.basis_used, splits: r.splits, flags: r.flags, read_ids: r.read_ids, digest, prev: cur?.id ?? null });
    if (!e.status_locked && e.race_status !== r.status) statusChanges.push({ id: e.id, from: e.race_status, to: r.status });
    for (const k of r.cutoffs) cutoffRows.push({ entrant_id: e.id, checkpoint_id: k.checkpoint_id, outcome: k.outcome, elapsed_ms: k.elapsed_ms, cutoff_ms: k.cutoff_ms });
  }
  for (const part of chunk(writes, 1000)) {
    const old = part.map((w) => w.prev).filter(Boolean);
    if (old.length) await c.query('UPDATE race_results SET superseded_at=now() WHERE id = ANY($1)', [old]);
    await c.query(
      `INSERT INTO race_results(discipline_id, entrant_id, version, race_status, start_at, finish_at, gun_at, gun_time_ms, net_time_ms, adjustment_ms, official_time_ms, basis_used, splits, flags, read_ids, policy_version, course_version, digest, created_by)
       SELECT $1, x.entrant_id, x.version, x.race_status, x.start_at, x.finish_at, x.gun_at, x.gun_time_ms, x.net_time_ms, x.adjustment_ms, x.official_time_ms, x.basis_used, x.splits,
              ARRAY(SELECT jsonb_array_elements_text(x.flags)), ARRAY(SELECT (jsonb_array_elements_text(x.read_ids))::uuid), $2, $3, x.digest, $4
         FROM jsonb_to_recordset($5::jsonb) AS x(entrant_id uuid, version int, race_status text, start_at timestamptz, finish_at timestamptz, gun_at timestamptz, gun_time_ms bigint, net_time_ms bigint, adjustment_ms bigint,
              official_time_ms bigint, basis_used text, splits jsonb, flags jsonb, read_ids jsonb, digest text)`,
      [d.id, ctx.policyVersion, pc.course.version, actorId, JSON.stringify(part.map(({ prev, ...w }) => w))]);
  }
  for (const part of chunk(statusChanges, 2000)) {
    await c.query('UPDATE race_entrants e SET race_status=t.s, updated_at=now() FROM unnest($1::uuid[], $2::text[]) AS t(i, s) WHERE e.id=t.i', [part.map((x) => x.id), part.map((x) => x.to)]);
    await c.query("INSERT INTO race_status_log(entrant_id, from_status, to_status, source, actor_id) SELECT i, f, s, 'timing', $1 FROM unnest($2::uuid[], $3::text[], $4::text[]) AS t(i, f, s)", [actorId, part.map((x) => x.id), part.map((x) => x.from), part.map((x) => x.to)]);
  }
  for (const part of chunk(cutoffRows, 2000)) await c.query(
    `INSERT INTO race_cutoffs(discipline_id, entrant_id, checkpoint_id, course_version, policy_version, outcome, elapsed_ms, cutoff_ms, review)
     SELECT $1, i, k, $2, $3, o, el, co, CASE WHEN o='passed' THEN 'none' ELSE 'pending' END FROM unnest($4::uuid[], $5::uuid[], $6::text[], $7::bigint[], $8::bigint[]) AS t(i, k, o, el, co)
     ON CONFLICT (entrant_id, checkpoint_id) DO UPDATE SET outcome=EXCLUDED.outcome, elapsed_ms=EXCLUDED.elapsed_ms, cutoff_ms=EXCLUDED.cutoff_ms, course_version=EXCLUDED.course_version, policy_version=EXCLUDED.policy_version, updated_at=now(),
       review=CASE WHEN EXCLUDED.outcome = race_cutoffs.outcome THEN race_cutoffs.review WHEN EXCLUDED.outcome='passed' THEN 'none' ELSE 'pending' END`,
    [d.id, pc.course.version, ctx.policyVersion, part.map((x) => x.entrant_id), part.map((x) => x.checkpoint_id), part.map((x) => x.outcome), part.map((x) => x.elapsed_ms), part.map((x) => x.cutoff_ms)]);

  // exceptions: refresh what still applies, close what no longer does, and do not reopen what an official already accepted unchanged
  const accepted = new Set((await c.query("SELECT DISTINCT ON (entrant_id, kind, coalesce(checkpoint_code,'')) entrant_id, kind, coalesce(checkpoint_code,'') AS cp, detail FROM race_exceptions WHERE discipline_id=$1 AND entrant_id = ANY($2) AND state='resolved' AND resolution IN ('reviewed','accepted','corrected') ORDER BY entrant_id, kind, coalesce(checkpoint_code,''), resolved_at DESC", [d.id, ids])).rows.map((x) => `${x.entrant_id}|${x.kind}|${x.cp}|${digestOf(x.detail)}`));
  const live = want.filter((x) => !accepted.has(`${x.entrant_id}|${x.kind}|${x.checkpoint_code ?? ''}|${digestOf(x.detail)}`));
  const liveKeys = new Set(live.map((x) => `${x.entrant_id}|${x.kind}|${x.checkpoint_code ?? ''}`));
  const open = (await c.query("SELECT id, entrant_id, kind, coalesce(checkpoint_code,'') AS cp FROM race_exceptions WHERE discipline_id=$1 AND entrant_id = ANY($2) AND state='open'", [d.id, ids])).rows;
  const stale = open.filter((x) => !liveKeys.has(`${x.entrant_id}|${x.kind}|${x.cp}`)).map((x) => x.id);
  if (stale.length) await c.query("UPDATE race_exceptions SET state='resolved', resolution='auto_cleared', resolved_at=now() WHERE id = ANY($1)", [stale]);
  for (const part of chunk(live, 2000)) await c.query(
    `INSERT INTO race_exceptions(discipline_id, entrant_id, kind, checkpoint_code, detail)
     SELECT $1, i, k, nullif(cp,''), dd::jsonb FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[]) AS t(i, k, cp, dd)
     ON CONFLICT (discipline_id, entrant_id, kind, coalesce(checkpoint_code, '')) WHERE state='open' AND entrant_id IS NOT NULL DO UPDATE SET detail=EXCLUDED.detail`,
    [d.id, part.map((x) => x.entrant_id), part.map((x) => x.kind), part.map((x) => x.checkpoint_code ?? ''), part.map((x) => JSON.stringify(x.detail ?? {}))]);
  return { entrants: ents.length, changed, unchanged: ents.length - changed - held, held_for_review: held, open_exceptions: live.length, reads_seen: readsSeen, next: more ? ents[ents.length - 1].id : null, policy_version: ctx.policyVersion, course_version: pc.course.version };
}

cap({
  name: 'reconcile_race', method: 'POST', path: '/races/:id/reconcile', tag: TAG,
  summary: 'Turn the raw reads into splits, gun/net/elapsed times, derived status, cutoff findings and exceptions, deterministically and idempotently, in resumable batches (`after` is the cursor returned as `next`). A duplicate read inside the window counts once by the checkpoint\'s read rule; a missing read stays missing (never invented); out-of-order, negative and unattributable reads become exceptions; chips reissued mid-race resolve by the time window each was held. Nothing is silently replaced by a faster time: if the policy clock cannot be computed the result is flagged for review. Each change is a new result version; unchanged results write nothing.',
  input: z.object({ id, after: id.optional(), limit: z.number().int().min(100).max(5000).default(2000), batches: z.number().int().min(1).max(25).default(10) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await raceCtx(c, user, i.id, 'timing');
      await lockRace(c, i.id);
      let after = i.after ?? null;
      const total = { entrants: 0, changed: 0, unchanged: 0, held_for_review: 0, open_exceptions: 0, reads_seen: 0 };
      let unattributed = null, last = null;
      if (!after) unattributed = await flagUnattributed(c, i.id, ctx.d.event_id, user.id);
      for (let b = 0; b < i.batches; b++) {
        last = await reconcileBatch(c, ctx, { after, limit: i.limit, actorId: user.id });
        for (const k of Object.keys(total)) total[k] += last[k] ?? 0;
        after = last.next;
        if (!after) break;
      }
      if (!after) await c.query('INSERT INTO race_runs(discipline_id, entrants, changed, exceptions, policy_version, rules_digest, course_version, reads_seen, started_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [i.id, total.entrants, total.changed, total.open_exceptions, ctx.policyVersion, computeKeys(ctx.rules), last?.course_version ?? null, total.reads_seen, user.id]);
      return { ...total, unattributed_reads: unattributed, next: after, complete: !after, policy_version: ctx.policyVersion, course_version: last?.course_version ?? null };
    });
  },
});

cap({
  name: 'list_race_exceptions', method: 'GET', path: '/races/:id/exceptions', tag: TAG,
  summary: 'Unresolved timing exceptions for the desk: missing reads, out-of-order or conflicting reads, negative times, unknown or retired chips, late evidence after final, and results that need an official decision. Paged by keyset cursor.',
  input: z.object({ id, state: z.enum(['open', 'resolved']).default('open'), kind: z.string().max(24).optional(), after: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await raceCtx(c, user, i.id);
      const args = [i.id, i.state], where = ['x.discipline_id=$1', 'x.state=$2'];
      const p = (v) => { args.push(v); return `$${args.length}`; };
      if (i.kind) where.push(`x.kind=${p(i.kind)}`);
      const cur = decodeCursor(i.after);
      if (cur) where.push(`(x.created_at, x.id) > (${p(cur[0])}::timestamptz, ${p(cur[1])}::uuid)`);
      const rows = (await c.query(
        `SELECT x.id, x.kind, x.checkpoint_code, x.detail, x.state, x.resolution, x.entrant_id, x.read_id, x.created_at, ${TS('x.created_at')} AS cur, bib.ref AS bib_no, pp.full_name
           FROM race_exceptions x LEFT JOIN race_entrants e ON e.id=x.entrant_id LEFT JOIN event_participants pp ON pp.id=e.participant_id
           LEFT JOIN race_assignments bib ON bib.entrant_id=e.id AND bib.kind='bib' AND bib.state='active'
          WHERE ${where.join(' AND ')} ORDER BY x.created_at, x.id LIMIT ${p(i.limit + 1)}`, args)).rows;
      const items = rows.slice(0, i.limit), last = items[items.length - 1];
      return { items: items.map(({ cur, ...x }) => x), next: rows.length > i.limit ? encodeCursor([last.cur, last.id]) : null };
    });
  },
});

cap({
  name: 'resolve_race_exception', method: 'POST', path: '/race-exceptions/:id/resolve', tag: TAG,
  summary: 'Close an exception after review: `reviewed` (looked at, nothing to change) or `accepted` (the unusual evidence is acceptable as it stands). It stays closed while the same detail persists and reopens if the evidence changes. A result flagged needs_review is decided by a chief official; to change the evidence or time, propose a correction instead.',
  input: z.object({ id, resolution: z.enum(['reviewed', 'accepted']), note: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const x = (await c.query('SELECT * FROM race_exceptions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!x) throw NO_ACCESS('Exception');
      await raceCtx(c, user, x.discipline_id, ['needs_review', 'status_conflict', 'negative_time'].includes(x.kind) ? 'chief' : 'timing');
      if (x.state !== 'open') throw conflict('Already resolved');
      const row = (await c.query("UPDATE race_exceptions SET state='resolved', resolution=$2, resolved_by=$3, resolved_at=now(), detail=detail || $4::jsonb WHERE id=$1 RETURNING *", [i.id, i.resolution, user.id, JSON.stringify(i.note ? { resolution_note: i.note } : {})])).rows[0];
      return row;
    });
  },
});

// ---------------------------------------------------------------- governed race status

async function applyStatus(c, ctx, entrant, { status, source, reasonText, evidence = {}, actorId, viaCorrection = false }) {
  if (!viaCorrection && (await isFinalised(c, entrant.discipline_id))) throw conflict('Results are final; propose a governed correction (status)');
  const allowed = ['registered', ...governedStatuses(ctx.rules)];
  if (!allowed.includes(status)) throw badRequest(`Status must be one of: ${allowed.join(', ')}`);
  const reads = Number((await c.query('SELECT coalesce(max(cardinality(read_ids)), 0) AS n FROM race_results WHERE entrant_id=$1 AND superseded_at IS NULL', [entrant.id])).rows[0].n);
  if (status === 'dns' && reads > 0) throw conflict('This entrant has timing reads, so they started: use DNF (or correct the reads first)');
  if (['dnf', 'cutoff'].includes(status) && reads === 0 && source !== 'official') throw conflict('No start evidence for this entrant: record DNS, or add a manual start read first');
  if (entrant.race_status === status && entrant.status_locked) return entrant;
  await c.query('UPDATE race_entrants SET race_status=$2, status_locked=$3, updated_at=now() WHERE id=$1', [entrant.id, status, status !== 'registered']);
  await c.query('INSERT INTO race_status_log(entrant_id, from_status, to_status, source, reason_enc, evidence, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [entrant.id, entrant.race_status, status, source, sealReason(reasonText), JSON.stringify(evidence), actorId]);
  await reconcileBatch(c, ctx, { entrantIds: [entrant.id], force: viaCorrection, actorId });
  return (await c.query('SELECT * FROM race_entrants WHERE id=$1', [entrant.id])).rows[0];
}

cap({
  name: 'set_race_status', method: 'POST', path: '/race-entrants/:id/status', tag: TAG,
  summary: 'Record a governed participant status: DNS, DNF, DQ, cutoff or a sport-configured status, or reinstate to registered. Every change needs a source (official, timing, medical, protest, entrant, organiser) and a written reason (stored encrypted, audit-logged on read), keeps the full history and is not overridden by later timing reads. DQ, cutoff and reinstatement need a chief official. DNS is refused when timing reads exist; DNF needs start evidence. After final results use a governed correction.',
  input: z.object({ id, status: z.string().trim().min(2).max(24), source: z.enum(['official', 'timing', 'medical', 'protest', 'entrant', 'organiser']), reason }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await loadEntrant(c, i.id);
      const chiefNeeded = ['dq', 'cutoff', 'registered'].includes(i.status);
      const ctx = await raceCtx(c, user, e.discipline_id, chiefNeeded ? 'chief' : 'timing');
      await lockRace(c, e.discipline_id);
      const fresh = await loadEntrant(c, i.id);
      return applyStatus(c, ctx, fresh, { status: i.status, source: i.source, reasonText: i.reason, actorId: user.id });
    });
  },
});

// ---------------------------------------------------------------- cutoffs

cap({
  name: 'list_race_cutoffs', method: 'GET', path: '/races/:id/cutoffs', tag: TAG,
  summary: 'Cutoff findings with the course and policy version they were evaluated under. `missed` is a confirmed failure (a read after the cutoff); `no_evidence` means the checkpoint was never read, which is NOT a confirmed failure. Filter by pending official review.',
  input: z.object({ id, review: z.enum(['none', 'pending', 'confirmed', 'waived']).optional(), outcome: z.enum(['passed', 'missed', 'no_evidence']).optional(), after: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await raceCtx(c, user, i.id);
      const args = [i.id], where = ['k.discipline_id=$1'];
      const p = (v) => { args.push(v); return `$${args.length}`; };
      if (i.review) where.push(`k.review=${p(i.review)}`);
      if (i.outcome) where.push(`k.outcome=${p(i.outcome)}`);
      const cur = decodeCursor(i.after);
      if (cur) where.push(`(k.updated_at, k.id) > (${p(cur[0])}::timestamptz, ${p(cur[1])}::uuid)`);
      const rows = (await c.query(
        `SELECT k.id, k.entrant_id, k.outcome, k.review, k.elapsed_ms, k.cutoff_ms, k.course_version, k.policy_version, k.updated_at, ${TS('k.updated_at')} AS cur, cp.code, cp.label, bib.ref AS bib_no, pp.full_name, e.race_status
           FROM race_cutoffs k JOIN race_checkpoints cp ON cp.id=k.checkpoint_id JOIN race_entrants e ON e.id=k.entrant_id JOIN event_participants pp ON pp.id=e.participant_id
           LEFT JOIN race_assignments bib ON bib.entrant_id=e.id AND bib.kind='bib' AND bib.state='active'
          WHERE ${where.join(' AND ')} ORDER BY k.updated_at, k.id LIMIT ${p(i.limit + 1)}`, args)).rows;
      const items = rows.slice(0, i.limit), last = items[items.length - 1];
      return { items: items.map(({ cur, ...x }) => x), next: rows.length > i.limit ? encodeCursor([last.cur, last.id]) : null };
    });
  },
});

cap({
  name: 'review_race_cutoff', method: 'POST', path: '/race-cutoffs/:id/review', tag: TAG,
  summary: 'A chief official confirms or waives a cutoff finding. Confirming a `missed` finding records the cutoff status for the entrant; confirming a `no_evidence` finding is only possible with `official_observation` (an official saw it), because missing timing data alone is not a failure. Waiving keeps the finding and the reason.',
  input: z.object({ id, decision: z.enum(['confirm', 'waive']), reason, official_observation: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k0 = (await c.query('SELECT discipline_id FROM race_cutoffs WHERE id=$1', [i.id])).rows[0];
      if (!k0) throw NO_ACCESS('Cutoff');
      const ctx = await raceCtx(c, user, k0.discipline_id, 'chief');
      await lockRace(c, k0.discipline_id);
      const k = (await c.query('SELECT * FROM race_cutoffs WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (k.review !== 'pending') throw conflict(`Cutoff review is ${k.review}`);
      if (i.decision === 'confirm') {
        if (k.outcome === 'passed') throw badRequest('This checkpoint was passed in time');
        if (k.outcome === 'no_evidence' && !i.official_observation) throw badRequest('There is no timing evidence for this checkpoint. Confirm only with official_observation, or waive it');
      }
      const row = (await c.query('UPDATE race_cutoffs SET review=$2, reviewed_by=$3, reviewed_at=now(), note_enc=$4, updated_at=now() WHERE id=$1 RETURNING *', [i.id, i.decision === 'confirm' ? 'confirmed' : 'waived', user.id, sealReason(i.reason)])).rows[0];
      await raceLog(c, { discipline_id: k.discipline_id, entrant_id: k.entrant_id, subject: 'cutoff', subject_id: k.id, action: `cutoff_${row.review}`, before: { outcome: k.outcome }, after: { review: row.review, course_version: k.course_version, policy_version: k.policy_version }, actor_id: user.id });
      if (i.decision === 'confirm') {
        const e = await loadEntrant(c, k.entrant_id);
        await applyStatus(c, ctx, e, { status: 'cutoff', source: 'official', reasonText: i.reason, evidence: { cutoff_id: k.id, outcome: k.outcome, official_observation: i.official_observation, course_version: k.course_version, policy_version: k.policy_version }, actorId: user.id, viaCorrection: await isFinalised(c, k.discipline_id) });
      }
      return row;
    });
  },
});

// ---------------------------------------------------------------- corrections

const payloads = {
  manual_read: z.object({ checkpoint: z.string().trim().toUpperCase().regex(CP), observed_at: dt }),
  void_read: z.object({ read_id: id }),
  restore_read: z.object({ read_id: id }),
  link_read: z.object({ read_id: id }),
  adjustment: z.object({ ms: z.number().int().min(-3_600_000).max(3_600_000).refine((n) => n !== 0, 'cannot be zero'), label: z.string().trim().min(3).max(80) }),
  use_gun_time: z.object({}),
  status: z.object({ status: z.string().trim().min(2).max(24), source: z.enum(['official', 'timing', 'medical', 'protest', 'entrant', 'organiser']) }),
  recompute: z.object({}),
};

cap({
  name: 'propose_race_correction', method: 'POST', path: '/race-entrants/:id/corrections', tag: TAG, status: 201,
  summary: 'Propose a change to timing evidence or a result: add a manual read, void or restore a read, link a stray read to this entrant, a time adjustment or penalty (signed milliseconds with a label), rank this entrant on gun time, change a governed status, or accept recomputed results after late evidence. It cites the raw reads it rests on and a written reason, and changes nothing until a chief official approves (someone other than the proposer when the policy requires four eyes). Works after final results too: that is the only way a final result changes, and it produces a new version.',
  input: z.object({ id, kind: z.enum(['manual_read', 'void_read', 'restore_read', 'link_read', 'adjustment', 'use_gun_time', 'status', 'recompute']), payload: z.record(z.string(), z.unknown()).default({}), reason: z.string().trim().min(10).max(1000), evidence_read_ids: z.array(id).max(50).default([]), protest_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await loadEntrant(c, i.id);
      const ctx = await raceCtx(c, user, e.discipline_id, 'timing');
      const p = payloads[i.kind].safeParse(i.payload);
      if (!p.success) throw badRequest(p.error.issues.map((x) => `${x.path.join('.') || 'payload'}: ${x.message}`).join('; '));
      const readId = p.data.read_id;
      const need = [...i.evidence_read_ids, ...(readId ? [readId] : [])];
      if (need.length && (await c.query('SELECT count(*)::int AS n FROM race_reads WHERE discipline_id=$1 AND id = ANY($2)', [e.discipline_id, need])).rows[0].n !== new Set(need).size) throw notFound('Read');
      if (i.kind === 'manual_read') {
        const { checkpoints } = await publishedCourse(c, e.discipline_id);
        if (!checkpoints.some((x) => x.code === p.data.checkpoint)) throw badRequest(`Unknown checkpoint ${p.data.checkpoint}`);
      }
      if (i.kind === 'status' && !['registered', ...governedStatuses(ctx.rules)].includes(p.data.status)) throw badRequest('Not a governed status for this race');
      if (i.protest_id && !(await c.query("SELECT 1 FROM race_protests WHERE id=$1 AND discipline_id=$2 AND status='open'", [i.protest_id, e.discipline_id])).rowCount) throw notFound('Protest');
      const row = (await c.query(
        'INSERT INTO race_corrections(discipline_id, entrant_id, kind, payload, reason_enc, evidence_read_ids, protest_id, proposed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, kind, payload, state, evidence_read_ids, protest_id, proposed_by, created_at',
        [e.discipline_id, e.id, i.kind, JSON.stringify(p.data), sealReason(i.reason), i.evidence_read_ids, i.protest_id ?? null, user.id])).rows[0];
      await raceLog(c, { discipline_id: e.discipline_id, entrant_id: e.id, subject: 'entrant', subject_id: row.id, action: 'correction_proposed', after: { kind: i.kind }, actor_id: user.id });
      return row;
    });
  },
});

cap({
  name: 'list_race_corrections', method: 'GET', path: '/races/:id/corrections', tag: TAG,
  summary: 'Corrections of a race with their proposer, approver, state and the resulting result version. Reasons are decrypted for officials and the read is audit-logged.',
  input: z.object({ id, state: z.enum(['proposed', 'approved', 'rejected', 'withdrawn']).optional(), entrant_id: id.optional(), after: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await raceCtx(c, user, i.id);
      const args = [i.id], where = ['k.discipline_id=$1'];
      const p = (v) => { args.push(v); return `$${args.length}`; };
      if (i.state) where.push(`k.state=${p(i.state)}`);
      if (i.entrant_id) where.push(`k.entrant_id=${p(i.entrant_id)}`);
      const cur = decodeCursor(i.after);
      if (cur) where.push(`(k.created_at, k.id) < (${p(cur[0])}::timestamptz, ${p(cur[1])}::uuid)`);
      const rows = (await c.query(
        `SELECT k.*, ${TS('k.created_at')} AS cur, bib.ref AS bib_no, pp.full_name, r.version AS result_version FROM race_corrections k JOIN race_entrants e ON e.id=k.entrant_id JOIN event_participants pp ON pp.id=e.participant_id
           LEFT JOIN race_assignments bib ON bib.entrant_id=e.id AND bib.kind='bib' AND bib.state='active' LEFT JOIN race_results r ON r.id=k.applied_result_id
          WHERE ${where.join(' AND ')} ORDER BY k.created_at DESC, k.id DESC LIMIT ${p(i.limit + 1)}`, args)).rows;
      const items = rows.slice(0, i.limit), last = items[items.length - 1];
      if (items.length) await audit(c, user.id, 'read_race_reasons', 'race', i.id);
      return { items: items.map(({ reason_enc, decision_enc, cur, ...k }) => ({ ...k, reason: openReason(reason_enc), decision: openReason(decision_enc) })), next: rows.length > i.limit ? encodeCursor([last.cur, last.id]) : null };
    });
  },
});

cap({
  name: 'withdraw_race_correction', method: 'POST', path: '/race-corrections/:id/withdraw', tag: TAG,
  summary: 'The proposer withdraws a correction that has not been decided.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k = (await c.query('SELECT * FROM race_corrections WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!k) throw NO_ACCESS('Correction');
      await raceCtx(c, user, k.discipline_id);
      if (k.proposed_by !== user.id) throw forbidden('Only the proposer can withdraw a correction');
      if (k.state !== 'proposed') throw conflict(`Correction is ${k.state}`);
      return (await c.query("UPDATE race_corrections SET state='withdrawn', decided_at=now() WHERE id=$1 RETURNING id, state", [i.id])).rows[0];
    });
  },
});

cap({
  name: 'decide_race_correction', method: 'POST', path: '/race-corrections/:id/decision', tag: TAG,
  summary: 'A chief official approves or rejects a correction. With four-eyes policy the approver must differ from the proposer. Approving applies it through the same rules as the original actions (a read is added, voided or linked as an append-only mark; a status goes through the governed status log), recomputes that entrant as a NEW result version and notifies the entrant (and guardians of a young account holder). The old version, the raw reads and the published snapshot remain; publish a corrected result to release the change.',
  input: z.object({ id, decision: z.enum(['approve', 'reject']), note: z.string().trim().min(5).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k0 = (await c.query('SELECT discipline_id FROM race_corrections WHERE id=$1', [i.id])).rows[0];
      if (!k0) throw NO_ACCESS('Correction');
      const ctx = await raceCtx(c, user, k0.discipline_id, 'chief');
      await lockRace(c, k0.discipline_id);
      const k = (await c.query('SELECT * FROM race_corrections WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (k.state !== 'proposed') throw conflict(`Correction is ${k.state}`);
      if (ctx.rules.four_eyes && k.proposed_by === user.id) throw forbidden('A correction must be approved by someone other than the person who proposed it (policy four_eyes)');
      if (i.decision === 'reject') {
        const row = (await c.query("UPDATE race_corrections SET state='rejected', decided_by=$2, decided_at=now(), decision_enc=$3 WHERE id=$1 RETURNING id, state, decided_at", [i.id, user.id, sealReason(i.note)])).rows[0];
        await raceLog(c, { discipline_id: k.discipline_id, entrant_id: k.entrant_id, subject: 'entrant', subject_id: k.id, action: 'correction_rejected', actor_id: user.id });
        return row;
      }
      const e = await loadEntrant(c, k.entrant_id);
      const p = k.payload;
      const mark = (kind, readId, entrantId = null) => c.query('INSERT INTO race_read_marks(discipline_id, read_id, kind, entrant_id, correction_id, actor_id) VALUES ($1,$2,$3,$4,$5,$6)', [k.discipline_id, readId, kind, entrantId, k.id, user.id]);
      if (k.kind === 'manual_read') await insertManualRead(c, ctx, e, { checkpoint: p.checkpoint, observed_at: p.observed_at, origin: 'correction', dedupe: `corr:${k.id}`, actor: user.id });
      else if (k.kind === 'void_read') await mark('void', p.read_id);
      else if (k.kind === 'restore_read') await mark('restore', p.read_id);
      else if (k.kind === 'link_read') await mark('link', p.read_id, e.id);
      else if (k.kind === 'status') {
        await c.query("UPDATE race_corrections SET state='approved', decided_by=$2, decided_at=now() WHERE id=$1", [k.id, user.id]);
        await applyStatus(c, ctx, e, { status: p.status, source: p.source, reasonText: openReason(k.reason_enc), evidence: { correction_id: k.id }, actorId: user.id, viaCorrection: true });
      }
      await c.query("UPDATE race_corrections SET state='approved', decided_by=$2, decided_at=now(), decision_enc=$3 WHERE id=$1", [k.id, user.id, sealReason(i.note)]);
      await reconcileBatch(c, ctx, { entrantIds: [e.id], force: true, actorId: user.id });
      const result = (await c.query('SELECT id, version, official_time_ms, race_status FROM race_results WHERE entrant_id=$1 AND superseded_at IS NULL', [e.id])).rows[0];
      await c.query('UPDATE race_corrections SET applied_result_id=$2 WHERE id=$1', [k.id, result?.id ?? null]);
      await raceLog(c, { discipline_id: k.discipline_id, entrant_id: e.id, subject: 'entrant', subject_id: k.id, action: 'correction_approved', after: { kind: k.kind, result_version: result?.version }, actor_id: user.id });
      await notifyEntrants(c, [e.id], { kind: 'race_correction', title: 'A race result was corrected', body: `A result for ${ctx.d.name} was corrected after official review.`, data: { discipline_id: k.discipline_id } });
      return { id: k.id, state: 'approved', result: result ?? null };
    });
  },
});

// ---------------------------------------------------------------- protests (a protest is a canonical dispute case; this is the race side of it)

cap({
  name: 'file_race_protest', method: 'POST', path: '/races/:id/protests', tag: TAG, status: 201,
  summary: 'Protest a result. The entrant (or the verified guardian of a young entrant) files it; it is opened through the canonical dispute/case workflow (a dispute linked to the event) and tracked here against the entrant and result version, routed to the race officials. Officials answer with corrections referencing the protest and then decide it.',
  input: z.object({ id, entrant_id: id.optional(), description: z.string().trim().min(10).max(2000) }),
  async handler({ user }, i) {
    const open = capabilities.find((x) => x.name === 'open_case');
    const found = await tx(async (c) => {
      const d = (await c.query('SELECT d.* FROM race_setups s JOIN event_disciplines d ON d.id=s.discipline_id WHERE s.discipline_id=$1', [i.id])).rows[0];
      if (!d) throw NO_ACCESS();
      const own = (await c.query('SELECT e.* FROM race_entrants e JOIN event_participants p ON p.id=e.participant_id WHERE e.discipline_id=$1 AND p.user_id=$2', [i.id, user.id])).rows[0];
      let entrant = own && (!i.entrant_id || i.entrant_id === own.id) ? own : null;
      if (!entrant && i.entrant_id) {
        const e = (await c.query('SELECT e.*, p.user_id FROM race_entrants e JOIN event_participants p ON p.id=e.participant_id WHERE e.id=$1 AND e.discipline_id=$2', [i.entrant_id, i.id])).rows[0];
        if (e?.user_id && (await guardianLink(user.id, e.user_id, c))) entrant = e;
      }
      if (!entrant) throw NO_ACCESS('Entrant');
      const result = (await c.query('SELECT id FROM race_results WHERE entrant_id=$1 AND superseded_at IS NULL', [entrant.id])).rows[0];
      const bib = (await c.query("SELECT ref FROM race_assignments WHERE entrant_id=$1 AND kind='bib' AND state='active'", [entrant.id])).rows[0]?.ref;
      const ev = (await c.query('SELECT id, name, organizer_id FROM events WHERE id=$1', [d.event_id])).rows[0];
      return { d, entrant, result, bib, ev };
    });
    // the dispute is opened through its own capability (own validation, duplicate guard, SLA, notifications); the race side is recorded right after
    const cs = await open.handler({ user }, open.input.parse({ kind: 'dispute', category: 'other', subject: `Race protest: ${found.d.name}${found.bib ? ` bib ${found.bib}` : ''}`, description: i.description, links: [{ type: 'event', id: found.ev.id }] }));
    return tx(async (c) => {
      await c.query("UPDATE cases SET routed_to='game_officials' WHERE id=$1", [cs.id]);
      const row = (await c.query('INSERT INTO race_protests(discipline_id, entrant_id, case_id, filed_by, result_id) VALUES ($1,$2,$3,$4,$5) RETURNING *', [i.id, found.entrant.id, cs.id, user.id, found.result?.id ?? null])).rows[0];
      const chiefs = new Set([found.ev.organizer_id, ...(await c.query("SELECT user_id FROM event_staff WHERE event_id=$1 AND status='accepted' AND role = ANY($2)", [found.d.event_id, STAFF_CHIEF])).rows.map((r) => r.user_id)]);
      for (const u of chiefs) if (u !== user.id) await notify(c, u, { kind: 'race_protest', title: `Protest filed: ${found.d.name}`, body: `Case #${cs.case_no} needs a decision from the race officials.`, data: { discipline_id: i.id, protest_id: row.id } });
      return { ...row, case_no: cs.case_no };
    });
  },
});

cap({
  name: 'list_race_protests', method: 'GET', path: '/races/:id/protests', tag: TAG,
  summary: 'Protests of a race for the chief officials: case number, entrant, status and the protester\'s statement (decrypted; the read is audit-logged).',
  input: z.object({ id, status: z.enum(['open', 'upheld', 'rejected', 'withdrawn']).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await raceCtx(c, user, i.id, 'chief');
      const rows = (await c.query(
        `SELECT pr.id, pr.status, pr.case_id, pr.entrant_id, pr.result_id, pr.created_at, pr.decided_at, cs.case_no, bib.ref AS bib_no, pp.full_name,
                (SELECT m.body_enc FROM case_messages m WHERE m.case_id=pr.case_id AND m.visibility='public' ORDER BY m.created_at LIMIT 1) AS body_enc,
                (SELECT count(*)::int FROM race_corrections k WHERE k.protest_id=pr.id AND k.state='approved') AS approved_corrections
           FROM race_protests pr JOIN cases cs ON cs.id=pr.case_id JOIN race_entrants e ON e.id=pr.entrant_id JOIN event_participants pp ON pp.id=e.participant_id
           LEFT JOIN race_assignments bib ON bib.entrant_id=e.id AND bib.kind='bib' AND bib.state='active'
          WHERE pr.discipline_id=$1 AND ($2::text IS NULL OR pr.status=$2) ORDER BY pr.created_at DESC LIMIT 200`, [i.id, i.status ?? null])).rows;
      if (rows.length) await audit(c, user.id, 'read_race_protests', 'race', i.id);
      return rows.map(({ body_enc, ...r }) => ({ ...r, statement: body_enc ? decrypt(body_enc, 'case_messages.body') : null }));
    });
  },
});

cap({
  name: 'decide_race_protest', method: 'POST', path: '/race-protests/:id/decision', tag: TAG,
  summary: 'A chief official (not the protester) decides a protest. Upholding needs at least one approved correction that references it; rejecting records the reason. The linked dispute case is resolved with the decision on its public timeline and the protester is notified.',
  input: z.object({ id, decision: z.enum(['upheld', 'rejected']), reason: z.string().trim().min(10).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const pr0 = (await c.query('SELECT discipline_id FROM race_protests WHERE id=$1', [i.id])).rows[0];
      if (!pr0) throw NO_ACCESS('Protest');
      await raceCtx(c, user, pr0.discipline_id, 'chief');
      const pr = (await c.query('SELECT * FROM race_protests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (pr.status !== 'open') throw conflict(`Protest is ${pr.status}`);
      if (pr.filed_by === user.id) throw forbidden('You cannot decide your own protest');
      if (i.decision === 'upheld' && !(await c.query("SELECT 1 FROM race_corrections WHERE protest_id=$1 AND state='approved'", [pr.id])).rowCount) throw badRequest('Approve a correction that references this protest before upholding it');
      const row = (await c.query('UPDATE race_protests SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1 RETURNING *', [i.id, i.decision, user.id])).rows[0];
      const cs = (await c.query('SELECT * FROM cases WHERE id=$1 FOR UPDATE', [pr.case_id])).rows[0];
      if (cs && !['resolved', 'withdrawn'].includes(cs.status)) {
        await c.query("UPDATE cases SET status='resolved', resolution=$2, resolved_by=$3, resolved_at=now(), first_responded_at=coalesce(first_responded_at, now()), updated_at=now() WHERE id=$1", [cs.id, i.reason, user.id]);
        await c.query("INSERT INTO case_events(case_id, actor_id, action, from_status, to_status, reason, data) VALUES ($1,$2,$3,$4,'resolved',$5,$6)", [cs.id, user.id, `race_protest_${i.decision}`, cs.status, i.reason, JSON.stringify({ protest_id: pr.id })]);
      }
      await notify(c, pr.filed_by, { kind: 'case_update', title: `Protest ${i.decision}`, body: i.reason, data: { case_id: pr.case_id, protest_id: pr.id } });
      await raceLog(c, { discipline_id: pr.discipline_id, entrant_id: pr.entrant_id, subject: 'entrant', subject_id: pr.id, action: `protest_${i.decision}`, actor_id: user.id });
      return row;
    });
  },
});
