// Shared rules for multi-sport events (sports day / games): access, nomination limits, the person-level schedule
// clash engine, heat & bracket generation, standings and points. Pure helpers take a transaction client `c`.
import { badRequest, conflict, forbidden, notFound } from './errors.js';

export const STAGE_ORDER = { qualifying: 1, heat: 1, round_robin: 1, knockout: 2, quarter_final: 3, semi_final: 4, third_place: 5, final: 5 };
export const FINISHED = "('registered','finished','dns','dnf','dq')"; // everything except scratched

/** Serialise schedule/state changes for one event (released at commit/rollback). */
export const lockEvent = (c, eventId) => c.query("SELECT pg_advisory_xact_lock(hashtextextended('games:' || $1::text, 0))", [eventId]);

export async function programmeFor(c, eventId) {
  const p = (await c.query('SELECT * FROM event_programmes WHERE event_id=$1', [eventId])).rows[0];
  if (!p) throw conflict('This event is not set up as a multi-sport programme yet (call setup_multi_sport)');
  return p;
}

/** What the caller may do inside an event: organiser, house master of some houses, a participant's own account, accepted crew. */
export async function scopeFor(c, user, ev, isOrganizer) {
  const [houses, own, staff] = await Promise.all([
    c.query('SELECT id FROM event_houses WHERE event_id=$1 AND manager_user_id=$2 AND archived_at IS NULL', [ev.id, user.id]),
    c.query("SELECT id, house_id FROM event_participants WHERE event_id=$1 AND user_id=$2 AND status='active'", [ev.id, user.id]),
    c.query("SELECT id, role FROM event_staff WHERE event_id=$1 AND user_id=$2 AND status='accepted'", [ev.id, user.id]),
  ]);
  return { organizer: isOrganizer, houseIds: houses.rows.map((r) => r.id), participantIds: own.rows.map((r) => r.id), staff: staff.rows };
}

/** True when `user` may act for this participant (organiser, their house master, or the person themself). */
export const canActFor = (scope, participant) =>
  scope.organizer || (participant.house_id && scope.houseIds.includes(participant.house_id)) || scope.participantIds.includes(participant.id);

export const isMedicalStaff = (scope) => scope.staff.some((s) => ['physio', 'doctor', 'first_aider'].includes(s.role));

export const pointsFor = (programme, discipline) => discipline?.points ?? programme.default_points ?? {};

const better = (type) => (type === 'time' ? (a, b) => a - b : (a, b) => b - a); // sort comparator, best first

/** Competition ranking (1,1,3) of finished entries by value; everything else gets no position. */
export function rankSession(entries, resultType, byScore) {
  const key = (e) => (byScore ? e.score : e.result_value);
  const done = entries.filter((e) => e.result_status === 'finished' && key(e) != null);
  const cmp = byScore ? (a, b) => b - a : better(resultType);
  done.sort((a, b) => cmp(key(a), key(b)));
  const pos = new Map();
  done.forEach((e, i) => pos.set(e.id, i > 0 && key(done[i - 1]) === key(e) ? pos.get(done[i - 1].id) : i + 1));
  return pos;
}

export const laneOrder = (m) => [...Array(m).keys()].map((i) => i + 1).sort((a, b) => Math.abs(a - (m + 1) / 2) - Math.abs(b - (m + 1) / 2) || a - b);

/** Snake-draft entries (best seed first) into the fewest heats of at most `lanes`, sizes differing by at most one. */
export function balancedHeats(entries, lanes, resultType) {
  const n = entries.length;
  const k = Math.max(1, Math.ceil(n / lanes));
  const cmp = better(resultType);
  const sorted = [...entries].sort((a, b) => (a.seed == null) - (b.seed == null) || (a.seed != null && b.seed != null ? cmp(a.seed, b.seed) : 0));
  const heats = Array.from({ length: k }, () => []);
  sorted.forEach((e, i) => { const r = i % (2 * k); heats[r < k ? r : 2 * k - 1 - r].push(e); });
  return heats;
}

export const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(n, 1)));
export const knockoutStage = (size) => (size <= 2 ? 'final' : size === 4 ? 'semi_final' : size === 8 ? 'quarter_final' : 'knockout');
export const stageLabel = (stage, size) => ({ final: 'Final', semi_final: 'Semi-final', quarter_final: 'Quarter-final', third_place: 'Third place', knockout: `Round of ${size}` }[stage]);

