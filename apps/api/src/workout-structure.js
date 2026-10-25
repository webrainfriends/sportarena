// Structured workouts (issue #326): the blocks a coach plans inside a training session and the results the athlete records
// against them. Planned blocks live in the (immutable) plan revision and are copied to training_sessions.structure on
// acceptance; the athlete's results live in training_sessions.actuals. Units are canonical: metres, seconds, kilograms,
// watts, pace in seconds per `pace_per_m` metres (the sport decides which). The UI converts for display only.
import { z } from 'zod';
import { badRequest } from './errors.js';

export const BLOCK_KINDS = ['warmup', 'work', 'interval', 'strength', 'rest', 'cooldown'];
const ENDURANCE = new Set(['athletics', 'swimming', 'running', 'cycling', 'rowing', 'triathlon', 'cross-country', 'marathon']);
const POWER = new Set(['cycling', 'rowing', 'triathlon']);
const PACE_PER_M = { swimming: 100, rowing: 500 };

/** What a sport's workouts may measure. Anything outside the rules is rejected, not stored. */
export function rulesFor(sport) {
  const slug = sport?.slug ?? '';
  const endurance = ENDURANCE.has(slug) || ['time', 'distance'].includes(sport?.scoring);
  return { distance: true, pace: endurance, power: POWER.has(slug), pace_per_m: PACE_PER_M[slug] ?? 1000, power_zones: POWER.has(slug) };
}

const https = z.string().max(500).url().refine((u) => { try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password; } catch { return false; } }, 'Use a plain https link (no sign-in details in it)');
const range = (lo, hi) => z.number().int().min(lo).max(hi);

export const blockIn = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).describe('stable id for this block within the session; results are recorded against it'),
  kind: z.enum(BLOCK_KINDS),
  label: z.string().min(1).max(120),
  sets: range(1, 50).optional(),
  reps: range(1, 500).optional().describe('repetitions per set'),
  load_kg: z.number().min(0.5).max(1000).multipleOf(0.5).optional(),
  work_m: range(1, 200000).optional().describe('distance of each repetition/set, in metres'),
  work_sec: range(1, 21600).optional().describe('duration of each repetition/set, in seconds'),
  rest_sec: range(0, 3600).optional().describe('rest after each set/repetition, in seconds'),
  zone: z.object({
    kind: z.enum(['pace', 'power']),
    level: range(1, 5).describe('training zone 1 (easy) to 5 (maximal)'),
    min: z.number().positive().max(100000).optional().describe('pace: seconds per sport pace distance; power: watts'),
    max: z.number().positive().max(100000).optional(),
  }).optional(),
  demo: z.object({ url: https, title: z.string().max(120).optional() }).optional().describe('link to a demonstration video or page'),
  notes: z.string().max(500).optional(),
}).strict();

export const structureIn = z.array(blockIn).min(1).max(30);

/** Reject a plan that cannot be carried out or measured for this sport. Throws 400 with the first problem, naming the block. */
export function validateStructure(blocks, sport) {
  const rules = rulesFor(sport);
  const seen = new Set();
  blocks.forEach((b, n) => {
    const at = `Block ${n + 1} “${b.label}”`;
    if (seen.has(b.id)) throw badRequest(`${at}: duplicate block id`);
    seen.add(b.id);
    if (b.kind === 'rest') {
      if (b.rest_sec === undefined) throw badRequest(`${at}: a rest block needs a rest time`);
      if (b.sets || b.reps || b.work_m || b.work_sec || b.zone || b.load_kg) throw badRequest(`${at}: a rest block only has a rest time`);
      return;
    }
    if (!b.sets && !b.reps && !b.work_m && !b.work_sec) throw badRequest(`${at}: give it something to do — sets, reps, a distance or a time`);
    if (b.kind === 'interval' && !(b.work_m || b.work_sec)) throw badRequest(`${at}: an interval needs a work distance or time`);
    if (b.kind === 'interval' && !b.sets) throw badRequest(`${at}: an interval needs the number of repetitions (sets)`);
    if (b.work_m && b.work_sec && b.kind !== 'interval') throw badRequest(`${at}: choose a distance or a time, not both`);
    if (b.load_kg && !['strength', 'work'].includes(b.kind)) throw badRequest(`${at}: load only applies to strength or work blocks`);
    if (b.zone) {
      if (b.zone.kind === 'pace' && !rules.pace) throw badRequest(`${at}: pace zones are not used for ${sport?.name ?? 'this sport'}`);
      if (b.zone.kind === 'power' && !rules.power) throw badRequest(`${at}: power zones are not used for ${sport?.name ?? 'this sport'}`);
      if (b.zone.min !== undefined && b.zone.max !== undefined && b.zone.min > b.zone.max) throw badRequest(`${at}: the zone's minimum is above its maximum`);
      if (b.zone.kind === 'pace' && !(b.work_m || b.work_sec)) throw badRequest(`${at}: a pace target needs a distance or time to run it over`);
    }
  });
  return rules;
}

const num = (v) => (v === undefined || v === null ? null : Number(v));

