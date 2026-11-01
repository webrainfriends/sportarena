// Tournament stage management beyond "generate a schedule": the format catalogue, seed validation, publishing, governed redraws, Swiss rounds,
// pools → knockout, repechage, correction previews and conflict resolution, schedule checks. Everything extends the canonical stages and
// fixtures created by generate_event_schedule (event-schedule.js); there is no second bracket engine.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx, many, one } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit, standings, isAdmin, mustFind } from '../helpers.js';
import { eventForOrganizer } from './events.js';
import { assertEventReadable } from '../spectator.js';
import { stageViews } from '../tournament/view.js';
import { planStage, createStage, SCHEDULE_KEYS } from './event-schedule.js';
import { writeItems, recordRevision, retireUnstarted, snapshotOf } from '../tournament/stage.js';
import { orderField, buildPlan, swissPlan, graphPlan } from '../tournament/plan.js';
import { MAX_KNOCKOUT_TEAMS } from '../tournament/bracket.js';
import { MAX_DOUBLE_TEAMS } from '../tournament/formats/double-elim.js';
import { pairSwissRound, SWISS_POLICIES, SWISS_TIEBREAKS, FIRST_ROUND, DEFAULT_SWISS, suggestedRounds } from '../tournament/formats/swiss.js';
import { POOL_TIEBREAKS, DEFAULT_POOLS, separatePools } from '../tournament/formats/pools.js';
import { REPECHAGE_TEMPLATES, PLACEMENT_DEPTHS, repechageGraph } from '../tournament/formats/repechage.js';
import { SERIES_LENGTHS, HOME_ROTATIONS, LEG_DECIDERS } from '../tournament/formats/series.js';
import { validateSeeds } from '../tournament/formats/seeds.js';
import { correctionImpact } from '../tournament/formats/propagation.js';
import { decideWinner, tieState, place, voidFixture, isStarted } from '../tournament/advance.js';
import { seededTeams, acceptedTeams } from '../tournament/data.js';
import { newDrawSeed } from '../tournament/formats/rng.js';
import { scheduleInput } from './event-schedule.js';

const TAG = 'Tournament';
const reason = z.string().trim().min(5).max(500);
const WINDOW = { from_date: z.string().date().optional(), to_date: z.string().date().optional() };
const win = (i) => ({ ...(i.from_date ? { from_date: i.from_date } : {}), ...(i.to_date ? { to_date: i.to_date } : {}) });

// ---------------------------------------------------------------- catalogue
cap({
  name: 'get_bracket_formats', method: 'GET', path: '/bracket-formats', tag: TAG, auth: 'public',
  summary: 'The competition formats a stage can use, with their options and limits: round robin, knockout (third place, placement play-offs, consolation), double elimination (optional grand-final reset), Swiss (named pairing policies and tie-breaks), pools → knockout (draws, wildcards, tie-breaks), best-of-N series, multi-leg aggregate ties (away goals only when explicitly enabled) and repechage templates. Pass the chosen options as `format_config` to preview_event_schedule / generate_event_schedule.',
  async handler() {
    return {
      formats: [
        { id: 'round_robin', label: 'Round robin', teams: { min: 2 }, options: [] },
        { id: 'knockout', label: 'Knockout', teams: { min: 2, max: MAX_KNOCKOUT_TEAMS }, options: ['third_place', 'placement_up_to', 'consolation', 'tie', 'repechage_template'] },
        { id: 'double_elimination', label: 'Double elimination', teams: { min: 3, max: MAX_DOUBLE_TEAMS }, options: ['reset', 'tie'] },
        { id: 'swiss', label: 'Swiss system', teams: { min: 4 }, options: ['swiss'] },
        { id: 'pools', label: 'Pools, then knockout', teams: { min: 4 }, options: ['pools'] },
      ],
      swiss: { policies: Object.entries(SWISS_POLICIES).map(([k, v]) => ({ id: k, version: v.version, label: v.label, note: v.note })), tie_breaks: SWISS_TIEBREAKS, first_round: FIRST_ROUND, defaults: DEFAULT_SWISS, suggested_rounds: 'ceil(log2(teams))', suggested_rounds_fn: 'rounds = ceil(log2(n))', note: 'No universal Swiss algorithm is claimed: the policy is named on the stage and recorded with every round.' },
      pools: { draws: ['snake', 'pots', 'manual'], tie_breaks: POOL_TIEBREAKS, defaults: DEFAULT_POOLS },
      ties: { best_of: SERIES_LENGTHS, home_rotations: HOME_ROTATIONS, leg_deciders: LEG_DECIDERS, legs: [2, 3, 4], away_goals: 'Never assumed: counted only when the stage config sets away_goals to true.' },
      repechage_templates: Object.entries(REPECHAGE_TEMPLATES).map(([k, t]) => ({ id: k, version: t.version, label: t.label, description: t.description, commonly_used_in: t.commonly_used_in })),
      placement_depths: PLACEMENT_DEPTHS,
    };
  },
});

