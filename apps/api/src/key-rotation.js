// Encryption key rotation: re-encrypt stored values under the active key (see the keyring in crypto.js).
//
// What it does: walks every `*_enc` text column, and rewrites each value that is not already under the active key. It never deletes or
// narrows anything, never touches a value it cannot read, and never disables a trigger. A run is resumable (a cursor per column is kept)
// and idempotent (values already under the active key are skipped; each write only applies if the value is still the one that was read).
//
// Why it can report "unmapped": a value's AES-GCM context is part of the ciphertext binding, and the app uses several shapes of it
// (`table.field`, a feature-specific name, or one bound to a row id). The job tries, in order: a row-bound resolver, `table.field`,
// `table.column`, the context that last worked for this column, then every context-shaped string found in the source. A value that none of
// them opens is left exactly as it is and counted, so the report says honestly how much is still under an older key. The old key can be
// retired only when nothing is unmapped, blocked or left (`retirable`).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeKeyId, decrypt, encrypt, keyIdOf, knownKeyIds } from './crypto.js';
import { many, one, query } from './db.js';

const BATCH = 200;
const PK_TYPES = new Set(['uuid', 'int2', 'int4', 'int8', 'text', 'varchar']);
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** Contexts that depend on the row, so they cannot be guessed from the column alone. */
export const ROW_CONTEXTS = {
  'proc_proposals.draft_enc': (row) => [`proc_proposals.draft:${row.pk}`],
  'proc_submissions.tech_enc': (row) => [`proc_submissions.tech_enc:${row.pk}`],
  'proc_submissions.comm_enc': (row) => [`proc_submissions.comm_enc:${row.pk}`],
};

