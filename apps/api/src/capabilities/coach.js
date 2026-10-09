import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { isAdmin, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { RELATIONSHIP_SQL, hiddenYouth, sessionKinds } from '../coaching.js';
import { canCoachTeam } from './teams.js';
import { badgesFor } from '../verification.js';

const TAG = 'Coach';
const COACH = ['coach'];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const myTeams = (uid) => many(
  `SELECT t.id, t.name, t.emoji, t.color, s.name AS sport, s.slug AS sport_slug, (SELECT count(*)::int FROM team_members x WHERE x.team_id=t.id AND x.status='active' AND x.user_id <> $1) AS members
     FROM team_members m JOIN teams t ON t.id=m.team_id JOIN sports s ON s.id=t.sport_id
    WHERE m.user_id=$1 AND m.role='coach' AND m.status='active' ORDER BY t.name, t.id`, [uid]);

cap({
  name: 'coach_home', method: 'GET', path: '/coach/home', tag: TAG, auth: COACH,
  summary: 'Coach Home: credential status, sports, next session, counts and an action inbox where every card names the screen that resolves it.',
  async handler({ user }) {
    const sports = await many("SELECT s.slug, s.name, s.emoji, p.hourly_rate_cents, p.id AS profile_id FROM sport_profiles p JOIN sports s ON s.id=p.sport_id WHERE p.user_id=$1 AND p.role='coach' ORDER BY s.name", [user.id]);
    const badge = ((await badgesFor('user', [user.id])).get(user.id) ?? []).find((b) => b.type === 'coach') ?? null;
    const teams = await myTeams(user.id);
    const [nextHire, nextSession, counts, requests, toConfirm, planReplies, feedbackWaiting, invites, awaitingAthlete] = await Promise.all([
      one("SELECT id, starts_at FROM coach_hires WHERE coach_id=$1 AND status='confirmed' AND starts_at > now() ORDER BY starts_at, id LIMIT 1", [user.id]),
      one("SELECT s.id, s.starts_at, s.title FROM training_sessions s JOIN training_plans p ON p.id=s.plan_id WHERE p.coach_id=$1 AND s.status='scheduled' AND s.starts_at > now() ORDER BY s.starts_at, s.id LIMIT 1", [user.id]),
      one(`SELECT (SELECT count(DISTINCT athlete_id)::int FROM (${RELATIONSHIP_SQL}) r WHERE coach_id=$1) AS athletes`, [user.id]),
      many("SELECT h.id, h.starts_at, h.payment_status, u.display_name AS hirer_name FROM coach_hires h JOIN users u ON u.id=h.hirer_id WHERE h.coach_id=$1 AND h.status='requested' ORDER BY h.starts_at, h.id LIMIT 20", [user.id]),
      many("SELECT h.id FROM coach_hires h WHERE h.coach_id=$1 AND h.status='requested' AND h.payment_status IN ('paid','not_required')", [user.id]),
      many(`SELECT p.id, p.title, r.response, ua.display_name AS athlete_name FROM training_plans p JOIN training_plan_revisions r ON r.plan_id=p.id AND r.rev=p.current_rev JOIN users ua ON ua.id=p.athlete_id
             WHERE p.coach_id=$1 AND p.status <> 'closed' AND r.response IN ('declined','change_requested') ORDER BY p.updated_at DESC, p.id LIMIT 20`, [user.id]),
      many(`SELECT s.id, s.title, p.id AS plan_id, ua.display_name AS athlete_name FROM training_sessions s JOIN training_plans p ON p.id=s.plan_id JOIN users ua ON ua.id=p.athlete_id
             WHERE p.coach_id=$1 AND s.status IN ('completed','skipped') AND s.coach_feedback IS NULL AND s.completed_at > now() - interval '30 days' ORDER BY s.completed_at DESC, s.id LIMIT 20`, [user.id]),
      many("SELECT t.id, t.name FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1 AND m.status='invited' ORDER BY t.name LIMIT 20", [user.id]),
      one("SELECT count(*)::int AS n FROM training_plans WHERE coach_id=$1 AND status='proposed'", [user.id]),
    ]);
    const inbox = [
      ...requests.map((r) => ({ kind: 'hire_request', title: `Coaching request from ${r.hirer_name}`, detail: r.payment_status === 'unpaid' ? 'Waiting for payment' : 'Ready to confirm', ready: toConfirm.some((x) => x.id === r.id), at: r.starts_at, link: { screen: 'Hub', params: { section: 'hires' }, source_type: 'coach_hire', source_id: r.id } })),
      ...planReplies.map((r) => ({ kind: 'plan_reply', title: `${r.athlete_name}: ${r.response === 'declined' ? 'declined' : 'asked for changes to'} "${r.title}"`, link: { screen: 'CoachPlan', params: { id: r.id }, source_type: 'training_plan', source_id: r.id } })),
      ...feedbackWaiting.map((r) => ({ kind: 'session_feedback', title: `Review ${r.athlete_name}'s session "${r.title}"`, link: { screen: 'CoachPlan', params: { id: r.plan_id }, source_type: 'training_session', source_id: r.id } })),
      ...invites.map((r) => ({ kind: 'team_invite', title: `Team invitation: ${r.name}`, link: { screen: 'Team', params: { id: r.id }, source_type: 'team', source_id: r.id } })),
    ];
    const warnings = [];
    if (!badge) warnings.push({ kind: 'credential', title: 'Your coach credential is not verified yet', link: { screen: 'Me', params: {} } });
    return {
      verification: badge, sports, teams,
      next_session: [nextHire && { source_type: 'coach_hire', source_id: nextHire.id, starts_at: nextHire.starts_at }, nextSession && { source_type: 'training_session', source_id: nextSession.id, starts_at: nextSession.starts_at, title: nextSession.title }]
        .filter(Boolean).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0] ?? null,
      counts: { athletes: counts.athletes, teams: teams.length, requests: requests.length, plans_awaiting_athlete: awaitingAthlete.n, plans_needing_revision: planReplies.length },
      inbox, warnings,
    };
  },
});

