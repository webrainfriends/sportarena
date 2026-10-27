// Officials Development & Assessment (#486) 4/4: mentoring and development items, then the dashboards. The official's Home view reads everything live from
// its sources (licences, assessments, CPD, fitness, mentoring); the body view is aggregate counts only, never an opaque cross-sport score or a leaderboard.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { toCsv } from '../csv.js';
import { bodyById, subtree, today, plain, LIC_STATUS } from '../federation.js';
import { ASSESSOR_STATUS, devStaff, reportAuthority, logOff, historyOf, sealText, unsealText, CTX, holdsLicenceUnder, developmentChecks, liveRequirement, fitnessStanding, cpdHours, currentGrade } from '../officials-development.js';
import { settingsOf } from './officials-assessors.js';

const TAG = 'Officials development';
const text = (n) => z.string().trim().max(n);
const day = z.string().date();

// ------------------------------------------------------------------ mentoring
const MENT_COLS = `m.id, m.body_id, m.mentor_id, mu.display_name AS mentor_name, m.mentee_id, eu.display_name AS mentee_name, m.sport_id, s.name AS sport_name, m.starts_on::text AS starts_on, m.ends_on::text AS ends_on, m.status,
  m.mentor_accepted_at, m.mentee_accepted_at, m.end_reason, m.created_at, m.scope_enc`;
const MENT_FROM = 'off_mentorships m JOIN users mu ON mu.id=m.mentor_id JOIN users eu ON eu.id=m.mentee_id JOIN sports s ON s.id=m.sport_id';
const mentView = (r, party) => { const { scope_enc, ...rest } = r; return plain({ ...rest, ...(party ? { scope: unsealText(scope_enc, CTX.scope) } : {}) }); };
const mentorshipRow = async (c, mid, party = true) => mentView((await c.query(`SELECT ${MENT_COLS} FROM ${MENT_FROM} WHERE m.id=$1`, [mid])).rows[0], party);