// ---------------------------------------------------------------- seeds
cap({
  name: 'validate_event_seeds', method: 'POST', path: '/events/:id/seed-check', tag: TAG,
  summary: 'Check an intended seeding before the draw is created or locked: duplicates, gaps, byes, same-city teams meeting in round one, pool sizes. Returns blocking `errors`, advisory `warnings` and the first-round pairs the order implies. Pass `order` (team ids, best first) to test a reorder; omit it to check the stored seeds.',
  input: z.object({ id, format: z.enum(['round_robin', 'knockout', 'double_elimination', 'swiss', 'pools']).default('knockout'), order: z.array(id).max(128).optional(), pool_count: z.number().int().min(2).max(16).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await eventForOrganizer(user, i.id, c);
      const field = await seededTeams(c, ev);
      let list = field;
      if (i.order) {
        const by = new Map(field.map((t) => [t.team_id, t]));
        const bad = i.order.find((t) => !by.has(t));
        if (bad || new Set(i.order).size !== i.order.length) throw badRequest('order must name accepted entrants of this event, each once');
        list = i.order.map((t, k) => ({ ...by.get(t), seed: k + 1 }));
      }
      const max = i.format === 'knockout' ? MAX_KNOCKOUT_TEAMS : i.format === 'double_elimination' ? MAX_DOUBLE_TEAMS : undefined;
      const min = { knockout: 2, round_robin: 2, double_elimination: 3, swiss: 4, pools: 4 }[i.format];
      return { teams: list.map((t) => ({ team_id: t.team_id, name: t.name, city: t.city, seed: t.seed, rating: t.rating })), ...validateSeeds(list, { format: i.format, pool_count: i.pool_count, min, max }) };
    });
  },
});

// ---------------------------------------------------------------- stages
cap({
  name: 'list_event_stages', method: 'GET', path: '/events/:id/stages', tag: TAG, auth: 'public',
  summary: 'Every stage of an event as sections of rounds (winners / losers / grand final, main bracket, repechage, placement, consolation), Swiss rounds with the standings, pool tables with qualifiers, and series / aggregate tie state. Spectators see published stages only; organisers also see drafts, open conflicts and the audit counters. `list` views are always available next to any drawing.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await mustFind('events', i.id, 'organizer_id');
    await assertEventReadable(user, i.id);
    return stageViews(i.id, { organiser: !!user && (isAdmin(user) || ev.organizer_id === user.id) });
  },
});

async function lockStage(c, user, eventId, stageId) {
  const ev = await eventForOrganizer(user, eventId, c);
  const stage = (await c.query('SELECT * FROM event_stages WHERE id=$1 AND event_id=$2 FOR UPDATE', [stageId, eventId])).rows[0];
  if (!stage) throw notFound('Stage');
  return { ev, stage };
}

cap({
  name: 'publish_event_stage', method: 'POST', path: '/events/:id/stages/:stage_id/publish', tag: TAG,
  summary: 'Publish a draft stage: spectators see the bracket / rounds, and from now on changing the draw needs a governed redraw with a reason (redraw_event_stage). Idempotent.',
  input: z.object({ id, stage_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { stage } = await lockStage(c, user, i.id, i.stage_id);
      if (stage.published_at) return stage;
      const out = (await c.query('UPDATE event_stages SET published_at=now(), published_by=$2 WHERE id=$1 RETURNING *', [stage.id, user.id])).rows[0];
      await recordRevision(c, stage.id, 'published', { actor: user.id, algorithm: stage.algorithm });
      return out;
    });
  },
});

/** The scheduling inputs a stage was created with, parsed back into a full schedule input. */
function argsOf(ev, stage, over = {}) {
  const cfg = stage.config ?? {};
  const fc = {};
  const clean = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null).map(([k, v]) => [k, clean(v)])) : o);
  for (const k of ['reset', 'placement_up_to', 'consolation', 'tie', 'swiss', 'pools', 'repechage_template']) if (cfg[k] !== undefined && cfg[k] !== null && cfg[k] !== false) fc[k] = clean(cfg[k]);
  return scheduleInput.parse({ ...(cfg.schedule_args ?? {}), id: ev.id, format: cfg.format ?? stage.kind, format_config: fc, third_place: !!cfg.third_place, from: cfg.from ?? 'seeds', publish: !!stage.published_at, ...over });
}

