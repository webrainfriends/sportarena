import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { validateValue, officialPoints, EVIDENCE_LABELS, RANKING_RULES } from '../scoring/performance-rules.js';
import { resolveRule, ruleOfVersion, builtinRule, aggregationFor, standardOf } from '../scoring/metric-defs.js';
import { isAdmin, mustFind, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { NOT_YOUTH_SQL } from '../youth.js';
import { notify } from '../notify.js';
import { onResultsChanged } from '../rankings/data.js';

const TAG_PERF = 'Scores & Awards';
const label = (p) => EVIDENCE_LABELS[p] ?? p;
const withLabel = (r) => (r ? { ...r, evidence_label: label(r.provenance) } : r);

/** The people who may submit/decide official results: platform admin, the event organiser, the fixture's referee and the event's accepted officiating crew. */
async function officialsOf(c, perf) {
  const ev = perf.event_id ? (await c.query('SELECT organizer_id FROM events WHERE id=$1', [perf.event_id])).rows[0] : null;
  const fx = perf.fixture_id ? (await c.query('SELECT referee_id FROM fixtures WHERE id=$1', [perf.fixture_id])).rows[0] : null;
  const crew = perf.event_id ? (await c.query("SELECT user_id FROM event_staff WHERE event_id=$1 AND status='accepted' AND role IN ('referee','umpire','judge','starter','timekeeper','scorer')", [perf.event_id])).rows.map((r) => r.user_id) : [];
  return [ev?.organizer_id, fx?.referee_id, ...crew].filter(Boolean);
}
const mayOfficiate = async (c, user, perf) => isAdmin(user) || (await officialsOf(c, perf)).includes(user.id);

/** Is this athlete actually in the event (individually, via a team entry, or on the multi-sport roster), and in the fixture's teams if one is named? */
async function checkParticipation(c, athleteId, ev, fx) {
  const inEvent = (await c.query(
    `SELECT 1 FROM event_entries e WHERE e.event_id=$1 AND e.status <> 'rejected' AND e.status <> 'withdrawn' AND (e.user_id=$2 OR e.team_id IN (SELECT team_id FROM team_members WHERE user_id=$2 AND status='active'))
     UNION ALL SELECT 1 FROM event_participants WHERE event_id=$1 AND user_id=$2 AND status='active' LIMIT 1`, [ev.id, athleteId])).rows[0];
  if (!inEvent) throw unprocessable('This athlete is not entered in the event, so a result cannot be submitted for them');
  if (fx && (fx.home_team_id || fx.away_team_id)) {
    const onTeam = (await c.query("SELECT 1 FROM team_members WHERE user_id=$1 AND status='active' AND team_id = ANY($2::uuid[])", [athleteId, [fx.home_team_id, fx.away_team_id].filter(Boolean)])).rows[0];
    const solo = (await c.query("SELECT 1 FROM event_entries WHERE event_id=$1 AND user_id=$2 AND status='accepted'", [ev.id, athleteId])).rows[0];
    if (!onTeam && !solo) throw unprocessable('This athlete does not play for either team in that game');
  }
}

async function eventSportOk(c, ev, sport) {
  if (ev.sport_id === sport.id) return true;
  return !!(await c.query('SELECT 1 FROM event_disciplines WHERE event_id=$1 AND sport_id=$2 LIMIT 1', [ev.id, sport.id])).rows[0];
}

const logStep = (c, perfId, actor, action, from, to, note, snap) =>
  c.query('INSERT INTO performance_log(performance_id, actor_id, action, from_status, to_status, note, snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7)', [perfId, actor, action, from, to, note ?? null, snap ? JSON.stringify(snap) : null]);

cap({
  name: 'record_performance', method: 'POST', path: '/performances', tag: TAG_PERF, status: 201,
  summary: 'Record a score or stat. Without an event/fixture it is private practice (self-reported, or imported evidence with an evidence_ref) and never affects official rankings; any points you type are kept as a claim only. With an event/fixture it is a competition result that the event organiser, an accepted official of the event or an admin submits; it is validated against the event, the athlete and the sport rules, gets official points derived on the server, and counts only once someone else approves it. Send client_key to retry safely.',
  input: z.object({
    user_id: id.optional().describe('defaults to you'), sport: z.string(), metric: z.string().min(1).max(40), value: z.number(),
    points: z.number().optional().describe('ignored for rankings; kept as the athlete’s own claim for practice'),
    event_id: id.optional(), fixture_id: id.optional(), achieved_on: z.string().date().optional(),
    imported: z.boolean().default(false).describe('practice that came from a device or another app; needs evidence_ref'),
    evidence_ref: z.string().max(300).optional().describe('link or reference to where the figure came from'),
    client_key: z.string().min(8).max(80).optional(),
  }),
  async handler({ user }, i) {
    const target = i.user_id ?? user.id;
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    const rule = await resolveRule(sport, i.metric);
    const bad = validateValue(rule, i.value);
    if (bad) throw unprocessable(bad);
    if (i.achieved_on && i.achieved_on > new Date().toISOString().slice(0, 10)) throw unprocessable('The date a result was achieved cannot be in the future');
    return tx(async (c) => {
      if (i.client_key) {
        const dup = (await c.query('SELECT * FROM performances WHERE recorded_by=$1 AND client_key=$2', [user.id, i.client_key])).rows[0];
        if (dup) return withLabel(dup);
      }
      await mustFind('users', target, 'id', c);
      const competition = !!(i.event_id || i.fixture_id);
      if (!competition) {
        if (target !== user.id && !isAdmin(user)) throw forbidden('You can only log practice for yourself');
        const prov = i.imported ? 'imported' : 'self_reported';
        if (!i.evidence_ref && (i.imported || rule.evidence_required_for.includes(prov))) throw unprocessable(i.imported ? 'Imported results need a link or reference to the evidence' : 'This metric needs a link or reference to the evidence, even for a self-reported claim');
        const row = (await c.query(
          `INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, unit, direction, rule_version, achieved_on, evidence_ref, client_key, metric_version_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'recorded',$8,$9,$10,coalesce($11::date, current_date),$12,$13,$14) RETURNING *`,
          [target, sport.id, i.metric, i.value, i.points ?? 0, user.id, prov, rule.unit, rule.direction, rule.version, i.achieved_on ?? null, i.evidence_ref ?? null, i.client_key ?? null, rule.version_id])).rows[0];
        return withLabel(row);
      }
      // ---- competition result
      let fx = null, eventId = i.event_id;
      if (i.fixture_id) {
        fx = await mustFind('fixtures', i.fixture_id, '*', c);
        if (eventId && eventId !== fx.event_id) throw unprocessable('That game belongs to a different event');
        eventId = fx.event_id;
      }
      const ev = await mustFind('events', eventId, '*', c);
      if (!(await mayOfficiate(c, user, { event_id: ev.id, fixture_id: fx?.id ?? null }))) throw forbidden('Only the event organiser, its officials or an admin can submit a competition result');
      if (!(await eventSportOk(c, ev, sport))) throw unprocessable(`This event is not a ${sport.name} event`);
      await checkParticipation(c, target, ev, fx);
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`perf:${target}:${fx?.id ?? ev.id}:${i.metric}`]);
      if (fx) {
        const clash = (await c.query("SELECT id FROM performances WHERE user_id=$1 AND fixture_id=$2 AND metric=$3 AND provenance='approved_competition' AND status IN ('submitted','approved','disputed')", [target, fx.id, i.metric])).rows[0];
        if (clash) throw conflict('A result for this athlete and metric already exists for that game. Correct it instead of submitting another.', { performance_id: clash.id });
      } else {
        // Event-only results (no game): several attempts are valid (the leaderboard keeps the best), but the same figure on the same day is a double entry.
        const same = (await c.query("SELECT id FROM performances WHERE user_id=$1 AND event_id=$2 AND fixture_id IS NULL AND metric=$3 AND value=$4 AND achieved_on=coalesce($5::date, current_date) AND provenance='approved_competition' AND status IN ('submitted','approved','disputed')", [target, ev.id, i.metric, i.value, i.achieved_on ?? null])).rows[0];
        if (same) throw conflict('The same result for this athlete, event, metric, value and date already exists. If this is a different attempt, change the value or the date.', { performance_id: same.id });
      }
      const row = (await c.query(
        `INSERT INTO performances(user_id, sport_id, event_id, fixture_id, metric, value, points, recorded_by, provenance, status, unit, direction, rule_version, official_points, achieved_on, evidence_ref, client_key, metric_version_id)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,'approved_competition','submitted',$8,$9,$10,$11,coalesce($12::date, current_date),$13,$14,$15) RETURNING *`,
        [target, sport.id, ev.id, fx?.id ?? null, i.metric, i.value, user.id, rule.unit, rule.direction, rule.version, officialPoints(rule, i.value), i.achieved_on ?? null, i.evidence_ref ?? null, i.client_key ?? null, rule.version_id])).rows[0];
      await logStep(c, row.id, user.id, 'submitted', null, 'submitted', null, { value: row.value, official_points: row.official_points });
      return withLabel(row);
    });
  },
});