/** Planned totals for a session card: distance and work time across all repetitions, excluding rest. */
export function summarize(blocks) {
  let distance_m = 0, work_sec = 0, rest_sec = 0;
  for (const b of blocks ?? []) {
    const reps = b.kind === 'interval' || b.work_m || b.work_sec ? (b.sets ?? 1) : 1;
    distance_m += (b.work_m ?? 0) * reps;
    work_sec += (b.work_sec ?? 0) * reps;
    rest_sec += (b.rest_sec ?? 0) * (b.kind === 'rest' ? 1 : (b.sets ?? 1));
  }
  return { blocks: (blocks ?? []).length, distance_m, work_sec, rest_sec };
}

export const resultIn = z.object({
  block_id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  completed: z.boolean(),
  sets_done: range(0, 50).optional(),
  reps_done: range(0, 500).optional().describe('repetitions per set actually done'),
  load_kg: z.number().min(0).max(1000).optional(),
  distance_m: range(0, 200000).optional().describe('total distance actually covered, in metres'),
  duration_sec: range(0, 86400).optional().describe('total time actually spent, in seconds'),
  avg_pace: z.number().positive().max(100000).optional().describe('average pace in seconds per the sport pace distance'),
  avg_power_w: z.number().positive().max(3000).optional(),
}).strict();
export const actualsIn = z.array(resultIn).max(30);

/** Results must belong to this session's blocks and only use measures its sport records. */
export function validateActuals(results, blocks, sport) {
  const rules = rulesFor(sport);
  const byId = new Map((blocks ?? []).map((b) => [b.id, b]));
  const seen = new Set();
  for (const r of results) {
    const b = byId.get(r.block_id);
    if (!b) throw badRequest(`Result for an unknown block (${r.block_id}) — the session was changed, reload it`);
    if (seen.has(r.block_id)) throw badRequest(`Block “${b.label}” has two results`);
    seen.add(r.block_id);
    if (r.avg_pace !== undefined && !rules.pace) throw badRequest(`Pace is not recorded for ${sport?.name ?? 'this sport'}`);
    if (r.avg_power_w !== undefined && !rules.power) throw badRequest(`Power is not recorded for ${sport?.name ?? 'this sport'}`);
    if (b.sets && r.sets_done !== undefined && r.sets_done > b.sets * 2) throw badRequest(`Block “${b.label}”: ${r.sets_done} sets is far above the plan — check the number`);
  }
}

const pct = (a, p) => (p > 0 ? Math.round((a / p) * 100) : null);

/** Actual versus planned, per block and overall. Deterministic and computed on read — nothing derived is stored. */
export function compare(blocks, results) {
  const got = new Map((results ?? []).map((r) => [r.block_id, r]));
  const rows = (blocks ?? []).map((b) => {
    const r = got.get(b.id);
    const metrics = [];
    if (r) {
      const sets = b.sets ?? 1;
      if (b.sets) metrics.push({ metric: 'sets', planned: b.sets, actual: num(r.sets_done), pct: r.sets_done === undefined ? null : pct(r.sets_done, b.sets) });
      if (b.reps) metrics.push({ metric: 'reps', planned: b.reps, actual: num(r.reps_done), pct: r.reps_done === undefined ? null : pct(r.reps_done, b.reps) });
      if (b.work_m) metrics.push({ metric: 'distance_m', planned: b.work_m * sets, actual: num(r.distance_m), pct: r.distance_m === undefined ? null : pct(r.distance_m, b.work_m * sets) });
      if (b.work_sec) metrics.push({ metric: 'duration_sec', planned: b.work_sec * sets, actual: num(r.duration_sec), pct: r.duration_sec === undefined ? null : pct(r.duration_sec, b.work_sec * sets) });
      if (b.load_kg) metrics.push({ metric: 'load_kg', planned: b.load_kg, actual: num(r.load_kg), pct: r.load_kg === undefined ? null : pct(r.load_kg, b.load_kg) });
      if (b.zone?.kind === 'pace' && r.avg_pace !== undefined) {
        const within = (b.zone.min === undefined || r.avg_pace >= b.zone.min) && (b.zone.max === undefined || r.avg_pace <= b.zone.max);
        metrics.push({ metric: 'pace', planned: [num(b.zone.min), num(b.zone.max)], actual: r.avg_pace, in_zone: within });
      }
      if (b.zone?.kind === 'power' && r.avg_power_w !== undefined) {
        const within = (b.zone.min === undefined || r.avg_power_w >= b.zone.min) && (b.zone.max === undefined || r.avg_power_w <= b.zone.max);
        metrics.push({ metric: 'power_w', planned: [num(b.zone.min), num(b.zone.max)], actual: r.avg_power_w, in_zone: within });
      }
    }
    const scored = metrics.filter((m) => m.pct !== null && m.pct !== undefined).map((m) => Math.min(m.pct, 100));
    const block_pct = !r ? 0 : scored.length ? Math.round(scored.reduce((a, x) => a + x, 0) / scored.length) : r.completed ? 100 : 0;
    return { block_id: b.id, label: b.label, recorded: !!r, completed: !!r?.completed, pct: block_pct, metrics };
  });
  const work = rows.filter((_, i) => blocks[i].kind !== 'rest');
  const overall = work.length ? Math.round(work.reduce((a, x) => a + x.pct, 0) / work.length) : null;
  return { blocks: rows, pct: overall, recorded: rows.filter((x) => x.recorded).length, planned: blocks?.length ?? 0 };
}