cap({
  name: 'redraw_event_stage', method: 'POST', path: '/events/:id/stages/:stage_id/redraw', tag: TAG,
  summary: 'Re-seed or redraw a stage whose games have not started. A draft stage can be re-ordered freely; a published stage needs a reason. mode: manual (send `order`, best seed first), random (new persisted draw seed, `protect_top` seeds stay put), seeds (current event seeds), standings (current table). The old games are kept as history (cancelled, "redrawn") and their courts released, the new games are scheduled through the same scheduler, and the change is added to the stage audit trail. If any game has started or been played the redraw is refused. Swiss: re-pair the latest round only (send `manual_pairings` or a changed policy).',
  input: z.object({ id, stage_id: id, mode: z.enum(['manual', 'random', 'seeds', 'standings']).default('manual'), order: z.array(id).max(128).optional(), protect_top: z.number().int().min(0).max(64).default(0),
    manual_pairings: z.array(z.object({ home: id, away: id })).max(64).optional(), reason: reason.optional(), accept_mismatch: z.boolean().default(false),
    format_config: z.record(z.string(), z.any()).optional().describe('a material change to the format itself (e.g. the grand-final reset, placement depth, series length, consolation): merged over the stage’s options, validated like generate_event_schedule, recorded as a format revision. Needs a reason once published; refused once any game has started'),
    third_place: z.boolean().optional(), ...WINDOW }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev, stage } = await lockStage(c, user, i.id, i.stage_id);
      const cfg = stage.config ?? {};
      if (stage.published_at && !i.reason) throw badRequest('A published stage can only be redrawn with a reason');
      if (['completed', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
      const revising = !!(i.format_config || i.third_place !== undefined);
      if (revising && stage.published_at && !i.reason) throw badRequest('A format change on a published stage needs a reason');
      if (revising && stage.kind === 'swiss') throw badRequest('A Swiss stage’s policy is changed by re-pairing the latest round, not by a format revision');
      const base = argsOf(ev, stage);
      const sched = argsOf(ev, stage, { accept_mismatch: i.accept_mismatch, ...win(i), ...(i.format_config ? { format_config: { ...base.format_config, ...i.format_config } } : {}), ...(i.third_place !== undefined ? { third_place: i.third_place } : {}) });
      const previous = cfg.field ?? [];
      if (stage.kind === 'swiss') {
        const last = (await c.query("SELECT max(round_no) AS n FROM fixtures WHERE stage_id=$1 AND status <> 'cancelled'", [stage.id])).rows[0].n;
        if (!last) throw conflict('This Swiss stage has no round to redraw');
        await retireUnstarted(c, stage.id, 'redrawn', { roundNo: last });
        const out = await swissRound(c, user, ev, stage, { round: last, manual: i.manual_pairings, args: sched, kind: 'redraw', reason: i.reason });
        return out;
      }
      let order;
      let drawSeed = stage.draw_seed;
      if (i.mode === 'manual') {
        if (!i.order) throw badRequest('Send `order` (every team id, best seed first)');
        if (i.order.length !== previous.length || new Set(i.order).size !== i.order.length || i.order.some((t) => !previous.includes(t))) throw badRequest('order must contain exactly the teams of this stage, once each');
        order = i.order;
      } else if (i.mode === 'random') {
        drawSeed = newDrawSeed();
        order = orderField(previous, { mode: 'random', protect_top: i.protect_top }, drawSeed).order;
      } else if (i.mode === 'seeds') {
        const rank = new Map((await seededTeams(c, ev)).map((t, k) => [t.team_id, k]));
        order = previous.slice().sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
      } else {
        const table = new Map((await standings(ev.id, c)).map((r) => [r.team_id, r.rank]));
        order = previous.slice().sort((a, b) => (table.get(a) ?? 1e9) - (table.get(b) ?? 1e9));
      }
      const retired = await retireUnstarted(c, stage.id, 'redrawn');
      const plan = await planStage(c, ev, sched, { field: order, drawSeed });
      if (plan.unplaced.length) throw conflict(`${plan.unplaced.length} of ${plan.items.length} games do not fit in that window`, { unplaced: plan.unplaced });
      if (plan.alignment.consent_required && !i.accept_mismatch) throw conflict(plan.alignment.verdict);
      await writeItems(c, user, ev, stage, plan.items);
      const next = { ...cfg, field: order, ...(plan.pools ? { pools_drawn: plan.pools } : {}), ...(revising ? { ...sched.format_config, third_place: sched.third_place } : {}) };
      const out = (await c.query('UPDATE event_stages SET config=$2, revision=revision+1, algorithm=$3, draw_seed=$4 WHERE id=$1 RETURNING *', [stage.id, JSON.stringify(next), plan.algorithm, drawSeed])).rows[0];
      await recordRevision(c, stage.id, revising ? 'format_revision' : stage.published_at ? 'redraw' : 'seed_edit', { reason: i.reason ?? null, actor: user.id, algorithm: plan.algorithm,
        inputs: { mode: i.mode, ...(revising ? { previous_format: base.format_config, format: sched.format_config, third_place: sched.third_place } : {}), previous_field: previous, field: order, draw_seed: drawSeed, protect_top: i.protect_top, games_retired: retired }, snapshot: { games: snapshotOf(plan.items) } });
      await audit(c, user.id, 'redraw_event_stage', 'event_stages', stage.id);
      return { stage: out, created: plan.items.length, retired, draw_seed: drawSeed, algorithm: plan.algorithm, warnings: plan.warnings };
    });
  },
});

// ---------------------------------------------------------------- Swiss
async function swissHistory(c, stage, uptoRound) {
  const rows = (await c.query("SELECT round_no, home_team_id, away_team_id, home_score, away_score FROM fixtures WHERE stage_id=$1 AND status='completed' AND round_no <= $2", [stage.id, uptoRound])).rows;
  const byes = Object.entries(stage.config?.swiss_state?.byes ?? {}).filter(([r, t]) => t && Number(r) <= uptoRound).map(([r, t]) => ({ round: Number(r), home: t, away: null }));
  return [...rows.map((g) => ({ round: g.round_no, home: g.home_team_id, away: g.away_team_id, home_score: g.home_score, away_score: g.away_score })), ...byes];
}

