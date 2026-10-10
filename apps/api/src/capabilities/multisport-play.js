// Multi-sport events, part 2: qualifying rounds, draws, the conflict-free timetable, results, final standings and points.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notify.js';
import { eventAccess, organizerOnly, houseBoard } from './multisport.js';
import {
  STAGE_ORDER, lockEvent, programmeFor, pointsFor, rankSession, balancedHeats, laneOrder, roundRobin, seedBracket, knockoutStage, stageLabel, nextPow2,
  scheduleConflicts, assertNoHardClash, assertStaffFree, disciplineStandings, roundRobinTable, SESSION_PEOPLE,
} from '../multisport.js';

const TAG = 'Multi-sport events';
const dt = z.string().datetime({ offset: true });
const NO_SCOPE = { organizer: false, houseIds: [], participantIds: [], staff: [] };

const discipline = async (c, disciplineId) => {
  const d = (await c.query('SELECT * FROM event_disciplines WHERE id=$1', [disciplineId])).rows[0];
  if (!d) throw notFound('Discipline');
  return d;
};
const mustSession = async (c, sessionId, lock = false) => {
  const s = (await c.query(`SELECT * FROM event_sessions WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [sessionId])).rows[0];
  if (!s) throw notFound('Session');
  return s;
};

/** Caller's scope in an event (anonymous callers have none). */
async function viewer(user, eventId) {
  if (!user) return { prog: await programmeFor(pool, eventId), scope: NO_SCOPE };
  const { scope } = await eventAccess(pool, user, eventId);
  return { prog: await programmeFor(pool, eventId), scope };
}
const sees = (scope, prog, houseId, participantId) =>
  prog.public_names || scope.organizer || scope.staff.length || (houseId && scope.houseIds.includes(houseId)) || (participantId && scope.participantIds.includes(participantId));

async function createSession(c, { ev, d, stage, label, round = 1, duration, entries, status = 'draft', userId }) {
  const s = (await c.query(
    `INSERT INTO event_sessions(event_id, discipline_id, stage, label, round, duration_min, venue_id, status, created_by, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $8='completed' THEN now() END) RETURNING *`,
    [ev.id, d.id, stage, label, round, duration, d.venue_id, status, userId])).rows[0];
  for (const e of entries) {
    await c.query(
      `INSERT INTO event_session_entries(session_id, participant_id, team_id, house_id, lane, result_status, position, qualified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [s.id, e.participant_id ?? null, e.team_id ?? null, e.house_id ?? null, e.lane ?? null, status === 'completed' ? 'finished' : 'registered', status === 'completed' ? 1 : null, status === 'completed']);
  }
  return { ...s, entries: entries.length };
}

// ---------------------------------------------------------------- generating sessions

cap({
  name: 'generate_heats', method: 'POST', path: '/disciplines/:id/heats', tag: TAG, status: 201,
  summary: 'Qualifying rounds for an individual discipline: split the nominated field into balanced heats of at most `lanes` (best seeds spread across heats, centre lanes to the best). A field that fits one race goes straight to a final. Sessions start unscheduled; place them with auto_schedule or update_session.',
  input: z.object({ id, lanes: z.number().int().min(2).max(24).default(8), stage: z.enum(['heat', 'qualifying']).default('heat'), duration_min: z.number().int().min(5).max(600).default(15) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = await discipline(c, i.id);
      const { ev } = await organizerOnly(c, user, d.event_id);
      await lockEvent(c, ev.id);
      if (d.mode !== 'individual') throw badRequest('Use generate_team_draw for team disciplines');
      if (['completed', 'cancelled'].includes(d.status)) throw conflict(`Discipline is ${d.status}`);
      if ((await c.query("SELECT 1 FROM event_sessions WHERE discipline_id=$1 AND status <> 'cancelled'", [d.id])).rowCount) throw conflict('This discipline already has sessions');
      const field = (await c.query(
        `SELECT n.participant_id, n.house_id, n.seed FROM discipline_nominations n JOIN event_participants p ON p.id=n.participant_id
          WHERE n.discipline_id=$1 AND n.status IN ('nominated','confirmed') AND p.status='active' ORDER BY n.created_at, n.id`, [d.id])).rows;
      if (field.length < 1) throw conflict('Nobody is nominated yet');
      const heats = balancedHeats(field, i.lanes, d.result_type);
      const out = [];
      if (field.length <= i.lanes) {
        const order = laneOrder(field.length);
        const sorted = heats[0];
        out.push(await createSession(c, { ev, d, stage: 'final', label: `${d.name} – Final`, duration: i.duration_min, userId: user.id, entries: sorted.map((e, k) => ({ ...e, lane: order[k] })) }));
      } else {
        for (const [k, h] of heats.entries()) {
          const order = laneOrder(h.length);
          out.push(await createSession(c, { ev, d, stage: i.stage, label: `${d.name} – Heat ${k + 1}`, round: k + 1, duration: i.duration_min, userId: user.id, entries: h.map((e, n) => ({ ...e, lane: order[n] })) }));
        }
      }
      await c.query("UPDATE event_disciplines SET status = CASE WHEN status='nominations' THEN 'scheduled' ELSE status END WHERE id=$1", [d.id]);
      return { discipline_id: d.id, entrants: field.length, sessions: out };
    });
  },
});

