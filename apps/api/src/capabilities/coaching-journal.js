import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { hiddenYouth, relationships, requireCoachingConsent, requireRelationship } from '../coaching.js';
import { canSeeYouth, isYouth } from '../youth.js';
import { canCoachTeam } from './teams.js';
import { sharedNotes, sharedSummaries } from '../coaching-shared.js';

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

export const block = z.object({
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
  unit: text(40).optional().describe('name of one of the session\'s groups (e.g. defenders) this block is for'),
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

/**
 * Who may touch a session record. The owner coach can do everything. Another coach of the same team can act only on what the owner
 * delegated ('attendance', 'observe'; any grant also lets them view), and only while they are still an active coach of that team.
 * @returns {{ rec: object, owner: boolean }}
 */
export async function sessionAccess(user, recordId, need = 'view', client) {
  const q = client ? (t, p) => client.query(t, p).then((r) => r.rows[0] ?? null) : one;
  const rec = await q('SELECT * FROM coaching_session_records WHERE id=$1', [recordId]);
  if (!rec) throw notFound('Coaching session');
  if (rec.coach_id === user.id || isAdmin(user)) return { rec: client ? await ownRecord(user, recordId, client) : rec, owner: true };
  const d = await q(
    `SELECT permissions FROM coaching_session_delegates d WHERE d.session_record_id=$1 AND d.user_id=$2 AND d.revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=$3 AND m.user_id=$2 AND m.status='active' AND m.role='coach')`, [recordId, user.id, rec.team_id]);
  if (!d || (need !== 'view' && !d.permissions.includes(need))) throw notFound('Coaching session');
  return { rec, owner: false };
}

const withIds = (blocks) => blocks.map((b) => ({ ...b, id: b.id ?? randomUUID() }));

/** Open (or return) the coaching record for a canonical source. Exported so cloning a session goes through the same checks. */
export async function openSession(user, i) {
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
}

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
  handler: ({ user }, i) => openSession(user, i),
});

cap({
  name: 'get_coaching_session_workspace', method: 'GET', path: '/coaching/sessions/:id', tag: TAG, auth: COACH,
  summary: 'Everything a coach needs to run or review one session: objective, plan (and the version it started with), participants with attendance, block progress, what you noted last time and follow-ups still open.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { rec, owner } = await sessionAccess(user, i.id, 'view');
    const who = owner ? rec.coach_id : user.id; // a delegate sees only their own notes and actions
    const [plan, atStart, participants, observations, previous, open_actions] = await Promise.all([
      one('SELECT version, blocks, created_at FROM coaching_session_plan_versions WHERE session_record_id=$1 AND version=$2', [rec.id, rec.plan_version]),
      rec.started_plan_version == null ? null : one('SELECT version, blocks, created_at FROM coaching_session_plan_versions WHERE session_record_id=$1 AND version=$2', [rec.id, rec.started_plan_version]),
      many(`SELECT ${PUBLIC_USER}, p.attendance, p.arrived_at, p.left_at, p.focus, (SELECT m.position FROM team_members m WHERE m.team_id=$2 AND m.user_id=p.athlete_id AND m.status='active' LIMIT 1) AS position FROM coaching_session_participants p JOIN users u ON u.id=p.athlete_id WHERE p.session_record_id=$1 ORDER BY u.display_name, u.id`, [rec.id, rec.team_id]),
      many("SELECT o.*, "+"(SELECT coalesce(array_agg(e.goal_id), '{}') FROM coaching_goal_evidence e WHERE e.evidence_type='observation' AND e.evidence_id=o.id::text) AS goal_ids FROM coaching_observations o WHERE o.session_record_id=$1 AND (o.coach_id=$2 OR ($3::boolean AND o.visibility='staff')) ORDER BY o.observed_at, o.id", [rec.id, who, owner]),
      many(`SELECT o.id, o.athlete_id, o.note, o.obs_type, o.skill_tag, o.follow_up, o.observed_at, o.visibility FROM (SELECT athlete_id FROM coaching_session_participants WHERE session_record_id=$1) pp
              CROSS JOIN LATERAL (SELECT * FROM coaching_observations x WHERE x.athlete_id=pp.athlete_id AND x.coach_id=$2 AND x.session_record_id IS DISTINCT FROM $1 AND (x.follow_up OR x.observed_at > now() - interval '60 days') ORDER BY x.follow_up DESC, x.observed_at DESC, x.id LIMIT 3) o`, [rec.id, who]),
      many(`SELECT a.id, a.title, a.athlete_id, a.team_id, a.due_at, a.status, a.priority, a.follow_up_next_session FROM coaching_actions a
             WHERE a.coach_id=$1 AND a.status IN ('open','in_progress') AND (a.athlete_id IN (SELECT athlete_id FROM coaching_session_participants WHERE session_record_id=$2) OR a.team_id IS NOT DISTINCT FROM $3)
             ORDER BY a.follow_up_next_session DESC, a.due_at NULLS LAST, a.id LIMIT 50`, [who, rec.id, rec.team_id]),
    ]);
    const session = owner ? rec : { ...rec, private_summary: null };
    const summaries = owner ? await many('SELECT athlete_id, summary, shared FROM coaching_player_summaries WHERE session_record_id=$1', [rec.id]) : [];
    const delegates = owner ? await many('SELECT d.user_id, u.display_name, d.permissions FROM coaching_session_delegates d JOIN users u ON u.id=d.user_id WHERE d.session_record_id=$1 AND d.revoked_at IS NULL ORDER BY u.display_name', [rec.id]) : [];
    return { session, you_are: owner ? 'owner' : 'delegate', player_summaries: summaries, delegates, plan: plan ?? { version: 0, blocks: [] }, plan_at_start: atStart, block_log: rec.block_log, participants, observations, previous_notes: previous, open_actions };
  },
});