/** Shared by approve / reject / dispute / correct: lock the row, check the transition and who is acting. */
async function transition(user, perfId, { from, to, action, note, needOfficial = true, needNote = false, mutate }) {
  const result = await transitionTx(user, perfId, { from, to, action, note, needOfficial, needNote, mutate });
  if (['approved', 'rejected', 'disputed'].includes(result.status)) onResultsChanged(result.sport_id); // a changed result re-runs the rankings; earlier snapshots are kept
  return result;
}
async function transitionTx(user, perfId, { from, to, action, note, needOfficial, needNote, mutate }) {
  return tx(async (c) => {
    const perf = (await c.query('SELECT * FROM performances WHERE id=$1 FOR UPDATE', [perfId])).rows[0];
    if (!perf || perf.provenance !== 'approved_competition') throw notFound('Competition result');
    if (needNote && !note) throw unprocessable('Please give a reason');
    const official = await mayOfficiate(c, user, perf);
    if (needOfficial && !official) throw forbidden('Only the event organiser, its officials or an admin can do that');
    if (!from.includes(perf.status)) throw conflict(`This result is ${perf.status}, so it cannot be ${to}`);
    const out = await mutate(c, perf, official);
    await logStep(c, perf.id, user.id, action, perf.status, out.status, note, { value: perf.value, official_points: perf.official_points });
    return withLabel(out);
  });
}