cap({
  name: 'propose_mentorship', method: 'POST', path: '/officials-development/mentorships', tag: TAG, status: 201,
  summary: 'Propose a mentor-official relationship for a sport (the mentor, the mentee, or the body\'s licensing staff). Both people hold a current official licence from the body; both must accept before it is active. A mentorship grants the mentor only the goals, actions and meetings of this relationship: no assessments, fitness results, competitions or personal data.',
  input: z.object({ body_id: id, mentor_id: id, mentee_id: id, sport_id: id, scope: text(500).optional(), starts_on: day.optional(), ends_on: day.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    if (i.mentor_id === i.mentee_id) throw badRequest('A mentor cannot mentor themselves');
    const staff = (await devStaff(user, i.body_id, { c, sportId: i.sport_id, optional: true }))?.staff;
    if (!staff && ![i.mentor_id, i.mentee_id].includes(user.id)) throw notFound('Governing body');
    for (const uid of [i.mentor_id, i.mentee_id]) if (!(await holdsLicenceUnder(c, uid, i.body_id, { currentOnly: true }))) throw badRequest('Both people need a current official licence from this body');
    if ((i.ends_on ?? '9') < (i.starts_on ?? today())) throw badRequest('It ends before it starts');
    let m;
    try {
      m = (await c.query(`INSERT INTO off_mentorships(body_id, mentor_id, mentee_id, sport_id, scope_enc, starts_on, ends_on, created_by, mentor_accepted_at, mentee_accepted_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $2::uuid=$8::uuid THEN now() END, CASE WHEN $3::uuid=$8::uuid THEN now() END) RETURNING id`,
        [i.body_id, i.mentor_id, i.mentee_id, i.sport_id, sealText(i.scope, CTX.scope), i.starts_on ?? today(), i.ends_on ?? null, user.id])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('There is already an open mentorship between them for this sport'); throw e; }
    await logOff(c, i.body_id, 'mentorship', m.id, 'proposed', { to: 'proposed', actor: user.id });
    for (const uid of [i.mentor_id, i.mentee_id].filter((x) => x !== user.id)) await notify(c, uid, { kind: 'official_mentorship_proposed', title: 'A mentoring relationship was proposed', body: 'Open Officials development to accept or decline.', data: { mentorship_id: m.id }, dedupe_key: `off-ment-prop:${m.id}:${uid}` });
    return mentorshipRow(c, m.id);
  }),
});

cap({
  name: 'respond_mentorship', method: 'POST', path: '/officials-development/mentorships/:id/respond', tag: TAG,
  summary: 'The mentor or the mentee accepts or declines a proposed mentorship. It becomes active when both have accepted.',
  input: z.object({ id, response: z.enum(['accept', 'decline']) }),
  handler: ({ user }, i) => tx(async (c) => {
    const m = (await c.query('SELECT * FROM off_mentorships WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!m || ![m.mentor_id, m.mentee_id].includes(user.id)) throw notFound('Mentorship');
    if (m.status !== 'proposed') throw conflict(`This mentorship is ${m.status}`);
    const col = m.mentor_id === user.id ? 'mentor_accepted_at' : 'mentee_accepted_at';
    if (i.response === 'decline') await c.query("UPDATE off_mentorships SET status='declined' WHERE id=$1", [m.id]);
    else {
      await c.query(`UPDATE off_mentorships SET ${col}=coalesce(${col}, now()) WHERE id=$1`, [m.id]);
      await c.query("UPDATE off_mentorships SET status='active' WHERE id=$1 AND mentor_accepted_at IS NOT NULL AND mentee_accepted_at IS NOT NULL", [m.id]);
    }
    const to = (await c.query('SELECT status FROM off_mentorships WHERE id=$1', [m.id])).rows[0].status;
    await logOff(c, m.body_id, 'mentorship', m.id, i.response === 'accept' ? 'accepted' : 'declined', { from: 'proposed', to, actor: user.id });
    const other = m.mentor_id === user.id ? m.mentee_id : m.mentor_id;
    await notify(c, other, { kind: 'official_mentorship_response', title: i.response === 'accept' ? (to === 'active' ? 'Mentorship is active' : 'Mentorship accepted') : 'Mentorship declined', body: 'Open Officials development.', data: { mentorship_id: m.id }, dedupe_key: `off-ment-resp:${m.id}:${user.id}:${i.response}` });
    return mentorshipRow(c, m.id);
  }),
});

cap({
  name: 'end_mentorship', method: 'POST', path: '/officials-development/mentorships/:id/end', tag: TAG,
  summary: 'Complete or end a mentorship (either person, or the body\'s licensing staff) with a reason. The goals, actions and meeting notes stay with the people they belong to.',
  input: z.object({ id, outcome: z.enum(['completed', 'ended']), reason: text(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const m = (await c.query('SELECT * FROM off_mentorships WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!m) throw notFound('Mentorship');
    const party = [m.mentor_id, m.mentee_id].includes(user.id);
    if (!party && !(await devStaff(user, m.body_id, { c, sportId: m.sport_id, optional: true }))?.staff) throw notFound('Mentorship');
    if (!['proposed', 'active'].includes(m.status)) throw conflict(`This mentorship is ${m.status}`);
    await c.query('UPDATE off_mentorships SET status=$2, end_reason=$3, ends_on=least(coalesce(ends_on, current_date), current_date) WHERE id=$1', [m.id, i.outcome, i.reason || null]);
    await logOff(c, m.body_id, 'mentorship', m.id, i.outcome, { from: m.status, to: i.outcome, actor: user.id, reason: i.reason });
    for (const uid of [m.mentor_id, m.mentee_id].filter((x) => x !== user.id)) await notify(c, uid, { kind: 'official_mentorship_ended', title: 'A mentorship ended', body: 'Open Officials development.', data: { mentorship_id: m.id }, dedupe_key: `off-ment-end:${m.id}:${uid}` });
    return mentorshipRow(c, m.id, party);
  }),
});

cap({
  name: 'list_mentorships', method: 'GET', path: '/officials-development/mentorships', tag: TAG,
  summary: 'Mentorships. Pass `mine` for those you are in (as mentor or mentee, with their scope), or `body_id` as the body\'s licensing staff (relationships only: no scope, goals or notes).',
  input: z.object({ mine: z.coerce.boolean().optional(), body_id: id.optional(), status: z.enum(['proposed', 'active', 'completed', 'ended', 'declined']).optional(), ...page }),
  async handler({ user }, i) {
    if (!i.mine && !i.body_id) throw badRequest('Give mine, or body_id');
    if (!i.mine) await devStaff(user, i.body_id);
    const w = '($1::uuid IS NULL OR m.mentor_id=$1 OR m.mentee_id=$1) AND ($2::uuid IS NULL OR m.body_id=$2) AND ($3::text IS NULL OR m.status=$3)';
    const a = [i.mine ? user.id : null, i.body_id ?? null, i.status ?? null];
    const total = await one(`SELECT count(*)::int AS n FROM ${MENT_FROM} WHERE ${w}`, a);
    const rows = await many(`SELECT ${MENT_COLS} FROM ${MENT_FROM} WHERE ${w} ORDER BY (m.status IN ('proposed','active')) DESC, m.created_at DESC LIMIT $4 OFFSET $5`, [...a, i.limit, i.offset]);
    return { total: total.n, items: rows.map((r) => mentView(r, !!i.mine)) };
  },
});

// ------------------------------------------------------------------ development items
const ITEM_COLS = 'd.id, d.body_id, d.official_id, d.kind, d.source_type, d.source_id, d.mentorship_id, d.title_enc, d.detail_enc, d.visibility, d.due_on::text AS due_on, d.happened_on::text AS happened_on, d.status, d.created_by, d.completed_at, d.created_at, (d.due_on < current_date AND d.status=\'open\') AS overdue';
const itemView = (r) => { const { title_enc, detail_enc, ...rest } = r; return plain({ ...rest, title: unsealText(title_enc, CTX.item), detail: unsealText(detail_enc, CTX.detail) }); };
const itemRow = async (c, did) => itemView((await c.query(`SELECT ${ITEM_COLS} FROM off_dev_items d WHERE d.id=$1`, [did])).rows[0]);

cap({
  name: 'add_development_item', method: 'POST', path: '/officials-development/items', tag: TAG, status: 201,
  summary: 'Add a goal, an action or a meeting record. Without `mentorship_id` you add to your own development (or, as the body\'s licensing staff, an action for an official it licenses). Inside an active mentorship either person adds goals, actions and meetings; the mentor may keep a note `mentor_only`. Items are private to the people involved: the body sees counts, never the text.',
  input: z.object({ body_id: id, mentorship_id: id.optional(), official_id: id.optional(), kind: z.enum(['goal', 'action', 'meeting']), title: text(200).min(2), detail: text(2000).optional(), due_on: day.optional(), happened_on: day.optional(), visibility: z.enum(['shared', 'mentor_only']).default('shared') }),
  handler: ({ user }, i) => tx(async (c) => {
    let official = user.id, source = 'self';
    if (i.mentorship_id) {
      const m = (await c.query('SELECT * FROM off_mentorships WHERE id=$1 AND body_id=$2', [i.mentorship_id, i.body_id])).rows[0];
      if (!m || ![m.mentor_id, m.mentee_id].includes(user.id)) throw notFound('Mentorship');
      if (m.status !== 'active') throw conflict('The mentorship is not active');
      official = m.mentee_id; source = 'mentorship';
      if (i.visibility === 'mentor_only' && m.mentor_id !== user.id) throw forbidden('Only the mentor keeps mentor-only notes');
    } else {
      if (i.visibility === 'mentor_only') throw badRequest('Mentor-only notes belong inside a mentorship');
      if (i.official_id && i.official_id !== user.id) {
        await devStaff(user, i.body_id, { c });
        if (!(await holdsLicenceUnder(c, i.official_id, i.body_id))) throw badRequest('That person is not licensed by this body');
        official = i.official_id; source = 'body';
        if (i.kind !== 'action') throw badRequest('The body can set an action; goals and meetings are the official\'s');
      } else if (!(await holdsLicenceUnder(c, user.id, i.body_id))) throw forbidden('Development is recorded with a body that licenses you');
    }
    if (i.kind === 'meeting' && !i.happened_on) throw badRequest('Say when the meeting happened');
    const d = (await c.query('INSERT INTO off_dev_items(body_id, official_id, kind, source_type, source_id, mentorship_id, title_enc, detail_enc, visibility, due_on, happened_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',
      [i.body_id, official, i.kind, source, i.mentorship_id ?? null, i.mentorship_id ?? null, sealText(i.title, CTX.item), sealText(i.detail, CTX.detail), i.visibility, i.due_on ?? null, i.happened_on ?? null, user.id])).rows[0];
    if (official !== user.id && i.visibility === 'shared') await notify(c, official, { kind: 'official_development_item', title: i.kind === 'action' ? 'A development action was added for you' : 'A development note was added', body: 'Open Officials development.', data: { item_id: d.id }, dedupe_key: `off-item:${d.id}` });
    return itemRow(c, d.id);
  }),
});

cap({
  name: 'update_development_item', method: 'POST', path: '/officials-development/items/:id', tag: TAG,
  summary: 'Mark a goal/action done or cancelled (or reopen it), or change its note and due date. The official it is about, their mentor (for mentorship items) and its author can do this.',
  input: z.object({ id, status: z.enum(['open', 'done', 'cancelled']).optional(), detail: text(2000).optional(), due_on: day.nullish() }),
  handler: ({ user }, i) => tx(async (c) => {
    const d = (await c.query('SELECT * FROM off_dev_items WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!d) throw notFound('Item');
    const mentor = d.mentorship_id ? (await c.query('SELECT mentor_id FROM off_mentorships WHERE id=$1', [d.mentorship_id])).rows[0]?.mentor_id : null;
    const mine = d.official_id === user.id && d.visibility === 'shared';
    if (!mine && mentor !== user.id && d.created_by !== user.id) throw notFound('Item');
    await c.query(`UPDATE off_dev_items SET status=coalesce($2, status), detail_enc=CASE WHEN $3::boolean THEN $4 ELSE detail_enc END, due_on=CASE WHEN $5::boolean THEN $6 ELSE due_on END,
      completed_at=CASE WHEN coalesce($2, status)='done' THEN coalesce(completed_at, now()) ELSE NULL END WHERE id=$1`,
      [d.id, i.status ?? null, i.detail !== undefined, sealText(i.detail, CTX.detail), i.due_on !== undefined, i.due_on ?? null]);
    return itemRow(c, d.id);
  }),
});

cap({
  name: 'list_development_items', method: 'GET', path: '/officials-development/items', tag: TAG,
  summary: 'Goals, actions and meetings. `mine` lists yours (including actions from your published assessments); `mentorship_id` lists a mentorship\'s items for its mentor (all) or mentee (shared only). The body\'s staff cannot list them.',
  input: z.object({ mine: z.coerce.boolean().optional(), mentorship_id: id.optional(), status: z.enum(['open', 'done', 'cancelled']).optional(), ...page }),
  async handler({ user }, i) {
    if (!i.mine && !i.mentorship_id) throw badRequest('Give mine, or mentorship_id');
    let where = "d.official_id=$1 AND d.visibility='shared'", args = [user.id];
    if (i.mentorship_id) {
      const m = (await pool.query('SELECT * FROM off_mentorships WHERE id=$1', [i.mentorship_id])).rows[0];
      if (!m || ![m.mentor_id, m.mentee_id].includes(user.id)) throw notFound('Mentorship');
      where = m.mentor_id === user.id ? 'd.mentorship_id=$1' : "d.mentorship_id=$1 AND d.visibility='shared'"; args = [i.mentorship_id];
    }
    const total = await one(`SELECT count(*)::int AS n FROM off_dev_items d WHERE ${where} AND ($2::text IS NULL OR d.status=$2)`, [...args, i.status ?? null]);
    const rows = await many(`SELECT ${ITEM_COLS} FROM off_dev_items d WHERE ${where} AND ($2::text IS NULL OR d.status=$2) ORDER BY (d.status='open') DESC, d.due_on NULLS LAST, d.created_at DESC LIMIT $3 OFFSET $4`, [...args, i.status ?? null, i.limit, i.offset]);
    return { total: total.n, items: rows.map(itemView) };
  },
});

// ------------------------------------------------------------------ the official's Home
const OFFICIAL_LIC = `SELECT l.id, l.body_id, bo.name AS body_name, b.abbreviation AS body_abbreviation, l.type_id, t.name AS type_name, t.grade, t.grade_rank, t.sport_id, s.name AS sport_name, t.discipline, l.licence_no, l.public_code, l.status AS recorded_status,
    (${LIC_STATUS('l')}) AS status, l.issued_on::text AS issued_on, l.expires_on::text AS expires_on, l.previous_id, l.submitted_at, l.decision_reason,
    CASE WHEN l.expires_on IS NOT NULL THEN l.expires_on - current_date END AS days_to_expiry
  FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id JOIN sports s ON s.id=t.sport_id JOIN governing_bodies b ON b.id=l.body_id JOIN organisations bo ON bo.id=b.organisation_id
 WHERE l.holder_id=$1 AND t.holder_role='official'`;
const monthsBack = (n) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };

cap({
  name: 'get_my_officials_development', method: 'GET', path: '/me/officials-development', tag: TAG,
  summary: 'The official\'s development home, read live from its sources: current grade and licence with expiry and renewal readiness, the next grade and what is still needed for it, promotion and renewal applications in progress, recent assessments (published to you only) and what awaits your acknowledgement, open development actions, mentor/mentee items, CPD progress, fitness/competency standing, and upcoming observations where your body tells officials. If you are an appointed assessor it also carries your assessor workspace.',
  input: z.object({}),
  async handler({ user }) {
    const lic = (await many(`${OFFICIAL_LIC} AND l.status <> 'withdrawn' ORDER BY t.grade_rank DESC, l.expires_on DESC NULLS LAST`, [user.id])).map(plain);
    const current = lic.filter((l) => l.status === 'active' || l.status === 'suspended');
    const applications = lic.filter((l) => ['draft', 'submitted', 'under_review', 'needs_info'].includes(l.recorded_status));
    const grades = [];
    for (const l of current) {
      const type = (await pool.query('SELECT * FROM fed_licence_types WHERE id=$1', [l.type_id])).rows[0];
      const renewal = await developmentChecks(pool, { holder_id: user.id, body_id: l.body_id, previous_id: l.id }, type, { issuedOn: today() });
      const settings = await liveRequirement(pool, l.type_id);
      const next = (await pool.query(
        `SELECT t.* FROM fed_licence_types t WHERE t.body_id=$1 AND t.sport_id=$2 AND t.holder_role='official' AND t.archived_at IS NULL AND t.grade_rank > $3 ORDER BY t.grade_rank LIMIT 1`, [l.body_id, l.sport_id, l.grade_rank])).rows[0];
      let nextGrade = null;
      if (next) {
        const checks = await developmentChecks(pool, { holder_id: user.id, body_id: l.body_id, previous_id: null }, next, { issuedOn: today() });
        const applied = applications.some((a) => a.type_id === next.id);
        nextGrade = { type_id: next.id, name: next.name, grade: next.grade, has_requirements: !!(await liveRequirement(pool, next.id)), ready: checks.every((x) => x.status === 'pass'), checks, applied };
      }
      grades.push({ ...l, requirements: !!settings, renewal: { ready: renewal.every((x) => x.status === 'pass'), checks: renewal, window_open: l.days_to_expiry != null && l.days_to_expiry <= 90 }, next_grade: nextGrade });
    }
    const recent = (await many(
      `SELECT a.id, a.body_id, a.status, a.published_at, a.current_version, a.grade_label, o.purpose, e.name AS event_name, f.scheduled_at, v.recommendation, a.void_reason,
              NOT EXISTS (SELECT 1 FROM off_assessment_responses r WHERE r.assessment_id=a.id AND r.kind='acknowledgement' AND r.version=a.current_version) AS needs_acknowledgement,
              EXISTS (SELECT 1 FROM off_appeals p WHERE p.assessment_id=a.id AND p.status IN ('lodged','under_review')) AS appeal_open
         FROM off_assessments a JOIN off_observations o ON o.id=a.observation_id JOIN fixtures f ON f.id=a.fixture_id JOIN events e ON e.id=f.event_id LEFT JOIN off_assessment_versions v ON v.assessment_id=a.id AND v.version=a.current_version
        WHERE a.official_id=$1 AND a.published_at IS NOT NULL ORDER BY a.published_at DESC LIMIT 5`, [user.id])).map(plain);
    const items = (await many(`SELECT ${ITEM_COLS} FROM off_dev_items d WHERE d.official_id=$1 AND d.visibility='shared' AND d.status='open' ORDER BY d.due_on NULLS LAST, d.created_at DESC LIMIT 8`, [user.id])).map(itemView);
    const counts = await one(`SELECT count(*) FILTER (WHERE status='open')::int AS open_items, count(*) FILTER (WHERE status='open' AND due_on < current_date)::int AS overdue_items FROM off_dev_items WHERE official_id=$1 AND visibility='shared'`, [user.id]);
    const mentorships = (await many(`SELECT ${MENT_COLS} FROM ${MENT_FROM} WHERE (m.mentor_id=$1 OR m.mentee_id=$1) AND m.status IN ('proposed','active') ORDER BY m.created_at DESC LIMIT 10`, [user.id])).map((r) => ({ ...mentView(r, true), role: r.mentor_id === user.id ? 'mentor' : 'mentee', needs_my_response: r.status === 'proposed' && !(r.mentor_id === user.id ? r.mentor_accepted_at : r.mentee_accepted_at) }));
    const menteeDue = await one(`SELECT count(*)::int AS n FROM off_dev_items d JOIN off_mentorships m ON m.id=d.mentorship_id WHERE m.mentor_id=$1 AND m.status='active' AND d.status='open' AND d.due_on < current_date`, [user.id]);
    const bodies = [...new Set(lic.map((l) => l.body_id))];
    const cpd = [];
    for (const bid of bodies) {
      const types = lic.filter((l) => l.body_id === bid && ['active', 'suspended'].includes(l.status)).map((l) => l.type_id);
      const reqs = (await Promise.all(types.map((t) => liveRequirement(pool, t)))).filter(Boolean);
      const target = Math.max(0, ...reqs.map((r) => Number(r.cpd_hours)));
      const window = reqs.find((r) => Number(r.cpd_hours) === target)?.cpd_window_months ?? 12;
      const verified = await cpdHours(pool, user.id, bid, { since: monthsBack(window), until: today() });
      const pending = (await one("SELECT count(*)::int AS n FROM off_cpd_records WHERE user_id=$1 AND body_id=$2 AND status='recorded'", [user.id, bid])).n;
      cpd.push({ body_id: bid, body_name: lic.find((l) => l.body_id === bid).body_name, verified_hours: verified, required_hours: target, window_months: window, pending_verification: pending });
    }
    const tests = await many(`SELECT DISTINCT t.id, t.name, t.version FROM off_fitness_test_types t WHERE t.body_id = ANY($1) AND t.archived_at IS NULL AND (EXISTS (SELECT 1 FROM off_grade_requirements r WHERE r.fitness_test_type_id=t.id AND r.superseded_at IS NULL) OR EXISTS (SELECT 1 FROM off_fitness_results x WHERE x.test_type_id=t.id AND x.official_id=$2))`, [bodies, user.id]);
    const fitness = [];
    for (const t of tests) fitness.push({ test_id: t.id, name: t.name, version: t.version, ...(await fitnessStanding(pool, user.id, t.id, today())) });
    const upcoming = (await many(
      `SELECT o.id, o.purpose, o.due_on::text AS due_on, e.name AS event_name, f.scheduled_at, o.status FROM off_observations o JOIN fixtures f ON f.id=o.fixture_id JOIN events e ON e.id=f.event_id
        WHERE o.official_id=$1 AND o.status IN ('assigned','accepted') AND COALESCE((SELECT disclose_observation FROM off_settings x WHERE x.body_id=o.body_id), true) ORDER BY f.scheduled_at LIMIT 5`, [user.id])).map(plain);
    const appointments = (await many(`SELECT a.id, a.body_id, bo.name AS body_name, a.sport_id, s.name AS sport_name, a.official_roles, a.max_grade_rank, a.valid_until::text AS valid_until, (${ASSESSOR_STATUS('a')}) AS status
      FROM off_assessors a JOIN governing_bodies b ON b.id=a.body_id JOIN organisations bo ON bo.id=b.organisation_id JOIN sports s ON s.id=a.sport_id WHERE a.user_id=$1 AND a.status <> 'revoked' ORDER BY a.valid_until DESC`, [user.id])).map(plain);
    let assessor = null;
    if (appointments.length) {
      assessor = { appointments, ...(await one(`SELECT count(*) FILTER (WHERE o.status='assigned')::int AS to_accept, count(*) FILTER (WHERE o.status='accepted')::int AS to_assess,
          count(*) FILTER (WHERE o.status IN ('assigned','accepted') AND o.due_on < current_date)::int AS overdue,
          (SELECT count(*)::int FROM off_assessments a WHERE a.assessor_id=$1 AND a.status='draft') AS drafts FROM off_observations o WHERE o.assessor_id=$1`, [user.id])) };
    }
    const settings = await Promise.all(bodies.map(async (bid) => ({ body_id: bid, ...(({ publication, appeal_window_days, disclose_observation }) => ({ publication, appeal_window_days, disclose_observation }))(await settingsOf(pool, bid)) })));
    return {
      has_licence: current.length > 0, grades, applications, recent_assessments: recent, awaiting_acknowledgement: recent.filter((r) => r.status === 'published' && r.needs_acknowledgement).length,
      development: { open_items: counts.open_items, overdue_items: counts.overdue_items, next: items }, mentoring: { items: mentorships, mentee_actions_overdue: menteeDue.n },
      cpd, fitness, upcoming_observations: upcoming, assessor, policy: settings,
    };
  },
});

// ------------------------------------------------------------------ body overview and report
const SUP = 3;
async function overviewFor(ids, { suppress }) {
  const s = (n) => (suppress && n > 0 && n < SUP ? null : n);
  const rows = (rs, key = 'k') => rs.map((r) => ({ ...r, n: s(r.n), suppressed: suppress && r.n > 0 && r.n < SUP }));
  const [obs, ass, apps, assessors, exp, apps2, dist, cpdQ, cpdMeet, fit, ment, trend, rec] = await Promise.all([
    many("SELECT o.status AS k, count(*)::int AS n FROM off_observations o WHERE o.body_id = ANY($1) GROUP BY 1", [ids]),
    many("SELECT a.status AS k, count(*)::int AS n FROM off_assessments a WHERE a.body_id = ANY($1) GROUP BY 1", [ids]),
    many("SELECT p.status AS k, count(*)::int AS n FROM off_appeals p WHERE p.body_id = ANY($1) GROUP BY 1", [ids]),
    many(`SELECT (${ASSESSOR_STATUS('a')}) AS k, count(*)::int AS n FROM off_assessors a WHERE a.body_id = ANY($1) GROUP BY 1`, [ids]),
    one(`SELECT count(*) FILTER (WHERE l.expires_on <= current_date + 30)::int AS d30, count(*) FILTER (WHERE l.expires_on <= current_date + 60)::int AS d60, count(*) FILTER (WHERE l.expires_on <= current_date + 90)::int AS d90
           FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id WHERE l.body_id = ANY($1) AND t.holder_role='official' AND l.status='active' AND l.expires_on >= current_date`, [ids]),
    many(`SELECT l.status AS k, count(*)::int AS n FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id WHERE l.body_id = ANY($1) AND t.holder_role='official' AND l.status IN ('draft','submitted','under_review','needs_info') GROUP BY 1`, [ids]),
    many(`SELECT s.name AS sport, t.name AS grade, t.grade_rank, count(*)::int AS n FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id JOIN sports s ON s.id=t.sport_id WHERE l.body_id = ANY($1) AND t.holder_role='official' AND (${LIC_STATUS('l')})='active' GROUP BY 1,2,3 ORDER BY 1,3`, [ids]),
    one("SELECT count(*)::int AS n FROM off_cpd_records WHERE body_id = ANY($1) AND status='recorded'", [ids]),
    one(`WITH req AS (SELECT l.holder_id, l.body_id, r.cpd_hours, r.cpd_window_months FROM fed_licences l JOIN off_grade_requirements r ON r.licence_type_id=l.type_id AND r.superseded_at IS NULL WHERE l.body_id = ANY($1) AND (${LIC_STATUS('l')})='active' AND r.cpd_hours > 0)
          SELECT count(*)::int AS total, count(*) FILTER (WHERE coalesce((SELECT sum(c.hours) FROM off_cpd_records c WHERE c.user_id=req.holder_id AND c.body_id=req.body_id AND c.status='verified' AND c.completed_on >= current_date - (req.cpd_window_months * 30)), 0) >= req.cpd_hours)::int AS meeting FROM req`, [ids]),
    many(`WITH req AS (SELECT l.holder_id, r.fitness_test_type_id FROM fed_licences l JOIN off_grade_requirements r ON r.licence_type_id=l.type_id AND r.superseded_at IS NULL WHERE l.body_id = ANY($1) AND (${LIC_STATUS('l')})='active' AND r.fitness_test_type_id IS NOT NULL)
          SELECT CASE WHEN x.id IS NULL THEN 'missing' WHEN x.outcome='fail' THEN 'failed' WHEN x.valid_until < current_date THEN 'expired' WHEN x.valid_until <= current_date + 30 THEN 'expiring' ELSE 'valid' END AS k, count(*)::int AS n
            FROM req LEFT JOIN LATERAL (SELECT * FROM off_fitness_results z WHERE z.official_id=req.holder_id AND z.test_type_id=req.fitness_test_type_id AND z.voided_at IS NULL ORDER BY z.taken_on DESC LIMIT 1) x ON true GROUP BY 1`, [ids]),
    one("SELECT count(*)::int AS n FROM off_mentorships WHERE body_id = ANY($1) AND status='active'", [ids]),
    many("SELECT to_char(date_trunc('month', a.submitted_at), 'YYYY-MM') AS month, count(*)::int AS n FROM off_assessments a WHERE a.body_id = ANY($1) AND a.submitted_at >= date_trunc('month', now()) - interval '11 months' AND a.status IN ('submitted','published') GROUP BY 1 ORDER BY 1", [ids]),
    many("SELECT v.recommendation AS k, count(*)::int AS n FROM off_assessments a JOIN off_assessment_versions v ON v.assessment_id=a.id AND v.version=a.current_version WHERE a.body_id = ANY($1) AND a.status='published' GROUP BY 1", [ids]),
  ]);
  const overdue = (await one("SELECT count(*)::int AS n FROM off_observations WHERE body_id = ANY($1) AND status IN ('assigned','accepted') AND due_on < current_date", [ids])).n;
  const awaiting = (await one("SELECT count(*)::int AS n FROM off_assessments WHERE body_id = ANY($1) AND status='submitted'", [ids])).n;
  return {
    observations: { by_status: rows(obs), overdue: s(overdue) }, assessments: { by_status: rows(ass), awaiting_review: s(awaiting), by_recommendation: rows(rec), completed_by_month: rows(trend.map((t) => ({ k: t.month, n: t.n }))) },
    appeals: rows(apps), assessors: rows(assessors),
    renewals: { expiring_30: s(exp.d30), expiring_60: s(exp.d60), expiring_90: s(exp.d90), applications: rows(apps2) },
    grade_distribution: rows(dist), cpd: { awaiting_verification: s(cpdQ.n), officials_with_requirement: s(cpdMeet.total), meeting_requirement: s(cpdMeet.meeting), completion_rate: suppress && cpdMeet.total < SUP ? null : (cpdMeet.total ? Math.round((cpdMeet.meeting / cpdMeet.total) * 100) : null) },
    fitness: rows(fit), mentorships_active: s(ment.n),
  };
}

cap({
  name: 'get_officials_development_overview', method: 'GET', path: '/officials-development/bodies/:id/overview', tag: TAG,
  summary: 'The body\'s officials-development overview: observations and assessments by status (and the review queue), appeals, assessor standing, the licence renewal pipeline, grade distribution, CPD completion, fitness standing, mentoring and a 12-month trend. Transparent counts only: no per-person score, no ranking, no cross-sport rating. Staff of a body above it see roll-ups with groups of fewer than three hidden. `include_descendants` rolls in the bodies beneath it.',
  input: z.object({ id, include_descendants: z.coerce.boolean().default(true) }),
  async handler({ user }, i) {
    const { auth, aggregateOnly } = await reportAuthority(user, i.id);
    const ids = i.include_descendants ? await subtree(i.id) : [i.id];
    const suppress = aggregateOnly || auth.viaAncestor || ids.length > 1; // a roll-up never reveals a group of fewer than three
    return { body_id: i.id, as_of: today(), scope: { bodies: ids.length, include_descendants: i.include_descendants }, suppression: suppress ? { below: SUP } : null, ...(await overviewFor(ids, { suppress })) };
  },
});

cap({
  name: 'export_officials_development_report', method: 'GET', path: '/officials-development/bodies/:id/export', tag: TAG,
  summary: 'Download the overview as a CSV of aggregate counts (reporting roles or licensing staff of the body). Only counts leave the platform (groups under three are blank in a roll-up of several bodies); the export is logged with who, when and a hash of the file.',
  input: z.object({ id, include_descendants: z.coerce.boolean().default(true) }),
  async handler({ user }, i) {
    const { auth, full } = await reportAuthority(user, i.id);
    if (!full) throw forbidden('Your role on this body does not allow exports');
    const ids = i.include_descendants ? await subtree(i.id) : [i.id];
    const o = await overviewFor(ids, { suppress: ids.length > 1 });
    const rows = [];
    const add = (section, key, n) => rows.push({ section, key, count: n });
    for (const [sec, list] of [['observations', o.observations.by_status], ['assessments', o.assessments.by_status], ['recommendations', o.assessments.by_recommendation], ['appeals', o.appeals], ['assessors', o.assessors], ['licence_applications', o.renewals.applications], ['fitness', o.fitness]]) for (const r of list) add(sec, r.k, r.n);
    for (const r of o.grade_distribution) add('grades', `${r.sport} / ${r.grade || 'ungraded'}`, r.n);
    for (const r of o.assessments.completed_by_month) add('assessments_by_month', r.k, r.n);
    add('renewals', 'expiring_30', o.renewals.expiring_30); add('renewals', 'expiring_60', o.renewals.expiring_60); add('renewals', 'expiring_90', o.renewals.expiring_90);
    add('cpd', 'officials_with_requirement', o.cpd.officials_with_requirement); add('cpd', 'meeting_requirement', o.cpd.meeting_requirement); add('cpd', 'awaiting_verification', o.cpd.awaiting_verification);
    add('mentoring', 'active', o.mentorships_active); add('observations', 'overdue', o.observations.overdue);
    const csv = toCsv(['section', 'key', 'count'], rows);
    const sha256 = createHash('sha256').update(csv).digest('hex');
    await tx(async (c) => {
      await c.query('INSERT INTO fed_exports(body_id, report, filters, as_of, row_count, sha256, exported_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [i.id, 'officials_development', { include_descendants: i.include_descendants }, today(), rows.length, sha256, user.id]);
      await audit(c, user.id, 'export_officials_development', 'governing_bodies', i.id);
    });
    return { report: 'officials_development', as_of: today(), rows: rows.length, filename: `${auth.body.abbreviation}-officials-development-${today()}.csv`, sha256, csv };
  },
});