cap({
  name: 'coach_athletes', method: 'GET', path: '/coach/athletes', tag: TAG, auth: COACH,
  summary: 'Your athletes: only people with an active coaching relationship (confirmed hire, shared team, led cohort, accepted plan). Public profile plus plan progress; never health data.',
  input: z.object({ sport: z.string().optional(), ...page }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    const rows = await many(
      `SELECT ${PUBLIC_USER}, array_agg(DISTINCT r.source ORDER BY r.source) AS relationships,
              (SELECT count(*)::int FROM training_plans p WHERE p.coach_id=$1 AND p.athlete_id=u.id AND p.status='active') AS active_plans,
              (SELECT count(*)::int FROM training_plans p WHERE p.coach_id=$1 AND p.athlete_id=u.id AND p.status IN ('proposed','change_requested')) AS plans_in_review,
              (SELECT min(x.starts_at) FROM training_sessions x JOIN training_plans p ON p.id=x.plan_id WHERE p.coach_id=$1 AND p.athlete_id=u.id AND x.status='scheduled' AND x.starts_at > now()) AS next_session_at,
              (SELECT count(*)::int FROM training_sessions x JOIN training_plans p ON p.id=x.plan_id WHERE p.coach_id=$1 AND p.athlete_id=u.id AND x.status='completed') AS sessions_completed,
              (SELECT count(*)::int FROM training_sessions x JOIN training_plans p ON p.id=x.plan_id WHERE p.coach_id=$1 AND p.athlete_id=u.id AND x.status IN ('completed','skipped')) AS sessions_recorded
         FROM (${RELATIONSHIP_SQL}) r JOIN users u ON u.id=r.athlete_id
        WHERE r.coach_id=$1 AND ($2::uuid IS NULL OR r.sport_id=$2)
        GROUP BY u.id ORDER BY u.display_name, u.id LIMIT $3 OFFSET $4`, [user.id, sport?.id ?? null, i.limit, i.offset]);
    const hidden = await hiddenYouth(user, rows.map((r) => r.id));
    return rows.filter((r) => !hidden.has(r.id)).map((r) => ({ ...r, source: 'relationship', adherence_pct: r.sessions_recorded ? Math.round((100 * r.sessions_completed) / r.sessions_recorded) : null, adherence_basis: 'athlete-reported session completion' }));
  },
});

