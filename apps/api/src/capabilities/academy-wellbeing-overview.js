// Academy student wellbeing & personal development (#795), part 3 - what the director and the mentors see. The director gets participation and
// engagement indicators (counts and rates, groups under five suppressed) and an "action due" queue (who, what kind, since when, whose job): never what
// was said in a check-in, a goal's wording, a referral's reason or a safeguarding concern, and never a score about a person's character or mental health.
// A mentor sees their own mentees in full, while consent lasts.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { tx } from '../db.js';
import { audit } from '../helpers.js';
import { MIN_GROUP, SCOPES, CATEGORIES, consentSql, scopesSql, liveConsent, log, mentorOf, notFound, suppress } from '../wellbeing.js';
import { wbAccess, shapeCheckin } from './academy-wellbeing.js';

const TAG = 'Academy wellbeing';
const EN = "SELECT DISTINCT e.user_id AS athlete_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.status IN ('enrolled','paused')";
const ONE = async (c, sql, p) => (await c.query(sql, p)).rows[0];
const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);

cap({
  name: 'get_academy_wellbeing_overview', method: 'GET', path: '/organisations/:id/academy/wellbeing', tag: TAG,
  summary: 'The director\'s wellbeing & development view: consent coverage, mentor coverage and rhythm, check-ins held and missed, open and overdue follow-ups, goals by status, referral flow by status, track participation and module completion (a group under five is returned as null), eight weeks of activity and the action-due queue (athlete, kind, due date, owner; never content). No score is computed about any person. Mentors get the same call limited to their own mentees\' actions.',
  input: z.object({ id, weeks: z.coerce.number().int().min(2).max(26).default(8) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await wbAccess(user, i.id, c);
      const total = (await ONE(c, `SELECT count(*)::int AS n FROM (${EN}) x`, [i.id])).n;
      const coverage = {};
      for (const s of SCOPES) coverage[s] = (await ONE(c, `SELECT count(*)::int AS n FROM (${EN}) x CROSS JOIN (SELECT $1::uuid AS organisation_id) o WHERE ${consentSql('o.organisation_id', 'x.athlete_id', s)}`, [i.id])).n;
      const mentoring = coverage.mentoring;
      const mentored = (await ONE(c, `SELECT count(*)::int AS n FROM academy_mentor_assignments m WHERE m.organisation_id=$1 AND m.status='active' AND ${consentSql('m.organisation_id', 'm.athlete_id', 'mentoring')}`, [i.id])).n;
      const rhythm = (await ONE(c,
        `SELECT count(*)::int AS live, count(*) FILTER (WHERE coalesce((SELECT max(k.completed_at) FROM academy_wellbeing_checkins k WHERE k.assignment_id=m.id AND k.status='completed'), m.started_at) > now() - make_interval(days => m.cadence_days + 3))::int AS on_rhythm
           FROM academy_mentor_assignments m WHERE m.organisation_id=$1 AND m.status='active' AND ${consentSql('m.organisation_id', 'm.athlete_id', 'mentoring')}`, [i.id]));
      const ck = await ONE(c,
        `SELECT count(*) FILTER (WHERE status='completed' AND completed_at > now() - interval '30 days')::int AS held_30d, count(*) FILTER (WHERE status='missed' AND scheduled_for > now() - interval '30 days')::int AS missed_30d,
                count(*) FILTER (WHERE status='scheduled' AND scheduled_for >= now() AND scheduled_for < now() + interval '14 days')::int AS upcoming_14d, count(*) FILTER (WHERE follow_up_status='open')::int AS follow_ups_open,
                count(*) FILTER (WHERE follow_up_status='open' AND follow_up_due < current_date)::int AS follow_ups_overdue
           FROM academy_wellbeing_checkins k WHERE k.organisation_id=$1 AND ${consentSql('k.organisation_id', 'k.athlete_id', 'checkins')}`, [i.id]);
      const goals = Object.fromEntries((await c.query(`SELECT g.status, count(*)::int AS n FROM academy_dev_goals g WHERE g.organisation_id=$1 AND ${consentSql('g.organisation_id', 'g.athlete_id', 'goals')} GROUP BY g.status`, [i.id])).rows.map((r) => [r.status, r.n]));
      const reviewsDue = (await ONE(c, `SELECT count(*)::int AS n FROM academy_dev_goals g WHERE g.organisation_id=$1 AND g.status IN ('agreed','active') AND g.next_review_on <= current_date AND ${consentSql('g.organisation_id', 'g.athlete_id', 'goals')}`, [i.id])).n;
      const referrals = Object.fromEntries((await c.query(`SELECT r.status, count(*)::int AS n FROM academy_wellbeing_referrals r WHERE r.organisation_id=$1 AND ${consentSql('r.organisation_id', 'r.athlete_id', 'referrals')} GROUP BY r.status`, [i.id])).rows.map((r) => [r.status, r.n]));
      const tracks = (await c.query(
        `SELECT t.id, t.category, t.title, t.status, jsonb_array_length(t.modules) AS modules,
                (SELECT count(*)::int FROM academy_dev_track_members m WHERE m.track_id=t.id AND m.status IN ('enrolled','completed') AND ${consentSql('t.organisation_id', 'm.athlete_id', 'tracks')}) AS participants,
                (SELECT coalesce(round(100 * avg(cardinality(m.modules_done)::numeric / NULLIF(jsonb_array_length(t.modules), 0))), 0)::int FROM academy_dev_track_members m WHERE m.track_id=t.id AND m.status IN ('enrolled','completed') AND ${consentSql('t.organisation_id', 'm.athlete_id', 'tracks')}) AS completion_pct
           FROM academy_dev_tracks t WHERE t.organisation_id=$1 AND t.status <> 'archived' ORDER BY t.category, t.title`, [i.id])).rows
        .map((t) => ({ id: t.id, category: t.category, title: t.title, status: t.status, modules: t.modules, participants: suppress(t.participants), completion_pct: t.participants >= MIN_GROUP ? t.completion_pct : null, suppressed: t.participants > 0 && t.participants < MIN_GROUP }));
      const byCategory = CATEGORIES.map((cat) => { const n = tracks.filter((t) => t.category === cat).reduce((s, t) => s + (t.participants ?? 0), 0); return { category: cat, participants: n >= MIN_GROUP ? n : null }; });
      const trend = (await c.query(
        `SELECT to_char(w.wk, 'IYYY-"W"IW') AS week, w.wk::date AS starts_on,
                (SELECT count(*)::int FROM academy_wellbeing_checkins k WHERE k.organisation_id=$1 AND k.status='completed' AND k.completed_at >= w.wk AND k.completed_at < w.wk + interval '1 week') AS checkins_held,
                (SELECT count(*)::int FROM academy_wellbeing_events e WHERE e.organisation_id=$1 AND e.kind='module_done' AND e.created_at >= w.wk AND e.created_at < w.wk + interval '1 week') AS modules_done
           FROM generate_series(date_trunc('week', now()) - make_interval(weeks => $2 - 1), date_trunc('week', now()), interval '1 week') AS w(wk) ORDER BY w.wk`, [i.id, i.weeks])).rows;

      // ---- action due: who, what kind, since when, whose job. Never content.
      const q = [];
      const add = (rows, kind) => rows.forEach((r) => q.push({ kind, athlete_id: r.athlete_id, athlete_name: r.athlete_name, owner_id: r.owner_id ?? null, owner_name: r.owner_name ?? null, due_on: r.due_on ?? null, ref_id: r.ref_id ?? null }));
      add((await c.query(`SELECT k.athlete_id, u.display_name AS athlete_name, k.mentor_id AS owner_id, m.display_name AS owner_name, k.scheduled_for::date AS due_on, k.id AS ref_id FROM academy_wellbeing_checkins k JOIN users u ON u.id=k.athlete_id JOIN users m ON m.id=k.mentor_id
        WHERE k.organisation_id=$1 AND k.status='scheduled' AND k.scheduled_for < now() - interval '1 day' AND ${consentSql('k.organisation_id', 'k.athlete_id', 'checkins')}`, [i.id])).rows, 'checkin_to_record');
      add((await c.query(`SELECT k.athlete_id, u.display_name AS athlete_name, k.mentor_id AS owner_id, m.display_name AS owner_name, k.follow_up_due AS due_on, k.id AS ref_id FROM academy_wellbeing_checkins k JOIN users u ON u.id=k.athlete_id JOIN users m ON m.id=k.mentor_id
        WHERE k.organisation_id=$1 AND k.follow_up_status='open' AND k.follow_up_due <= current_date + 3 AND ${consentSql('k.organisation_id', 'k.athlete_id', 'checkins')}`, [i.id])).rows, 'follow_up_due');
      add((await c.query(`SELECT g.athlete_id, u.display_name AS athlete_name, g.reviewer_id AS owner_id, r.display_name AS owner_name, g.next_review_on AS due_on, g.id AS ref_id FROM academy_dev_goals g JOIN users u ON u.id=g.athlete_id JOIN users r ON r.id=g.reviewer_id
        WHERE g.organisation_id=$1 AND g.status IN ('agreed','active') AND g.next_review_on <= current_date + 3 AND ${consentSql('g.organisation_id', 'g.athlete_id', 'goals')}`, [i.id])).rows, 'goal_review_due');
      add((await c.query(`SELECT g.athlete_id, u.display_name AS athlete_name, g.reviewer_id AS owner_id, r.display_name AS owner_name, (g.created_at + interval '7 days')::date AS due_on, g.id AS ref_id FROM academy_dev_goals g JOIN users u ON u.id=g.athlete_id JOIN users r ON r.id=g.reviewer_id
        WHERE g.organisation_id=$1 AND g.status='proposed' AND g.created_at < now() - interval '7 days' AND ${consentSql('g.organisation_id', 'g.athlete_id', 'goals')}`, [i.id])).rows, 'goal_awaiting_family');
      add((await c.query(`SELECT r.athlete_id, u.display_name AS athlete_name, r.proposed_by AS owner_id, p.display_name AS owner_name, (r.created_at + interval '3 days')::date AS due_on, r.id AS ref_id FROM academy_wellbeing_referrals r JOIN users u ON u.id=r.athlete_id JOIN users p ON p.id=r.proposed_by
        WHERE r.organisation_id=$1 AND ((r.status='proposed' AND r.created_at < now() - interval '3 days') OR (r.status='consented' AND r.decided_at < now() - interval '3 days')) AND ${consentSql('r.organisation_id', 'r.athlete_id', 'referrals')}`, [i.id])).rows, 'referral_waiting');
      add((await c.query(`SELECT m.athlete_id, u.display_name AS athlete_name, m.mentor_id AS owner_id, mu.display_name AS owner_name, (coalesce((SELECT max(k.completed_at) FROM academy_wellbeing_checkins k WHERE k.assignment_id=m.id AND k.status='completed'), m.started_at) + make_interval(days => m.cadence_days + 3))::date AS due_on, m.id AS ref_id
          FROM academy_mentor_assignments m JOIN users u ON u.id=m.athlete_id JOIN users mu ON mu.id=m.mentor_id WHERE m.organisation_id=$1 AND m.status='active' AND ${consentSql('m.organisation_id', 'm.athlete_id', 'mentoring')}
           AND coalesce((SELECT max(k.completed_at) FROM academy_wellbeing_checkins k WHERE k.assignment_id=m.id AND k.status='completed'), m.started_at) < now() - make_interval(days => m.cadence_days + 3)
           AND NOT EXISTS (SELECT 1 FROM academy_wellbeing_checkins k WHERE k.assignment_id=m.id AND k.status='scheduled' AND k.scheduled_for >= now())`, [i.id])).rows, 'checkin_not_booked');
      add((await c.query(`SELECT m.athlete_id, u.display_name AS athlete_name, m.mentor_id AS owner_id, mu.display_name AS owner_name, m.review_on AS due_on, m.id AS ref_id FROM academy_mentor_assignments m JOIN users u ON u.id=m.athlete_id JOIN users mu ON mu.id=m.mentor_id
        WHERE m.organisation_id=$1 AND m.status IN ('active','paused') AND m.review_on <= current_date + 7 AND ${consentSql('m.organisation_id', 'm.athlete_id', 'mentoring')}`, [i.id])).rows, 'mentor_review_due');
      if (a.oversight) {
        add((await c.query(`SELECT x.athlete_id, u.display_name AS athlete_name, NULL::date AS due_on FROM (${EN}) x JOIN users u ON u.id=x.athlete_id CROSS JOIN (SELECT $1::uuid AS organisation_id) o
          WHERE ${consentSql('o.organisation_id', 'x.athlete_id', 'mentoring')} AND NOT EXISTS (SELECT 1 FROM academy_mentor_assignments m WHERE m.organisation_id=o.organisation_id AND m.athlete_id=x.athlete_id AND m.status <> 'ended') ORDER BY u.display_name LIMIT 25`, [i.id])).rows, 'needs_mentor');
        add((await c.query(`SELECT w.athlete_id, u.display_name AS athlete_name, w.expires_at::date AS due_on, w.id AS ref_id FROM academy_wellbeing_consents w JOIN users u ON u.id=w.athlete_id WHERE w.organisation_id=$1 AND w.revoked_at IS NULL AND w.expires_at > now() AND w.expires_at < now() + interval '30 days'`, [i.id])).rows, 'consent_expiring');
      }
      const actions = q.filter((x) => a.oversight || x.owner_id === user.id).sort((x, y) => String(x.due_on ?? '9999').localeCompare(String(y.due_on ?? '9999'))).slice(0, 60);
      await audit(c, user.id, 'read_wellbeing_overview', 'organisations', i.id);
      return {
        organisation_id: i.id, scope: a.oversight ? 'organisation' : 'my_mentees', min_group: MIN_GROUP,
        kpis: { academy_athletes: total, mentor_coverage_pct: pct(mentored, mentoring), on_rhythm_pct: pct(rhythm.on_rhythm, rhythm.live), checkins_held_30d: ck.held_30d, checkins_missed_30d: ck.missed_30d, checkins_upcoming_14d: ck.upcoming_14d,
          follow_ups_open: ck.follow_ups_open, follow_ups_overdue: ck.follow_ups_overdue, goal_reviews_due: reviewsDue, referrals_awaiting_family: referrals.proposed ?? 0, actions_due: actions.length },
        coverage: Object.fromEntries(SCOPES.map((s) => [s, { athletes: coverage[s], pct: pct(coverage[s], total) }])),
        mentors: { athletes_mentored: mentored, needing_mentor: Math.max(0, mentoring - mentored) },
        goals, referrals, tracks, participation_by_category: byCategory, trend, actions,
      };
    });
  },
});