cap({
  name: 'generate_team_draw', method: 'POST', path: '/disciplines/:id/draw', tag: TAG, status: 201,
  summary: 'Fixtures for a team discipline: a round robin (every team plays every team) or a seeded knockout (byes for odd fields). Sessions start unscheduled.',
  input: z.object({ id, format: z.enum(['round_robin', 'knockout']), duration_min: z.number().int().min(5).max(600).default(40), team_ids: z.array(id).min(2).max(128).optional().describe('seed order; defaults to the order teams were created') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = await discipline(c, i.id);
      const { ev } = await organizerOnly(c, user, d.event_id);
      await lockEvent(c, ev.id);
      if (d.mode !== 'team') throw badRequest('Use generate_heats for individual disciplines');
      if (['completed', 'cancelled'].includes(d.status)) throw conflict(`Discipline is ${d.status}`);
      if ((await c.query("SELECT 1 FROM event_sessions WHERE discipline_id=$1 AND status <> 'cancelled'", [d.id])).rowCount) throw conflict('This discipline already has sessions');
      const all = (await c.query("SELECT id, house_id, name FROM discipline_teams WHERE discipline_id=$1 AND status='active' ORDER BY created_at, id", [d.id])).rows;
      let teams = all;
      if (i.team_ids) {
        teams = i.team_ids.map((t) => all.find((x) => x.id === t));
        if (teams.some((t) => !t)) throw badRequest('team_ids must be active teams of this discipline');
        if (new Set(i.team_ids).size !== i.team_ids.length) throw badRequest('A team is listed twice');
      }
      if (teams.length < 2) throw conflict('At least two teams are needed (build_house_teams / create_discipline_team)');
      for (const t of teams) {
        const n = (await c.query("SELECT count(*)::int AS n FROM discipline_nominations WHERE team_id=$1 AND status IN ('nominated','confirmed')", [t.id])).rows[0].n;
        if (d.team_size_min && n < d.team_size_min) throw conflict(`${t.name} has ${n} players; the minimum is ${d.team_size_min}`);
      }
      const side = (t) => ({ team_id: t.id, house_id: t.house_id });
      const out = [];
      if (i.format === 'round_robin') {
        for (const [r, pairs] of roundRobin(teams).entries()) {
          for (const [a, b] of pairs) out.push(await createSession(c, { ev, d, stage: 'round_robin', label: `${a.name} v ${b.name}`, round: r + 1, duration: i.duration_min, userId: user.id, entries: [side(a), side(b)] }));
        }
      } else {
        const { size, slots } = seedBracket(teams);
        const stage = knockoutStage(size);
        for (const [k, m] of slots.entries()) {
          out.push(await createSession(c, m.length === 2
            ? { ev, d, stage, label: `${stageLabel(stage, size)} ${k + 1}: ${m[0].name} v ${m[1].name}`, round: k + 1, duration: i.duration_min, userId: user.id, entries: m.map(side) }
            : { ev, d, stage, label: `${stageLabel(stage, size)} ${k + 1}: ${m[0].name} (bye)`, round: k + 1, duration: i.duration_min, userId: user.id, entries: [side(m[0])], status: 'completed' }));
        }
      }
      await c.query("UPDATE event_disciplines SET status = CASE WHEN status='nominations' THEN 'scheduled' ELSE status END WHERE id=$1", [d.id]);
      return { discipline_id: d.id, format: i.format, teams: teams.length, sessions: out };
    });
  },
});

cap({
  name: 'advance_discipline', method: 'POST', path: '/disciplines/:id/advance', tag: TAG, status: 201,
  summary: 'Run the next round once the current one is complete. Individual: pick the top finishers of each heat (+ fastest/best of the rest as wildcards) and create the next heats or the final. Team: round robin → knockout of the top N, or winners → next knockout round (optionally a third-place game).',
  input: z.object({
    id, qualifiers_per_session: z.number().int().min(1).max(24).default(2), wildcards: z.number().int().min(0).max(48).default(0),
    lanes: z.number().int().min(2).max(24).default(8), qualifiers: z.number().int().min(2).max(64).optional().describe('team round robin: how many teams go through'),
    third_place: z.boolean().default(false), duration_min: z.number().int().min(5).max(600).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = await discipline(c, i.id);
      const { ev } = await organizerOnly(c, user, d.event_id);
      await lockEvent(c, ev.id);
      if (['completed', 'cancelled'].includes(d.status)) throw conflict(`Discipline is ${d.status}`);
      const sessions = (await c.query("SELECT * FROM event_sessions WHERE discipline_id=$1 AND status <> 'cancelled' ORDER BY round, created_at, id", [d.id])).rows;
      if (!sessions.length) throw conflict('Generate the heats or draw first');
      const top = Math.max(...sessions.map((s) => STAGE_ORDER[s.stage]));
      const latestStage = sessions.filter((s) => STAGE_ORDER[s.stage] === top).map((s) => s.stage);
      const stage = latestStage.includes('final') ? 'final' : latestStage[0];
      if (stage === 'final' || stage === 'third_place') throw conflict('The final has been drawn — record its result, then finalize the discipline');
      const current = sessions.filter((s) => STAGE_ORDER[s.stage] === top);
      if (current.some((s) => s.status !== 'completed')) throw conflict('Finish and record every session of the current round first');
      const entries = (await c.query(
        'SELECT e.*, s.round AS session_round FROM event_session_entries e JOIN event_sessions s ON s.id=e.session_id WHERE e.session_id = ANY($1::uuid[]) AND e.result_status <> $2 ORDER BY s.round, s.created_at, e.created_at',
        [current.map((s) => s.id), 'scratched'])).rows;

      if (d.mode === 'individual') {
        const bySession = new Map(current.map((s) => [s.id, entries.filter((e) => e.session_id === s.id)]));
        const chosen = new Set(), pool = [];
        for (const list of bySession.values()) for (const e of list) {
          if (e.result_status !== 'finished' || e.position == null) continue;
          if (e.position <= i.qualifiers_per_session) chosen.add(e.id); else pool.push(e);
        }
        const cmp = d.result_type === 'time' ? (a, b) => a.result_value - b.result_value : (a, b) => b.result_value - a.result_value;
        pool.filter((e) => e.result_value != null).sort(cmp).slice(0, i.wildcards).forEach((e) => chosen.add(e.id));
        const q = entries.filter((e) => chosen.has(e.id));
        if (!q.length) throw conflict('Nobody qualified');
        await c.query('UPDATE event_session_entries SET qualified = (id = ANY($2::uuid[])) WHERE session_id = ANY($1::uuid[])', [current.map((s) => s.id), [...chosen]]);
        const field = q.map((e) => ({ participant_id: e.participant_id, house_id: e.house_id, seed: e.result_value }));
        const duration = i.duration_min ?? 15;
        const out = [];
        if (field.length <= i.lanes) {
          const order = laneOrder(field.length);
          const sorted = balancedHeats(field, i.lanes, d.result_type)[0];
          out.push(await createSession(c, { ev, d, stage: 'final', label: `${d.name} – Final`, duration, userId: user.id, entries: sorted.map((e, k) => ({ ...e, lane: order[k] })) }));
        } else {
          if (stage === 'semi_final') throw conflict('Too many qualifiers for a final — lower qualifiers_per_session or raise lanes');
          for (const [k, h] of balancedHeats(field, i.lanes, d.result_type).entries()) {
            const order = laneOrder(h.length);
            out.push(await createSession(c, { ev, d, stage: 'semi_final', label: `${d.name} – Semi-final ${k + 1}`, round: k + 1, duration, userId: user.id, entries: h.map((e, n) => ({ ...e, lane: order[n] })) }));
          }
        }
        return { discipline_id: d.id, from: stage, qualified: q.length, sessions: out };
      }

      // team disciplines
      const duration = i.duration_min ?? 40;
      const side = (e) => ({ team_id: e.team_id, house_id: e.house_id });
      const names = new Map((await c.query('SELECT id, name FROM discipline_teams WHERE discipline_id=$1', [d.id])).rows.map((t) => [t.id, t.name]));
      const out = [];
      if (stage === 'round_robin') {
        const table = roundRobinTable(entries);
        const n = Math.min(i.qualifiers ?? Math.min(4, table.length), table.length);
        if (n < 2) throw conflict('At least two teams must go through');
        const seeded = table.slice(0, n).map((r) => ({ id: r.team_id, house_id: r.house_id, name: names.get(r.team_id) }));
        const { size, slots } = seedBracket(seeded);
        const st = knockoutStage(size);
        for (const [k, m] of slots.entries()) {
          out.push(await createSession(c, m.length === 2
            ? { ev, d, stage: st, label: `${stageLabel(st, size)}${size > 2 ? ` ${k + 1}` : ''}: ${m[0].name} v ${m[1].name}`, round: k + 1, duration, userId: user.id, entries: m.map((t) => ({ team_id: t.id, house_id: t.house_id })) }
            : { ev, d, stage: st, label: `${stageLabel(st, size)} ${k + 1}: ${m[0].name} (bye)`, round: k + 1, duration, userId: user.id, entries: [{ team_id: m[0].id, house_id: m[0].house_id }], status: 'completed' }));
        }
        return { discipline_id: d.id, from: stage, qualified: n, sessions: out };
      }
      // knockout → next round
      const winners = [], losers = [];
      for (const s of current) {
        const list = entries.filter((e) => e.session_id === s.id && e.result_status === 'finished');
        const w = list.filter((e) => e.position === 1);
        if (w.length !== 1) throw conflict(`${s.label}: the winner is not decided`);
        winners.push(w[0]);
        losers.push(...list.filter((e) => e.position !== 1));
      }
      if (winners.length < 2) throw conflict('Only one team is left — finalize the discipline');
      const size = winners.length;
      const st = knockoutStage(size);
      for (let k = 0; k < winners.length; k += 2) {
        const [a, b] = [winners[k], winners[k + 1]];
        out.push(await createSession(c, { ev, d, stage: st, label: `${stageLabel(st, size)}${size > 2 ? ` ${k / 2 + 1}` : ''}: ${names.get(a.team_id)} v ${names.get(b.team_id)}`, round: k / 2 + 1, duration, userId: user.id, entries: [side(a), side(b)] }));
      }
      if (size === 2 && i.third_place && losers.length === 2) {
        out.push(await createSession(c, { ev, d, stage: 'third_place', label: `Third place: ${names.get(losers[0].team_id)} v ${names.get(losers[1].team_id)}`, duration, userId: user.id, entries: losers.map(side) }));
      }
      return { discipline_id: d.id, from: stage, qualified: winners.length, sessions: out };
    });
  },
});