/** Circle-method round robin: returns rounds of [a, b] pairs (byes dropped). */
export function roundRobin(teams) {
  const t = [...teams];
  if (t.length % 2) t.push(null);
  const n = t.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) { const a = t[i], b = t[n - 1 - i]; if (a && b) pairs.push(r % 2 ? [b, a] : [a, b]); }
    rounds.push(pairs);
    t.splice(1, 0, t.pop());
  }
  return rounds;
}

/** Pair seeds 1..P (best v worst) in bracket order. Seeds above the field size get a bye. Returns { size, slots: [[a,b] | [a]] }. */
export function seedBracket(seeded) {
  const P = nextPow2(seeded.length);
  const order = (m) => (m === 1 ? [1] : order(m / 2).flatMap((s) => [s, m + 1 - s]));
  const o = order(P);
  const slots = [];
  for (let i = 0; i < P; i += 2) {
    const a = seeded[o[i] - 1], b = seeded[o[i + 1] - 1];
    if (a && b) slots.push([a, b]); else slots.push([a ?? b]);
  }
  return { size: P, slots };
}

/** SQL fragment: which participants are in which session (directly, or through a team they are nominated into). */
export const SESSION_PEOPLE = `
  SELECT se.session_id, se.participant_id FROM event_session_entries se JOIN event_sessions s ON s.id=se.session_id
   WHERE s.event_id=$1 AND se.participant_id IS NOT NULL AND se.result_status <> 'scratched'
  UNION
  SELECT se.session_id, n.participant_id FROM event_session_entries se JOIN event_sessions s ON s.id=se.session_id
    JOIN discipline_nominations n ON n.team_id=se.team_id AND n.status IN ('nominated','confirmed')
   WHERE s.event_id=$1 AND se.team_id IS NOT NULL AND se.result_status <> 'scratched'`;

/**
 * Everything that makes the timetable unworkable: a person in two places at once (or without enough rest),
 * a ground double-booked, a participant on medical hold who is still scheduled.
 * `sessionId` narrows the report to clashes involving that session.
 */
export async function scheduleConflicts(c, eventId, restGap, sessionId = null) {
  const live = "status IN ('scheduled','live') AND scheduled_at IS NOT NULL";
  const [people, grounds, holds] = await Promise.all([
    c.query(
      `WITH pe AS (${SESSION_PEOPLE}),
            t AS (SELECT id, label, discipline_id, scheduled_at AS s, scheduled_at + duration_min * interval '1 minute' AS e FROM event_sessions WHERE event_id=$1 AND ${live})
       SELECT a.participant_id, p.full_name, p.house_id, ta.id AS session_a, ta.label AS label_a, ta.s AS starts_a, ta.discipline_id AS discipline_a,
              tb.id AS session_b, tb.label AS label_b, tb.s AS starts_b, tb.discipline_id AS discipline_b,
              (ta.s < tb.e AND tb.s < ta.e) AS overlap
         FROM pe a JOIN pe b ON a.participant_id=b.participant_id AND a.session_id < b.session_id
         JOIN t ta ON ta.id=a.session_id JOIN t tb ON tb.id=b.session_id JOIN event_participants p ON p.id=a.participant_id
        WHERE ta.s < tb.e + $2 * interval '1 minute' AND tb.s < ta.e + $2 * interval '1 minute'
          AND ($3::uuid IS NULL OR ta.id=$3 OR tb.id=$3)
        ORDER BY ta.s, p.full_name`, [eventId, restGap, sessionId]),
    c.query(
      `SELECT a.id AS session_a, a.label AS label_a, b.id AS session_b, b.label AS label_b, a.scheduled_at AS starts_a, b.scheduled_at AS starts_b,
              coalesce(r.name, a.location) AS ground
         FROM event_sessions a JOIN event_sessions b ON a.id < b.id AND a.event_id=b.event_id
         LEFT JOIN resources r ON r.id=a.resource_id
        WHERE a.event_id=$1 AND a.status IN ('scheduled','live') AND a.scheduled_at IS NOT NULL AND b.status IN ('scheduled','live') AND b.scheduled_at IS NOT NULL
          AND ((a.resource_id IS NOT NULL AND a.resource_id=b.resource_id) OR (a.resource_id IS NULL AND b.resource_id IS NULL AND a.location IS NOT NULL AND lower(a.location)=lower(b.location)))
          AND a.scheduled_at < b.scheduled_at + b.duration_min * interval '1 minute' AND b.scheduled_at < a.scheduled_at + a.duration_min * interval '1 minute'
          AND ($2::uuid IS NULL OR a.id=$2 OR b.id=$2)
        ORDER BY a.scheduled_at`, [eventId, sessionId]),
    c.query(
      `WITH pe AS (${SESSION_PEOPLE})
       SELECT p.id AS participant_id, p.full_name, s.id AS session_id, s.label, s.scheduled_at
         FROM pe JOIN event_participants p ON p.id=pe.participant_id JOIN event_sessions s ON s.id=pe.session_id
        WHERE p.medical_hold AND s.status IN ('scheduled','live') AND s.scheduled_at IS NOT NULL AND ($2::uuid IS NULL OR s.id=$2)
        ORDER BY s.scheduled_at`, [eventId, sessionId]),
  ]);
  const items = [
    ...people.rows.map((r) => ({ type: r.overlap ? 'participant_overlap' : 'participant_tight', ...r })),
    ...grounds.rows.map((r) => ({ type: 'ground_double_booked', ...r })),
    ...holds.rows.map((r) => ({ type: 'medical_hold', ...r })),
  ];
  return items;
}

