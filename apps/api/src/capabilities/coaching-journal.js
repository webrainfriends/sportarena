import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { hiddenYouth, relationships, requireRelationship } from '../coaching.js';
import { canSeeYouth, isYouth } from '../youth.js';
import { canCoachTeam } from './teams.js';

// Coaching journal (issue #269, slice 1): a session record over a canonical source, attendance, structured observations with explicit
// visibility, and a longitudinal timeline. Nothing here is medical data and nothing here edits a booking, plan, score or match event.
const TAG = 'Coaching journal';
const COACH = ['coach'];
const BLOCK_KINDS = ['arrival', 'warm_up', 'skill_drill', 'tactical_drill', 'conditioned_game', 'match_play', 'conditioning', 'recovery', 'review', 'custom'];
const ATTENDANCE = ['expected', 'present', 'late', 'left_early', 'absent', 'excused'];
const OBS_TYPES = ['strength', 'progress', 'development_area', 'tactical', 'technical', 'teamwork', 'behaviour', 'goal_evidence', 'follow_up', 'general'];
const VISIBILITY = ['coach_private', 'staff', 'player', 'team'];
const BLOCK_STATUS = ['completed', 'skipped', 'modified'];
const text = (n) => z.string().trim().max(n);

const block = z.object({
  id: z.string().max(60).optional().describe('keep the id of an existing block when re-saving; omit for a new block'),
  kind: z.enum(BLOCK_KINDS),
  title: text(120).min(2),
  objective: text(500).optional(),
  duration_min: z.number().int().min(1).max(240).optional(),
  instructions: text(2000).optional(),
  setup: text(500).optional(),
  cues: z.array(text(200)).max(10).default([]),
  success_criteria: text(500).optional(),
  target_rpe: z.number().int().min(1).max(10).optional().describe('non-clinical perceived-effort target'),
  tags: z.array(text(60)).max(10).default([]),
  scope: z.array(id).max(60).optional().describe('athlete ids this block is for; omit for everyone'),
  coach_notes: text(1000).optional().describe('shown only to the coach, never shared'),
});

const activeCoachOf = (uid, teamId) => one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active' AND role='coach'", [teamId, uid]);

async function teamPlayers(user, teamId) {
  const rows = await many("SELECT user_id FROM team_members WHERE team_id=$1 AND status='active' AND role IN ('player','captain') AND user_id <> $2 ORDER BY user_id", [teamId, user.id]);
  const hidden = isAdmin(user) ? new Set() : await hiddenYouth(user, rows.map((r) => r.user_id));
  return rows.map((r) => r.user_id).filter((x) => !hidden.has(x));
}

export async function requireTeam(user, teamId) {
  const team = await one('SELECT * FROM teams WHERE id=$1', [teamId]);
  if (!team) throw notFound('Team');
  if (!(await canCoachTeam(user, team))) throw forbidden('You do not coach this team');
  return team;
}

/** Resolve the canonical source the coach may run a session for; the server decides access, never the client-supplied id. */
async function resolveSource(user, i) {
  if (i.source_type === 'training_session') {
    const s = await one(`SELECT x.id, x.title, x.starts_at, p.athlete_id, p.sport_id FROM training_sessions x JOIN training_plans p ON p.id=x.plan_id WHERE x.id=$1 AND p.coach_id=$2`, [i.source_id, user.id]);
    if (!s) throw notFound('Training session');
    return { title: s.title, scheduled_at: s.starts_at, sport_id: s.sport_id, team_id: null, athletes: [s.athlete_id] };
  }
  if (i.source_type === 'coach_hire') {
    const h = await one("SELECT * FROM coach_hires WHERE id=$1 AND coach_id=$2 AND status IN ('confirmed','completed')", [i.source_id, user.id]);
    if (!h) throw notFound('Coaching hire');
    const athletes = h.audience === 'team' && h.team_id ? await teamPlayers(user, h.team_id) : [h.hirer_id];
    return { title: i.title ?? 'Coaching session', scheduled_at: h.starts_at, sport_id: h.sport_id, team_id: h.audience === 'team' ? h.team_id : null, athletes };
  }
  if (i.source_type === 'fixture') {
    const f = await one(`SELECT f.*, e.sport_id, h.name AS home_name, a.name AS away_name FROM fixtures f JOIN events e ON e.id=f.event_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id=$1`, [i.source_id]);
    if (!f) throw notFound('Fixture');
    const teamId = [f.home_team_id, f.away_team_id].find((t) => t && t === i.team_id);
    if (!teamId) throw badRequest('team_id must be one of the fixture\'s teams');
    await requireTeam(user, teamId);
    return { title: i.title ?? `${f.home_name ?? 'TBC'} v ${f.away_name ?? 'TBC'}`, scheduled_at: f.scheduled_at, sport_id: f.sport_id, team_id: teamId, athletes: await teamPlayers(user, teamId) };
  }
  if (!i.team_id) throw badRequest('team_id is required for a team session');
  const team = await requireTeam(user, i.team_id);
  if (!i.title) throw badRequest('title is required for a team session');
  return { title: i.title, scheduled_at: i.scheduled_at ?? null, sport_id: team.sport_id, team_id: team.id, athletes: await teamPlayers(user, team.id) };
}