cap({
  name: 'approve_performance', method: 'POST', path: '/performances/:id/approve', tag: TAG_PERF,
  summary: 'Approve a submitted (or disputed) competition result so it counts in official rankings. The approver must be the event organiser, the game’s referee or an admin, and cannot be the person who submitted it or the athlete it is about. Approving a correction retires the result it replaces.',
  input: z.object({ id, note: z.string().max(500).optional() }),
  handler: ({ user }, i) => transition(user, i.id, {
    from: ['submitted', 'disputed'], to: 'approved', action: 'approved', note: i.note,
    async mutate(c, perf) {
      if (perf.recorded_by === user.id) throw forbidden('A different official must approve a result you submitted');
      if (perf.user_id === user.id) throw forbidden('You cannot approve your own result');
      const row = (await c.query("UPDATE performances SET status='approved', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1 RETURNING *", [perf.id, user.id, i.note ?? null])).rows[0];
      if (perf.supersedes_id) {
        const prev = (await c.query("SELECT status FROM performances WHERE id=$1 AND status IN ('approved','disputed') FOR UPDATE", [perf.supersedes_id])).rows[0];
        if (prev) {
          await c.query("UPDATE performances SET status='superseded' WHERE id=$1", [perf.supersedes_id]);
          await logStep(c, perf.supersedes_id, user.id, 'superseded', prev.status, 'superseded', `Replaced by ${perf.id}`, null);
        }
      }
      return row;
    },
  }),
});

cap({
  name: 'reject_performance', method: 'POST', path: '/performances/:id/reject', tag: TAG_PERF,
  summary: 'Reject a submitted or disputed competition result with a reason; it stays on record but never counts. Same people and separation of duties as approval: not the person who submitted it and not the athlete.',
  input: z.object({ id, reason: z.string().min(3).max(500) }),
  handler: ({ user }, i) => transition(user, i.id, {
    from: ['submitted', 'disputed'], to: 'rejected', action: 'rejected', note: i.reason, needNote: true,
    async mutate(c, perf) {
      if (perf.recorded_by === user.id) throw forbidden('A different official must reject a result you submitted');
      if (perf.user_id === user.id) throw forbidden('You cannot decide your own result');
      return (await c.query("UPDATE performances SET status='rejected', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1 RETURNING *", [perf.id, user.id, i.reason])).rows[0];
    },
  }),
});