/** Pair, schedule and write one Swiss round (a new one, or the replacement of an unstarted one). */
async function swissRound(c, user, ev, stage, { round, manual, args, kind, reason: why }) {
  const cfg = stage.config ?? {};
  const sw = { ...DEFAULT_SWISS, ...(cfg.swiss ?? {}) };
  const field = cfg.field;
  const history = await swissHistory(c, stage, round - 1);
  let pairing;
  try { pairing = pairSwissRound(field, history, sw, { round, drawSeed: stage.draw_seed, manual, pointsWin: ev.points_win, pointsDraw: ev.points_draw, pointsLoss: ev.points_loss }); }
  catch (e) { throw conflict(e.message, { code: e.code }); }
  const plan = swissPlan(pairing, sw, field);
  const lastDate = (await c.query("SELECT max((scheduled_at AT TIME ZONE 'UTC')::date)::text AS d FROM fixtures WHERE stage_id=$1 AND status <> 'cancelled'", [stage.id])).rows[0].d;
  const from = lastDate && lastDate > args.from_date ? lastDate : args.from_date;
  const sched = await planStage(c, ev, { ...args, from_date: from, to_date: args.to_date && args.to_date >= from ? args.to_date : undefined }, { field, plan, drawSeed: stage.draw_seed });
  if (sched.unplaced.length) throw conflict(`Round ${round} does not fit in the scheduling window (${sched.unplaced.length} game(s)); extend the window or add courts`, { unplaced: sched.unplaced });
  await writeItems(c, user, ev, stage, sched.items);
  const state = { ...(cfg.swiss_state ?? { rounds_total: sw.rounds, byes: {} }) };
  state.byes = { ...state.byes }; delete state.byes[round]; if (pairing.bye) state.byes[round] = pairing.bye.team;
  const out = (await c.query('UPDATE event_stages SET config=$2, algorithm=$3 WHERE id=$1 RETURNING *', [stage.id, JSON.stringify({ ...cfg, swiss_state: state }), pairing.algorithm])).rows[0];
  await recordRevision(c, stage.id, kind === 'redraw' ? 'redraw' : 'round_generated', { reason: why ?? null, actor: user.id, algorithm: pairing.algorithm,
    inputs: pairing.inputs, snapshot: { round, pairings: pairing.pairings, bye: pairing.bye, warnings: pairing.warnings } });
  return { stage: out, round, created: sched.items.length, pairings: pairing.pairings, bye: pairing.bye, warnings: pairing.warnings, algorithm: pairing.algorithm };
}

cap({
  name: 'generate_swiss_round', method: 'POST', path: '/events/:id/stages/:stage_id/next-round', tag: TAG, status: 201,
  summary: 'Pair and schedule the next Swiss round once every game of the previous round has an official result. Pairings follow the stage’s named policy (score groups, no rematches unless allowed, bye to the lowest-ranked player without one, home/away balance) and each pair carries the reason it was made. The inputs and algorithm are recorded in the stage audit trail. Send `manual_pairings` to pair the round by hand (recorded as a manual draw).',
  input: z.object({ id, stage_id: id, manual_pairings: z.array(z.object({ home: id, away: id })).max(64).optional(), ...WINDOW }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev, stage } = await lockStage(c, user, i.id, i.stage_id);
      if (stage.kind !== 'swiss') throw badRequest('Only a Swiss stage has rounds to generate');
      const cfg = stage.config ?? {};
      const total = cfg.swiss_state?.rounds_total ?? cfg.swiss?.rounds ?? DEFAULT_SWISS.rounds;
      const last = (await c.query("SELECT coalesce(max(round_no),0) AS n FROM fixtures WHERE stage_id=$1 AND status <> 'cancelled'", [stage.id])).rows[0].n;
      if (last >= total) throw conflict(`All ${total} rounds have been generated`);
      const open = (await c.query("SELECT count(*)::int AS n FROM fixtures WHERE stage_id=$1 AND round_no=$2 AND status NOT IN ('completed','cancelled')", [stage.id, last])).rows[0].n;
      if (open) throw conflict(`Round ${last} still has ${open} game(s) without an official result`);
      return swissRound(c, user, ev, stage, { round: last + 1, manual: i.manual_pairings, args: argsOf(ev, stage, win(i)), kind: 'next' });
    });
  },
});