/** Throw 409 when the (already updated, uncommitted) timetable has a hard clash involving `sessionId`. */
export async function assertNoHardClash(c, eventId, restGap, sessionId, allowTight = false) {
  const hard = (await scheduleConflicts(c, eventId, restGap, sessionId)).filter((x) => x.type !== 'medical_hold' && !(allowTight && x.type === 'participant_tight'));
  if (hard.length) throw conflict(`Schedule clash: ${hard[0].type.replace(/_/g, ' ')}${hard[0].full_name ? ` for ${hard[0].full_name}` : ''} (${hard.length} in total)`, { conflicts: hard.slice(0, 20) });
}

/** Overlap of a crew member's other work: other shifts (any event) and fixtures they officiate. Call under the user's advisory lock. */
export async function assertStaffFree(c, userId, start, end, excludeShiftId = null) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('official:' || $1::text, 0))", [userId]);
  const shift = await c.query(
    `SELECT 1 FROM event_shifts sh JOIN event_staff st ON st.id=sh.staff_id
      WHERE st.user_id=$1 AND sh.status='assigned' AND ($4::uuid IS NULL OR sh.id <> $4) AND sh.starts_at < $3 AND sh.ends_at > $2 LIMIT 1`, [userId, start, end, excludeShiftId]);
  if (shift.rowCount) throw conflict('That person already has another shift in that window');
  const fx = await c.query(
    `SELECT 1 FROM fixtures f WHERE f.status IN ('scheduled','live')
        AND (f.referee_id=$1 OR EXISTS (SELECT 1 FROM fixture_officials fo WHERE fo.fixture_id=f.id AND fo.user_id=$1 AND fo.status='accepted'))
        AND f.scheduled_at < $3 AND f.scheduled_at + f.duration_min * interval '1 minute' > $2 LIMIT 1`, [userId, start, end]);
  if (fx.rowCount) throw conflict('That person already officiates a fixture in that window');
}

const ROLE_NEEDS = { referee: 'referee', umpire: 'referee', judge: 'referee', starter: 'referee', timekeeper: 'referee', scorer: null, physio: 'physio', doctor: 'doctor', first_aider: null, volunteer: null };
export const STAFF_ROLES = Object.keys(ROLE_NEEDS);
export const MEDICAL_ROLES = ['physio', 'doctor', 'first_aider'];
export const OFFICIATING_ROLES = ['referee', 'umpire', 'judge', 'starter', 'timekeeper', 'scorer'];

/** A crew member must hold the platform role their post needs (a doctor post needs the doctor role, etc.). */
export function assertCanHold(userRoles, role) {
  const need = ROLE_NEEDS[role];
  if (need && !userRoles.includes(need) && !userRoles.includes('admin')) throw badRequest(`That person does not have the ${need} role on SportArena`);
}