cap({
  name: 'coach_calendar', method: 'GET', path: '/coach/calendar', tag: TAG, auth: COACH,
  summary: 'Your coaching schedule over canonical records (hires, plan sessions, fixtures of teams you coach). Each item carries source_type/source_id; nothing is copied.',
  input: z.object({ from: day.optional(), to: day.optional(), athlete_id: id.optional(), team_id: id.optional(), sport: z.string().optional() }),
  async handler({ user }, i) {
    const from = i.from ?? new Date().toISOString().slice(0, 10);
    const to = i.to ?? new Date(Date.parse(from) + 14 * 86400000).toISOString().slice(0, 10);
    if (to < from) throw badRequest('to is before from');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92) throw badRequest('Range is limited to 92 days');
    const win = [user.id, from, to];
    const [hires, sessions, fixtures] = await Promise.all([
      many(`SELECT h.id, h.status, h.starts_at, h.starts_at + h.duration_min * interval '1 minute' AS ends_at, h.hirer_id AS athlete_id, u.display_name AS athlete_name, s.slug AS sport
              FROM coach_hires h JOIN users u ON u.id=h.hirer_id LEFT JOIN sports s ON s.id=h.sport_id
             WHERE h.coach_id=$1 AND h.status IN ('requested','confirmed') AND h.starts_at >= $2::date AND h.starts_at < $3::date + 1`, win),
      many(`SELECT x.id, x.status, x.title, x.kind, x.starts_at, x.starts_at + x.duration_min * interval '1 minute' AS ends_at, p.id AS plan_id, p.athlete_id, u.display_name AS athlete_name, s.slug AS sport, x.booking_id
              FROM training_sessions x JOIN training_plans p ON p.id=x.plan_id JOIN users u ON u.id=p.athlete_id LEFT JOIN sports s ON s.id=p.sport_id
             WHERE p.coach_id=$1 AND x.status IN ('scheduled','completed') AND x.starts_at >= $2::date AND x.starts_at < $3::date + 1`, win),
      many(`SELECT f.id, f.status, f.scheduled_at AS starts_at, f.scheduled_at + interval '90 minutes' AS ends_at, t.id AS team_id, t.name AS team_name, h.name AS home_name, a.name AS away_name, s.slug AS sport
              FROM fixtures f JOIN teams t ON t.id IN (f.home_team_id, f.away_team_id) JOIN team_members m ON m.team_id=t.id AND m.user_id=$1 AND m.role='coach' AND m.status='active'
              JOIN teams h ON h.id=f.home_team_id JOIN teams a ON a.id=f.away_team_id JOIN events e ON e.id=f.event_id JOIN sports s ON s.id=e.sport_id
             WHERE f.status IN ('scheduled','live') AND f.scheduled_at >= $2::date AND f.scheduled_at < $3::date + 1`, win),
    ]);
    let items = [
      ...hires.map((r) => ({ kind: 'hire', source_type: 'coach_hire', source_id: r.id, title: `Session with ${r.athlete_name}`, athlete_id: r.athlete_id, sport: r.sport, starts_at: r.starts_at, ends_at: r.ends_at, status: r.status === 'confirmed' ? 'confirmed' : 'awaiting_response', link: { screen: 'Hub', params: { section: 'hires' } } })),
      ...sessions.map((r) => ({ kind: 'plan_session', source_type: 'training_session', source_id: r.id, title: r.title, context: r.athlete_name, athlete_id: r.athlete_id, sport: r.sport, starts_at: r.starts_at, ends_at: r.ends_at, status: r.status, booking_id: r.booking_id, link: { screen: 'CoachPlan', params: { id: r.plan_id } } })),
      ...fixtures.map((r) => ({ kind: 'match', source_type: 'fixture', source_id: `${r.id}`, title: `${r.home_name} v ${r.away_name}`, context: r.team_name, team_id: r.team_id, sport: r.sport, starts_at: r.starts_at, ends_at: r.ends_at, status: 'confirmed', link: { screen: 'Team', params: { id: r.team_id } } })),
    ].map((x) => ({ timezone: 'UTC', conflict: false, ...x }));
    const dedup = new Map(items.map((x) => [`${x.source_type}:${x.source_id}:${x.team_id ?? ''}`, x]));
    items = [...dedup.values()].filter((x) => (!i.athlete_id || x.athlete_id === i.athlete_id) && (!i.team_id || x.team_id === i.team_id) && (!i.sport || x.sport === i.sport));
    items.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at) || a.source_type.localeCompare(b.source_type) || String(a.source_id).localeCompare(String(b.source_id)));
    for (const a of items) for (const b of items) if (a !== b && new Date(a.starts_at) < new Date(b.ends_at) && new Date(b.starts_at) < new Date(a.ends_at)) a.conflict = true;
    return { from, to, items, conflicts: items.filter((x) => x.conflict).length };
  },
});