// ---------------------------------------------------------------- pools → knockout
cap({
  name: 'advance_pools_stage', method: 'POST', path: '/events/:id/stages/:stage_id/advance', tag: TAG, status: 201,
  summary: 'When every pool game has an official result, create the knockout from the pools: the top N of each pool plus the best runners-up (wildcards, ranked on points per game), seeded winners first, with teams from the same pool kept apart in round one where the field allows it. The pool tables use the explicit tie-break order of the stage. The knockout is a normal stage (parent = the pools stage) scheduled through the same scheduler.',
  input: z.object({ id, stage_id: id, format: z.enum(['knockout', 'double_elimination']).default('knockout'), third_place: z.boolean().optional(), format_config: z.object({ tie: z.any().optional(), reset: z.boolean().optional(), placement_up_to: z.number().int().optional(), consolation: z.boolean().optional(), repechage_template: z.string().optional() }).default({}),
    from_date: z.string().date().optional(), to_date: z.string().date().optional(), publish: z.boolean().default(true) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev, stage } = await lockStage(c, user, i.id, i.stage_id);
      if (stage.kind !== 'pools') throw badRequest('Only a pools stage can be advanced');
      if ((await c.query('SELECT 1 FROM event_stages WHERE parent_stage_id=$1', [stage.id])).rowCount) throw conflict('The knockout for these pools already exists');
      const view = (await stageViews(ev.id, { organiser: true })).find((s) => s.id === stage.id);
      if (!view.pools_complete) throw conflict('Every pool game needs an official result before the knockout is created');
      const pc = { ...DEFAULT_POOLS, ...(stage.config?.pools ?? {}) };
      const sep = separatePools(view.qualifiers, { avoid: pc.avoid_same_pool_round_one });
      const field = sep.teams.map((q) => q.team);
      const lastDate = (await c.query("SELECT max((scheduled_at AT TIME ZONE 'UTC')::date)::text AS d FROM fixtures WHERE stage_id=$1 AND status <> 'cancelled'", [stage.id])).rows[0].d;
      const base = argsOf(ev, stage);
      const from = i.from_date ?? (lastDate && lastDate > base.from_date ? lastDate : base.from_date);
      const args = scheduleInput.parse({ ...base, format: i.format, from_date: from, to_date: i.to_date ?? (base.to_date && base.to_date >= from ? base.to_date : undefined), third_place: i.third_place ?? pc.third_place ?? false, format_config: i.format_config, publish: i.publish, team_ids: field });
      const plan = await planStage(c, ev, args, { field, drawSeed: stage.draw_seed ?? newDrawSeed() });
      if (plan.unplaced.length) throw conflict(`${plan.unplaced.length} of ${plan.items.length} knockout games do not fit in the scheduling window`, { unplaced: plan.unplaced });
      const child = await createStage(c, user, ev, args, plan, { parent: stage.id, name: 'Knockout (from pools)' });
      await writeItems(c, user, ev, child, plan.items);
      await recordRevision(c, stage.id, 'stage_generated', { actor: user.id, algorithm: 'pools/qualifiers@1', inputs: { qualifiers: view.qualifiers, tie_breaks: pc.tie_breaks, advance_per_pool: pc.advance_per_pool, wildcards: pc.wildcards, same_pool_round_one_conflicts: sep.conflicts }, snapshot: { child_stage_id: child.id } });
      return { stage: child, qualifiers: view.qualifiers, same_pool_round_one_conflicts: sep.conflicts, created: plan.items.length, warnings: plan.warnings };
    });
  },
});

// ---------------------------------------------------------------- repechage
cap({
  name: 'generate_repechage', method: 'POST', path: '/events/:id/stages/:stage_id/repechage', tag: TAG, status: 201,
  summary: 'Create the repechage of a knockout once both semi-finals are official, from a versioned template (see get_bracket_formats): the teams beaten by each finalist play a ladder in that finalist’s half, then the bronze contest(s). The entrants come from the completed games, never from a hard-coded sport assumption. The games are scheduled through the same scheduler and recorded in the stage audit trail.',
  input: z.object({ id, stage_id: id, template: z.string().max(80).optional(), ...WINDOW }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev, stage } = await lockStage(c, user, i.id, i.stage_id);
      if (stage.kind !== 'knockout') throw badRequest('Repechage applies to a knockout stage');
      const template = i.template ?? stage.config?.repechage_template;
      if (!template) throw badRequest('Choose a repechage template');
      if (stage.config?.tie) throw conflict('Repechage is not available for stages played as series or multi-leg ties');
      if ((await c.query("SELECT 1 FROM fixtures WHERE stage_id=$1 AND round_kind='repechage' AND status <> 'cancelled' LIMIT 1", [stage.id])).rowCount) throw conflict('The repechage for this stage already exists');
      const rows = (await c.query("SELECT * FROM fixtures WHERE stage_id=$1 AND status <> 'cancelled' AND round_kind IN ('round_of_32','round_of_16','quarter','semi','final')", [stage.id])).rows;
      let g;
      try { g = repechageGraph(rows, template); } catch (e) { throw badRequest(e.message); }
      if (!g.ready) throw conflict(g.reason);
      if (!g.graph.fixtures.length) throw conflict('This field is too small for a repechage: no team was beaten before the semi-finals');
      const built = graphPlan(g.graph.fixtures, {}, (f) => f.label);
      const sched = await planStage(c, ev, argsOf(ev, stage, win(i)), { field: stage.config?.field ?? [], plan: { ...built, byes: [], warnings: [], stageKind: 'knockout', stageName: 'Repechage', algorithm: `repechage/${template}@${g.template.version}` }, drawSeed: stage.draw_seed });
      if (sched.unplaced.length) throw conflict(`${sched.unplaced.length} repechage game(s) do not fit in the scheduling window`, { unplaced: sched.unplaced });
      await writeItems(c, user, ev, stage, sched.items);
      await c.query('UPDATE event_stages SET config = config || $2::jsonb WHERE id=$1', [stage.id, JSON.stringify({ repechage_template: template })]);
      await recordRevision(c, stage.id, 'repechage_generated', { actor: user.id, algorithm: `repechage/${template}@${g.template.version}`, inputs: { template, halves: g.halves.map((h) => ({ finalist: h.finalist, entrants: h.entrants.map((e) => e.team), semi_loser: h.semi_loser })) }, snapshot: { games: snapshotOf(sched.items) } });
      return { created: sched.items.length, template: { id: template, version: g.template.version, label: g.template.label }, halves: g.halves };
    });
  },
});

