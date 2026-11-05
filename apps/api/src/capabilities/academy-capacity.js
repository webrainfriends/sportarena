// Academy OS P2 (#805): capacity, progression & workforce scenarios. Extends the canonical #395 scenario store (academy_scenarios, kind='capacity'),
// so there is one list, one snapshot model and one archive. Read-only over live records; owner/admin only (it carries staff cost and workload).
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { STAFF } from '../academy.js';
import { capacityBaseline, evaluateCapacity, suggestSlots, FORMULAS } from '../academy-capacity.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const clock = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM');
const idem = z.string().min(8).max(80);

const assumptions = z.object({
  horizon: z.object({ from: day, to: day }),
  enrolment_mix: z.array(z.object({ programme_id: id, change: z.number().int().min(-500).max(500) })).max(40).default([]),
  promotions: z.array(z.object({ pathway_id: id, from_level: z.string().min(1).max(40), athletes: z.number().int().min(1).max(500) })).max(60).default([]),
  cohorts: z.array(z.object({
    name: z.string().min(2).max(80), programme_id: id, athletes: z.number().int().min(1).max(500), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start_time: clock, end_time: clock, timezone: z.string().max(64).optional(), venue_id: id.optional(), coach_ids: z.array(id).max(12).default([]),
    source_cohort_id: id.optional(), max_ratio: z.number().int().min(1).max(200).optional(),
  })).max(6).default([]),
  extra_coaches: z.number().int().min(0).max(50).default(0), extra_coach_hours_week: z.number().min(0).max(80).optional(), budget_minor: z.number().int().min(0).optional(),
}).refine((a) => a.enrolment_mix.length + a.promotions.length + a.cohorts.length + a.extra_coaches > 0, 'Add at least one input: an enrolment change, a promotion, a proposed cohort or extra coaches');

cap({
  name: 'get_academy_capacity_baseline', method: 'GET', path: '/organisations/:id/academy/capacity/baseline', tag: 'Academy',
  summary: 'The sourced, read-only starting point for capacity scenarios (owner/admin): programmes and enrolment, coaches with standing availability and assigned hours, venues, pathway levels with athletes and seats, cost per coach-hour and venue cost per session from the last 90 days, with the source of every figure and the formulas used. Changes nothing.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF);
    await audit(null, user.id, 'read_academy_capacity_baseline', 'organisations', i.id);
    return { ...(await capacityBaseline(i.id)), formulas: FORMULAS };
  },
});