cap({
  name: 'coach_team_roster', method: 'GET', path: '/coach/teams/:id/roster', tag: TAG, auth: COACH,
  summary: 'Coach-scoped team roster with availability. No rates, settlement, finance or medical data.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const team = await one('SELECT * FROM teams WHERE id=$1', [i.id]);
    if (!team) throw notFound('Team');
    if (!(await canCoachTeam(user, team))) throw forbidden('You do not coach this team');
    const rows = await many(
      `SELECT ${PUBLIC_USER}, m.role, m.jersey_no, m.availability, m.availability_note FROM team_members m JOIN users u ON u.id=m.user_id
        WHERE m.team_id=$1 AND m.status='active' ORDER BY m.role, u.display_name, u.id`, [team.id]);
    const hidden = isAdmin(user) ? new Set() : await hiddenYouth(user, rows.map((r) => r.id));
    return { team: { id: team.id, name: team.name }, members: rows.filter((r) => !hidden.has(r.id)) };
  },
});

cap({
  name: 'create_coach_template', method: 'POST', path: '/coach/templates', tag: TAG, auth: COACH, status: 201,
  summary: 'Save a reusable drill/session structure. Templates hold no athlete data.',
  input: z.object({ title: z.string().min(2).max(120), sport: z.string().optional(), kind: z.enum(sessionKinds).optional(), structure: z.object({ duration_min: z.number().int().min(15).max(480).optional(), instructions: z.string().max(2000).optional(), target_rpe: z.number().int().min(1).max(10).optional(), drills: z.array(z.string().max(200)).max(30).optional() }).default({}) }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    return one('INSERT INTO coach_templates(coach_id, sport_id, title, kind, structure) VALUES ($1,$2,$3,$4,$5) RETURNING *', [user.id, sport?.id ?? null, i.title, i.kind, JSON.stringify(i.structure)]);
  },
});

cap({
  name: 'list_coach_templates', method: 'GET', path: '/coach/templates', tag: TAG, auth: COACH,
  summary: 'Your templates.', input: z.object({ ...page }),
  handler: ({ user }, i) => many('SELECT t.*, s.slug AS sport_slug FROM coach_templates t LEFT JOIN sports s ON s.id=t.sport_id WHERE t.coach_id=$1 AND t.archived_at IS NULL ORDER BY t.created_at DESC, t.id LIMIT $2 OFFSET $3', [user.id, i.limit, i.offset]),
});

cap({
  name: 'archive_coach_template', method: 'DELETE', path: '/coach/templates/:id', tag: TAG, auth: COACH,
  summary: 'Archive a template (kept, hidden from the list).', input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE coach_templates SET archived_at=now() WHERE id=$1 AND coach_id=$2 RETURNING id, archived_at', [i.id, user.id]);
    if (!r) throw notFound('Template');
    return r;
  },
});