// ---------------------------------------------------------------- corrections
async function stageRows(c, f) {
  return (await c.query("SELECT id, round, status, scheduled_at, home_team_id, away_team_id, winner_team_id, win_feeds_fixture_id, win_feeds_side, lose_feeds_fixture_id, lose_feeds_side, tie_id FROM fixtures WHERE event_id=$1 AND ($2::uuid IS NULL OR stage_id=$2) AND status <> 'cancelled'", [f.event_id, f.stage_id])).rows;
}

cap({
  name: 'preview_result_correction', method: 'POST', path: '/fixtures/:id/correction-preview', tag: TAG,
  summary: 'Show, before anything changes, what a corrected result would do to the rest of the bracket: games that have not started and would be re-filled automatically, games already started or played that would need an organiser decision, and what sits below them. Writes nothing. To apply a correction that affects played games, repeat record_result (or publish_score_sheet) with accept_downstream_conflicts = true, then resolve each conflict (keep the played game, or replay it).',
  input: z.object({ id, home_score: z.number().int().min(0), away_score: z.number().int().min(0), winner_team_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const f = (await c.query('SELECT * FROM fixtures WHERE id=$1', [i.id])).rows[0];
      if (!f) throw notFound('fixture');
      await eventForOrganizer(user, f.event_id, c);
      const winner = decideWinner(f, i.home_score, i.away_score, i.winner_team_id);
      const names = new Map((await c.query('SELECT id, name FROM teams')).rows.map((t) => [t.id, t.name]));
      let rows = await stageRows(c, f), source = f.id, next, outcomeChanged;
      if (f.tie_id) {
        const tie = (await c.query('SELECT * FROM bracket_ties WHERE id=$1', [f.tie_id])).rows[0];
        const games = (await c.query('SELECT * FROM fixtures WHERE tie_id=$1 ORDER BY leg_no', [tie.id])).rows.map((g) => (g.id === f.id ? { ...g, status: 'completed', home_score: i.home_score, away_score: i.away_score, winner_team_id: winner } : g));
        const st = tieState(tie, games);
        const w = st.decided ? (st.winner === 'a' ? tie.a_team_id : tie.b_team_id) : null;
        outcomeChanged = (tie.winner_team_id ?? null) !== w;
        const pseudo = { id: `tie:${tie.id}`, round: tie.config.label ?? tie.key, status: 'completed', winner_team_id: tie.winner_team_id, win_feeds_fixture_id: tie.win_feeds_fixture_id, win_feeds_side: tie.win_feeds_side, lose_feeds_fixture_id: tie.lose_feeds_fixture_id, lose_feeds_side: tie.lose_feeds_side };
        rows = [...rows, pseudo]; source = pseudo.id;
        next = { winner: w, loser: w ? (w === tie.a_team_id ? tie.b_team_id : tie.a_team_id) : null };
      } else {
        next = { winner, loser: winner ? (winner === f.home_team_id ? f.away_team_id : f.home_team_id) : null };
        outcomeChanged = (f.winner_team_id ?? null) !== (winner ?? null);
      }
      const imp = next.winner || next.loser ? correctionImpact(rows, source, next) : { auto: [], needs_resolution: [], blocked_downstream: [], unchanged: true };
      const label = (x) => ({ ...x, from_team: x.from_team_id ? names.get(x.from_team_id) : null, to_team: x.to_team_id ? names.get(x.to_team_id) : null });
      return {
        fixture_id: f.id, current: { home_score: f.home_score, away_score: f.away_score, winner_team_id: f.winner_team_id }, proposed: { home_score: i.home_score, away_score: i.away_score, winner_team_id: winner },
        outcome_changes: outcomeChanged, auto_update: imp.auto.map(label), needs_resolution: imp.needs_resolution.map(label), blocked_downstream: imp.blocked_downstream,
        requires_accept: imp.needs_resolution.length > 0,
        how_to_apply: imp.needs_resolution.length ? 'Repeat the correction with accept_downstream_conflicts = true; each played game is then raised as a bracket conflict to keep or replay.' : 'Safe to apply: only games that have not started change.',
      };
    });
  },
});

cap({
  name: 'list_bracket_conflicts', method: 'GET', path: '/events/:id/bracket-conflicts', tag: TAG,
  summary: 'Games that were already started or played when an upstream result was corrected, waiting for an organiser decision (open) or already decided (kept / replayed), with who was expected and who played.',
  input: z.object({ id, status: z.enum(['open', 'kept', 'replayed']).optional() }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.id);
    return many(
      `SELECT c.*, f.round AS fixture_round, f.status AS fixture_status, pt.name AS played_team, et.name AS expected_team
         FROM bracket_conflicts c JOIN fixtures f ON f.id=c.fixture_id LEFT JOIN teams pt ON pt.id=c.played_team_id LEFT JOIN teams et ON et.id=c.expected_team_id
        WHERE c.event_id=$1 AND ($2::text IS NULL OR c.status=$2) ORDER BY c.created_at DESC`, [i.id, i.status ?? null]);
  },
});