cap({
  name: 'create_session', method: 'POST', path: '/disciplines/:id/sessions', tag: TAG, status: 201,
  summary: 'Add a one-off session by hand (an exhibition match, a re-run, a special final). Entries are participants (individual) or teams (team); lanes optional.',
  input: z.object({
    id, stage: z.enum(['qualifying', 'heat', 'round_robin', 'knockout', 'quarter_final', 'semi_final', 'third_place', 'final']).default('final'), label: z.string().min(1).max(120), duration_min: z.number().int().min(5).max(600).default(30),
    participant_ids: z.array(id).max(64).optional(), team_ids: z.array(id).max(64).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = await discipline(c, i.id);
      const { ev } = await organizerOnly(c, user, d.event_id);
      await lockEvent(c, ev.id);
      if (['completed', 'cancelled'].includes(d.status)) throw conflict(`Discipline is ${d.status}`);
      const entries = [];
      if (d.mode === 'individual') {
        for (const [k, pid] of (i.participant_ids ?? []).entries()) {
          const n = (await c.query("SELECT house_id FROM discipline_nominations WHERE discipline_id=$1 AND participant_id=$2 AND status IN ('nominated','confirmed')", [d.id, pid])).rows[0];
          if (!n) throw badRequest('Every participant must be nominated in this discipline');
          entries.push({ participant_id: pid, house_id: n.house_id, lane: k + 1 });
        }
      } else {
        for (const tid of i.team_ids ?? []) {
          const t = (await c.query("SELECT * FROM discipline_teams WHERE id=$1 AND discipline_id=$2 AND status='active'", [tid, d.id])).rows[0];
          if (!t) throw badRequest('Every team must be an active team of this discipline');
          entries.push({ team_id: t.id, house_id: t.house_id });
        }
      }
      return createSession(c, { ev, d, stage: i.stage, label: i.label, duration: i.duration_min, entries, userId: user.id });
    });
  },
});

cap({
  name: 'add_session_entry', method: 'POST', path: '/sessions/:id/entries', tag: TAG, status: 201,
  summary: 'Late entry: put a nominated participant (or team) into a session that has not been played. Refused if it would create a timetable clash.',
  input: z.object({ id, participant_id: id.optional(), team_id: id.optional(), lane: z.number().int().min(1).max(64).optional(), allow_tight: z.boolean().default(false) }),
  async handler({ user }, i) {
    if (!!i.participant_id === !!i.team_id) throw badRequest('Give either participant_id or team_id');
    return tx(async (c) => {
      const s = await mustSession(c, i.id, true);
      const d = await discipline(c, s.discipline_id);
      const { ev } = await organizerOnly(c, user, s.event_id);
      await lockEvent(c, ev.id);
      if (['completed', 'cancelled'].includes(s.status)) throw conflict(`Session is ${s.status}`);
      let house = null;
      if (i.participant_id) {
        if (d.mode !== 'individual') throw badRequest('This is a team discipline');
        const n = (await c.query("SELECT house_id FROM discipline_nominations WHERE discipline_id=$1 AND participant_id=$2 AND status IN ('nominated','confirmed')", [d.id, i.participant_id])).rows[0];
        if (!n) throw badRequest('That participant is not nominated in this discipline');
        house = n.house_id;
      } else {
        const t = (await c.query("SELECT house_id FROM discipline_teams WHERE id=$1 AND discipline_id=$2 AND status='active'", [i.team_id, d.id])).rows[0];
        if (!t) throw badRequest('That team is not active in this discipline');
        house = t.house_id;
      }
      let row;
      try {
        row = (await c.query('INSERT INTO event_session_entries(session_id, participant_id, team_id, house_id, lane) VALUES ($1,$2,$3,$4,$5) RETURNING *', [s.id, i.participant_id ?? null, i.team_id ?? null, house, i.lane ?? null])).rows[0];
      } catch (e) {
        if (e.code !== '23505') throw e;
        row = (await c.query("UPDATE event_session_entries SET result_status='registered', lane=coalesce($3,lane) WHERE session_id=$1 AND (participant_id=$2 OR team_id=$4) AND result_status='scratched' RETURNING *", [s.id, i.participant_id ?? null, i.lane ?? null, i.team_id ?? null])).rows[0];
        if (!row) throw conflict('Already in this session');
      }
      if (s.scheduled_at) await assertNoHardClash(c, ev.id, (await programmeFor(c, ev.id)).rest_gap_min, s.id, i.allow_tight);
      return row;
    });
  },
});