cap({
  name: 'dispute_performance', method: 'POST', path: '/performances/:id/dispute', tag: TAG_PERF,
  summary: 'The athlete (or an official) flags a competition result as wrong, with a reason. It is taken out of the official standings until an official approves it again, rejects it, or corrects it, and the event organiser and officials are notified (it also appears in list_performances status=disputed). An athlete can dispute a given result once; a second dispute is a 409.',
  input: z.object({ id, reason: z.string().min(5).max(1000) }),
  handler: ({ user }, i) => transition(user, i.id, {
    from: ['submitted', 'approved'], to: 'disputed', action: 'disputed', note: i.reason, needOfficial: false, needNote: true,
    async mutate(c, perf, official) {
      if (!official && perf.user_id !== user.id) throw forbidden('Only the athlete or an official can dispute this result');
      if (!official) {
        // An athlete gets one dispute per result: it cannot be pulled out of the standings again and again once an official has looked at it.
        const used = (await c.query("SELECT 1 FROM performance_log WHERE performance_id=$1 AND action='disputed' LIMIT 1", [perf.id])).rows[0];
        if (used) throw conflict('This result was already disputed and reviewed. Ask the event organiser to correct it if it is still wrong.');
      }
      const row = (await c.query("UPDATE performances SET status='disputed', decision_note=$2 WHERE id=$1 RETURNING *", [perf.id, i.reason])).rows[0];
      const ev = perf.event_id ? (await c.query('SELECT name FROM events WHERE id=$1', [perf.event_id])).rows[0] : null;
      for (const uid of new Set(await officialsOf(c, perf))) {
        if (uid === user.id) continue;
        await notify(c, uid, { kind: 'result_disputed', title: `Result disputed${ev ? `: ${ev.name}` : ''}`, body: `A result was disputed and removed from the standings until you decide it: ${i.reason.slice(0, 150)}`, data: { performance_id: perf.id, event_id: perf.event_id } });
      }
      return row;
    },
  }),
});