cap({
  name: 'resolve_bracket_conflict', method: 'POST', path: '/bracket-conflicts/:id/resolve', tag: TAG,
  summary: 'Decide a bracket conflict with a reason. keep_played: the game that was played stands as it is (recorded, nothing rewritten). replay: the played game is kept as history (cancelled, "superseded by correction") and a replacement game with the corrected line-up takes its slot and court; anything it had fed is sent back to "winner of …" or raised as a further conflict. Officials of the old game must be re-assigned.',
  input: z.object({ id, action: z.enum(['keep_played', 'replay']), reason }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cf = (await c.query('SELECT * FROM bracket_conflicts WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!cf) throw notFound('Conflict');
      await eventForOrganizer(user, cf.event_id, c);
      if (cf.status !== 'open') throw conflict(`Already ${cf.status}`);
      const d = (await c.query('SELECT * FROM fixtures WHERE id=$1 FOR UPDATE', [cf.fixture_id])).rows[0];
      let replacement = null;
      if (i.action === 'replay') {
        if (['live', 'paused'].includes(d.status)) throw conflict('This game is being played right now: finish or abandon it first');
        const other = cf.side === 'home' ? 'away' : 'home';
        const cols = ['event_id', 'round', 'resource_id', 'scheduled_at', 'duration_min', 'stage_id', 'round_kind', 'bracket_slot', 'bracket_side', 'round_no', 'pool', 'conditional', 'winner_optional', 'win_feeds_fixture_id', 'win_feeds_side', 'lose_feeds_fixture_id', 'lose_feeds_side'];
        const home = cf.side === 'home' ? cf.expected_team_id : d.home_team_id, away = cf.side === 'away' ? cf.expected_team_id : d.away_team_id;
        replacement = (await c.query(`INSERT INTO fixtures(${cols.join(',')}, home_team_id, away_team_id, home_placeholder, away_placeholder) SELECT ${cols.join(',')}, $2, $3, $4, $5 FROM fixtures WHERE id=$1 RETURNING *`,
          [d.id, home, away, cf.side === 'home' && !cf.expected_team_id ? `Winner of an earlier game` : null, cf.side === 'away' && !cf.expected_team_id ? `Winner of an earlier game` : null])).rows[0];
        void other;
        await c.query("UPDATE fixtures SET status='cancelled', void_reason='superseded_by_correction', win_feeds_fixture_id=NULL, lose_feeds_fixture_id=NULL WHERE id=$1", [d.id]);
        await c.query('UPDATE fixtures SET win_feeds_fixture_id=$2 WHERE win_feeds_fixture_id=$1 AND id <> $2', [d.id, replacement.id]);
        await c.query('UPDATE fixtures SET lose_feeds_fixture_id=$2 WHERE lose_feeds_fixture_id=$1 AND id <> $2', [d.id, replacement.id]);
        await c.query('UPDATE bracket_ties SET win_feeds_fixture_id=$2 WHERE win_feeds_fixture_id=$1', [d.id, replacement.id]);
        await c.query('UPDATE bracket_ties SET lose_feeds_fixture_id=$2 WHERE lose_feeds_fixture_id=$1', [d.id, replacement.id]);
        await c.query("UPDATE bracket_conflicts SET fixture_id=$2 WHERE fixture_id=$1 AND status='open' AND id <> $3", [d.id, replacement.id, cf.id]);
        // what the old game had fed forward no longer holds
        const src = { round: d.round };
        if (d.win_feeds_fixture_id && d.winner_team_id) await place(c, d.win_feeds_fixture_id, d.win_feeds_side, null, src, 'Winner', { allowConflicts: true });
        if (d.lose_feeds_fixture_id && d.winner_team_id) await place(c, d.lose_feeds_fixture_id, d.lose_feeds_side, null, src, 'Loser', { allowConflicts: true });
        await c.query('UPDATE fixtures SET win_feeds_fixture_id=$2, win_feeds_side=$3, lose_feeds_fixture_id=$4, lose_feeds_side=$5 WHERE id=$1', [replacement.id, d.win_feeds_fixture_id, d.win_feeds_side, d.lose_feeds_fixture_id, d.lose_feeds_side]);
      }
      const out = (await c.query("UPDATE bracket_conflicts SET status=$2, resolution_reason=$3, resolved_by=$4, resolved_at=now(), replacement_fixture_id=$5 WHERE id=$1 RETURNING *", [cf.id, i.action === 'replay' ? 'replayed' : 'kept', i.reason, user.id, replacement?.id ?? null])).rows[0];
      if (cf.stage_id) await recordRevision(c, cf.stage_id, 'conflict_resolved', { reason: i.reason, actor: user.id, inputs: { conflict_id: cf.id, action: i.action, fixture_id: cf.fixture_id, expected_team_id: cf.expected_team_id, played_team_id: cf.played_team_id }, snapshot: { replacement_fixture_id: replacement?.id ?? null } });
      await audit(c, user.id, `bracket_conflict_${i.action}`, 'bracket_conflicts', cf.id);
      return { ...out, replacement_fixture: replacement, officials_need_reassigning: !!replacement };
    });
  },
});