cap({
  name: 'scratch_session_entry', method: 'POST', path: '/session-entries/:id/scratch', tag: TAG,
  summary: 'Take an entry out of a session that has not been played (injury, withdrawal). The row is kept, marked scratched.',
  input: z.object({ id, note: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = (await c.query('SELECT * FROM event_session_entries WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!e) throw notFound('Entry');
      const s = await mustSession(c, e.session_id);
      await organizerOnly(c, user, s.event_id);
      if (['completed', 'cancelled'].includes(s.status)) throw conflict(`Session is ${s.status}`);
      return (await c.query("UPDATE event_session_entries SET result_status='scratched', note=$2 WHERE id=$1 RETURNING *", [i.id, i.note ?? null])).rows[0];
    });
  },
});

// ---------------------------------------------------------------- timetable

async function notifySession(c, s, d, title, body) {
  const users = await c.query(
    `WITH pe AS (${SESSION_PEOPLE})
     SELECT DISTINCT u FROM (
       SELECT p.user_id AS u FROM pe JOIN event_participants p ON p.id=pe.participant_id WHERE pe.session_id=$2 AND p.user_id IS NOT NULL
       UNION SELECT h.manager_user_id FROM event_session_entries e JOIN event_houses h ON h.id=e.house_id WHERE e.session_id=$2 AND h.manager_user_id IS NOT NULL
       UNION SELECT st.user_id FROM event_shifts sh JOIN event_staff st ON st.id=sh.staff_id WHERE sh.session_id=$2 AND sh.status='assigned') x WHERE u IS NOT NULL`, [s.event_id, s.id]);
  for (const r of users.rows) await notify(c, r.u, { kind: 'event_schedule', title, body, data: { event_id: s.event_id, session_id: s.id, discipline_id: d.id } });
}

cap({
  name: 'update_session', method: 'PATCH', path: '/sessions/:id', tag: TAG,
  summary: 'Put a session on the timetable or move it: time, duration, ground (resource or free-text location), or cancel it. Refuses a clash: a person in two places, too little rest between a person\'s games, the same ground twice, a later round before an earlier one, or crew already busy. Moving a timed session notifies the people in it.',
  input: z.object({
    id, scheduled_at: dt.nullable().optional(), duration_min: z.number().int().min(5).max(600).optional(), resource_id: id.nullable().optional(), location: z.string().max(80).nullable().optional(),
    cancel: z.boolean().optional(), allow_tight: z.boolean().default(false).describe('accept less than the programme rest gap between one person\'s games'),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const probe = await mustSession(c, i.id);
      const { ev } = await organizerOnly(c, user, probe.event_id);
      await lockEvent(c, ev.id);
      const s = await mustSession(c, i.id, true);
      const d = await discipline(c, s.discipline_id);
      const prog = await programmeFor(c, ev.id);
      if (['completed', 'cancelled'].includes(s.status)) throw conflict(`Session is ${s.status}`);
      if (i.cancel) {
        await c.query("UPDATE event_shifts SET status='cancelled' WHERE session_id=$1 AND status='assigned'", [s.id]);
        const row = (await c.query("UPDATE event_sessions SET status='cancelled' WHERE id=$1 RETURNING *", [s.id])).rows[0];
        if (s.scheduled_at) await notifySession(c, s, d, 'Session cancelled', `${s.label} has been cancelled.`);
        return row;
      }
      let resource = i.resource_id === undefined ? s.resource_id : i.resource_id, venue = s.venue_id;
      if (i.resource_id) {
        const r = (await c.query('SELECT id, venue_id FROM resources WHERE id=$1 AND active', [i.resource_id])).rows[0];
        if (!r) throw badRequest('Unknown or inactive resource');
        venue = r.venue_id;
      }
      const at = i.scheduled_at === undefined ? s.scheduled_at : i.scheduled_at;
      const dur = i.duration_min ?? s.duration_min;
      const was = s.scheduled_at;
      if (at) {
        // a later round cannot start before an earlier round of the same discipline has finished
        const earlier = (await c.query(
          `SELECT max(scheduled_at + duration_min * interval '1 minute') AS e FROM event_sessions WHERE discipline_id=$1 AND id <> $2 AND status IN ('scheduled','live','completed') AND scheduled_at IS NOT NULL AND (CASE stage WHEN 'qualifying' THEN 1 WHEN 'heat' THEN 1 WHEN 'round_robin' THEN 1 WHEN 'knockout' THEN 2 WHEN 'quarter_final' THEN 3 WHEN 'semi_final' THEN 4 ELSE 5 END) < $3`,
          [s.discipline_id, s.id, STAGE_ORDER[s.stage]])).rows[0].e;
        if (earlier && new Date(at) < new Date(earlier)) throw conflict('A later round cannot start before the earlier round of this discipline has finished');
      }
      const row = (await c.query(
        `UPDATE event_sessions SET scheduled_at=$2, duration_min=$3, resource_id=$4, venue_id=$5, location=CASE WHEN $6::boolean THEN $7 ELSE location END,
           status = CASE WHEN $2::timestamptz IS NULL THEN 'draft' WHEN status='draft' THEN 'scheduled' ELSE status END WHERE id=$1 RETURNING *`,
        [s.id, at, dur, resource, venue, i.location !== undefined, i.location ?? null])).rows[0];
      if (at) {
        const shifts = (await c.query("SELECT sh.*, st.user_id FROM event_shifts sh JOIN event_staff st ON st.id=sh.staff_id WHERE sh.session_id=$1 AND sh.status='assigned'", [s.id])).rows;
        const end = new Date(new Date(at).getTime() + dur * 60000).toISOString();
        for (const sh of shifts) {
          await assertStaffFree(c, sh.user_id, at, end, sh.id);
          await c.query('UPDATE event_shifts SET starts_at=$2, ends_at=$3 WHERE id=$1', [sh.id, at, end]);
        }
        await assertNoHardClash(c, ev.id, prog.rest_gap_min, s.id, i.allow_tight);
        if (!was || new Date(was).getTime() !== new Date(at).getTime()) {
          await notifySession(c, s, d, was ? 'Session rescheduled' : 'Session scheduled', `${s.label} is at ${new Date(at).toISOString().replace('T', ' ').slice(0, 16)} UTC${row.location ? ` · ${row.location}` : ''}.`);
        }
      } else await c.query("UPDATE event_shifts SET status='cancelled' WHERE session_id=$1 AND status='assigned'", [s.id]);
      return row;
    });
  },
});