let pool_;
/** Every context-shaped string literal in the source (`area.field`, `area:thing`) plus the few single-word contexts. Built once. */
export function contextPool() {
  if (pool_) return pool_;
  const found = new Set(['access_credentials']);
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { walk(join(dir, e.name)); continue; }
      if (!e.name.endsWith('.js')) continue;
      for (const m of readFileSync(join(dir, e.name), 'utf8').matchAll(/(['"`])([a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)+)\1/g)) found.add(m[2]);
    }
  };
  walk(dirname(fileURLToPath(import.meta.url)));
  pool_ = [...found];
  return pool_;
}

/** Every base-table text column ending in _enc, with its table's primary key columns (or why it has none we can page by). */
export async function encryptedColumns() {
  const cols = await many(
    `SELECT c.table_name AS tbl, c.column_name AS col
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name LIKE '%\\_enc' AND c.data_type IN ('text', 'character varying')
      ORDER BY c.table_name, c.column_name`);
  const pks = await many(
    `SELECT kcu.table_name AS tbl, array_agg(kcu.column_name::text ORDER BY kcu.ordinal_position) AS cols, array_agg(col.udt_name::text ORDER BY kcu.ordinal_position) AS types
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       JOIN information_schema.columns col ON col.table_schema = kcu.table_schema AND col.table_name = kcu.table_name AND col.column_name = kcu.column_name
      WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY' GROUP BY kcu.table_name`);
  const byTable = new Map(pks.map((p) => [p.tbl, p]));
  return cols.map((c) => {
    const pk = byTable.get(c.tbl);
    const ok = pk && pk.types.every((t) => PK_TYPES.has(t));
    return { ...c, key: `${c.tbl}.${c.col}`, pk: ok ? pk.cols : null, pk_types: ok ? pk.types : null, skip: ok ? null : 'no usable primary key' };
  });
}

function candidates(col, row, lastGood) {
  const base = col.col.replace(/_enc$/, '');
  const first = [...(ROW_CONTEXTS[col.key]?.(row) ?? []), `${col.tbl}.${base}`, `${col.tbl}.${col.col}`];
  if (lastGood) first.push(lastGood);
  return [...new Set(first)];
}

/** The plaintext's context for one value: first context that opens it, else null. */
function resolveContext(col, row, value, lastGood) {
  const tryCtx = (ctx) => { try { decrypt(value, ctx); return true; } catch { return false; } };
  for (const ctx of candidates(col, row, lastGood)) if (tryCtx(ctx)) return ctx;
  for (const ctx of contextPool()) if (tryCtx(ctx)) return ctx;
  return null;
}

const currentPrefix = (kid) => (kid === 'k1' ? 'v1.' : `v2.${kid}.`);
const blank = () => ({ reencrypted: 0, current: 0, unmapped: 0, blocked: null, done: false });

/** Re-encrypt one column from `cursor` (a JSON array of the last primary key values) on. `save` is called after every batch with (report, cursor). */
async function rotateColumn(col, kid, report, cursor, save) {
  let last = cursor ? JSON.parse(cursor) : null;
  let lastGood = null;
  const like = `${currentPrefix(kid)}%`;
  const pks = col.pk.map(ident).join(', ');
  const tuple = col.pk.map((k, i) => `${ident(k)} AS pk${i}`).join(', ');
  for (;;) {
    const after = last ? `AND (${pks}) > (${col.pk.map((_, i) => `$${i + 3}::${col.pk_types[i]}`).join(', ')})` : '';
    const rows = (await query(
      `SELECT ${tuple}, ${ident(col.col)} AS v FROM ${ident(col.tbl)}
        WHERE ${ident(col.col)} IS NOT NULL AND ${ident(col.col)} NOT LIKE $1 ${after} ORDER BY ${pks} LIMIT $2`, [like, BATCH, ...(last ?? [])])).rows;
    if (!rows.length) break;
    for (const r of rows) {
      const key = col.pk.map((_, i) => String(r[`pk${i}`]));
      last = key;
      if (!keyIdOf(r.v)) { report.unmapped++; continue; }
      const ctx = resolveContext(col, { ...r, pk: key.join(':') }, r.v, lastGood);
      if (!ctx) { report.unmapped++; continue; }
      lastGood = ctx;
      try {
        // only applies while the value is still the one we read: a concurrent edit is simply picked up by the next run
        const upd = await query(`UPDATE ${ident(col.tbl)} SET ${ident(col.col)} = $1 WHERE ${col.pk.map((k, i) => `${ident(k)} = $${i + 3}`).join(' AND ')} AND ${ident(col.col)} = $2`,
          [encrypt(decrypt(r.v, ctx), ctx), r.v, ...key]);
        if (upd.rowCount) report.reencrypted++; else report.current++;
      } catch (e) {
        report.blocked = `${e.code ?? 'error'}: ${String(e.message).slice(0, 160)}`;   // e.g. an append-only table: reported, never bypassed
        return report;
      }
    }
    await save(report, JSON.stringify(last));
  }
  report.done = true;
  return report;
}

const running = new Set();
const FRESH_MS = 60_000;

export const rotationRun = (id) => one('SELECT * FROM key_rotation_runs WHERE id = $1', [id]);

/** Start (or resume) a rotation to the active key. Returns the run row; the work continues in the background. */
export async function startRotation(actorId, { wait = false } = {}) {
  const kid = activeKeyId();
  if (!knownKeyIds().includes(kid)) throw new Error(`Key ${kid} is not loaded`);
  let run = await one("SELECT * FROM key_rotation_runs WHERE status = 'running' AND target_key = $1 ORDER BY started_at DESC LIMIT 1", [kid]);
  if (run && Date.now() - new Date(run.heartbeat_at).getTime() < FRESH_MS && running.has(run.id)) return run;
  if (!run) run = await one('INSERT INTO key_rotation_runs(target_key, started_by) VALUES ($1,$2) RETURNING *', [kid, actorId ?? null]);
  else run = await one('UPDATE key_rotation_runs SET heartbeat_at = now() WHERE id = $1 RETURNING *', [run.id]);
  running.add(run.id);
  const job = (async () => {
    try { await execute(run, kid); } catch (e) {
      await query("UPDATE key_rotation_runs SET status='failed', error=$2, finished_at=now() WHERE id=$1", [run.id, String(e.message).slice(0, 300)]);
    } finally { running.delete(run.id); }
  })();
  if (wait) await job;
  return run;
}

async function execute(run, kid) {
  const report = run.report ?? {};
  const cursors = run.cursors ?? {};
  const persist = () => query('UPDATE key_rotation_runs SET report=$2, cursors=$3, heartbeat_at=now() WHERE id=$1', [run.id, report, cursors]);
  for (const col of await encryptedColumns()) {
    const rep = report[col.key] ?? (report[col.key] = blank());
    if (col.skip) { rep.blocked = col.skip; continue; }   // (a table with no primary key cannot be paged safely)
    if (rep.done) continue;
    rep.blocked = null;
    await rotateColumn(col, kid, rep, cursors[col.key] ?? null, async (r, last) => { cursors[col.key] = last; report[col.key] = r; await persist(); });
    await persist();
  }
  const open = Object.values(report).some((r) => r.blocked || r.unmapped);
  await query("UPDATE key_rotation_runs SET status='done', finished_at=now(), report=$2, cursors=$3 WHERE id=$1", [run.id, report, cursors]);
  return !open;
}

/** Totals for a run report, and whether every older key could be retired (nothing unmapped or blocked). */
export function summariseReport(report = {}) {
  const t = { columns: 0, columns_done: 0, reencrypted: 0, unmapped: 0, blocked: [] };
  for (const [key, r] of Object.entries(report)) {
    t.columns++; if (r.done) t.columns_done++;
    t.reencrypted += r.reencrypted ?? 0; t.unmapped += r.unmapped ?? 0;
    if (r.blocked) t.blocked.push({ column: key, reason: r.blocked });
  }
  return t;
}

/** How many stored values each key currently protects, per key, across every mapped column. Counts only, never values. */
export async function keyUsage() {
  const usage = {};
  let unreadable = 0; const skipped = [];
  for (const col of await encryptedColumns()) {
    if (col.skip) { skipped.push({ column: col.key, reason: col.skip }); }
    const { rows } = await query(
      `SELECT CASE WHEN ${ident(col.col)} LIKE 'v1.%' THEN 'k1' WHEN ${ident(col.col)} LIKE 'v2.%' THEN split_part(${ident(col.col)}, '.', 2) ELSE '?' END AS kid, count(*)::int AS n
         FROM ${ident(col.tbl)} WHERE ${ident(col.col)} IS NOT NULL GROUP BY 1`);
    for (const r of rows) { if (r.kid === '?') unreadable += r.n; else usage[r.kid] = (usage[r.kid] ?? 0) + r.n; }
  }
  return { usage, unreadable, skipped };
}