cap({
  name: 'correct_performance', method: 'POST', path: '/performances/:id/correct', tag: TAG_PERF, status: 201,
  summary: 'Submit a corrected value for an approved or disputed result. The original stays on record and keeps counting until a different official approves the correction, which then supersedes it.',
  input: z.object({ id, value: z.number(), reason: z.string().min(5).max(500) }),
  handler: ({ user }, i) => transition(user, i.id, {
    from: ['approved', 'disputed'], to: 'corrected', action: 'corrected', note: i.reason, needNote: true,
    async mutate(c, perf) {
      const sport = (await c.query('SELECT * FROM sports WHERE id=$1', [perf.sport_id])).rows[0];
      // a correction is judged under the rule the original was scored with, not whatever is in force today
      const rule = perf.metric_version_id ? await ruleOfVersion(perf.metric_version_id, c) : builtinRule(sport, perf.metric);
      const bad = validateValue(rule, i.value);
      if (bad) throw unprocessable(bad);
      const pending = (await c.query("SELECT id FROM performances WHERE supersedes_id=$1 AND status='submitted'", [perf.id])).rows[0];
      if (pending) throw conflict('A correction for this result is already waiting for approval', { performance_id: pending.id });
      const row = (await c.query(
        `INSERT INTO performances(user_id, sport_id, event_id, fixture_id, metric, value, points, recorded_by, provenance, status, unit, direction, rule_version, official_points, achieved_on, supersedes_id, decision_note, evidence_ref, metric_version_id)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,'approved_competition','submitted',$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [perf.user_id, perf.sport_id, perf.event_id, perf.fixture_id, perf.metric, i.value, user.id, rule.unit, rule.direction, rule.version, officialPoints(rule, i.value), perf.achieved_on, perf.id, i.reason, perf.evidence_ref, perf.metric_version_id])).rows[0];
      await logStep(c, row.id, user.id, 'submitted', null, 'submitted', i.reason, { value: row.value, official_points: row.official_points, supersedes: perf.id });
      return row;
    },
  }),
});

cap({
  name: 'list_performances', method: 'GET', path: '/performances', tag: TAG_PERF, auth: 'public',
  summary: 'Results with their evidence label. Anyone sees approved competition results; an athlete also sees their own practice, imports and pending results; an event organiser, its officials or an admin also sees every result for their event (use status=submitted for the approval queue).',
  input: z.object({ user_id: id.optional(), event_id: id.optional(), fixture_id: id.optional(), sport: z.string().optional(), status: z.enum(['recorded', 'submitted', 'approved', 'disputed', 'rejected', 'superseded']).optional(), provenance: z.enum(['self_reported', 'imported', 'approved_competition']).optional(), ...page }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    const rows = await many(
      `SELECT p.*, s.slug AS sport, s.emoji, u.display_name, u.handle, e.name AS event_name
         FROM performances p JOIN sports s ON s.id=p.sport_id JOIN users u ON u.id=p.user_id LEFT JOIN events e ON e.id=p.event_id
        WHERE ($1::uuid IS NULL OR p.user_id=$1) AND ($2::uuid IS NULL OR p.event_id=$2) AND ($3::uuid IS NULL OR p.fixture_id=$3) AND ($4::uuid IS NULL OR p.sport_id=$4)
          AND ($5::text IS NULL OR p.status=$5) AND ($6::text IS NULL OR p.provenance=$6)
          AND ((p.provenance='approved_competition' AND p.status='approved' AND (${NOT_YOUTH_SQL} OR p.user_id=$7))
               OR ($7::uuid IS NOT NULL AND (p.user_id=$7 OR $8 OR p.recorded_by=$7
                    OR EXISTS (SELECT 1 FROM events ev WHERE ev.id=p.event_id AND ev.organizer_id=$7)
                    OR EXISTS (SELECT 1 FROM fixtures f WHERE f.id=p.fixture_id AND f.referee_id=$7)
                    OR EXISTS (SELECT 1 FROM event_staff st WHERE st.event_id=p.event_id AND st.user_id=$7 AND st.status='accepted' AND st.role IN ('referee','umpire','judge','starter','timekeeper','scorer')))))
        ORDER BY p.recorded_at DESC, p.id LIMIT $9 OFFSET $10`,
      [i.user_id ?? null, i.event_id ?? null, i.fixture_id ?? null, sport?.id ?? null, i.status ?? null, i.provenance ?? null, user?.id ?? null, isAdmin(user) ?? false, i.limit, i.offset]);
    return rows.map(withLabel);
  },
});

cap({
  name: 'get_performance_history', method: 'GET', path: '/performances/:id/history', tag: TAG_PERF,
  summary: 'Every step a result went through (submitted, approved, disputed, corrected, superseded) with who and why. Visible to the athlete, the event’s officials and admins.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const perf = await mustFind('performances', i.id);
    const ok = isAdmin(user) || perf.user_id === user.id || perf.recorded_by === user.id || (await mayOfficiate({ query }, user, perf));
    if (!ok) throw notFound('Result');
    return many('SELECT l.id, l.action, l.from_status, l.to_status, l.note, l.snapshot, l.at, u.display_name AS actor FROM performance_log l JOIN users u ON u.id=l.actor_id WHERE l.performance_id=$1 ORDER BY l.at, l.id', [i.id]);
  },
});

cap({
  name: 'list_scoring_rules', method: 'GET', path: '/scoring-rules', tag: TAG_PERF, auth: 'public',
  summary: 'The rules (version, unit, ranking direction, allowed range, how official points are derived) for a metric in a sport, plus the documented ranking and tie-break rules. Without a metric it lists the metrics that have approved results in that sport.',
  input: z.object({ sport: z.string(), metric: z.string().min(1).max(40).optional() }),
  async handler(_, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    const base = { sport: sport.slug, ranking: RANKING_RULES, evidence_labels: EVIDENCE_LABELS };
    if (i.metric) return { ...base, metric: i.metric, rule: await resolveRule(sport, i.metric), standard: standardOf(sport, i.metric) };
    const metrics = await many("SELECT metric FROM performances WHERE sport_id=$1 AND provenance='approved_competition' AND status='approved' UNION SELECT key FROM metric_definitions WHERE sport_id=$1 AND status='published' ORDER BY metric", [sport.id]);
    return { ...base, metrics: await Promise.all(metrics.map(async (m) => ({ metric: m.metric, rule: await resolveRule(sport, m.metric) }))) };
  },
});

cap({
  name: 'get_athlete_stats', method: 'GET', path: '/people/:id/stats', tag: TAG_PERF, auth: 'public',
  summary: 'Per sport & metric: entries, best (max), lowest (min — use for time metrics) and official points, from approved competition results only. Signed in as the athlete (or an admin) it also returns your own practice and imported figures, clearly labelled and never added to the official total.',
  input: z.object({ id, sport: z.string().optional() }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    const own = !!user && (user.id === i.id || isAdmin(user));
    const rows = await many(
      `SELECT s.id AS sport_id, s.slug AS sport, s.emoji, p.metric, p.provenance, p.unit, count(*)::int AS entries, sum(p.value) AS total, max(p.value) AS best, min(p.value) AS lowest,
              avg(p.value) AS mean, (array_agg(p.value ORDER BY p.achieved_on DESC, p.recorded_at DESC))[1] AS last, min(p.direction) AS direction,
              coalesce(sum(p.official_points), 0) AS points
         FROM performances p JOIN sports s ON s.id=p.sport_id
        WHERE p.user_id=$1 AND ($2::uuid IS NULL OR p.sport_id=$2)
          AND ((p.provenance='approved_competition' AND p.status='approved') OR ($3 AND p.provenance <> 'approved_competition'))
        GROUP BY s.id, s.slug, s.emoji, p.metric, p.provenance, p.unit ORDER BY s.slug, p.metric, p.provenance`, [i.id, sport?.id ?? null, own]);
    const total = rows.filter((r) => r.provenance === 'approved_competition').reduce((a, r) => a + Number(r.points), 0);
    return { total_points: total, evidence: label('approved_competition'), by_metric: await Promise.all(rows.map(async (r) => {
      // the governed aggregation says which figure is "the" result for this metric (best, sum, mean or last)
      const aggregation = await aggregationFor(r.sport_id, r.metric);
      const aggregate = { best: r.direction === 'lower' ? r.lowest : r.best, sum: r.total, mean: r.mean, last: r.last }[aggregation];
      const { sport_id, ...rest } = r;
      return withLabel({ ...rest, aggregation, aggregate });
    })), pending_results: own ? (await one("SELECT count(*)::int AS n FROM performances WHERE user_id=$1 AND provenance='approved_competition' AND status IN ('submitted','disputed')", [i.id])).n : undefined };
  },
});

cap({
  name: 'leaderboard', method: 'GET', path: '/leaderboard', tag: TAG_PERF, auth: 'public',
  summary: 'Official leaderboard from approved competition results only — practice, imports and unapproved results never count. Without a metric: ranked by official points. With a metric: ranked by best value in the sport’s direction (lowest wins for times). Filter by sport, event, sport category and season (year). Ranks are shared only when every tie-break is equal; paging is deterministic.',
  input: z.object({ sport: z.string().optional(), event_id: id.optional(), metric: z.string().optional(), category: z.string().max(40).optional(), season: z.coerce.number().int().min(1900).max(2200).optional(), ...page }),
  async handler(_, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    const filter = `p.provenance='approved_competition' AND p.status='approved' AND ${NOT_YOUTH_SQL}
        AND ($1::uuid IS NULL OR p.sport_id=$1) AND ($2::uuid IS NULL OR p.event_id=$2) AND ($3::text IS NULL OR p.metric=$3)
        AND ($4::text IS NULL OR s.category=$4) AND ($5::int IS NULL OR extract(year FROM p.achieved_on)=$5)`;
    const args = [sport?.id ?? null, i.event_id ?? null, i.metric ?? null, i.category ?? null, i.season ?? null];
    let direction = 'higher';
    if (i.metric) {
      const dirs = (await many(`SELECT DISTINCT p.direction FROM performances p JOIN users u ON u.id=p.user_id JOIN sports s ON s.id=p.sport_id WHERE ${filter} AND p.direction IS NOT NULL`, args)).map((r) => r.direction);
      if (dirs.length > 1) throw badRequest('That metric is ranked differently in different sports — pick a sport');
      direction = dirs[0] ?? 'higher';
    }
    // governed aggregation: best (default), sum, mean or last — one definition per sport, so a mixed set cannot be ranked together
    let aggregation = 'best';
    if (i.metric) {
      const sportIds = (await many(`SELECT DISTINCT p.sport_id FROM performances p JOIN users u ON u.id=p.user_id JOIN sports s ON s.id=p.sport_id WHERE ${filter}`, args)).map((r) => r.sport_id);
      const aggs = [...new Set(await Promise.all(sportIds.map((sid) => aggregationFor(sid, i.metric))))];
      if (aggs.length > 1) throw badRequest('That metric is aggregated differently in different sports — pick a sport');
      aggregation = aggs[0] ?? 'best';
    }
    const best = { best: direction === 'lower' ? 'min(p.value)' : 'max(p.value)', sum: 'sum(p.value)', mean: 'avg(p.value)', last: '(array_agg(p.value ORDER BY p.achieved_on DESC, p.recorded_at DESC))[1]' }[aggregation];
    const bestOrder = direction === 'lower' ? 'best ASC' : 'best DESC';
    const keys = i.metric ? `${bestOrder}, first_on ASC, points DESC` : 'points DESC, entries DESC, first_approved ASC';
    const rankKeys = i.metric ? `${bestOrder}, first_on ASC, points DESC` : 'points DESC, entries DESC, first_approved ASC';
    const rows = await many(
      `WITH base AS (
         SELECT u.id AS uid, ${best} AS best, count(*)::int AS entries, sum(p.official_points) AS total_points, min(p.decided_at) AS first_approved
           FROM performances p JOIN users u ON u.id=p.user_id JOIN sports s ON s.id=p.sport_id WHERE ${filter} GROUP BY u.id),
       at_best AS (
         SELECT u.id AS uid, coalesce(min(p.achieved_on) FILTER (WHERE p.value=b.best), min(p.achieved_on)) AS first_on, coalesce(max(p.official_points) FILTER (WHERE p.value=b.best), max(p.official_points)) AS best_points
           FROM performances p JOIN users u ON u.id=p.user_id JOIN sports s ON s.id=p.sport_id JOIN base b ON b.uid=u.id WHERE ${filter} GROUP BY u.id),
       agg AS (
         SELECT b.uid, ${i.metric ? 'a.best_points' : 'b.total_points'} AS points, b.best, b.entries, a.first_on, b.first_approved FROM base b JOIN at_best a ON a.uid=b.uid),
       ranked AS (SELECT agg.*, rank() OVER (ORDER BY ${rankKeys}) AS rank FROM agg)
       SELECT ${PUBLIC_USER}, r.rank::int AS rank, r.points, r.best, r.entries, r.first_on AS best_on, 'Approved competition result' AS evidence_label
         FROM ranked r JOIN users u ON u.id=r.uid ORDER BY r.rank, ${keys}, u.id LIMIT $6 OFFSET $7`, [...args, i.limit, i.offset]);
    return rows.map((r) => ({ ...r, ranking: i.metric ? (direction === 'lower' ? 'lower_is_better' : 'higher_is_better') : 'official_points', ...(i.metric ? { aggregation } : {}) }));
  },
});

cap({
  name: 'grant_award', method: 'POST', path: '/awards', tag: 'Scores & Awards', status: 201,
  summary: 'Give a cup, trophy, medal, MVP or badge to an athlete or team (event organiser, or admin for non-event awards).',
  input: z.object({ name: z.string().min(2).max(100), kind: z.enum(['cup', 'trophy', 'medal_gold', 'medal_silver', 'medal_bronze', 'mvp', 'badge']), event_id: id.optional(), user_id: id.optional(), team_id: id.optional(), note: z.string().max(300).optional() }),
  async handler({ user }, i) {
    if (!i.user_id && !i.team_id) throw forbidden('Specify user_id or team_id');
    if (i.event_id) {
      const ev = await mustFind('events', i.event_id);
      if (!isAdmin(user) && ev.organizer_id !== user.id) throw forbidden('Only the event organiser can grant awards');
    } else if (!isAdmin(user)) throw forbidden('Awards outside an event are admin-only');
    return one('INSERT INTO awards(name, kind, event_id, user_id, team_id, note, awarded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [i.name, i.kind, i.event_id ?? null, i.user_id ?? null, i.team_id ?? null, i.note, user.id]);
  },
});

cap({
  name: 'list_awards', method: 'GET', path: '/awards', tag: 'Scores & Awards', auth: 'public', summary: 'Trophy cabinet for an athlete, team or event.',
  input: z.object({ user_id: id.optional(), team_id: id.optional(), event_id: id.optional(), ...page }),
  handler: (_, i) => many(
    `SELECT a.*, e.name AS event_name, t.name AS team_name, u.display_name FROM awards a LEFT JOIN events e ON e.id=a.event_id LEFT JOIN teams t ON t.id=a.team_id LEFT JOIN users u ON u.id=a.user_id
      WHERE ($1::uuid IS NULL OR a.user_id=$1) AND ($2::uuid IS NULL OR a.team_id=$2) AND ($3::uuid IS NULL OR a.event_id=$3) ORDER BY a.awarded_at DESC LIMIT $4 OFFSET $5`,
    [i.user_id ?? null, i.team_id ?? null, i.event_id ?? null, i.limit, i.offset]),
});