cap({
  name: 'check_schedule_conflicts', method: 'GET', path: '/events/:id/schedule/conflicts', tag: TAG,
  summary: 'Audit the whole timetable: people in two places at once or with too little rest between games (across every sport they are nominated for), grounds double-booked, scheduled people on medical hold. Returns the clashes and how many sessions are still unscheduled.',
  input: z.object({ id, rest_gap_min: z.coerce.number().int().min(0).max(240).optional() }),
  async handler({ user }, i) {
    const { scope } = await eventAccess(pool, user, i.id);
    if (!scope.organizer && !scope.houseIds.length) throw forbidden();
    const prog = await programmeFor(pool, i.id);
    const items = await scheduleConflicts(pool, i.id, i.rest_gap_min ?? prog.rest_gap_min);
    const visible = scope.organizer ? items : items.filter((x) => scope.houseIds.includes(x.house_id));
    const unscheduled = (await one("SELECT count(*)::int AS n FROM event_sessions WHERE event_id=$1 AND status='draft'", [i.id])).n;
    return { rest_gap_min: i.rest_gap_min ?? prog.rest_gap_min, ok: visible.length === 0, total: visible.length, unscheduled_sessions: unscheduled, conflicts: visible };
  },
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

cap({
  name: 'auto_schedule', method: 'POST', path: '/events/:id/schedule/auto', tag: TAG,
  summary: 'Place every unscheduled session on the timetable so that nobody is in two places at once or without the rest gap — across all the sports a person is nominated for — and no ground is double-booked. Give the days, daily hours, lunch breaks and the grounds (tracks/fields/courts) that run in parallel. Earlier rounds always come before later rounds. Dry run by default; sessions that cannot fit are listed with a reason.',
  input: z.object({
    id, dates: z.array(z.string().date()).min(1).max(31), day_start: hhmm.default('09:00'), day_end: hhmm.default('17:00'), timezone: z.string().max(60).default('UTC'),
    breaks: z.array(z.object({ start: hhmm, end: hhmm })).max(6).default([]),
    grounds: z.array(z.object({ name: z.string().min(1).max(80), resource_id: id.optional(), discipline_ids: z.array(id).optional().describe('limit this ground to these disciplines') })).min(1).max(40),
    discipline_ids: z.array(id).max(100).optional().describe('only schedule these disciplines, in this priority order'), turnover_min: z.number().int().min(0).max(120).default(5), step_min: z.number().int().min(1).max(60).default(5),
    dry_run: z.boolean().default(true),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await organizerOnly(c, user, i.id);
      await lockEvent(c, ev.id);
      const prog = await programmeFor(c, ev.id);
      const gap = prog.rest_gap_min * 60000, turn = i.turnover_min * 60000;
      for (const g of i.grounds) if (g.resource_id && !(await c.query('SELECT 1 FROM resources WHERE id=$1 AND active', [g.resource_id])).rowCount) throw badRequest(`Unknown resource for ground ${g.name}`);
      // local day windows -> UTC instants
      const spans = [];
      for (const day of [...i.dates].sort()) spans.push(day);
      const tzq = async (day, t) => (await c.query('SELECT (($1::date + $2::time) AT TIME ZONE $3) AS ts', [day, t, i.timezone])).rows[0].ts.getTime();
      const windows = [];
      for (const day of spans) {
        const a = await tzq(day, i.day_start), b = await tzq(day, i.day_end);
        if (b <= a) throw badRequest('day_end must be after day_start');
        let cur = [[a, b]];
        for (const br of i.breaks) {
          const bs = await tzq(day, br.start), be = await tzq(day, br.end);
          cur = cur.flatMap(([x, y]) => (be <= x || bs >= y ? [[x, y]] : [[x, Math.min(bs, y)], [Math.max(be, x), y]].filter(([p, q]) => q > p)));
        }
        windows.push(...cur);
      }
      const sessions = (await c.query(
        `SELECT s.*, d.name AS discipline_name FROM event_sessions s JOIN event_disciplines d ON d.id=s.discipline_id
          WHERE s.event_id=$1 AND s.status='draft' AND s.scheduled_at IS NULL AND d.status <> 'cancelled' AND ($2::uuid[] IS NULL OR s.discipline_id = ANY($2::uuid[]))`, [ev.id, i.discipline_ids ?? null])).rows;
      const rank = new Map((i.discipline_ids ?? []).map((x, k) => [x, k]));
      sessions.sort((a, b) => (rank.get(a.discipline_id) ?? 999) - (rank.get(b.discipline_id) ?? 999) || a.discipline_name.localeCompare(b.discipline_name) || STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || a.round - b.round || String(a.created_at).localeCompare(String(b.created_at)));
      // busy maps from what is already on the timetable
      const live = (await c.query("SELECT id, discipline_id, stage, resource_id, location, scheduled_at, duration_min FROM event_sessions WHERE event_id=$1 AND status IN ('scheduled','live') AND scheduled_at IS NOT NULL", [ev.id])).rows;
      const people = new Map(); // session id -> participant ids
      for (const r of (await c.query(`WITH pe AS (${SESSION_PEOPLE}) SELECT session_id, participant_id FROM pe`, [ev.id])).rows) { if (!people.has(r.session_id)) people.set(r.session_id, []); people.get(r.session_id).push(r.participant_id); }
      const busy = new Map(), trackBusy = new Map(), discEnds = new Map(); // participant -> [[s,e]], ground key -> [[s,e]], discipline -> [{order,end}]
      const add = (m, k, a, b) => { if (!m.has(k)) m.set(k, []); m.get(k).push([a, b]); };
      const place = (s, at, gkey) => {
        const end = at + s.duration_min * 60000;
        for (const p of people.get(s.id) ?? []) add(busy, p, at, end);
        if (gkey) add(trackBusy, gkey, at, end + turn);
        if (!discEnds.has(s.discipline_id)) discEnds.set(s.discipline_id, []);
        discEnds.get(s.discipline_id).push({ order: STAGE_ORDER[s.stage], end });
      };
      const gkeyOf = (r) => (r.resource_id ? `r:${r.resource_id}` : r.location ? `l:${r.location.toLowerCase()}` : null);
      for (const s of live) place({ ...s, duration_min: s.duration_min }, new Date(s.scheduled_at).getTime(), gkeyOf(s));
      const grounds = i.grounds.map((g) => ({ ...g, key: g.resource_id ? `r:${g.resource_id}` : `l:${g.name.toLowerCase()}` }));
      const clashes = (list, a, b, pad = 0) => (list ?? []).some(([x, y]) => a < y + pad && x < b + pad);
      const step = i.step_min * 60000;
      const placed = [], unplaced = [];
      for (const s of sessions) {
        const dur = s.duration_min * 60000, ppl = people.get(s.id) ?? [];
        const lower = Math.max(0, ...(discEnds.get(s.discipline_id) ?? []).filter((x) => x.order < STAGE_ORDER[s.stage]).map((x) => x.end));
        const allowed = grounds.filter((g) => !g.discipline_ids || g.discipline_ids.includes(s.discipline_id));
        let best = null;
        for (const [ws, we] of windows) {
          if (we <= lower) continue;
          const first = Math.max(ws, lower);
          const t0 = ws + Math.ceil((first - ws) / step) * step;
          for (let t = t0; t + dur <= we && (!best || t < best.t); t += step) {
            if (ppl.some((p) => clashes(busy.get(p), t, t + dur, gap))) continue;
            const g = allowed.find((x) => !clashes(trackBusy.get(x.key), t, t + dur));
            if (g) { best = { t, g }; break; }
          }
          if (best) break;
        }
        if (!best) { unplaced.push({ session_id: s.id, label: s.label, reason: allowed.length ? 'no free slot for everyone and a ground inside the given days/hours' : 'no ground allowed for this discipline' }); continue; }
        place(s, best.t, best.g.key);
        placed.push({ session_id: s.id, label: s.label, discipline_id: s.discipline_id, scheduled_at: new Date(best.t).toISOString(), duration_min: s.duration_min, ground: best.g.name, resource_id: best.g.resource_id ?? null });
      }
      if (!i.dry_run) {
        for (const p of placed) {
          const venue = p.resource_id ? (await c.query('SELECT venue_id FROM resources WHERE id=$1', [p.resource_id])).rows[0].venue_id : null;
          await c.query("UPDATE event_sessions SET scheduled_at=$2, status='scheduled', resource_id=$3, location=$4, venue_id=coalesce($5, venue_id) WHERE id=$1", [p.session_id, p.scheduled_at, p.resource_id, p.resource_id ? null : p.ground, venue]);
        }
        const hard = (await scheduleConflicts(c, ev.id, prog.rest_gap_min)).filter((x) => x.type !== 'medical_hold');
        if (hard.length) throw conflict('The generated timetable would clash with the existing one; nothing was changed', { conflicts: hard.slice(0, 20) });
        if (placed.length) await c.query("UPDATE event_disciplines SET status='scheduled' WHERE event_id=$1 AND status='nominations' AND id = ANY($2::uuid[])", [ev.id, [...new Set(placed.map((p) => p.discipline_id))]]);
      }
      return { dry_run: i.dry_run, placed: placed.length, unplaced: unplaced.length, schedule: placed, unplaced_sessions: unplaced };
    });
  },
});

cap({
  name: 'list_sessions', method: 'GET', path: '/events/:id/sessions', tag: TAG, auth: 'public',
  summary: 'The programme / notice board: sessions with time, ground, stage and status. Participant names appear only if the organiser publishes names or the caller is involved; otherwise counts and houses.',
  input: z.object({ id, discipline_id: id.optional(), house_id: id.optional(), status: z.enum(['draft', 'scheduled', 'live', 'completed', 'cancelled']).optional(), from: dt.optional(), to: dt.optional(), mine: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    await viewer(user, i.id);
    const args = [i.id], w = ['s.event_id=$1'];
    const p = (v) => { args.push(v); return `$${args.length}`; };
    if (i.discipline_id) w.push(`s.discipline_id=${p(i.discipline_id)}`);
    if (i.status) w.push(`s.status=${p(i.status)}`); else w.push("s.status <> 'cancelled'");
    if (i.from) w.push(`s.scheduled_at >= ${p(i.from)}`);
    if (i.to) w.push(`s.scheduled_at < ${p(i.to)}`);
    if (i.house_id) w.push(`EXISTS (SELECT 1 FROM event_session_entries e WHERE e.session_id=s.id AND e.house_id=${p(i.house_id)} AND e.result_status <> 'scratched')`);
    if (i.mine && user) w.push(`EXISTS (WITH pe AS (${SESSION_PEOPLE}) SELECT 1 FROM pe JOIN event_participants pp ON pp.id=pe.participant_id WHERE pe.session_id=s.id AND pp.user_id=${p(user.id)})`);
    const rows = await many(
      `SELECT s.id, s.discipline_id, d.name AS discipline, d.mode, s.stage, s.label, s.round, s.scheduled_at, s.duration_min, s.status, s.location, s.resource_id, s.venue_id,
              coalesce(r.name, s.location) AS ground,
              (SELECT count(*)::int FROM event_session_entries e WHERE e.session_id=s.id AND e.result_status <> 'scratched') AS entrants
         FROM event_sessions s JOIN event_disciplines d ON d.id=s.discipline_id LEFT JOIN resources r ON r.id=s.resource_id
        WHERE ${w.join(' AND ')} ORDER BY s.scheduled_at NULLS LAST, d.name, s.round LIMIT ${p(i.limit)} OFFSET ${p(i.offset)}`, args);
    return rows;
  },
});

async function entryRows(c, sessionId, scope, prog) {
  const rows = (await c.query(
    `SELECT e.id, e.participant_id, e.team_id, e.house_id, h.name AS house, e.lane, e.result_value, e.score, e.position, e.result_status, e.qualified, e.note,
            p.full_name, t.name AS team_name
       FROM event_session_entries e LEFT JOIN event_participants p ON p.id=e.participant_id LEFT JOIN discipline_teams t ON t.id=e.team_id LEFT JOIN event_houses h ON h.id=e.house_id
      WHERE e.session_id=$1 ORDER BY e.position NULLS LAST, e.lane NULLS LAST, p.full_name`, [sessionId])).rows;
  return rows.map((r) => ({ ...r, full_name: r.participant_id && !sees(scope, prog, r.house_id, r.participant_id) ? null : r.full_name }));
}

cap({
  name: 'get_session', method: 'GET', path: '/sessions/:id', tag: TAG, auth: 'public',
  summary: 'One session with its entries, lanes and results. Participant names follow the programme\'s privacy setting.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await one('SELECT s.*, d.name AS discipline, d.mode, d.result_type FROM event_sessions s JOIN event_disciplines d ON d.id=s.discipline_id WHERE s.id=$1', [i.id]);
    if (!s) throw notFound('Session');
    const { prog, scope } = await viewer(user, s.event_id);
    const officials = await many("SELECT st.id AS staff_id, st.role, u.display_name FROM event_shifts sh JOIN event_staff st ON st.id=sh.staff_id JOIN users u ON u.id=st.user_id WHERE sh.session_id=$1 AND sh.status='assigned' ORDER BY st.role, u.display_name", [i.id]);
    return { ...s, entries: await entryRows(pool, i.id, scope, prog), officials };
  },
});

// ---------------------------------------------------------------- results

cap({
  name: 'record_session_results', method: 'POST', path: '/sessions/:id/results', tag: TAG,
  summary: 'Record a heat/match result (organiser, or the official assigned to the session). Individual: `value` (seconds/metres/points); team: `score`. Positions are computed (ties share a place) unless you set them; status dns/dnf/dq removes someone from the ranking. Knockout ties must be decided with `position`. Re-recording corrects a result.',
  input: z.object({
    id, complete: z.boolean().default(true),
    results: z.array(z.object({ entry_id: id, value: z.number().optional(), score: z.number().int().min(0).optional(), status: z.enum(['finished', 'dns', 'dnf', 'dq']).optional(), position: z.number().int().min(1).optional(), note: z.string().max(300).optional() })).min(1).max(64),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await mustSession(c, i.id, true);
      const d = await discipline(c, s.discipline_id);
      const { ev, scope } = await eventAccess(c, user, s.event_id);
      const assigned = (await c.query("SELECT 1 FROM event_shifts sh JOIN event_staff st ON st.id=sh.staff_id WHERE sh.session_id=$1 AND sh.status='assigned' AND st.user_id=$2 AND st.status='accepted'", [s.id, user.id])).rowCount > 0;
      if (!scope.organizer && !assigned) throw forbidden('Only the organiser or an official assigned to this session can record results');
      if (s.status === 'cancelled') throw conflict('Session is cancelled');
      if (ev.status === 'cancelled') throw conflict('Event is cancelled');
      const entries = (await c.query("SELECT * FROM event_session_entries WHERE session_id=$1 AND result_status <> 'scratched' FOR UPDATE", [s.id])).rows;
      const byId = new Map(entries.map((e) => [e.id, e]));
      for (const r of i.results) {
        const e = byId.get(r.entry_id);
        if (!e) throw badRequest('entry_id does not belong to this session (or was scratched)');
        const status = r.status ?? 'finished';
        if (status === 'finished' && d.mode === 'individual' && r.value == null && r.position == null) throw badRequest('Give a value (or a position) for a finished entry');
        if (status === 'finished' && d.mode === 'team' && r.score == null && r.position == null && entries.length > 1) throw badRequest('Give a score (or a position) for a finished team');
        Object.assign(e, { result_value: r.value ?? null, score: r.score ?? null, result_status: status, position: status === 'finished' ? (r.position ?? null) : null, note: r.note ?? e.note, _explicit: r.position != null });
      }
      const byScore = d.mode === 'team';
      const auto = rankSession(entries.filter((e) => !e._explicit), d.result_type, byScore);
      for (const e of entries) {
        if (e.result_status === 'finished' && !e._explicit) e.position = entries.length === 1 ? 1 : (auto.get(e.id) ?? null);
        await c.query('UPDATE event_session_entries SET result_value=$2, score=$3, result_status=$4, position=$5, note=$6 WHERE id=$1', [e.id, e.result_value, e.score, e.result_status, e.position, e.note ?? null]);
      }
      if (i.complete) {
        const open = entries.filter((e) => e.result_status === 'registered');
        if (open.length) throw badRequest(`${open.length} entr${open.length > 1 ? 'ies have' : 'y has'} no result yet`);
        if (d.mode === 'team' && ['knockout', 'quarter_final', 'semi_final', 'final', 'third_place'].includes(s.stage)) {
          const fin = entries.filter((e) => e.result_status === 'finished');
          if (fin.length > 1 && fin.filter((e) => e.position === 1).length !== 1) throw conflict('A knockout game needs a winner: set `position` on the entries to settle the tie');
        }
        await c.query("UPDATE event_sessions SET status='completed', completed_at=now() WHERE id=$1", [s.id]);
        await c.query("UPDATE event_disciplines SET status='ongoing' WHERE id=$1 AND status IN ('nominations','scheduled')", [d.id]);
      } else if (s.status !== 'live') await c.query("UPDATE event_sessions SET status='live' WHERE id=$1 AND status IN ('draft','scheduled')", [s.id]);
      const out = await entryRows(c, s.id, { ...scope, organizer: true }, { public_names: true });
      return { session_id: s.id, completed: i.complete, entries: out, refinalize_required: !!d.finalized_at };
    });
  },
});