/** Final placings of a discipline from its completed sessions: [{ rank, participant_id | team_id, house_id }]. */
export async function disciplineStandings(c, d) {
  const sessions = (await c.query("SELECT * FROM event_sessions WHERE discipline_id=$1 AND status <> 'cancelled'", [d.id])).rows;
  if (!sessions.length) throw conflict('This discipline has no sessions yet');
  if (sessions.some((s) => s.status !== 'completed')) throw conflict('Some sessions are not completed yet');
  const entries = (await c.query(
    `SELECT e.*, s.stage FROM event_session_entries e JOIN event_sessions s ON s.id=e.session_id WHERE s.discipline_id=$1 AND s.status='completed' AND e.result_status <> 'scratched'`, [d.id])).rows;
  const byStage = (st) => entries.filter((e) => e.stage === st);
  const subject = (e) => (e.team_id ? { team_id: e.team_id, house_id: e.house_id } : { participant_id: e.participant_id, house_id: e.house_id });
  const finishers = (list) => list.filter((e) => e.result_status === 'finished' && e.position != null).sort((a, b) => a.position - b.position);

  if (d.mode === 'individual') {
    if (entries.some((e) => e.qualified) && !byStage('final').length) throw conflict('Qualifiers were chosen but the next round has not been run yet (advance_discipline)');
    if (byStage('final').length) return finishers(byStage('final')).map((e) => ({ rank: e.position, ...subject(e) }));
    const cmp = better(d.result_type);
    const done = entries.filter((e) => e.result_status === 'finished' && e.result_value != null).sort((a, b) => cmp(a.result_value, b.result_value));
    const out = [];
    done.forEach((e, i) => out.push({ rank: i > 0 && done[i - 1].result_value === e.result_value ? out[i - 1].rank : i + 1, ...subject(e) }));
    return out;
  }

  // team disciplines
  const fin = finishers(byStage('final'));
  if (fin.length) {
    const out = fin.map((e) => ({ rank: e.position, ...subject(e) }));
    const third = finishers(byStage('third_place'));
    if (third.length) out.push(...third.map((e) => ({ rank: 2 + e.position, ...subject(e) })));
    else {
      const losers = finishers(byStage('semi_final')).filter((e) => e.position > 1 && !out.some((o) => o.team_id === e.team_id));
      out.push(...losers.map((e) => ({ rank: 3, ...subject(e) })));
    }
    return out;
  }
  if (byStage('semi_final').length || byStage('quarter_final').length || byStage('knockout').length) throw conflict('The knockout has no final yet (advance_discipline)');
  return roundRobinTable(byStage('round_robin')).map((r) => ({ rank: r.rank, team_id: r.team_id, house_id: r.house_id }));
}

/** Table from round-robin match entries (win 3, draw 1), tie-broken by score difference then score for. */
export function roundRobinTable(entries) {
  const bySession = new Map();
  for (const e of entries) { if (!bySession.has(e.session_id)) bySession.set(e.session_id, []); bySession.get(e.session_id).push(e); }
  const rows = new Map();
  const row = (e) => { if (!rows.has(e.team_id)) rows.set(e.team_id, { team_id: e.team_id, house_id: e.house_id, played: 0, won: 0, drawn: 0, lost: 0, score_for: 0, score_against: 0, points: 0 }); return rows.get(e.team_id); };
  for (const m of bySession.values()) {
    const sides = m.filter((e) => e.result_status === 'finished' && e.score != null);
    if (sides.length !== 2) { m.forEach(row); continue; }
    const [a, b] = sides;
    for (const [x, y] of [[a, b], [b, a]]) {
      const r = row(x);
      r.played++; r.score_for += x.score; r.score_against += y.score;
      if (x.score > y.score) { r.won++; r.points += 3; } else if (x.score === y.score) { r.drawn++; r.points += 1; } else r.lost++;
    }
  }
  const list = [...rows.values()].map((r) => ({ ...r, score_diff: r.score_for - r.score_against }))
    .sort((a, b) => b.points - a.points || b.score_diff - a.score_diff || b.score_for - a.score_for);
  list.forEach((r, i) => { const p = list[i - 1]; r.rank = p && p.points === r.points && p.score_diff === r.score_diff && p.score_for === r.score_for ? p.rank : i + 1; });
  return list;
}

export { badRequest, conflict, forbidden, notFound };