export async function ownRecord(user, recordId, client) {
  const q = client ? (t, p) => client.query(t, p).then((r) => r.rows[0] ?? null) : one;
  const r = await q(`SELECT * FROM coaching_session_records WHERE id=$1${client ? ' FOR UPDATE' : ''}`, [recordId]);
  if (!r || (r.coach_id !== user.id && !isAdmin(user))) throw notFound('Coaching session');
  return r;
}

const withIds = (blocks) => blocks.map((b) => ({ ...b, id: b.id ?? randomUUID() }));

cap({
  name: 'create_coaching_session', method: 'POST', path: '/coaching/sessions', tag: TAG, auth: COACH, status: 201,
  summary: 'Open the coaching record for a session or match you run. It links to the canonical source (plan session, hire, fixture) and never creates a booking; one team session has one record with many participants. Repeating the call returns the same record.',
  input: z.object({
    source_type: z.enum(['training_session', 'coach_hire', 'fixture', 'team_session']),
    source_id: z.string().max(80).describe('id of the plan session / hire / fixture; for team_session a client-generated uuid makes retries idempotent'),
    team_id: id.optional().describe('required for fixture and team_session'),
    title: text(120).min(2).optional(), objective: text(1000).optional(),
    scheduled_at: z.string().datetime({ offset: true }).optional().describe('team_session only; other sources use their own time'),
  }),
  async handler({ user }, i) {
    if (i.source_type === 'team_session' && !z.string().uuid().safeParse(i.source_id).success) throw badRequest('source_id must be a uuid for a team session');
    const existing = await one('SELECT id FROM coaching_session_records WHERE coach_id=$1 AND source_type=$2 AND source_id=$3', [user.id, i.source_type, i.source_id]);
    if (existing) return one('SELECT * FROM coaching_session_records WHERE id=$1', [existing.id]);
    const src = await resolveSource(user, i);
    return tx(async (c) => {
      const rec = (await c.query(
        `INSERT INTO coaching_session_records(coach_id, sport_id, team_id, source_type, source_id, title, objective, scheduled_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (coach_id, source_type, source_id) DO UPDATE SET updated_at=coaching_session_records.updated_at RETURNING *`,
        [user.id, src.sport_id, src.team_id, i.source_type, i.source_id, i.title ?? src.title, i.objective, src.scheduled_at])).rows[0];
      for (const a of src.athletes) await c.query('INSERT INTO coaching_session_participants(session_record_id, athlete_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rec.id, a]);
      return rec;
    });
  },
});

cap({
  name: 'get_coaching_session_workspace', method: 'GET', path: '/coaching/sessions/:id', tag: TAG, auth: COACH,
  summary: 'Everything a coach needs to run or review one session: objective, plan (and the version it started with), participants with attendance, block progress, what you noted last time and follow-ups still open.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const rec = await ownRecord(user, i.id);
    const [plan, atStart, participants, observations, previous, open_actions] = await Promise.all([
      one('SELECT version, blocks, created_at FROM coaching_session_plan_versions WHERE session_record_id=$1 AND version=$2', [rec.id, rec.plan_version]),
      rec.started_plan_version == null ? null : one('SELECT version, blocks, created_at FROM coaching_session_plan_versions WHERE session_record_id=$1 AND version=$2', [rec.id, rec.started_plan_version]),
      many(`SELECT ${PUBLIC_USER}, p.attendance, p.arrived_at, p.left_at, p.focus FROM coaching_session_participants p JOIN users u ON u.id=p.athlete_id WHERE p.session_record_id=$1 ORDER BY u.display_name, u.id`, [rec.id]),
      many('SELECT * FROM coaching_observations WHERE session_record_id=$1 AND coach_id=$2 ORDER BY observed_at, id', [rec.id, rec.coach_id]),
      many(`SELECT o.id, o.athlete_id, o.note, o.obs_type, o.skill_tag, o.follow_up, o.observed_at, o.visibility FROM (SELECT athlete_id FROM coaching_session_participants WHERE session_record_id=$1) pp
              CROSS JOIN LATERAL (SELECT * FROM coaching_observations x WHERE x.athlete_id=pp.athlete_id AND x.coach_id=$2 AND x.session_record_id IS DISTINCT FROM $1 AND (x.follow_up OR x.observed_at > now() - interval '60 days') ORDER BY x.follow_up DESC, x.observed_at DESC, x.id LIMIT 3) o`, [rec.id, rec.coach_id]),
      many(`SELECT a.id, a.title, a.athlete_id, a.team_id, a.due_at, a.status, a.priority, a.follow_up_next_session FROM coaching_actions a
             WHERE a.coach_id=$1 AND a.status IN ('open','in_progress') AND (a.athlete_id IN (SELECT athlete_id FROM coaching_session_participants WHERE session_record_id=$2) OR a.team_id IS NOT DISTINCT FROM $3)
             ORDER BY a.follow_up_next_session DESC, a.due_at NULLS LAST, a.id LIMIT 50`, [rec.coach_id, rec.id, rec.team_id]),
    ]);
    return { session: rec, plan: plan ?? { version: 0, blocks: [] }, plan_at_start: atStart, block_log: rec.block_log, participants, observations, previous_notes: previous, open_actions };
  },
});