cap({
  name: 'list_wellbeing_athletes', method: 'GET', path: '/organisations/:id/academy/wellbeing/athletes', tag: TAG,
  summary: 'The academy\'s athletes with what they have chosen to take part in (scope names), their mentor and next check-in, so staff can ask for consent, assign mentors and enrol in tracks. The director and safeguarding staff see everyone; a mentor sees their own mentees. Search by name; filter by consent or mentor state.',
  input: z.object({ id, q: z.string().trim().max(80).optional(), consent: z.enum(['none', 'some']).optional(), mentor: z.enum(['none', 'assigned']).optional(), ...page }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await wbAccess(user, i.id, c);
      return (await c.query(
        `SELECT * FROM (SELECT x.athlete_id, u.display_name, u.avatar_emoji, u.avatar_color, (u.youth_until IS NOT NULL AND u.youth_until > current_date) AS is_youth, coalesce(${scopesSql('$1::uuid', 'x.athlete_id')}, '{}') AS scopes,
                m.id AS assignment_id, m.mentor_id, mu.display_name AS mentor_name, m.status AS mentor_status,
                (SELECT min(k.scheduled_for) FROM academy_wellbeing_checkins k WHERE k.assignment_id=m.id AND k.status='scheduled' AND k.scheduled_for >= now()) AS next_checkin_at
           FROM (${EN}) x JOIN users u ON u.id=x.athlete_id LEFT JOIN academy_mentor_assignments m ON m.organisation_id=$1 AND m.athlete_id=x.athlete_id AND m.status <> 'ended' LEFT JOIN users mu ON mu.id=m.mentor_id
          WHERE ($2::text IS NULL OR u.display_name ILIKE '%' || $2 || '%') AND ($3::boolean OR m.mentor_id=$4)) r
          WHERE ($5::text IS NULL OR ($5='assigned') = (r.assignment_id IS NOT NULL)) AND ($6::text IS NULL OR ($6='some') = (cardinality(r.scopes) > 0)) ORDER BY r.display_name, r.athlete_id LIMIT $7 OFFSET $8`,
        [i.id, i.q ?? null, a.oversight, user.id, i.mentor ?? null, i.consent ?? null, i.limit, i.offset])).rows;
    });
  },
});