/** Save blocks as the next plan version of a session record the coach owns. Shared by the plan editor and by accepting an AI draft. */
export async function savePlan(user, recordId, blocksIn, { objective, expected_version, template } = {}) {
  return tx(async (c) => {
    const rec = await ownRecord(user, recordId, c);
    if (rec.status === 'completed') throw conflict('A completed session\'s plan cannot be changed');
    if (expected_version != null && expected_version !== rec.plan_version) throw conflict('The plan changed since you loaded it');
    const unitNames = new Set((rec.groups ?? []).map((g) => g.name.toLowerCase()));
    const badUnit = blocksIn.find((b) => b.unit && !unitNames.has(b.unit.toLowerCase()));
    if (badUnit) throw badRequest(`Block "${badUnit.title}" is aimed at the group "${badUnit.unit}", which this session does not have. Create the group first.`);
    const version = rec.plan_version + 1;
    const blocks = withIds(blocksIn);
    await c.query('INSERT INTO coaching_session_plan_versions(session_record_id, version, blocks, saved_by, from_template_id, from_template_version) VALUES ($1,$2,$3,$4,$5,$6)', [rec.id, version, JSON.stringify(blocks), user.id, template?.id ?? null, template?.version ?? null]);
    const upd = (await c.query('UPDATE coaching_session_records SET plan_version=$2, objective=coalesce($3, objective), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [rec.id, version, objective])).rows[0];
    return { session: upd, plan: { version, blocks } };
  });
}

cap({
  name: 'save_coaching_session_plan', method: 'POST', path: '/coaching/sessions/:id/plan', tag: TAG, auth: COACH,
  summary: 'Save the ordered blocks for a session as a new plan version. Earlier versions are kept, so the plan a session started with stays readable; a completed session is frozen.',
  input: z.object({ id, blocks: z.array(block).max(30), objective: text(1000).optional(), expected_version: z.number().int().min(0).optional().describe('plan version you loaded; a different current version is a conflict') }),
  handler: ({ user }, i) => savePlan(user, i.id, i.blocks, i),
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
      const { rec } = await sessionAccess(user, i.id, 'attendance', c);
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
  name: 'review_coaching_session', method: 'POST', path: '/coaching/sessions/:id/review', tag: TAG, auth: COACH,
  summary: 'File or edit the review (team summary and private summary) of a session, including after it was completed. The first time a review is filed it is timestamped, so the time from session end to review can be measured.',
  input: z.object({ id, team_summary: text(4000).optional(), private_summary: text(4000).optional(), share_team_summary: z.boolean().optional().describe('let the people who took part read the team summary') }),
  async handler({ user }, i) {
    if (i.team_summary === undefined && i.private_summary === undefined) throw badRequest('Write a team or private summary');
    return tx(async (c) => {
      const rec = await ownRecord(user, i.id, c);
      return (await c.query(
        `UPDATE coaching_session_records SET team_summary=coalesce($2, team_summary), private_summary=coalesce($3, private_summary), team_summary_shared=coalesce($4, team_summary_shared), reviewed_at=coalesce(reviewed_at, now()), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [rec.id, i.team_summary ?? null, i.private_summary ?? null, i.share_team_summary ?? null])).rows[0];
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
        `UPDATE coaching_session_records SET status='completed', ended_at=now(), started_at=coalesce(started_at, now()), team_summary=$2, private_summary=$3, reviewed_at=CASE WHEN $2::text IS NOT NULL OR $3::text IS NOT NULL THEN now() END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
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
    goal_ids: z.array(id).max(10).optional().describe('your goals this note is evidence for'), rubric_id: id.optional(), dimension_key: z.string().max(40).optional(), score: z.number().optional().describe('score on the rubric dimension\'s own scale; the rubric version is recorded with it'),
    ...obsBody,
  }),
  async handler({ user }, i) {
    if (!i.athlete_id && !i.team_id) throw badRequest('Name an athlete or a team');
    if (i.visibility === 'player' && !i.athlete_id) throw badRequest('player visibility needs an athlete');
    if (i.visibility === 'team' && (i.athlete_id || !i.team_id)) throw badRequest('team visibility is for team-level notes only');
    if (i.visibility === 'staff' && !i.team_id) throw badRequest('staff visibility needs the team whose coaches may read it');
    if (i.visibility === 'player' && i.athlete_id) await requireCoachingConsent(i.athlete_id, 'sharing coaching notes with them');
    let rec = null;
    if (i.session_record_id) {
      rec = (await sessionAccess(user, i.session_record_id, 'observe')).rec;
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
      const v = await one('SELECT r.sport_id, r.positions, v.version, v.dimensions FROM coaching_rubrics r JOIN coaching_rubric_versions v ON v.rubric_id=r.id WHERE r.id=$1 AND r.coach_id=$2 AND r.archived_at IS NULL ORDER BY v.version DESC LIMIT 1', [i.rubric_id, user.id]);
      if (!v) throw notFound('Rubric');
      const d = v.dimensions.find((x) => x.key === i.dimension_key);
      if (!d) throw badRequest('Unknown rubric dimension');
      if (i.score < d.scale_min || i.score > d.scale_max) throw badRequest(`Score must be between ${d.scale_min} and ${d.scale_max} for this dimension`);
      rubricVersion = v.version;
      // applicability: the rubric's sport, and the athlete's position on the team when the rubric is limited to positions
      const sportOk = !v.sport_id || !rec?.sport_id || v.sport_id === rec.sport_id;
      if (!sportOk) throw badRequest('That rubric is for a different sport');
      if (v.positions.length && i.athlete_id) {
        const pos = (await one("SELECT position FROM team_members WHERE user_id=$1 AND status='active' AND position IS NOT NULL AND ($2::uuid IS NULL OR team_id=$2) LIMIT 1", [i.athlete_id, i.team_id ?? null]))?.position;
        if (!pos || !v.positions.some((x) => x.toLowerCase() === pos.toLowerCase())) throw badRequest(`That rubric applies to ${v.positions.join(', ')} only`);
      }
    }
    if (i.goal_ids?.length) {
      const gs = await many('SELECT id, athlete_id, team_id FROM coaching_goals WHERE id = ANY($1::uuid[]) AND coach_id=$2', [i.goal_ids, user.id]);
      if (gs.length !== new Set(i.goal_ids).size) throw badRequest('Some of those goals are not yours');
      if (gs.some((g) => !((g.athlete_id && g.athlete_id === i.athlete_id) || (!g.athlete_id && g.team_id && g.team_id === i.team_id)))) throw badRequest('A goal you named is about someone else');
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
    if (row && i.goal_ids?.length) for (const gid of i.goal_ids) await one("INSERT INTO coaching_goal_evidence(goal_id, evidence_type, evidence_id, added_by) VALUES ($1,'observation',$2,$3) ON CONFLICT DO NOTHING RETURNING goal_id", [gid, row.id, user.id]);
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
    if (next.visibility === 'player' && cur.visibility !== 'player') await requireCoachingConsent(next.athlete_id, 'sharing coaching notes with them');
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
const obsItem = (o) => ({ kind: 'observation', source_type: 'coaching_observation', source_id: o.id, at: o.observed_at, title: o.skill_tag ?? o.obs_type, detail: o.note, visibility: o.visibility, obs_type: o.obs_type, skill_tag: o.skill_tag, follow_up: o.follow_up, edited: o.row_version > 1, athlete_id: o.athlete_id, team_id: o.team_id, session_record_id: o.session_record_id, author_id: o.coach_id, own: o.own, rubric_id: o.rubric_id, rubric_version: o.rubric_version, dimension_key: o.dimension_key, score: o.score, goal_ids: o.goal_ids });
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
    const obs = await many(`SELECT o.*, (o.coach_id=$2) AS own, (SELECT coalesce(array_agg(e.goal_id), '{}') FROM coaching_goal_evidence e WHERE e.evidence_type='observation' AND e.evidence_id=o.id::text) AS goal_ids FROM coaching_observations o WHERE o.athlete_id=$1 AND (o.coach_id=$2 ${staff})${f} ORDER BY o.observed_at DESC, o.id LIMIT ${take}`, params);
    const plain = !i.skill_tag && !i.obs_type && !i.session_record_id;
    const [att, sessions] = plain ? await Promise.all([
      many(`SELECT r.id, r.title, r.status, coalesce(r.started_at, r.scheduled_at, r.created_at) AS at, p.attendance FROM coaching_session_participants p JOIN coaching_session_records r ON r.id=p.session_record_id
             WHERE p.athlete_id=$1 AND r.coach_id=$2 AND coalesce(r.started_at, r.scheduled_at, r.created_at) BETWEEN coalesce($3::timestamptz,'-infinity') AND coalesce($4::timestamptz,'infinity') ORDER BY at DESC, r.id LIMIT ${take}`, [i.athlete_id, user.id, i.from ?? null, i.to ?? null]),
      many(`SELECT x.id, x.title, x.completed_at AS at, x.status, x.athlete_rpe, x.target_rpe FROM training_sessions x JOIN training_plans p ON p.id=x.plan_id
             WHERE p.athlete_id=$1 AND p.coach_id=$2 AND x.status IN ('completed','skipped') AND x.completed_at BETWEEN coalesce($3::timestamptz,'-infinity') AND coalesce($4::timestamptz,'infinity') ORDER BY x.completed_at DESC, x.id LIMIT ${take}`, [i.athlete_id, user.id, i.from ?? null, i.to ?? null]),
    ]) : [[], []];
    const extra = plain ? await many(
      `SELECT * FROM (
         SELECT 'goal' AS kind, 'coaching_goal' AS source_type, g.id::text AS source_id, e.created_at AS at, g.title, 'Goal ' || e.to_status AS detail, NULL::text AS status FROM coaching_goal_events e JOIN coaching_goals g ON g.id=e.goal_id WHERE g.coach_id=$2 AND g.athlete_id=$1 AND e.created_at BETWEEN coalesce($3::timestamptz,'-infinity') AND coalesce($4::timestamptz,'infinity')
         UNION ALL
         SELECT 'action', 'coaching_action', a.id::text, coalesce(a.completed_at, a.created_at), a.title, CASE WHEN a.status='done' THEN 'Action completed' ELSE 'Action ' || a.status END, a.status FROM coaching_actions a WHERE a.coach_id=$2 AND a.athlete_id=$1 AND coalesce(a.completed_at, a.created_at) BETWEEN coalesce($3::timestamptz,'-infinity') AND coalesce($4::timestamptz,'infinity')
         UNION ALL
         SELECT 'report', 'coaching_report', r.id::text, v.published_at, r.title, 'Report v' || v.version || ' published for ' || replace(v.audience, '_', ' '), NULL FROM coaching_report_versions v JOIN coaching_reports r ON r.id=v.report_id WHERE r.coach_id=$2 AND r.athlete_id=$1 AND v.published_at BETWEEN coalesce($3::timestamptz,'-infinity') AND coalesce($4::timestamptz,'infinity')
         UNION ALL
         SELECT 'match', 'fixture', f.id::text, f.scheduled_at, coalesce(h.name,'TBC') || ' v ' || coalesce(a.name,'TBC'), CASE WHEN f.status='completed' THEN 'Official result: ' || f.home_score || '-' || f.away_score ELSE 'Match ' || f.status END, f.status
           FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id
          WHERE EXISTS (SELECT 1 FROM team_members m WHERE m.user_id=$1 AND m.status='active' AND m.team_id IN (f.home_team_id, f.away_team_id)) AND EXISTS (SELECT 1 FROM team_members c WHERE c.user_id=$2 AND c.status='active' AND c.role='coach' AND c.team_id IN (f.home_team_id, f.away_team_id))
            AND f.status IN ('completed','live') AND f.scheduled_at BETWEEN coalesce($3::timestamptz,'-infinity') AND coalesce($4::timestamptz,'infinity')) u
        ORDER BY at DESC, source_id LIMIT ${take}`, [i.athlete_id, user.id, i.from ?? null, i.to ?? null]) : [];
    const items = [
      ...extra.map((x) => ({ kind: x.kind, source_type: x.source_type, source_id: x.source_id, at: x.at, title: x.title, detail: x.detail, status: x.status ?? undefined })),
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
    const obs = await many(`SELECT o.*, (o.coach_id=$2) AS own, (SELECT coalesce(array_agg(e.goal_id), '{}') FROM coaching_goal_evidence e WHERE e.evidence_type='observation' AND e.evidence_id=o.id::text) AS goal_ids FROM coaching_observations o WHERE o.team_id=$1 AND (o.coach_id=$2 ${staff})${f} ORDER BY o.observed_at DESC, o.id LIMIT ${take}`, params);
    const recs = (i.skill_tag || i.obs_type || i.session_record_id) ? [] : await many(
      `SELECT r.id, r.title, r.status, r.team_summary, coalesce(r.started_at, r.scheduled_at, r.created_at) AS at,
              (SELECT count(*)::int FROM coaching_session_participants p WHERE p.session_record_id=r.id AND p.attendance IN ('present','late','left_early')) AS present,
              (SELECT count(*)::int FROM coaching_session_participants p WHERE p.session_record_id=r.id) AS roster
         FROM coaching_session_records r WHERE r.team_id=$1 AND r.coach_id=$2 AND coalesce(r.started_at, r.scheduled_at, r.created_at) BETWEEN coalesce($3::timestamptz,'-infinity') AND coalesce($4::timestamptz,'infinity') ORDER BY at DESC, r.id LIMIT ${take}`, [team.id, user.id, i.from ?? null, i.to ?? null]);
    const extra = (i.skill_tag || i.obs_type || i.session_record_id) ? [] : await many(
      `SELECT * FROM (
         SELECT 'goal' AS kind, 'coaching_goal' AS source_type, g.id::text AS source_id, e.created_at AS at, g.title, 'Goal ' || e.to_status AS detail FROM coaching_goal_events e JOIN coaching_goals g ON g.id=e.goal_id WHERE g.coach_id=$2 AND g.team_id=$1 AND e.created_at BETWEEN coalesce($3::timestamptz,'-infinity') AND coalesce($4::timestamptz,'infinity')
         UNION ALL
         SELECT 'action', 'coaching_action', a.id::text, coalesce(a.completed_at, a.created_at), a.title, CASE WHEN a.status='done' THEN 'Action completed' ELSE 'Action ' || a.status END FROM coaching_actions a WHERE a.coach_id=$2 AND a.team_id=$1 AND coalesce(a.completed_at, a.created_at) BETWEEN coalesce($3::timestamptz,'-infinity') AND coalesce($4::timestamptz,'infinity')
         UNION ALL
         SELECT 'report', 'coaching_report', r.id::text, v.published_at, r.title, 'Report v' || v.version || ' published for ' || replace(v.audience, '_', ' ') FROM coaching_report_versions v JOIN coaching_reports r ON r.id=v.report_id WHERE r.coach_id=$2 AND r.team_id=$1 AND v.published_at BETWEEN coalesce($3::timestamptz,'-infinity') AND coalesce($4::timestamptz,'infinity')
         UNION ALL
         SELECT 'match', 'fixture', f.id::text, f.scheduled_at, coalesce(h.name,'TBC') || ' v ' || coalesce(a.name,'TBC'), CASE WHEN f.status='completed' THEN 'Official result: ' || f.home_score || '-' || f.away_score ELSE 'Match ' || f.status END
           FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE $1 IN (f.home_team_id, f.away_team_id) AND f.status IN ('completed','live') AND f.scheduled_at BETWEEN coalesce($3::timestamptz,'-infinity') AND coalesce($4::timestamptz,'infinity')) u
        ORDER BY at DESC, source_id LIMIT ${take}`, [team.id, user.id, i.from ?? null, i.to ?? null]);
    return [
      ...extra.map((x) => ({ kind: x.kind, source_type: x.source_type, source_id: x.source_id, at: x.at, title: x.title, detail: x.detail })),
      ...obs.map(obsItem),
      ...recs.map((r) => ({ kind: 'session', source_type: 'coaching_session_record', source_id: r.id, at: r.at, title: r.title, detail: r.team_summary, status: r.status, present: r.present, roster: r.roster })),
    ].sort(byTime).slice(i.offset, i.offset + i.limit);
  },
});

cap({
  name: 'set_coaching_session_groups', method: 'POST', path: '/coaching/sessions/:id/groups', tag: TAG, auth: COACH,
  summary: 'Split a session\'s roster into named groups (for example defenders and forwards, or batting and bowling) so blocks can be aimed at one group. Members must already be on the roster. A completed session\'s groups are frozen.',
  input: z.object({ id, groups: z.array(z.object({ name: text(40).min(1), athlete_ids: z.array(id).min(1).max(60) })).max(8) }),
  async handler({ user }, i) {
    const names = i.groups.map((g) => g.name.toLowerCase());
    if (new Set(names).size !== names.length) throw badRequest('Group names must be different');
    return tx(async (c) => {
      const rec = await ownRecord(user, i.id, c);
      if (rec.status === 'completed') throw conflict('A completed session\'s groups cannot be changed');
      const roster = new Set((await c.query('SELECT athlete_id FROM coaching_session_participants WHERE session_record_id=$1', [rec.id])).rows.map((r) => r.athlete_id));
      if (i.groups.some((g) => g.athlete_ids.some((a) => !roster.has(a)))) throw badRequest('Everyone in a group must be on this session\'s roster');
      return (await c.query('UPDATE coaching_session_records SET groups=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING id, groups', [rec.id, JSON.stringify(i.groups)])).rows[0];
    });
  },
});

cap({
  name: 'delegate_coaching_session', method: 'POST', path: '/coaching/sessions/:id/delegates', tag: TAG, auth: COACH, status: 201,
  summary: 'Let another active coach of the session\'s team help with this one session: "attendance" (record who is there) and/or "observe" (write notes about the people on the roster). They can see the roster and plan but not your private summary, your notes, or anything outside this session. Sending an empty permission list removes the delegation. Access ends if they stop coaching the team.',
  input: z.object({ id, user_id: id, permissions: z.array(z.enum(['attendance', 'observe'])).max(2) }),
  async handler({ user }, i) {
    const rec = await ownRecord(user, i.id);
    if (!rec.team_id) throw badRequest('Only team sessions can be delegated');
    if (i.user_id === user.id) throw badRequest('You already have full access');
    if (!(await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active' AND role='coach'", [rec.team_id, i.user_id]))) throw badRequest('They must be an active coach of this team');
    if (!i.permissions.length) {
      const r = await one('UPDATE coaching_session_delegates SET revoked_at=now() WHERE session_record_id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING user_id', [rec.id, i.user_id]);
      return { user_id: i.user_id, permissions: [], revoked: !!r };
    }
    return one(
      `INSERT INTO coaching_session_delegates(session_record_id, user_id, permissions, granted_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (session_record_id, user_id) DO UPDATE SET permissions=EXCLUDED.permissions, granted_by=EXCLUDED.granted_by, granted_at=now(), revoked_at=NULL RETURNING user_id, permissions`, [rec.id, i.user_id, [...new Set(i.permissions)], user.id]);
  },
});

cap({
  name: 'list_my_delegated_coaching_sessions', method: 'GET', path: '/coaching/delegated-sessions', tag: TAG, auth: COACH,
  summary: 'Sessions another coach has let you help with, newest first, with what you may do.', input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT r.id, r.title, r.team_id, r.status, r.scheduled_at, d.permissions, u.display_name AS head_coach FROM coaching_session_delegates d JOIN coaching_session_records r ON r.id=d.session_record_id JOIN users u ON u.id=r.coach_id
      WHERE d.user_id=$1 AND d.revoked_at IS NULL AND EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=r.team_id AND m.user_id=$1 AND m.status='active' AND m.role='coach')
      ORDER BY coalesce(r.scheduled_at, r.created_at) DESC, r.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'set_player_session_summary', method: 'POST', path: '/coaching/sessions/:id/player-summaries', tag: TAG, auth: COACH,
  summary: 'Write a short summary of one player\'s session. It stays private to you until you set shared=true, when that player (only) can read it. Also set share_team_summary on the session to let participants read the team summary.',
  input: z.object({ id, athlete_id: id, summary: text(2000).min(1), shared: z.boolean().default(false), share_team_summary: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const rec = await ownRecord(user, i.id, c);
      if (!(await c.query('SELECT 1 FROM coaching_session_participants WHERE session_record_id=$1 AND athlete_id=$2', [rec.id, i.athlete_id])).rows.length) throw badRequest('That player is not on this session');
      await requireRelationship(user, i.athlete_id);
      if (i.shared) await requireCoachingConsent(i.athlete_id, 'sharing a coaching summary with them');
      if (i.share_team_summary !== undefined) await c.query('UPDATE coaching_session_records SET team_summary_shared=$2, updated_at=now() WHERE id=$1', [rec.id, i.share_team_summary]);
      return (await c.query(
        `INSERT INTO coaching_player_summaries(session_record_id, athlete_id, summary, shared) VALUES ($1,$2,$3,$4)
         ON CONFLICT (session_record_id, athlete_id) DO UPDATE SET summary=EXCLUDED.summary, shared=EXCLUDED.shared, row_version=coaching_player_summaries.row_version+1, updated_at=now() RETURNING session_record_id, athlete_id, summary, shared, row_version`,
        [rec.id, i.athlete_id, i.summary, i.shared])).rows[0];
    });
  },
});

cap({
  name: 'my_coaching_session_summaries', method: 'GET', path: '/me/coaching-session-summaries', tag: TAG, auth: 'user',
  summary: 'Summaries of sessions you took part in that your coach chose to share: a summary written for you, and the team summary where the coach shared it. Nothing private is included.', input: z.object({ ...page }),
  handler: ({ user }, i) => sharedSummaries(user.id, i),
});

cap({
  name: 'get_coach_performance_home', method: 'GET', path: '/coaching/home', tag: TAG, auth: COACH,
  summary: 'Performance Studio overview. Sections: sessions running, sessions to run in the window (default today; each links to its canonical source), sessions awaiting review, matches to prepare and to debrief, open and overdue actions, goal reviews due and goals not reviewed for a month, notes flagged for follow-up, draft reports and AI drafts waiting for you. Filters narrow every section: sport, scope (individual / group / team), athlete, team, skill tag, date window, and open actions only.',
  input: z.object({
    sport: z.string().optional(), scope: z.enum(['individual', 'group', 'team']).optional(), team_id: id.optional(), athlete_id: id.optional(), skill_tag: z.string().trim().max(60).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), open_actions: z.coerce.boolean().optional(),
  }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    const from = i.from ?? new Date().toISOString().slice(0, 10), to = i.to ?? from;
    if (to < from) throw badRequest('to is before from');
    // $1 coach, $2 sport, $3 team, $4 athlete, $5 skill tag, $6 scope, $7 open-actions-only, $8 from, $9 to(+1 day)
    const base = [user.id, sport?.id ?? null, i.team_id ?? null, i.athlete_id ?? null, i.skill_tag ?? null, i.scope ?? null, !!i.open_actions, from, to];
    // every query is prefixed with a CTE naming all nine parameters, so a query that uses only some of them still type-checks
    const P = 'WITH _p AS (SELECT $1::uuid a1, $2::uuid a2, $3::uuid a3, $4::uuid a4, $5::text a5, $6::text a6, $7::boolean a7, $8::date a8, $9::date a9) ';
    const Q = (sql) => many(P + sql, base);
    const rec = ` AND ($2::uuid IS NULL OR r.sport_id=$2) AND ($3::uuid IS NULL OR r.team_id=$3)
      AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM coaching_session_participants q WHERE q.session_record_id=r.id AND q.athlete_id=$4))
      AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM coaching_observations o WHERE o.session_record_id=r.id AND o.skill_tag=$5))
      AND ($6::text IS NULL OR ($6='team' AND r.team_id IS NOT NULL) OR ($6='individual' AND r.team_id IS NULL AND (SELECT count(*) FROM coaching_session_participants q WHERE q.session_record_id=r.id) <= 1) OR ($6='group' AND r.team_id IS NULL AND (SELECT count(*) FROM coaching_session_participants q WHERE q.session_record_id=r.id) > 1))
      AND (NOT $7::boolean OR EXISTS (SELECT 1 FROM coaching_actions a WHERE a.coach_id=$1 AND a.status IN ('open','in_progress') AND (a.session_record_id=r.id OR a.team_id=r.team_id OR a.athlete_id IN (SELECT athlete_id FROM coaching_session_participants q WHERE q.session_record_id=r.id))))`;
    const subj = (athleteCol, teamCol) => ` AND ($3::uuid IS NULL OR ${teamCol}=$3) AND ($4::uuid IS NULL OR ${athleteCol}=$4)`;
    const [running, today_records, needs_review, to_open, follow_ups, counts, overdue_actions, open_actions, goals_due, goals_stale, matches_to_prepare, matches_to_debrief, draft_reports, ai_waiting] = await Promise.all([
      Q(`SELECT r.* FROM coaching_session_records r WHERE r.coach_id=$1 AND r.status='running'${rec} ORDER BY r.started_at, r.id`),
      Q(`SELECT r.* FROM coaching_session_records r WHERE r.coach_id=$1 AND r.status='planned' AND r.scheduled_at >= $8::date AND r.scheduled_at < $9::date + 1${rec} ORDER BY r.scheduled_at, r.id`),
      Q(`SELECT r.* FROM coaching_session_records r WHERE r.coach_id=$1 AND r.status='completed' AND r.reviewed_at IS NULL AND r.team_summary IS NULL AND r.private_summary IS NULL AND r.ended_at > now() - interval '30 days'${rec} ORDER BY r.ended_at DESC, r.id LIMIT 20`),
      Q(`SELECT * FROM (
              SELECT 'training_session' AS source_type, x.id::text AS source_id, x.title, x.starts_at AS scheduled_at, p.athlete_id, p.sport_id, NULL::uuid AS team_id
                FROM training_sessions x JOIN training_plans p ON p.id=x.plan_id
               WHERE p.coach_id=$1 AND x.status='scheduled' AND x.starts_at >= $8::date AND x.starts_at < $9::date + 1 AND ($2::uuid IS NULL OR p.sport_id=$2) AND $3::uuid IS NULL AND ($4::uuid IS NULL OR p.athlete_id=$4) AND ($6::text IS NULL OR $6='individual') AND $5::text IS NULL
                 AND NOT EXISTS (SELECT 1 FROM coaching_session_records r WHERE r.coach_id=$1 AND r.source_type='training_session' AND r.source_id=x.id::text)
              UNION ALL
              SELECT 'coach_hire', h.id::text, 'Coaching session', h.starts_at, h.hirer_id, h.sport_id, h.team_id
                FROM coach_hires h WHERE h.coach_id=$1 AND h.status='confirmed' AND h.starts_at >= $8::date AND h.starts_at < $9::date + 1 AND ($2::uuid IS NULL OR h.sport_id=$2) AND ($3::uuid IS NULL OR h.team_id=$3) AND ($4::uuid IS NULL OR h.hirer_id=$4) AND $5::text IS NULL
                 AND ($6::text IS NULL OR ($6='team' AND h.team_id IS NOT NULL) OR ($6='individual' AND h.audience='individual') OR ($6='group' AND h.audience='group'))
                 AND NOT EXISTS (SELECT 1 FROM coaching_session_records r WHERE r.coach_id=$1 AND r.source_type='coach_hire' AND r.source_id=h.id::text)) u
             WHERE NOT $7::boolean OR EXISTS (SELECT 1 FROM coaching_actions a WHERE a.coach_id=$1 AND a.status IN ('open','in_progress') AND (a.athlete_id=u.athlete_id OR a.team_id=u.team_id))
             ORDER BY scheduled_at, source_id LIMIT 20`),
      Q(`SELECT o.id, o.athlete_id, u.display_name AS athlete_name, o.team_id, o.note, o.skill_tag, o.obs_type, o.observed_at, o.session_record_id FROM coaching_observations o LEFT JOIN users u ON u.id=o.athlete_id
             WHERE o.coach_id=$1 AND o.follow_up AND o.observed_at > now() - interval '90 days' AND ($2::uuid IS NULL OR o.sport_id=$2)${subj('o.athlete_id', 'o.team_id')} AND ($5::text IS NULL OR o.skill_tag=$5)
               AND ($6::text IS NULL OR ($6='team' AND o.athlete_id IS NULL) OR ($6='individual' AND o.athlete_id IS NOT NULL) OR $6='group') AND (NOT $7::boolean OR EXISTS (SELECT 1 FROM coaching_actions a WHERE a.coach_id=$1 AND a.status IN ('open','in_progress') AND (a.observation_id=o.id OR a.athlete_id=o.athlete_id OR a.team_id=o.team_id)))
             ORDER BY o.observed_at DESC, o.id LIMIT 20`),
      one('SELECT (SELECT count(*)::int FROM coaching_session_records WHERE coach_id=$1 AND status=\'completed\') AS sessions_completed, (SELECT count(*)::int FROM coaching_observations WHERE coach_id=$1) AS observations', [user.id]),
      Q(`SELECT a.id, a.title, a.athlete_id, u.display_name AS athlete_name, a.team_id, a.due_at, a.priority FROM coaching_actions a LEFT JOIN users u ON u.id=a.athlete_id
             WHERE a.coach_id=$1 AND a.status IN ('open','in_progress') AND a.due_at < now() AND ($2::uuid IS NULL OR a.team_id IN (SELECT id FROM teams WHERE sport_id=$2) OR a.athlete_id IN (SELECT athlete_id FROM coaching_session_participants q JOIN coaching_session_records r ON r.id=q.session_record_id WHERE r.sport_id=$2))${subj('a.athlete_id', 'a.team_id')} ORDER BY a.due_at, a.id LIMIT 20`),
      Q(`SELECT a.id, a.title, a.athlete_id, u.display_name AS athlete_name, a.team_id, a.due_at, a.priority, a.follow_up_next_session FROM coaching_actions a LEFT JOIN users u ON u.id=a.athlete_id
             WHERE a.coach_id=$1 AND a.status IN ('open','in_progress') AND ($2::uuid IS NULL OR a.team_id IN (SELECT id FROM teams WHERE sport_id=$2) OR a.athlete_id IN (SELECT athlete_id FROM coaching_session_participants q JOIN coaching_session_records r ON r.id=q.session_record_id WHERE r.sport_id=$2))${subj('a.athlete_id', 'a.team_id')}
               AND ($6::text IS NULL OR ($6='team' AND a.athlete_id IS NULL) OR ($6<>'team' AND a.athlete_id IS NOT NULL)) ORDER BY a.due_at NULLS LAST, a.id LIMIT 30`),
      Q(`SELECT g.id, g.title, g.athlete_id, u.display_name AS athlete_name, g.team_id, g.review_on, g.status FROM coaching_goals g LEFT JOIN users u ON u.id=g.athlete_id
             WHERE g.coach_id=$1 AND g.status IN ('planned','active') AND g.review_on <= current_date + 7 AND ($2::uuid IS NULL OR g.sport_id=$2)${subj('g.athlete_id', 'g.team_id')} AND ($6::text IS NULL OR ($6='team' AND g.athlete_id IS NULL) OR ($6<>'team' AND g.athlete_id IS NOT NULL)) ORDER BY g.review_on, g.id LIMIT 20`),
      Q(`SELECT g.id, g.title, g.athlete_id, u.display_name AS athlete_name, g.team_id, g.status,
                   greatest(g.created_at, coalesce((SELECT max(e.created_at) FROM coaching_goal_events e WHERE e.goal_id=g.id AND e.from_status IS NOT NULL), g.created_at), coalesce((SELECT max(v.created_at) FROM coaching_goal_evidence v WHERE v.goal_id=g.id), g.created_at)) AS last_touched
              FROM coaching_goals g LEFT JOIN users u ON u.id=g.athlete_id
             WHERE g.coach_id=$1 AND g.status='active' AND ($2::uuid IS NULL OR g.sport_id=$2)${subj('g.athlete_id', 'g.team_id')} AND ($6::text IS NULL OR ($6='team' AND g.athlete_id IS NULL) OR ($6<>'team' AND g.athlete_id IS NOT NULL))
               AND NOT EXISTS (SELECT 1 FROM coaching_goal_events e WHERE e.goal_id=g.id AND e.from_status IS NOT NULL AND e.created_at > now() - interval '30 days') AND NOT EXISTS (SELECT 1 FROM coaching_goal_evidence v WHERE v.goal_id=g.id AND v.created_at > now() - interval '30 days') AND g.created_at < now() - interval '30 days'
             ORDER BY last_touched, g.id LIMIT 20`),
      Q(`SELECT f.id AS fixture_id, t.id AS team_id, t.name AS team_name, f.scheduled_at, h.name AS home_name, a.name AS away_name, (SELECT r.id FROM coaching_session_records r WHERE r.coach_id=$1 AND r.source_type='fixture' AND r.source_id=f.id::text) AS session_record_id
              FROM fixtures f JOIN teams t ON t.id IN (f.home_team_id, f.away_team_id) JOIN team_members m ON m.team_id=t.id AND m.user_id=$1 AND m.role='coach' AND m.status='active'
              LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id JOIN events e ON e.id=f.event_id
             WHERE f.status IN ('scheduled','live') AND f.scheduled_at >= now() AND f.scheduled_at < now() + interval '7 days' AND ($2::uuid IS NULL OR e.sport_id=$2) AND ($3::uuid IS NULL OR t.id=$3) AND $4::uuid IS NULL AND ($6::text IS NULL OR $6='team')
               AND NOT EXISTS (SELECT 1 FROM coaching_session_records r WHERE r.coach_id=$1 AND r.source_type='fixture' AND r.source_id=f.id::text AND r.plan_version > 0)
             ORDER BY f.scheduled_at, f.id LIMIT 20`),
      Q(`SELECT f.id AS fixture_id, t.id AS team_id, t.name AS team_name, f.scheduled_at, h.name AS home_name, a.name AS away_name
              FROM fixtures f JOIN teams t ON t.id IN (f.home_team_id, f.away_team_id) JOIN team_members m ON m.team_id=t.id AND m.user_id=$1 AND m.role='coach' AND m.status='active'
              LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id JOIN events e ON e.id=f.event_id
             WHERE f.status IN ('finished','completed') AND f.scheduled_at > now() - interval '14 days' AND ($2::uuid IS NULL OR e.sport_id=$2) AND ($3::uuid IS NULL OR t.id=$3) AND $4::uuid IS NULL AND ($6::text IS NULL OR $6='team')
               AND NOT EXISTS (SELECT 1 FROM coaching_session_records r WHERE r.coach_id=$1 AND r.source_type='fixture' AND r.source_id=f.id::text AND r.status='completed' AND (r.reviewed_at IS NOT NULL OR r.team_summary IS NOT NULL OR r.private_summary IS NOT NULL))
             ORDER BY f.scheduled_at DESC, f.id LIMIT 20`),
      Q(`SELECT r.id, r.title, r.audience, r.athlete_id, r.team_id, r.kind, r.updated_at FROM coaching_reports r
             WHERE r.coach_id=$1 AND r.latest_version=0${subj('r.athlete_id', 'r.team_id')} AND ($6::text IS NULL OR ($6='team' AND r.athlete_id IS NULL) OR ($6<>'team' AND r.athlete_id IS NOT NULL)) ORDER BY r.updated_at DESC, r.id LIMIT 20`),
      Q(`SELECT d.id, d.task, d.athlete_id, d.team_id, d.session_record_id, d.created_at, d.output->>'headline' AS headline FROM coaching_ai_drafts d
             WHERE d.coach_id=$1 AND d.status='draft' AND d.created_at > now() - interval '14 days'${subj('d.athlete_id', 'd.team_id')} ORDER BY d.created_at DESC, d.id LIMIT 20`),
    ]);
    return {
      window: { from, to }, filters: { sport: i.sport ?? null, scope: i.scope ?? null, team_id: i.team_id ?? null, athlete_id: i.athlete_id ?? null, skill_tag: i.skill_tag ?? null, open_actions: !!i.open_actions },
      running, today: today_records, needs_review, to_open: to_open.map((x) => ({ ...x, link: { screen: 'CoachSession', params: { source_type: x.source_type, source_id: x.source_id } } })),
      matches_to_prepare, matches_to_debrief, follow_ups, overdue_actions, open_actions, goals_due, goals_stale, draft_reports, ai_waiting, counts,
    };
  },
});

cap({
  name: 'my_shared_coaching_notes', method: 'GET', path: '/me/coaching-notes', tag: TAG, auth: 'user',
  summary: 'Coaching notes a coach deliberately shared with you (player visibility) and team-level notes shared with a team you are an active member of. Private and staff-only notes are never included.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => sharedNotes(user.id, i),
});
