// Mass-participation race operations (issue #487): the pure, deterministic parts. Nothing here touches the database, so the same
// reads always produce the same splits, times, exceptions and cutoff findings, and the rules can be tested exhaustively.
// Raw reads are evidence; everything computed here is derived and carries the policy and course version it was computed under.
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const BASE_STATUSES = ['registered', 'started', 'finished', 'dns', 'dnf', 'dq', 'cutoff'];
export const GOVERNED_STATUSES = ['dns', 'dnf', 'dq', 'cutoff'];
export const STAFF_TIMING = ['timekeeper', 'starter', 'judge', 'referee', 'umpire', 'scorer'];
export const STAFF_CHIEF = ['judge', 'referee', 'umpire'];

export const rulesSchema = z.object({
  time_basis: z.enum(['gun', 'net']).default('net').describe('which clock ranks the race: gun (from the wave gun) or net (chip start to chip finish)'),
  cutoff_basis: z.enum(['gun', 'net']).optional().describe('clock the cutoffs are measured on; defaults to the time basis'),
  dedupe_window_s: z.number().int().min(0).max(600).default(5).describe('reads of one chip at one checkpoint closer together than this are one crossing'),
  tie_rule: z.enum(['share', 'earlier_crossing']).default('share').describe('share = equal times share a place; earlier_crossing = the earlier finish read wins, equal reads still share'),
  bib_scope: z.enum(['discipline', 'event']).default('discipline').describe('bib numbers are unique within this race, or across the whole event'),
  allow_guests: z.boolean().default(false).describe('entrants without a platform account (guests / external participants) may be registered'),
  max_entrants: z.number().int().min(1).max(500000).optional(),
  extra_statuses: z.array(z.string().regex(/^[a-z][a-z_]{1,22}$/)).max(10).default([]).describe('sport-configured governed statuses on top of dns/dnf/dq/cutoff, e.g. "overtime"'),
  award_depth: z.number().int().min(0).max(50).default(3).describe('places awarded in each classification'),
  team_scoring: z.object({ enabled: z.boolean().default(false), count: z.number().int().min(1).max(20).default(3) }).prefault({}).describe('club/house classification: the sum of the best `count` finish times'),
  four_eyes: z.boolean().default(true).describe('a correction must be approved by someone other than its proposer'),
  public: z.object({
    enabled: z.boolean().default(false), names: z.boolean().default(false), splits: z.boolean().default(false), categories: z.boolean().default(true),
  }).prefault({}).describe('what the public live page may show; names only for entrants who agreed, never for young account holders'),
}).superRefine((r, ctx) => {
  for (const s of r.extra_statuses) if (BASE_STATUSES.includes(s)) ctx.addIssue({ code: 'custom', message: `"${s}" is already a standard status`, path: ['extra_statuses'] });
});

export const stableJson = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
export const digestOf = (v) => createHash('sha256').update(stableJson(v)).digest('hex');
export const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Only the rules that change how a time is computed. Display settings (public page, award depth) never invalidate a result. */
export const computeKeys = (rules) => digestOf({ t: rules.time_basis, c: rules.cutoff_basis ?? null, w: rules.dedupe_window_s, x: [...(rules.extra_statuses ?? [])].sort() });

export const governedStatuses = (rules) => [...GOVERNED_STATUSES, ...(rules.extra_statuses ?? [])];