cap({
  name: 'get_wellbeing_athlete', method: 'GET', path: '/organisations/:id/academy/wellbeing/athletes/:athlete_id', tag: TAG,
  summary: 'One athlete\'s wellbeing record as this member of staff may see it. The athlete\'s current mentor gets the check-ins (topics, outcome, agreed next step), goals, tracks and referrals the athlete has consented to share; the director and safeguarding staff get who mentors, the rhythm, what is open and statuses, nothing else. Every read is added to the athlete\'s transparency log, which the family can read. Anyone else gets 404.',
  input: z.object({ id, athlete_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await wbAccess(user, i.id, c);
      const m = await mentorOf(c, i.id, i.athlete_id);
      const role = m?.mentor_id === user.id ? 'mentor' : a.oversight ? 'oversight' : null;
      if (!role || !(await c.query('SELECT 1 FROM (' + EN + ') x WHERE x.athlete_id=$2', [i.id, i.athlete_id])).rowCount) throw notFound('Athlete');
      const consent = await liveConsent(c, i.id, i.athlete_id), scopes = consent?.scopes ?? [];
      const u = (await c.query('SELECT display_name, avatar_emoji, avatar_color, (youth_until IS NOT NULL AND youth_until > current_date) AS is_youth FROM users WHERE id=$1', [i.athlete_id])).rows[0];
      const out = { athlete: { id: i.athlete_id, ...u }, role, consent: consent ? { scopes, granted_as: consent.granted_as, expires_at: consent.expires_at } : null, mentor: m ? { id: m.id, mentor_id: m.mentor_id, status: m.status, cadence_days: m.cadence_days, review_on: m.review_on } : null };
      const who = role === 'mentor' ? 'mentor' : 'oversight';
      out.checkins = scopes.includes('checkins') ? (await c.query(`SELECT k.*, $2::text AS athlete_name, mu.display_name AS mentor_name FROM academy_wellbeing_checkins k JOIN users mu ON mu.id=k.mentor_id WHERE k.organisation_id=$1 AND k.athlete_id=$3 ORDER BY k.scheduled_for DESC LIMIT 40`, [i.id, u.display_name, i.athlete_id])).rows.map((k) => shapeCheckin(k, who)) : [];
      out.goals = scopes.includes('goals') ? (await c.query('SELECT g.*, r.display_name AS reviewer_name FROM academy_dev_goals g JOIN users r ON r.id=g.reviewer_id WHERE g.organisation_id=$1 AND g.athlete_id=$2 ORDER BY g.created_at DESC LIMIT 40', [i.id, i.athlete_id])).rows
        .map((g) => (role === 'mentor' || g.reviewer_id === user.id ? g : { ...g, title: null, measure: null, decision_note: null })) : [];
      out.tracks = scopes.includes('tracks') ? (await c.query('SELECT t.id, t.category, t.title, jsonb_array_length(t.modules) AS modules, m.status, m.modules_done FROM academy_dev_track_members m JOIN academy_dev_tracks t ON t.id=m.track_id WHERE t.organisation_id=$1 AND m.athlete_id=$2 ORDER BY t.title', [i.id, i.athlete_id])).rows : [];
      out.referrals = scopes.includes('referrals') ? (await c.query('SELECT r.id, r.specialty, r.reason, r.urgency, r.status, r.proposed_by, r.created_at FROM academy_wellbeing_referrals r WHERE r.organisation_id=$1 AND r.athlete_id=$2 ORDER BY r.created_at DESC LIMIT 20', [i.id, i.athlete_id])).rows.map((r) => (role === 'mentor' && r.proposed_by === user.id ? r : { ...r, reason: null })) : [];
      const recent = await c.query("SELECT 1 FROM academy_wellbeing_events WHERE organisation_id=$1 AND athlete_id=$2 AND actor_id=$3 AND kind='record_viewed' AND created_at > now() - interval '10 minutes'", [i.id, i.athlete_id, user.id]);
      if (!recent.rowCount) await log(c, i.id, i.athlete_id, 'record_viewed', user.id, null, role);
      await audit(c, user.id, 'read_wellbeing_athlete', 'users', i.athlete_id);
      return out;
    });
  },
});