cap({
  name: 'save_coaching_session_plan', method: 'POST', path: '/coaching/sessions/:id/plan', tag: TAG, auth: COACH,
  summary: 'Save the ordered blocks for a session as a new plan version. Earlier versions are kept, so the plan a session started with stays readable; a completed session is frozen.',
  input: z.object({ id, blocks: z.array(block).max(30), objective: text(1000).optional(), expected_version: z.number().int().min(0).optional().describe('plan version you loaded; a different current version is a conflict') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const rec = await ownRecord(user, i.id, c);
      if (rec.status === 'completed') throw conflict('A completed session\'s plan cannot be changed');
      if (i.expected_version != null && i.expected_version !== rec.plan_version) throw conflict('The plan changed since you loaded it');
      const version = rec.plan_version + 1;
      const blocks = withIds(i.blocks);
      await c.query('INSERT INTO coaching_session_plan_versions(session_record_id, version, blocks, saved_by) VALUES ($1,$2,$3,$4)', [rec.id, version, JSON.stringify(blocks), user.id]);
      const upd = (await c.query('UPDATE coaching_session_records SET plan_version=$2, objective=coalesce($3, objective), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [rec.id, version, i.objective])).rows[0];
      return { session: upd, plan: { version, blocks } };
    });
  },
});

cap({
  name: 'start_coaching_session', method: 'POST', path: '/coaching/sessions/:id/start', tag: TAG, auth: COACH,
  summary: 'Start the execution record. Remembers which plan version is being run. Repeating it keeps the original start time.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const rec = await ownRecord(user, i.id, c);
      if (rec.status === 'completed') throw conflict('This session is already completed');
      if (rec.status === 'running') return rec;
      return (await c.query("UPDATE coaching_session_records SET status='running', started_at=now(), started_plan_version=plan_version, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [rec.id])).rows[0];
    });
  },
});

cap({
  name: 'mark_coaching_session_block', method: 'POST', path: '/coaching/sessions/:id/blocks/:block_id', tag: TAG, auth: COACH,
  summary: 'Mark a planned block completed, skipped or modified while running the session. Progress is stored apart from the plan, so the plan version is untouched.',
  input: z.object({ id, block_id: z.string().max(60), status: z.enum(BLOCK_STATUS) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const rec = await ownRecord(user, i.id, c);
      if (rec.status !== 'running') throw conflict('Start the session first');
      const plan = (await c.query('SELECT blocks FROM coaching_session_plan_versions WHERE session_record_id=$1 AND version=$2', [rec.id, rec.plan_version])).rows[0];
      if (!plan?.blocks.some((b) => b.id === i.block_id)) throw notFound('Block');
      const log = { ...rec.block_log, [i.block_id]: { status: i.status, at: new Date().toISOString() } };
      await c.query('UPDATE coaching_session_records SET block_log=$2, updated_at=now() WHERE id=$1', [rec.id, JSON.stringify(log)]);
      return { block_log: log };
    });
  },
});

cap({
  name: 'record_session_attendance', method: 'POST', path: '/coaching/sessions/:id/attendance', tag: TAG, auth: COACH,
  summary: 'Set attendance (and an optional per-player focus) for participants of one session record. Idempotent: sending the same entries again changes nothing. Only people already on the session\'s roster can be recorded.',
  input: z.object({ id, entries: z.array(z.object({ athlete_id: id, attendance: z.enum(ATTENDANCE), focus: text(500).optional() })).min(1).max(100) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const rec = await ownRecord(user, i.id, c);
      for (const e of i.entries) {
        const r = await c.query(
          `UPDATE coaching_session_participants SET attendance=$3, focus=coalesce($4, focus), updated_at=now(),
                  arrived_at = CASE WHEN $3 IN ('present','late','left_early') THEN coalesce(arrived_at, now()) ELSE NULL END,
                  left_at = CASE WHEN $3='left_early' THEN coalesce(left_at, now()) ELSE NULL END
            WHERE session_record_id=$1 AND athlete_id=$2 RETURNING athlete_id`, [rec.id, e.athlete_id, e.attendance, e.focus]);
        if (!r.rows.length) throw badRequest('That person is not on this session\'s roster');
      }
      return (await c.query(`SELECT ${PUBLIC_USER}, p.attendance, p.arrived_at, p.left_at, p.focus FROM coaching_session_participants p JOIN users u ON u.id=p.athlete_id WHERE p.session_record_id=$1 ORDER BY u.display_name, u.id`, [rec.id])).rows;
    });
  },
});