/** "1:02:03.456" from milliseconds. */
export function fmtMs(ms) {
  if (ms === null || ms === undefined) return null;
  const n = Number(ms), a = Math.abs(n), h = Math.floor(a / 3600000), m = Math.floor(a / 60000) % 60, s = Math.floor(a / 1000) % 60, f = a % 1000;
  const body = `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
  return n < 0 ? `-${body}` : body;
}

// ---------------------------------------------------------------- reconciliation of one entrant

/**
 * @param {object} a
 * @param {Array}  a.checkpoints  ordered course checkpoints [{ id, seq, code, label, kind, distance_m, read_rule, cutoff_s }]
 * @param {Array}  a.reads        usable reads for this entrant [{ id, code, at (epoch ms) }] - voided and stale reads are already out
 * @param {number|null} a.gunAt   the recorded gun time of the entrant's wave (epoch ms)
 * @param {object} a.rules        the pinned race policy rules
 * @param {number} a.adjustmentMs approved penalties / adjustments
 * @param {boolean} a.useGun      an approved correction says to rank this entrant on gun time
 */
export function reconcileEntrant({ checkpoints, reads, gunAt, rules, adjustmentMs = 0, useGun = false }) {
  const windowMs = (rules.dedupe_window_s ?? 5) * 1000;
  const byCode = new Map();
  for (const r of [...reads].sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1))) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }
  const exceptions = [];
  const selected = new Map();
  const readIds = [];
  for (const cp of checkpoints) {
    const list = byCode.get(cp.code) ?? [];
    if (!list.length) continue;
    const cluster = list.filter((r) => r.at - list[0].at <= windowMs);
    const far = list.filter((r) => r.at - list[0].at > windowMs);
    const pick = cp.read_rule === 'last' ? cluster[cluster.length - 1] : cluster[0];
    selected.set(cp.code, pick);
    readIds.push(...cluster.map((r) => r.id));
    if (cluster.length > 1) exceptions.push({ kind: 'duplicate_read', checkpoint_code: cp.code, detail: { reads: cluster.map((r) => r.id), counted: pick.id, rule: cp.read_rule } });
    if (far.length) {
      readIds.push(...far.map((r) => r.id));
      exceptions.push({ kind: 'multiple_reads', checkpoint_code: cp.code, detail: { reads: list.map((r) => r.id), counted: pick.id, ignored: far.map((r) => r.id) } });
    }
  }
  const started = selected.size > 0;
  const lastSeq = Math.max(0, ...checkpoints.filter((cp) => selected.has(cp.code)).map((cp) => cp.seq));
  const startCp = checkpoints.find((cp) => cp.kind === 'start');
  const finishCp = checkpoints.find((cp) => cp.kind === 'finish');
  const S = startCp ? selected.get(startCp.code) : null;
  const F = finishCp ? selected.get(finishCp.code) : null;

  // order: a read at a later checkpoint may not be earlier than the read at the one before it
  let prev = null;
  for (const cp of checkpoints) {
    const r = selected.get(cp.code);
    if (!r) continue;
    if (prev && r.at < prev.r.at) exceptions.push({ kind: 'out_of_order', checkpoint_code: cp.code, detail: { after: prev.cp.code, read: r.id, earlier_than: prev.r.id } });
    prev = { cp, r };
  }
  if (started) for (const cp of checkpoints) if (!selected.has(cp.code) && cp.seq < lastSeq) exceptions.push({ kind: 'missing_read', checkpoint_code: cp.code, detail: { seq: cp.seq } });

  let gunMs = F && gunAt != null ? F.at - gunAt : null;
  let netMs = F && S ? F.at - S.at : null;
  if (F && gunAt == null && ((useGun ? 'gun' : rules.time_basis ?? 'net') === 'gun')) exceptions.push({ kind: 'no_gun_time', checkpoint_code: finishCp.code, detail: {} });
  if (F && !S) exceptions.push({ kind: 'no_start_read', checkpoint_code: startCp?.code ?? null, detail: {} });
  if (gunMs !== null && gunMs < 0) { exceptions.push({ kind: 'negative_time', checkpoint_code: finishCp.code, detail: { basis: 'gun', ms: gunMs } }); gunMs = null; }
  if (netMs !== null && netMs < 0) { exceptions.push({ kind: 'negative_time', checkpoint_code: finishCp.code, detail: { basis: 'net', ms: netMs } }); netMs = null; }

  const wanted = useGun ? 'gun' : (rules.time_basis ?? 'net');
  const base = wanted === 'net' ? netMs : gunMs;
  const flags = [];
  if (exceptions.some((e) => e.kind === 'duplicate_read')) flags.push('duplicate_read'); // handled by the read rule; counted on the desk, not an exception to work
  if (exceptions.some((e) => e.kind === 'missing_read')) flags.push('missing_read');
  if (exceptions.some((e) => ['out_of_order', 'multiple_reads', 'negative_time'].includes(e.kind))) flags.push('review');
  if (F && base === null) { flags.push('needs_review'); exceptions.push({ kind: 'needs_review', checkpoint_code: finishCp.code, detail: { basis_wanted: wanted, reason: `no ${wanted} time can be computed (never silently using the other clock)` } }); }
  const officialMs = base === null ? null : base + Number(adjustmentMs || 0);

  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
  let before = null;
  const splits = checkpoints.map((cp) => {
    const r = selected.get(cp.code) ?? null;
    const row = {
      seq: cp.seq, code: cp.code, label: cp.label, kind: cp.kind, distance_m: Number(cp.distance_m), status: r ? 'read' : 'missing',
      read_id: r?.id ?? null, at: r ? iso(r.at) : null,
      gun_ms: r && gunAt != null ? r.at - gunAt : null, net_ms: r && S ? r.at - S.at : null, segment_ms: r && before ? r.at - before.at : null,
    };
    if (r) before = r;
    return row;
  });

  const cutBasis = rules.cutoff_basis ?? rules.time_basis ?? 'net';
  const cutoffs = [];
  if (started) for (const cp of checkpoints) {
    if (!cp.cutoff_s) continue;
    const r = selected.get(cp.code);
    const clock = r ? (cutBasis === 'net' ? (S ? r.at - S.at : null) : (gunAt != null ? r.at - gunAt : null)) : null;
    cutoffs.push({ checkpoint_id: cp.id, code: cp.code, cutoff_ms: cp.cutoff_s * 1000, elapsed_ms: clock, outcome: clock === null ? 'no_evidence' : clock > cp.cutoff_s * 1000 ? 'missed' : 'passed' });
  }

  const status = F ? 'finished' : started ? 'started' : 'registered';
  const core = { status, start_at: iso(S?.at), finish_at: iso(F?.at), gun_at: iso(gunAt), gun_time_ms: gunMs, net_time_ms: netMs, adjustment_ms: Number(adjustmentMs || 0), official_time_ms: officialMs, basis_used: base === null ? null : wanted, splits, flags, read_ids: [...new Set(readIds)].sort() };
  return { ...core, exceptions, cutoffs, digest: digestOf(core) };
}

// ---------------------------------------------------------------- ranking and classifications

const bibNum = (b) => (b !== null && b !== undefined && /^\d+$/.test(String(b)) ? Number(b) : Number.MAX_SAFE_INTEGER);

/** Deterministic display order for equal marks, never used to break a tie in the ranking. */
export const byTimeThenStable = (a, b) => (a.time - b.time) || (a.finish_ms - b.finish_ms) || (bibNum(a.bib) - bibNum(b.bib)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Competition ranking (1,1,3). Entries are { id, time, finish_ms, bib }. With tie_rule `earlier_crossing` an earlier finish read
 * separates equal times; equal reads still share a place. Returns Map id -> { rank, tied }.
 */
export function rankEntries(entries, tieRule = 'share') {
  const sorted = [...entries].sort(byTimeThenStable);
  const out = new Map();
  const same = (a, b) => a.time === b.time && (tieRule === 'share' || a.finish_ms === b.finish_ms);
  sorted.forEach((e, i) => {
    const p = sorted[i - 1];
    out.set(e.id, { rank: p && same(p, e) ? out.get(p.id).rank : i + 1, tied: false });
  });
  const count = new Map();
  for (const v of out.values()) count.set(v.rank, (count.get(v.rank) ?? 0) + 1);
  for (const v of out.values()) v.tied = count.get(v.rank) > 1;
  return out;
}

/**
 * Overall, declared-gender, declared-category and team classifications from explicit fields only.
 * rows: [{ id, bib, time, finish_ms, gender, category_id, house_id }] finishers with an official time.
 * An entrant with no declared gender is simply absent from the gender classification; nothing is guessed.
 */
export function classify(rows, { tieRule = 'share', categories = [], team = { enabled: false, count: 3 } } = {}) {
  const overall = rankEntries(rows, tieRule);
  const out = { overall, gender: new Map(), category: new Map(), teams: [] };
  for (const g of ['male', 'female']) {
    const sub = rows.filter((r) => r.gender === g);
    if (sub.length) out.gender.set(g, rankEntries(sub, tieRule));
  }
  for (const cat of categories) {
    const sub = rows.filter((r) => r.category_id === cat.id);
    if (sub.length) out.category.set(cat.id, rankEntries(sub, tieRule));
  }
  if (team.enabled) {
    const byHouse = new Map();
    for (const r of rows) if (r.house_id) { if (!byHouse.has(r.house_id)) byHouse.set(r.house_id, []); byHouse.get(r.house_id).push(r); }
    const scored = [];
    for (const [house_id, list] of byHouse) {
      const best = [...list].sort(byTimeThenStable).slice(0, team.count);
      if (best.length < team.count) continue; // a club without enough finishers is not classified, never scored short
      scored.push({ id: house_id, house_id, time: best.reduce((s, r) => s + r.time, 0), finish_ms: 0, bib: null, scorers: best.map((r) => r.id) });
    }
    const ranks = rankEntries(scored, 'share');
    out.teams = scored.map((t) => ({ ...t, ...ranks.get(t.id) })).sort((a, b) => a.rank - b.rank || a.time - b.time);
  }
  return out;
}

// ---------------------------------------------------------------- CSV (batch files from timing systems and entrant lists)

/** RFC 4180 reader: quoted fields, doubled quotes, CRLF. Returns objects keyed by the lower-cased header. */
export function parseCsv(text, { maxRows = 100000 } = {}) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
      if (rows.length > maxRows + 1) throw new Error(`more than ${maxRows} rows`);
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((v) => v !== '')) rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** A spreadsheet treats a leading = + - @ as a formula; neutralise it in exports. */
const cell = (v) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (columns, rows) => [columns.join(','), ...rows.map((r) => columns.map((k) => cell(r[k])).join(','))].join('\r\n') + '\r\n';

/** Opaque keyset cursor over (timestamp, id). */
export const encodeCursor = (parts) => Buffer.from(JSON.stringify(parts)).toString('base64url');
export const decodeCursor = (s) => { if (!s) return null; try { const v = JSON.parse(Buffer.from(s, 'base64url').toString()); return Array.isArray(v) ? v : null; } catch { return null; } };