cap({
  name: 'create_academy_capacity_scenario', method: 'POST', path: '/organisations/:id/academy/capacity-scenarios', tag: 'Academy', status: 201,
  summary: 'Run and save a capacity, progression & workforce scenario (owner/admin): enrolment mix, next-stage promotions, a proposed cohort with venue, days, time, coaches and an optional source cohort for School timetable checks. Returns demand and congestion, pathway bottlenecks, coaches and hours required, real venue / staff / School conflicts, cost trade-offs and recommendation candidates. Missing inputs make the result "incomplete" with the gaps listed; impossible inputs make it "impossible" with reasons and no projection. It changes no roster, booking, enrolment, cost, session or curriculum; the saved snapshot is audited. Same idempotency key returns the same scenario. With preview=true it only runs the maths (nothing saved, no key needed) so a screen can show live impact.',
  input: z.object({ id, name: z.string().min(2).max(120), assumptions, preview: z.boolean().default(false), idempotency_key: idem.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, STAFF, { write: true, c });
    if (i.preview) { const run = await evaluateCapacity(i.id, i.assumptions, c); return { preview: true, saved: false, outcome: run.outcome, result: run.result, baseline_hash: run.baseline_hash }; }
    if (!i.idempotency_key) throw badRequest('idempotency_key is required to save a scenario');
    const prior = (await c.query('SELECT * FROM academy_scenarios WHERE created_by=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
    if (prior) return prior;
    const run = await evaluateCapacity(i.id, i.assumptions, c);
    const r = (await c.query(
      `INSERT INTO academy_scenarios(organisation_id, kind, name, currency, assumptions, baseline, result, outcome, baseline_hash, horizon_from, horizon_to, created_by, idempotency_key)
       VALUES ($1,'capacity',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [i.id, i.name, run.baseline.currency ?? null, JSON.stringify(i.assumptions), JSON.stringify(run.baseline), JSON.stringify(run.result), run.outcome, run.baseline_hash, i.assumptions.horizon.from, i.assumptions.horizon.to, user.id, i.idempotency_key])).rows[0];
    await audit(c, user.id, 'create_academy_capacity_scenario', 'academy_scenarios', r.id);
    return r;
  }),
});

async function loadCapacity(user, scenarioId, { write = false } = {}) {
  const s = await one("SELECT * FROM academy_scenarios WHERE id=$1 AND kind='capacity'", [scenarioId]);
  if (!s) throw notFound('Scenario');
  await orgFor(user, s.organisation_id, STAFF, { write });   // outsiders and non-staff get 404 / 403 before anything is shown
  return s;
}

cap({
  name: 'get_academy_capacity_scenario', method: 'GET', path: '/academy/capacity-scenarios/:id', tag: 'Academy',
  summary: 'One saved capacity scenario with its frozen baseline snapshot, result and the decisions people recorded on its recommendation candidates (owner/admin).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await loadCapacity(user, i.id);
    const decisions = await many('SELECT d.id, d.candidate_key, d.decision, d.reason, d.decided_by, u.display_name AS decided_by_name, d.created_at FROM academy_scenario_decisions d JOIN users u ON u.id=d.decided_by WHERE d.scenario_id=$1 ORDER BY d.created_at DESC, d.id', [s.id]);
    await audit(null, user.id, 'read_academy_capacity_scenario', 'academy_scenarios', s.id);
    return { ...s, decisions };
  },
});

cap({
  name: 'compare_academy_capacity_scenarios', method: 'GET', path: '/organisations/:id/academy/capacity-scenarios/compare', tag: 'Academy',
  summary: 'Compare two to four saved capacity scenarios side by side (owner/admin): outcome, athletes, congested programmes, bottlenecks, coaches and hours, conflicts and cost. Says whether they were run against the same baseline data. Read-only.',
  input: z.object({ id, scenario_ids: z.string().regex(/^[0-9a-f-]{36}(,[0-9a-f-]{36}){1,3}$/, 'Give two to four scenario ids separated by commas') }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF);
    const ids = [...new Set(i.scenario_ids.split(','))];
    if (ids.length < 2) throw badRequest('Choose at least two different scenarios');
    const rows = await many("SELECT * FROM academy_scenarios WHERE organisation_id=$1 AND kind='capacity' AND id = ANY($2::uuid[]) ORDER BY created_at, id", [i.id, ids]);
    if (rows.length !== ids.length) throw notFound('Scenario');
    const col = (s) => {
      const p = s.result.projection;
      return { scenario_id: s.id, name: s.name, outcome: s.outcome, created_at: s.created_at, horizon: { from: s.horizon_from, to: s.horizon_to }, baseline_hash: s.baseline_hash,
        missing: s.result.missing?.length ?? 0, reasons: s.result.reasons?.length ?? 0,
        athletes_added: p ? p.demand.reduce((n, d) => n + d.change + d.promoted_in - d.promoted_out, 0) + p.cohorts.reduce((n, k) => n + k.athletes, 0) : null,
        congested_programmes: p ? p.demand.filter((d) => d.over_capacity_by > 0).length : null,
        bottlenecks: p ? p.pathways.flatMap((x) => x.levels).filter((l) => l.bottleneck).length : null,
        coaches_required: p?.workforce.coaches_required ?? null, coach_hours_week: p?.workforce.coach_hours_week ?? null, overloaded_coaches: p?.workforce.overloaded_coaches ?? null,
        conflicts: p?.totals.conflicts ?? null, cost_minor: p?.totals.cost_minor ?? null, cost_currency: p?.totals.cost_currency ?? null, cost_complete: p?.totals.cost_complete ?? null,
        candidates: s.result.candidates?.length ?? 0 };
    };
    const cols = rows.map(col);
    await audit(null, user.id, 'compare_academy_capacity_scenarios', 'organisations', i.id);
    return { scenarios: cols, same_baseline: new Set(cols.map((x) => x.baseline_hash)).size === 1,
      note: 'Figures marked null could not be known for that scenario (incomplete or impossible); they are not zero. Different baselines mean live data changed between runs.' };
  },
});

cap({
  name: 'decide_academy_capacity_candidate', method: 'POST', path: '/academy/capacity-scenarios/:id/decisions', tag: 'Academy', status: 201,
  summary: 'Record a person\'s decision (approved, declined or deferred, with a reason) on one recommendation candidate of a saved capacity scenario (owner/admin). It is an append-only record and changes nothing else: acting on an approved candidate is done in the screen that owns that record. Candidates never select or exclude an athlete.',
  input: z.object({ id, candidate_key: z.string().min(2).max(80), decision: z.enum(['approved', 'declined', 'deferred']), reason: z.string().min(3).max(500), idempotency_key: idem }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await loadCapacity(user, i.id, { write: true });
    const prior = (await c.query('SELECT * FROM academy_scenario_decisions WHERE decided_by=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
    if (prior) return prior;
    if (!(s.result.candidates ?? []).some((x) => x.key === i.candidate_key)) throw badRequest('That recommendation is not part of this scenario');
    const r = (await c.query('INSERT INTO academy_scenario_decisions(organisation_id, scenario_id, candidate_key, decision, reason, decided_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [s.organisation_id, s.id, i.candidate_key, i.decision, i.reason, user.id, i.idempotency_key])).rows[0];
    await audit(c, user.id, `capacity_candidate_${i.decision}`, 'academy_scenarios', s.id);
    return r;
  }),
});

cap({
  name: 'suggest_academy_capacity_slots', method: 'POST', path: '/organisations/:id/academy/capacity-scenarios/slots', tag: 'Academy',
  summary: 'Slot finder for a proposed cohort (owner/admin): ranks conflict-free start times for the chosen days, venue, coaches and optional source cohort, using the same venue, staff and School-timetable checks as a scenario. Read-only; it books nothing.',
  input: z.object({ id, horizon: z.object({ from: day, to: day }), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7), duration_min: z.number().int().min(15).max(480), earliest: z.number().int().min(0).max(1380).default(360), latest: z.number().int().min(30).max(1440).default(1320),
    venue_id: id.optional(), coach_ids: z.array(id).max(12).default([]), source_cohort_id: id.optional(), timezone: z.string().max(64).optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF);
    if (i.horizon.to < i.horizon.from) throw badRequest('The period ends before it starts');
    const { id: _o, ...q } = i;
    return suggestSlots(i.id, q);
  },
});