// ---------------------------------------------------------------- final standings & points

cap({
  name: 'finalize_discipline', method: 'POST', path: '/disciplines/:id/finalize', tag: TAG,
  summary: 'Close a discipline: compute final places from its completed sessions (final / third-place game / round-robin table / ranking by mark) and write placement points to the ledger for the people, teams and houses involved, plus participation points. Safe to re-run after a corrected result: earlier points are voided, not deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d0 = await discipline(c, i.id);
      const { ev } = await organizerOnly(c, user, d0.event_id);
      await lockEvent(c, ev.id);
      const d = (await c.query('SELECT * FROM event_disciplines WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (d.status === 'cancelled') throw conflict('Discipline is cancelled');
      const prog = await programmeFor(c, ev.id);
      const standings = await disciplineStandings(c, d);
      const scheme = pointsFor(prog, d);
      await c.query("UPDATE event_points SET voided_at=now(), voided_by=$2, void_reason='Re-finalized' WHERE discipline_id=$1 AND voided_at IS NULL AND kind IN ('placement','participation')", [d.id, user.id]);
      const houseOf = async (r) => r.house_id ?? null;
      const rows = [];
      for (const r of standings) {
        const pts = scheme[String(r.rank)] ?? 0;
        if (pts <= 0) continue;
        rows.push((await c.query(
          'INSERT INTO event_points(event_id, discipline_id, house_id, participant_id, team_id, kind, rank, points, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
          [ev.id, d.id, await houseOf(r), r.participant_id ?? null, r.team_id ?? null, 'placement', r.rank, pts, `${d.name}: place ${r.rank}`, user.id])).rows[0]);
      }
      if (prog.participation_points > 0) {
        const placed = new Set(standings.filter((r) => (scheme[String(r.rank)] ?? 0) > 0).map((r) => r.participant_id ?? r.team_id));
        const took = (await c.query(
          `SELECT DISTINCT e.participant_id, e.team_id, e.house_id FROM event_session_entries e JOIN event_sessions s ON s.id=e.session_id
            WHERE s.discipline_id=$1 AND s.status='completed' AND e.result_status='finished'`, [d.id])).rows;
        for (const r of took) {
          if (placed.has(r.participant_id ?? r.team_id)) continue;
          rows.push((await c.query(
            'INSERT INTO event_points(event_id, discipline_id, house_id, participant_id, team_id, kind, points, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
            [ev.id, d.id, r.house_id, r.participant_id, r.team_id, 'participation', prog.participation_points, `${d.name}: took part`, user.id])).rows[0]);
        }
      }
      await c.query("UPDATE event_disciplines SET status='completed', finalized_at=now() WHERE id=$1", [d.id]);
      return { discipline_id: d.id, standings, points_awarded: rows.reduce((a, r) => a + r.points, 0), ledger: rows };
    });
  },
});