// ---------------------------------------------------------------- audit and schedule checks
cap({
  name: 'get_stage_audit', method: 'GET', path: '/events/:id/stages/:stage_id/revisions', tag: TAG,
  summary: 'The append-only audit trail of a stage: every generation, seed edit, redraw, Swiss round, repechage, publish, correction and conflict decision with who, why, the algorithm and version, the inputs (field order, draw seed) and a snapshot of the pairings — enough to reproduce the draw. Organiser only.',
  input: z.object({ id, stage_id: id }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.id);
    if (!(await one('SELECT 1 AS ok FROM event_stages WHERE id=$1 AND event_id=$2', [i.stage_id, i.id]))) throw notFound('Stage');
    return many('SELECT r.*, u.display_name AS actor_name FROM bracket_revisions r LEFT JOIN users u ON u.id=r.actor_id WHERE r.stage_id=$1 ORDER BY r.version', [i.stage_id]);
  },
});

cap({
  name: 'check_stage_schedule', method: 'GET', path: '/events/:id/stages/:stage_id/schedule-check', tag: TAG,
  summary: 'Detect scheduling conflicts in a stage: a team or an official in two games at once, too little rest between a team’s games, two games on one court at once, a game timed before the games that feed it, and games with a court but no booking. A bracket never implies a valid timetable: this reports what actually is.',
  input: z.object({ id, stage_id: id }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    const stage = await one('SELECT * FROM event_stages WHERE id=$1 AND event_id=$2', [i.stage_id, i.id]);
    if (!stage) throw notFound('Stage');
    const rest = stage.config?.schedule_args?.rest_min ?? 0;
    const fx = await many("SELECT id, round, scheduled_at, duration_min, resource_id, home_team_id, away_team_id, win_feeds_fixture_id, lose_feeds_fixture_id, status FROM fixtures WHERE stage_id=$1 AND status NOT IN ('cancelled') ORDER BY scheduled_at", [stage.id]);
    const end = (f) => +new Date(f.scheduled_at) + f.duration_min * 60000;
    const out = [];
    const byTeam = new Map();
    for (const f of fx) for (const t of [f.home_team_id, f.away_team_id]) if (t) (byTeam.get(t) ?? byTeam.set(t, []).get(t)).push(f);
    const names = new Map((await many('SELECT id, name FROM teams WHERE id = ANY($1)', [[...byTeam.keys()]])).map((t) => [t.id, t.name]));
    for (const [t, list] of byTeam) for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const x = list[a], y = list[b];
      if (+new Date(x.scheduled_at) < end(y) && +new Date(y.scheduled_at) < end(x)) out.push({ kind: 'team_overlap', message: `${names.get(t)} is in two games at once (${x.round} and ${y.round})`, fixtures: [x.id, y.id] });
      else if (rest && Math.min(Math.abs(+new Date(y.scheduled_at) - end(x)), Math.abs(+new Date(x.scheduled_at) - end(y))) < rest * 60000 && ((+new Date(y.scheduled_at) >= end(x)) || (+new Date(x.scheduled_at) >= end(y)))) out.push({ kind: 'rest', message: `${names.get(t)} has less than ${rest} minutes between ${x.round} and ${y.round}`, fixtures: [x.id, y.id] });
    }
    const byRes = new Map();
    for (const f of fx) if (f.resource_id) (byRes.get(f.resource_id) ?? byRes.set(f.resource_id, []).get(f.resource_id)).push(f);
    for (const list of byRes.values()) for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) if (+new Date(list[a].scheduled_at) < end(list[b]) && +new Date(list[b].scheduled_at) < end(list[a])) out.push({ kind: 'court_overlap', message: `${list[a].round} and ${list[b].round} are on the same court at the same time`, fixtures: [list[a].id, list[b].id] });
    const byId = new Map(fx.map((f) => [f.id, f]));
    for (const f of fx) for (const tid of [f.win_feeds_fixture_id, f.lose_feeds_fixture_id]) { const t = tid && byId.get(tid); if (t && +new Date(t.scheduled_at) < end(f)) out.push({ kind: 'order', message: `${t.round} is timed before ${f.round}, which feeds it`, fixtures: [f.id, t.id] }); }
    const booked = await many("SELECT resource_id, starts_at FROM bookings WHERE event_id=$1 AND source='fixture' AND status='confirmed'", [i.id]);
    const key = (r, t) => `${r}|${+new Date(t)}`;
    const have = new Set(booked.map((b) => key(b.resource_id, b.starts_at)));
    for (const f of fx) if (f.resource_id && !have.has(key(f.resource_id, f.scheduled_at))) out.push({ kind: 'unbooked', message: `${f.round} has a court but no booking`, fixtures: [f.id] });
    const officials = await many(
      `SELECT o.user_id, f.id, f.round, f.scheduled_at, f.duration_min FROM fixture_officials o JOIN fixtures f ON f.id=o.fixture_id
        WHERE o.status IN ('invited','accepted') AND f.status NOT IN ('cancelled','completed') AND f.event_id=$1 ORDER BY o.user_id, f.scheduled_at`, [i.id]);
    for (let a = 0; a < officials.length; a++) for (let b = a + 1; b < officials.length; b++) {
      const x = officials[a], y = officials[b];
      if (x.user_id === y.user_id && x.id !== y.id && +new Date(x.scheduled_at) < end(y) && +new Date(y.scheduled_at) < end(x)) out.push({ kind: 'official_overlap', message: `An official is assigned to ${x.round} and ${y.round} at the same time`, fixtures: [x.id, y.id] });
    }
    void ev;
    return { ok: out.length === 0, conflicts: out, checked: fx.length };
  },
});