cap({
  name: 'complete_coaching_session', method: 'POST', path: '/coaching/sessions/:id/complete', tag: TAG, auth: COACH,
  summary: 'End the session and file the review: a team summary (shareable) and a private summary. People never marked are reported as not recorded, not as absent. Repeating it on a completed session changes nothing.',
  input: z.object({ id, team_summary: text(4000).optional(), private_summary: text(4000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const rec = await ownRecord(user, i.id, c);
      if (rec.status === 'completed') return rec;
      const done = (await c.query(
        `UPDATE coaching_session_records SET status='completed', ended_at=now(), started_at=coalesce(started_at, now()), team_summary=$2, private_summary=$3, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [rec.id, i.team_summary ?? null, i.private_summary ?? null])).rows[0];
      const not_recorded = (await c.query("SELECT count(*)::int AS n FROM coaching_session_participants WHERE session_record_id=$1 AND attendance='expected'", [rec.id])).rows[0].n;
      return { ...done, not_recorded };
    });
  },
});

const obsBody = {
  obs_type: z.enum(OBS_TYPES).default('general'),
  skill_tag: text(60).min(1).optional(),
  note: text(2000).min(1).describe('coaching observation only - no diagnoses, treatment or medication'),
  visibility: z.enum(VISIBILITY).default('coach_private'),
  follow_up: z.boolean().default(false),
};

cap({
  name: 'create_coaching_observation', method: 'POST', path: '/coaching/observations', tag: TAG, auth: COACH, status: 201,
  summary: 'Record a structured observation about an athlete you actively coach, or about a team you coach. Visibility is explicit: coach_private (default), staff (the team\'s coaches), player (that athlete) or team (the team, team-level notes only). A client_key makes retries safe.',
  input: z.object({
    athlete_id: id.optional(), team_id: id.optional(), session_record_id: id.optional(), block_ref: z.string().max(60).optional(),
    sport: z.string().optional(), observed_at: z.string().datetime({ offset: true }).optional(),
    client_key: z.string().min(8).max(80).optional().describe('idempotency key generated on the device'),
    rubric_id: id.optional(), dimension_key: z.string().max(40).optional(), score: z.number().optional().describe('score on the rubric dimension\'s own scale; the rubric version is recorded with it'),
    ...obsBody,
  }),
  async handler({ user }, i) {
    if (!i.athlete_id && !i.team_id) throw badRequest('Name an athlete or a team');
    if (i.visibility === 'player' && !i.athlete_id) throw badRequest('player visibility needs an athlete');
    if (i.visibility === 'team' && (i.athlete_id || !i.team_id)) throw badRequest('team visibility is for team-level notes only');
    if (i.visibility === 'staff' && !i.team_id) throw badRequest('staff visibility needs the team whose coaches may read it');
    let rec = null;
    if (i.session_record_id) {
      rec = await ownRecord(user, i.session_record_id);
      if (i.athlete_id && !(await one('SELECT 1 FROM coaching_session_participants WHERE session_record_id=$1 AND athlete_id=$2', [rec.id, i.athlete_id]))) throw badRequest('That athlete is not on this session');
      if (i.team_id && i.team_id !== rec.team_id) throw badRequest('That team is not this session\'s team');
    }
    if (i.client_key) {
      const dup = await one('SELECT * FROM coaching_observations WHERE coach_id=$1 AND client_key=$2', [user.id, i.client_key]);
      if (dup) return dup;
    }
    if (!!i.rubric_id !== (i.score !== undefined) || !!i.rubric_id !== !!i.dimension_key) throw badRequest('rubric_id, dimension_key and score go together');
    let rubricVersion = null;
    if (i.rubric_id) {
      const v = await one('SELECT v.version, v.dimensions FROM coaching_rubrics r JOIN coaching_rubric_versions v ON v.rubric_id=r.id WHERE r.id=$1 AND r.coach_id=$2 AND r.archived_at IS NULL ORDER BY v.version DESC LIMIT 1', [i.rubric_id, user.id]);
      if (!v) throw notFound('Rubric');
      const d = v.dimensions.find((x) => x.key === i.dimension_key);
      if (!d) throw badRequest('Unknown rubric dimension');
      if (i.score < d.scale_min || i.score > d.scale_max) throw badRequest(`Score must be between ${d.scale_min} and ${d.scale_max} for this dimension`);
      rubricVersion = v.version;
    }
    let sportId = rec?.sport_id ?? null;
    if (i.athlete_id) {
      const rels = await requireRelationship(user, i.athlete_id);
      sportId ??= rels[0].sport_id;
      if (i.team_id && !(await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [i.team_id, i.athlete_id]))) throw badRequest('That athlete is not on this team');
    }
    if (i.team_id) {
      const team = await requireTeam(user, i.team_id);
      sportId ??= team.sport_id;
    }
    if (i.sport) sportId = (await sportBySlugOrId(i.sport))?.id ?? sportId;
    const row = await one(
      `INSERT INTO coaching_observations(coach_id, athlete_id, team_id, sport_id, session_record_id, block_ref, obs_type, skill_tag, note, visibility, follow_up, observed_at, client_key, rubric_id, rubric_version, dimension_key, score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12, now()),$13,$14,$15,$16,$17) ON CONFLICT (coach_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING *`,
      [user.id, i.athlete_id ?? null, i.team_id ?? null, sportId, rec?.id ?? null, i.block_ref ?? null, i.obs_type, i.skill_tag ?? null, i.note, i.visibility, i.follow_up, i.observed_at ?? null, i.client_key ?? null, i.rubric_id ?? null, rubricVersion, i.dimension_key ?? null, i.score ?? null]);
    return row ?? one('SELECT * FROM coaching_observations WHERE coach_id=$1 AND client_key=$2', [user.id, i.client_key]);
  },
});

cap({
  name: 'update_coaching_observation', method: 'PATCH', path: '/coaching/observations/:id', tag: TAG, auth: COACH,
  summary: 'Edit your own observation. You must send the row_version you loaded; a stale edit is refused (409). The previous text is kept in the revision history. Only the author can edit, and only while the coaching relationship is current.',
  input: z.object({ id, row_version: z.number().int().min(1), obs_type: z.enum(OBS_TYPES).optional(), skill_tag: text(60).min(1).nullable().optional(), note: text(2000).min(1).optional(), visibility: z.enum(VISIBILITY).optional(), follow_up: z.boolean().optional() }),
  async handler({ user }, i) {
    const cur = await one('SELECT * FROM coaching_observations WHERE id=$1 AND coach_id=$2', [i.id, user.id]);
    if (!cur) throw notFound('Observation');
    if (cur.athlete_id) await requireRelationship(user, cur.athlete_id);
    else await requireTeam(user, cur.team_id);
    const next = { ...cur, ...Object.fromEntries(['obs_type', 'skill_tag', 'note', 'visibility', 'follow_up'].filter((k) => i[k] !== undefined).map((k) => [k, i[k]])) };
    if (next.visibility === 'player' && !next.athlete_id) throw badRequest('player visibility needs an athlete');
    if (next.visibility === 'team' && (next.athlete_id || !next.team_id)) throw badRequest('team visibility is for team-level notes only');
    if (next.visibility === 'staff' && !next.team_id) throw badRequest('staff visibility needs a team');
    return tx(async (c) => {
      const locked = (await c.query('SELECT * FROM coaching_observations WHERE id=$1 FOR UPDATE', [cur.id])).rows[0];
      if (locked.row_version !== i.row_version) throw conflict('This note was changed elsewhere - reload it first');
      await c.query('INSERT INTO coaching_observation_revisions(observation_id, rev, note, obs_type, skill_tag, visibility, edited_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [locked.id, locked.row_version, locked.note, locked.obs_type, locked.skill_tag, locked.visibility, user.id]);
      return (await c.query('UPDATE coaching_observations SET obs_type=$2, skill_tag=$3, note=$4, visibility=$5, follow_up=$6, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *',
        [locked.id, next.obs_type, next.skill_tag, next.note, next.visibility, next.follow_up])).rows[0];
    });
  },
});

cap({
  name: 'list_coaching_observation_history', method: 'GET', path: '/coaching/observations/:id/history', tag: TAG, auth: COACH,
  summary: 'The earlier versions of one of your observations, newest first.', input: z.object({ id }),
  async handler({ user }, i) {
    if (!(await one('SELECT 1 FROM coaching_observations WHERE id=$1 AND coach_id=$2', [i.id, user.id]))) throw notFound('Observation');
    return many('SELECT rev, note, obs_type, skill_tag, visibility, created_at FROM coaching_observation_revisions WHERE observation_id=$1 ORDER BY rev DESC', [i.id]);
  },
});

const timelineFilters = z.object({
  skill_tag: text(60).optional(), obs_type: z.enum(OBS_TYPES).optional(), session_record_id: id.optional(),
  from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), ...page,
});
const obsItem = (o) => ({ kind: 'observation', source_type: 'coaching_observation', source_id: o.id, at: o.observed_at, title: o.skill_tag ?? o.obs_type, detail: o.note, visibility: o.visibility, obs_type: o.obs_type, skill_tag: o.skill_tag, follow_up: o.follow_up, edited: o.row_version > 1, athlete_id: o.athlete_id, team_id: o.team_id, session_record_id: o.session_record_id, author_id: o.coach_id, own: o.own, rubric_id: o.rubric_id, rubric_version: o.rubric_version, dimension_key: o.dimension_key, score: o.score });
const byTime = (a, b) => new Date(b.at) - new Date(a.at) || String(a.source_id).localeCompare(String(b.source_id));

/** Filters shared by both timelines; `$n` positions are supplied by the caller. */
function obsFilter(i, params) {
  let sql = '';
  if (i.skill_tag) { params.push(i.skill_tag); sql += ` AND o.skill_tag = $${params.length}`; }
  if (i.obs_type) { params.push(i.obs_type); sql += ` AND o.obs_type = $${params.length}`; }
  if (i.session_record_id) { params.push(i.session_record_id); sql += ` AND o.session_record_id = $${params.length}`; }
  if (i.from) { params.push(i.from); sql += ` AND o.observed_at >= $${params.length}`; }
  if (i.to) { params.push(i.to); sql += ` AND o.observed_at <= $${params.length}`; }
  return sql;
}

cap({
  name: 'list_player_coaching_timeline', method: 'GET', path: '/coaching/athletes/:athlete_id/timeline', tag: TAG, auth: COACH,
  summary: 'The story of one athlete under your coaching: your observations, staff-visible notes from the team\'s other coaches, session attendance and completed plan sessions - a projection over the source records, newest first. A former coach sees only what they wrote themselves.',
  input: z.object({ athlete_id: id, ...timelineFilters.shape }),
  async handler({ user }, i) {
    const rels = await relationships(user.id, i.athlete_id);
    let current = rels.length > 0;
    if (current && (await isYouth(i.athlete_id)) && !(await canSeeYouth(user, i.athlete_id))) current = false;
    const own = await one('SELECT 1 FROM coaching_observations WHERE coach_id=$1 AND athlete_id=$2 LIMIT 1', [user.id, i.athlete_id]);
    if (!current && !own && !isAdmin(user)) throw forbidden('You have no active coaching relationship with this athlete');
    const take = i.limit + i.offset;
    const params = [i.athlete_id, user.id];
    const f = obsFilter(i, params);
    const staff = current ? "OR (o.visibility='staff' AND EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=o.team_id AND m.user_id=$2 AND m.status='active' AND m.role='coach'))" : '';
    const obs = await many(`SELECT o.*, (o.coach_id=$2) AS own FROM coaching_observations o WHERE o.athlete_id=$1 AND (o.coach_id=$2 ${staff})${f} ORDER BY o.observed_at DESC, o.id LIMIT ${take}`, params);
    const plain = !i.skill_tag && !i.obs_type && !i.session_record_id;
    const [att, sessions] = plain ? await Promise.all([
      many(`SELECT r.id, r.title, r.status, coalesce(r.started_at, r.scheduled_at, r.created_at) AS at, p.attendance FROM coaching_session_participants p JOIN coaching_session_records r ON r.id=p.session_record_id
             WHERE p.athlete_id=$1 AND r.coach_id=$2 AND coalesce(r.started_at, r.scheduled_at, r.created_at) BETWEEN coalesce($3::timestamptz,'-infinity') AND coalesce($4::timestamptz,'infinity') ORDER BY at DESC, r.id LIMIT ${take}`, [i.athlete_id, user.id, i.from ?? null, i.to ?? null]),
      many(`SELECT x.id, x.title, x.completed_at AS at, x.status, x.athlete_rpe, x.target_rpe FROM training_sessions x JOIN training_plans p ON p.id=x.plan_id
             WHERE p.athlete_id=$1 AND p.coach_id=$2 AND x.status IN ('completed','skipped') AND x.completed_at BETWEEN coalesce($3::timestamptz,'-infinity') AND coalesce($4::timestamptz,'infinity') ORDER BY x.completed_at DESC, x.id LIMIT ${take}`, [i.athlete_id, user.id, i.from ?? null, i.to ?? null]),
    ]) : [[], []];
    const items = [
      ...obs.map(obsItem),
      ...att.map((a) => ({ kind: 'session', source_type: 'coaching_session_record', source_id: a.id, at: a.at, title: a.title, detail: `Attendance: ${a.attendance.replace('_', ' ')}`, attendance: a.attendance, status: a.status })),
      ...sessions.map((s) => ({ kind: 'plan_session', source_type: 'training_session', source_id: s.id, at: s.at, title: s.title, detail: s.status === 'completed' ? 'Completed (athlete-reported)' : 'Skipped (athlete-reported)', status: s.status, athlete_rpe: s.athlete_rpe, target_rpe: s.target_rpe })),
    ].sort(byTime);
    return items.slice(i.offset, i.offset + i.limit);
  },
});

cap({
  name: 'list_team_coaching_timeline', method: 'GET', path: '/coaching/teams/:team_id/timeline', tag: TAG, auth: COACH,
  summary: 'The story of a team under your coaching: team-level notes, your own and other coaches\' staff-visible player notes, and session records. Newest first.',
  input: z.object({ team_id: id, ...timelineFilters.shape }),
  async handler({ user }, i) {
    const team = await one('SELECT * FROM teams WHERE id=$1', [i.team_id]);
    if (!team) throw notFound('Team');
    const current = isAdmin(user) || (await canCoachTeam(user, team));
    if (!current && !(await one('SELECT 1 FROM coaching_observations WHERE coach_id=$1 AND team_id=$2 LIMIT 1', [user.id, team.id]))) throw forbidden('You do not coach this team');
    const take = i.limit + i.offset;
    const params = [team.id, user.id];
    const f = obsFilter(i, params);
    const staff = current ? "OR (o.visibility='staff' AND EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=o.team_id AND m.user_id=$2 AND m.status='active' AND m.role='coach'))" : '';
    const obs = await many(`SELECT o.*, (o.coach_id=$2) AS own FROM coaching_observations o WHERE o.team_id=$1 AND (o.coach_id=$2 ${staff})${f} ORDER BY o.observed_at DESC, o.id LIMIT ${take}`, params);
    const recs = (i.skill_tag || i.obs_type || i.session_record_id) ? [] : await many(
      `SELECT r.id, r.title, r.status, r.team_summary, coalesce(r.started_at, r.scheduled_at, r.created_at) AS at,
              (SELECT count(*)::int FROM coaching_session_participants p WHERE p.session_record_id=r.id AND p.attendance IN ('present','late','left_early')) AS present,
              (SELECT count(*)::int FROM coaching_session_participants p WHERE p.session_record_id=r.id) AS roster
         FROM coaching_session_records r WHERE r.team_id=$1 AND r.coach_id=$2 AND coalesce(r.started_at, r.scheduled_at, r.created_at) BETWEEN coalesce($3::timestamptz,'-infinity') AND coalesce($4::timestamptz,'infinity') ORDER BY at DESC, r.id LIMIT ${take}`, [team.id, user.id, i.from ?? null, i.to ?? null]);
    return [
      ...obs.map(obsItem),
      ...recs.map((r) => ({ kind: 'session', source_type: 'coaching_session_record', source_id: r.id, at: r.at, title: r.title, detail: r.team_summary, status: r.status, present: r.present, roster: r.roster })),
    ].sort(byTime).slice(i.offset, i.offset + i.limit);
  },
});

cap({
  name: 'get_coach_performance_home', method: 'GET', path: '/coaching/home', tag: TAG, auth: COACH,
  summary: 'Performance Studio overview: sessions to run today (each links to its canonical source), sessions running or awaiting review, and your open follow-up notes. Optional filters narrow every list.',
  input: z.object({ sport: z.string().optional(), team_id: id.optional(), athlete_id: id.optional() }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    const base = [user.id, sport?.id ?? null, i.team_id ?? null, i.athlete_id ?? null];
    const recFilter = ` AND ($2::uuid IS NULL OR r.sport_id=$2) AND ($3::uuid IS NULL OR r.team_id=$3) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM coaching_session_participants q WHERE q.session_record_id=r.id AND q.athlete_id=$4))`;
    const [running, today_records, needs_review, today_unrecorded, follow_ups, counts, overdue_actions, goals_due] = await Promise.all([
      many(`SELECT r.* FROM coaching_session_records r WHERE r.coach_id=$1 AND r.status='running'${recFilter} ORDER BY r.started_at, r.id`, base),
      many(`SELECT r.* FROM coaching_session_records r WHERE r.coach_id=$1 AND r.status='planned' AND r.scheduled_at >= current_date AND r.scheduled_at < current_date + 1${recFilter} ORDER BY r.scheduled_at, r.id`, base),
      many(`SELECT r.* FROM coaching_session_records r WHERE r.coach_id=$1 AND r.status='completed' AND r.team_summary IS NULL AND r.private_summary IS NULL AND r.ended_at > now() - interval '30 days'${recFilter} ORDER BY r.ended_at DESC, r.id LIMIT 20`, base),
      many(`SELECT 'training_session' AS source_type, x.id::text AS source_id, x.title, x.starts_at AS scheduled_at, p.athlete_id, p.sport_id, NULL::uuid AS team_id
              FROM training_sessions x JOIN training_plans p ON p.id=x.plan_id
             WHERE p.coach_id=$1 AND x.status='scheduled' AND x.starts_at >= current_date AND x.starts_at < current_date + 1 AND ($2::uuid IS NULL OR p.sport_id=$2) AND $3::uuid IS NULL AND ($4::uuid IS NULL OR p.athlete_id=$4)
               AND NOT EXISTS (SELECT 1 FROM coaching_session_records r WHERE r.coach_id=$1 AND r.source_type='training_session' AND r.source_id=x.id::text)
            UNION ALL
            SELECT 'coach_hire', h.id::text, 'Coaching session', h.starts_at, h.hirer_id, h.sport_id, h.team_id
              FROM coach_hires h WHERE h.coach_id=$1 AND h.status='confirmed' AND h.starts_at >= current_date AND h.starts_at < current_date + 1 AND ($2::uuid IS NULL OR h.sport_id=$2) AND ($3::uuid IS NULL OR h.team_id=$3) AND ($4::uuid IS NULL OR h.hirer_id=$4)
               AND NOT EXISTS (SELECT 1 FROM coaching_session_records r WHERE r.coach_id=$1 AND r.source_type='coach_hire' AND r.source_id=h.id::text)
             ORDER BY 4, 2 LIMIT 20`, base),
      many(`SELECT o.id, o.athlete_id, u.display_name AS athlete_name, o.team_id, o.note, o.skill_tag, o.obs_type, o.observed_at, o.session_record_id FROM coaching_observations o LEFT JOIN users u ON u.id=o.athlete_id
             WHERE o.coach_id=$1 AND o.follow_up AND o.observed_at > now() - interval '90 days' AND ($2::uuid IS NULL OR o.sport_id=$2) AND ($3::uuid IS NULL OR o.team_id=$3) AND ($4::uuid IS NULL OR o.athlete_id=$4) ORDER BY o.observed_at DESC, o.id LIMIT 20`, base),
      one('SELECT (SELECT count(*)::int FROM coaching_session_records WHERE coach_id=$1 AND status=\'completed\') AS sessions_completed, (SELECT count(*)::int FROM coaching_observations WHERE coach_id=$1) AS observations', [user.id]),
      many(`SELECT a.id, a.title, a.athlete_id, u.display_name AS athlete_name, a.team_id, a.due_at, a.priority FROM coaching_actions a LEFT JOIN users u ON u.id=a.athlete_id
             WHERE a.coach_id=$1 AND a.status IN ('open','in_progress') AND a.due_at < now() AND ($2::uuid IS NULL OR a.team_id IN (SELECT id FROM teams WHERE sport_id=$2) OR a.athlete_id IN (SELECT athlete_id FROM coaching_session_participants q JOIN coaching_session_records r ON r.id=q.session_record_id WHERE r.sport_id=$2)) AND ($3::uuid IS NULL OR a.team_id=$3) AND ($4::uuid IS NULL OR a.athlete_id=$4) ORDER BY a.due_at, a.id LIMIT 20`, base),
      many(`SELECT g.id, g.title, g.athlete_id, u.display_name AS athlete_name, g.team_id, g.review_on, g.status FROM coaching_goals g LEFT JOIN users u ON u.id=g.athlete_id
             WHERE g.coach_id=$1 AND g.status IN ('planned','active') AND g.review_on <= current_date + 7 AND ($2::uuid IS NULL OR g.sport_id=$2) AND ($3::uuid IS NULL OR g.team_id=$3) AND ($4::uuid IS NULL OR g.athlete_id=$4) ORDER BY g.review_on, g.id LIMIT 20`, base),
    ]);
    return {
      running, today: today_records, needs_review, to_open: today_unrecorded.map((x) => ({ ...x, link: { screen: 'CoachSession', params: { source_type: x.source_type, source_id: x.source_id } } })),
      follow_ups, overdue_actions, goals_due, counts,
    };
  },
});

cap({
  name: 'my_shared_coaching_notes', method: 'GET', path: '/me/coaching-notes', tag: TAG, auth: 'user',
  summary: 'Coaching notes a coach deliberately shared with you (player visibility) and team-level notes shared with a team you are an active member of. Private and staff-only notes are never included.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT o.id, o.obs_type, o.skill_tag, o.note, o.visibility, o.observed_at, o.team_id, u.display_name AS coach_name
       FROM coaching_observations o JOIN users u ON u.id=o.coach_id
      WHERE (o.visibility='player' AND o.athlete_id=$1)
         OR (o.visibility='team' AND EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=o.team_id AND m.user_id=$1 AND m.status='active'))
      ORDER BY o.observed_at DESC, o.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});