cap({
  name: 'award_points', method: 'POST', path: '/events/:id/points', tag: TAG, status: 201,
  summary: 'Add a manual bonus or penalty (sportsmanship, a late arrival) to a house, a participant or a team. Use a negative number for a penalty. Kept in the ledger with the reason.',
  input: z.object({ id, house_id: id.optional(), participant_id: id.optional(), team_id: id.optional(), discipline_id: id.optional(), points: z.number().int().min(-1000).max(1000).refine((n) => n !== 0, 'points must not be 0'), reason: z.string().min(2).max(300) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await organizerOnly(c, user, i.id);
      await programmeFor(c, ev.id);
      let house = i.house_id ?? null;
      if (i.participant_id) {
        const p = (await c.query('SELECT house_id FROM event_participants WHERE id=$1 AND event_id=$2', [i.participant_id, ev.id])).rows[0];
        if (!p) throw badRequest('Unknown participant');
        house = house ?? p.house_id;
      }
      if (i.team_id) {
        const t = (await c.query('SELECT t.house_id FROM discipline_teams t JOIN event_disciplines d ON d.id=t.discipline_id WHERE t.id=$1 AND d.event_id=$2', [i.team_id, ev.id])).rows[0];
        if (!t) throw badRequest('Unknown team');
        house = house ?? t.house_id;
      }
      if (!house && !i.participant_id && !i.team_id) throw badRequest('Give a house, participant or team');
      if (house && !(await c.query('SELECT 1 FROM event_houses WHERE id=$1 AND event_id=$2', [house, ev.id])).rowCount) throw badRequest('Unknown house');
      return (await c.query(
        'INSERT INTO event_points(event_id, discipline_id, house_id, participant_id, team_id, kind, points, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [ev.id, i.discipline_id ?? null, house, i.participant_id ?? null, i.team_id ?? null, i.points < 0 ? 'penalty' : 'bonus', i.points, i.reason, user.id])).rows[0];
    });
  },
});

cap({
  name: 'void_points', method: 'POST', path: '/points/:id/void', tag: TAG,
  summary: 'Cancel a ledger entry that was a mistake. The row stays in the ledger marked void, with who and why.',
  input: z.object({ id, reason: z.string().min(2).max(300) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = (await c.query('SELECT * FROM event_points WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!p) throw notFound('Points entry');
      await organizerOnly(c, user, p.event_id);
      if (p.voided_at) throw conflict('Already void');
      return (await c.query('UPDATE event_points SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1 RETURNING *', [i.id, user.id, i.reason])).rows[0];
    });
  },
});

cap({
  name: 'get_games_leaderboard', method: 'GET', path: '/events/:id/leaderboard', tag: TAG, auth: 'public',
  summary: 'Points tables of a multi-sport event: scope house (with gold/silver/bronze), individual or team; optionally for one discipline. Individual names follow the programme\'s privacy setting.',
  input: z.object({ id, scope: z.enum(['house', 'individual', 'team']).default('house'), discipline_id: id.optional(), include_ledger: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  async handler({ user }, i) {
    const { prog, scope } = await viewer(user, i.id);
    if (i.scope === 'house' && !i.discipline_id) return { scope: 'house', rows: await houseBoard(null, i.id) };
    const col = { house: 'p.house_id', individual: 'p.participant_id', team: 'p.team_id' }[i.scope];
    const rows = await many(
      `SELECT ${col} AS subject_id, sum(p.points)::int AS points,
              count(*) FILTER (WHERE p.kind='placement' AND p.rank=1)::int AS gold, count(*) FILTER (WHERE p.kind='placement' AND p.rank=2)::int AS silver, count(*) FILTER (WHERE p.kind='placement' AND p.rank=3)::int AS bronze,
              max(p.house_id::text)::uuid AS house_id
         FROM event_points p WHERE p.event_id=$1 AND p.voided_at IS NULL AND ${col} IS NOT NULL AND ($2::uuid IS NULL OR p.discipline_id=$2)
        GROUP BY ${col} ORDER BY points DESC, gold DESC, silver DESC, bronze DESC LIMIT $3`, [i.id, i.discipline_id ?? null, i.limit]);
    const names = new Map();
    const table = { house: 'event_houses', individual: 'event_participants', team: 'discipline_teams' }[i.scope];
    const nameCol = i.scope === 'individual' ? 'full_name' : 'name';
    for (const r of await many(`SELECT id, ${nameCol} AS name${i.scope === 'individual' ? ', house_id' : ''} FROM ${table} WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.subject_id)])) names.set(r.id, r);
    const houses = new Map((await many('SELECT id, name FROM event_houses WHERE event_id=$1', [i.id])).map((h) => [h.id, h.name]));
    const out = rows.map((r, k) => {
      const subj = names.get(r.subject_id);
      const hide = i.scope === 'individual' && !sees(scope, prog, r.house_id, r.subject_id);
      return { rank: 0, subject_id: r.subject_id, name: hide ? null : subj?.name ?? null, house_id: r.house_id, house: houses.get(r.house_id) ?? null, points: r.points, gold: r.gold, silver: r.silver, bronze: r.bronze, _k: k };
    });
    out.forEach((r, k) => { const p = out[k - 1]; r.rank = p && p.points === r.points && p.gold === r.gold && p.silver === r.silver && p.bronze === r.bronze ? p.rank : k + 1; delete r._k; });
    const res = { scope: i.scope, discipline_id: i.discipline_id ?? null, rows: out };
    if (i.include_ledger && scope.organizer) res.ledger = await many('SELECT * FROM event_points WHERE event_id=$1 ORDER BY created_at DESC LIMIT 500', [i.id]);
    return res;
  },
});

cap({
  name: 'get_discipline_results', method: 'GET', path: '/disciplines/:id/results', tag: TAG, auth: 'public',
  summary: 'Result sheet of a discipline: every session with its results, the live round-robin table for team sports, and the final places once finalized.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const d = await one('SELECT d.*, s.name AS sport_name FROM event_disciplines d JOIN sports s ON s.id=d.sport_id WHERE d.id=$1', [i.id]);
    if (!d) throw notFound('Discipline');
    const { prog, scope } = await viewer(user, d.event_id);
    const sessions = await many("SELECT id, stage, label, round, status, scheduled_at, location FROM event_sessions WHERE discipline_id=$1 AND status <> 'cancelled' ORDER BY (CASE stage WHEN 'qualifying' THEN 1 WHEN 'heat' THEN 1 WHEN 'round_robin' THEN 1 WHEN 'knockout' THEN 2 WHEN 'quarter_final' THEN 3 WHEN 'semi_final' THEN 4 ELSE 5 END), round, created_at", [i.id]);
    for (const s of sessions) s.entries = await entryRows(pool, s.id, scope, prog);
    let table = null;
    if (d.mode === 'team') {
      const rr = (await many("SELECT e.*, t.name AS team_name FROM event_session_entries e JOIN event_sessions s ON s.id=e.session_id LEFT JOIN discipline_teams t ON t.id=e.team_id WHERE s.discipline_id=$1 AND s.stage='round_robin' AND s.status='completed'", [i.id]));
      if (rr.length) { const names = new Map(rr.map((r) => [r.team_id, r.team_name])); table = roundRobinTable(rr).map((r) => ({ ...r, team: names.get(r.team_id) })); }
    }
    const places = d.finalized_at ? await many(
      `SELECT p.rank, p.points, p.house_id, h.name AS house, p.team_id, t.name AS team, p.participant_id, pp.full_name, pp.house_id AS pp_house
         FROM event_points p LEFT JOIN event_houses h ON h.id=p.house_id LEFT JOIN discipline_teams t ON t.id=p.team_id LEFT JOIN event_participants pp ON pp.id=p.participant_id
        WHERE p.discipline_id=$1 AND p.kind='placement' AND p.voided_at IS NULL ORDER BY p.rank`, [i.id]) : null;
    return { discipline: d, sessions, table, final_places: places?.map(({ pp_house, ...r }) => ({ ...r, full_name: r.participant_id && !sees(scope, prog, pp_house, r.participant_id) ? null : r.full_name })) ?? null };
  },
});
