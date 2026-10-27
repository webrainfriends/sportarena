// Officials Development & Assessment (#486) 1/4: policy, assessor appointments, versioned rubrics and match-observation assignments. Assignments of
// officials to fixtures stay in #88; an observation only *points at* one of those assignments. An assessor never gains any power over the match result,
// the crew or a disciplinary record: nothing here writes to fixtures, fixture_officials or cases.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { bodyById, mustBeActive, today, plain } from '../federation.js';
import { OFFICIAL_ROLES, PURPOSES, ASSESSOR_STATUS, currentGrade, devStaff, inJurisdiction, runsEvent, logOff, historyOf, sealText, CTX, scaleSchema, dimensionSchema } from '../officials-development.js';
import { holdsLicenceUnder } from '../officials-development.js';
import { LIC_STATUS, lineage, subtree } from '../federation.js';

const TAG = 'Officials development';
const text = (n) => z.string().trim().max(n);
const day = z.string().date();
const role = z.enum(OFFICIAL_ROLES);

export const settingsOf = async (c, bodyId) => (await c.query('SELECT * FROM off_settings WHERE body_id=$1', [bodyId])).rows[0]
  ?? { body_id: bodyId, publication: 'on_submit', appeal_window_days: 14, disclose_observation: true };

// ------------------------------------------------------------------ policy
cap({
  name: 'get_officials_development_settings', method: 'GET', path: '/officials-development/bodies/:id/settings', tag: TAG,
  summary: 'How a body publishes formal assessments to the official (straight away, or after its own review), how long an official has to ask for a review or appeal, and whether an official is told in advance that they will be observed. Any signed-in user can read the policy that applies to them.',
  input: z.object({ id }),
  async handler(_ctx, i) { await bodyById(i.id); const s = await settingsOf(pool, i.id); return { body_id: s.body_id, publication: s.publication, appeal_window_days: s.appeal_window_days, disclose_observation: s.disclose_observation }; },
});
cap({
  name: 'save_officials_development_settings', method: 'POST', path: '/officials-development/bodies/:id/settings', tag: TAG,
  summary: 'Set the body\'s assessment policy (licensing officer/admin): `publication` on_submit or after_review, the appeal window in days, and whether officials are told when they are to be observed. Changes apply to assessments submitted afterwards.',
  input: z.object({ id, publication: z.enum(['on_submit', 'after_review']), appeal_window_days: z.number().int().min(1).max(90), disclose_observation: z.boolean() }),
  handler: ({ user }, i) => tx(async (c) => {
    await devStaff(user, i.id, { c });
    await c.query(`INSERT INTO off_settings(body_id, publication, appeal_window_days, disclose_observation, updated_by) VALUES ($1,$2,$3,$4,$5)
                   ON CONFLICT (body_id) DO UPDATE SET publication=$2, appeal_window_days=$3, disclose_observation=$4, updated_by=$5, updated_at=now()`, [i.id, i.publication, i.appeal_window_days, i.disclose_observation, user.id]);
    await logOff(c, i.id, 'settings', i.id, 'saved', { actor: user.id, detail: { publication: i.publication, appeal_window_days: i.appeal_window_days, disclose_observation: i.disclose_observation } });
    return settingsOf(c, i.id);
  }),
});

// ------------------------------------------------------------------ assessors
const ASSESSOR_COLS = `a.id, a.body_id, a.user_id, u.display_name AS assessor_name, u.handle AS assessor_handle, a.sport_id, s.name AS sport_name, a.discipline, a.official_roles, a.max_grade_rank, a.scope_event_id, e.name AS scope_event_name,
  a.credential_licence_id, cl.licence_no AS credential_licence_no, a.valid_from::text AS valid_from, a.valid_until::text AS valid_until, a.status AS recorded_status, ${ASSESSOR_STATUS('a')} AS status, a.status_reason, a.created_at`;
const ASSESSOR_FROM = 'off_assessors a JOIN users u ON u.id=a.user_id JOIN sports s ON s.id=a.sport_id LEFT JOIN events e ON e.id=a.scope_event_id JOIN fed_licences cl ON cl.id=a.credential_licence_id';
export const assessorRow = async (aid, c = pool) => (await c.query(`SELECT ${ASSESSOR_COLS} FROM ${ASSESSOR_FROM} WHERE a.id=$1`, [aid])).rows[0];

cap({
  name: 'appoint_assessor', method: 'POST', path: '/officials-development/bodies/:id/assessors', tag: TAG, status: 201,
  summary: 'Appoint a verified assessor/observer (licensing officer/admin). Authority is explicit and narrow: the sport, the official roles they may assess, the highest grade, an optional single competition, and a validity period. It rests on the person\'s own current licence from the federation system, so it lapses the moment that licence does. Being a referee grants nothing by itself.',
  input: z.object({ id, user_id: id, sport_id: id, discipline: text(60).default(''), official_roles: z.array(role).min(1).default(OFFICIAL_ROLES), max_grade_rank: z.number().int().min(0).max(20).default(20), scope_event_id: id.optional(),
    credential_licence_id: id.optional().describe('the assessor\'s own current licence this appointment rests on; defaults to their highest current licence in this sport from this body or one above or beneath it'), valid_from: day.optional(), valid_until: day }),
  handler: ({ user }, i) => tx(async (c) => {
    await devStaff(user, i.id, { c, sportId: i.sport_id });
    mustBeActive(await bodyById(i.id, c));
    if (!(await c.query('SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL', [i.id, i.sport_id])).rowCount) throw badRequest('That sport is not one this body governs');
    const from = i.valid_from ?? today();
    if (i.valid_until < from) throw badRequest('The appointment ends before it starts');
    if (i.valid_until > `${Number(from.slice(0, 4)) + 3}${from.slice(4)}`) throw badRequest('An appointment lasts at most three years; renew it instead');
    if (!i.credential_licence_id) {
      const near = [...new Set([...(await lineage(i.id, c)), ...(await subtree(i.id, c))])];
      i.credential_licence_id = (await c.query(`SELECT l.id FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id WHERE l.holder_id=$1 AND l.body_id = ANY($2) AND t.sport_id=$3 AND (${LIC_STATUS('l')})='active' ORDER BY t.grade_rank DESC, l.expires_on DESC LIMIT 1`, [i.user_id, near, i.sport_id])).rows[0]?.id;
      if (!i.credential_licence_id) throw badRequest('That person has no current licence in this sport from this body (or one above or beneath it) to rest an appointment on');
    }
    const lic = (await c.query(`SELECT l.id, l.holder_id, l.body_id, t.sport_id, (${LIC_STATUS('l')}) AS st FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id WHERE l.id=$1`, [i.credential_licence_id])).rows[0];
    if (!lic || lic.holder_id !== i.user_id) throw badRequest('That licence does not belong to the person being appointed');
    if (lic.st !== 'active') throw badRequest('That licence is not current');
    if (lic.sport_id !== i.sport_id) throw badRequest('That licence is for a different sport');
    if (!(await holdsLicenceUnder(c, i.user_id, i.id, { currentOnly: true }))) throw badRequest('The licence must come from this body, or one above or beneath it');
    if (i.scope_event_id && !(await c.query('SELECT 1 FROM events WHERE id=$1 AND sport_id=$2', [i.scope_event_id, i.sport_id])).rowCount) throw badRequest('That competition is not in this sport');
    let a;
    try {
      a = (await c.query('INSERT INTO off_assessors(body_id, user_id, sport_id, discipline, official_roles, max_grade_rank, scope_event_id, credential_licence_id, valid_from, valid_until, appointed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
        [i.id, i.user_id, i.sport_id, i.discipline, i.official_roles, i.max_grade_rank, i.scope_event_id ?? null, i.credential_licence_id, from, i.valid_until, user.id])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('That person already holds a live appointment with the same scope'); throw e; }
    await logOff(c, i.id, 'assessor', a.id, 'appointed', { to: 'active', actor: user.id });
    await notify(c, i.user_id, { kind: 'official_assessor_appointed', title: 'Appointed as an assessor', body: 'You can now be assigned to observe and assess officials within your appointment.', data: { assessor_id: a.id, body_id: i.id }, dedupe_key: `off-assessor:${a.id}` });
    await audit(c, user.id, 'official_assessor_appointed', 'off_assessors', a.id);
    return plain(await assessorRow(a.id, c));
  }),
});

cap({
  name: 'decide_assessor', method: 'POST', path: '/officials-development/assessors/:id/decision', tag: TAG,
  summary: 'Suspend, reinstate or revoke an assessor appointment (licensing officer/admin), with a reason. Assessments already submitted stay as they are; the assessor cannot start or submit new ones while suspended or revoked.',
  input: z.object({ id, action: z.enum(['suspend', 'reinstate', 'revoke']), reason: text(500).min(3) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = (await c.query('SELECT * FROM off_assessors WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!a) throw notFound('Assessor appointment');
    await devStaff(user, a.body_id, { c, sportId: a.sport_id });
    const to = { suspend: 'suspended', reinstate: 'active', revoke: 'revoked' }[i.action];
    if (i.action === 'suspend' && a.status !== 'active') throw conflict(`This appointment is ${a.status}`);
    if (i.action === 'reinstate' && a.status !== 'suspended') throw conflict('Only a suspended appointment can be reinstated');
    if (i.action === 'revoke' && a.status === 'revoked') throw conflict('Already revoked');
    await c.query('UPDATE off_assessors SET status=$2, status_reason=$3, ended_at=CASE WHEN $2=\'revoked\' THEN now() ELSE NULL END WHERE id=$1', [a.id, to, i.reason]);
    await logOff(c, a.body_id, 'assessor', a.id, i.action, { from: a.status, to, actor: user.id, reason: i.reason });
    await notify(c, a.user_id, { kind: `official_assessor_${i.action}`, title: `Assessor appointment ${to}`, body: i.reason, data: { assessor_id: a.id }, dedupe_key: `off-assessor-${i.action}:${a.id}:${Date.now()}` });
    return plain(await assessorRow(a.id, c));
  }),
});

cap({
  name: 'list_assessors', method: 'GET', path: '/officials-development/bodies/:id/assessors', tag: TAG,
  summary: 'The body\'s assessor appointments with their live standing (active, suspended, revoked, expired, or lapsed because the licence they rest on no longer is). Licensing officer/admin.',
  input: z.object({ id, sport_id: id.optional(), status: z.enum(['active', 'suspended', 'revoked', 'expired', 'lapsed', 'pending']).optional(), ...page }),
  async handler({ user }, i) {
    await devStaff(user, i.id);
    const w = `a.body_id=$1 AND ($2::uuid IS NULL OR a.sport_id=$2) AND ($3::text IS NULL OR (${ASSESSOR_STATUS('a')})=$3)`;
    const total = await one(`SELECT count(*)::int AS n FROM ${ASSESSOR_FROM} WHERE ${w}`, [i.id, i.sport_id ?? null, i.status ?? null]);
    const items = await many(`SELECT ${ASSESSOR_COLS} FROM ${ASSESSOR_FROM} WHERE ${w} ORDER BY u.display_name, a.created_at LIMIT $4 OFFSET $5`, [i.id, i.sport_id ?? null, i.status ?? null, i.limit, i.offset]);
    return { total: total.n, items: items.map(plain) };
  },
});

// ------------------------------------------------------------------ rubrics
const withLatest = `SELECT r.*, s.name AS sport_name, v.id AS version_id, v.version, v.scale, v.dimensions, v.published_at AS version_published_at
  FROM off_rubrics r JOIN sports s ON s.id=r.sport_id LEFT JOIN LATERAL (SELECT * FROM off_rubric_versions x WHERE x.rubric_id=r.id ORDER BY x.version DESC LIMIT 1) v ON true`;

cap({
  name: 'save_rubric', method: 'POST', path: '/officials-development/bodies/:id/rubrics', tag: TAG, status: 201,
  summary: 'Define an assessment rubric for a sport and official role, for a range of grades (licensing officer/admin). Pass `rubric_id` to rename, change the grade range or archive it. Its scale and dimensions are published as immutable versions with publish_rubric_version.',
  input: z.object({ id, rubric_id: id.optional(), sport_id: id, official_role: role, name: text(80).min(2), min_grade_rank: z.number().int().min(0).max(20).default(0), max_grade_rank: z.number().int().min(0).max(20).default(20), archived: z.boolean().optional() })
    .refine((r) => r.max_grade_rank >= r.min_grade_rank, 'The highest grade is below the lowest'),
  handler: ({ user }, i) => tx(async (c) => {
    await devStaff(user, i.id, { c, sportId: i.sport_id });
    if (!(await c.query('SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL', [i.id, i.sport_id])).rowCount) throw badRequest('That sport is not one this body governs');
    let r;
    try {
      if (i.rubric_id) {
        r = (await c.query('UPDATE off_rubrics SET name=$3, min_grade_rank=$4, max_grade_rank=$5, archived_at=CASE WHEN $6::boolean THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1 AND body_id=$2 RETURNING id', [i.rubric_id, i.id, i.name, i.min_grade_rank, i.max_grade_rank, !!i.archived])).rows[0];
        if (!r) throw notFound('Rubric');
      } else {
        r = (await c.query('INSERT INTO off_rubrics(body_id, sport_id, official_role, name, min_grade_rank, max_grade_rank, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [i.id, i.sport_id, i.official_role, i.name, i.min_grade_rank, i.max_grade_rank, user.id])).rows[0];
      }
    } catch (e) { if (e.code === '23505') throw conflict('There is already a rubric with that name for this sport and role'); throw e; }
    await logOff(c, i.id, 'rubric', r.id, i.rubric_id ? (i.archived ? 'archived' : 'updated') : 'created', { actor: user.id });
    return (await c.query(`${withLatest} WHERE r.id=$1`, [r.id])).rows[0];
  }),
});

cap({
  name: 'publish_rubric_version', method: 'POST', path: '/officials-development/rubrics/:id/versions', tag: TAG, status: 201,
  summary: 'Publish the next immutable version of a rubric (licensing officer/admin): a scale with a definition for every point, and dimensions (rules/laws, positioning, decision process, communication, teamwork, match control, administration, or sport-specific) each with a description, the evidence expected, whether evidence is required and whether N/A is allowed. Assessments in progress or done keep the version they started on.',
  input: z.object({ id, scale: scaleSchema, dimensions: z.array(dimensionSchema).min(2).max(30) }),
  handler: ({ user }, i) => tx(async (c) => {
    const r = (await c.query('SELECT * FROM off_rubrics WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!r) throw notFound('Rubric');
    await devStaff(user, r.body_id, { c, sportId: r.sport_id });
    if (r.archived_at) throw conflict('This rubric is archived');
    const keys = i.dimensions.map((d) => d.key);
    if (new Set(keys).size !== keys.length) throw badRequest('Each dimension needs its own key');
    const n = (await c.query('SELECT coalesce(max(version),0)+1 AS n FROM off_rubric_versions WHERE rubric_id=$1', [r.id])).rows[0].n;
    const v = (await c.query('INSERT INTO off_rubric_versions(rubric_id, version, scale, dimensions, published_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, version', [r.id, n, i.scale, JSON.stringify(i.dimensions), user.id])).rows[0];
    await logOff(c, r.body_id, 'rubric', r.id, 'version_published', { actor: user.id, detail: { version: v.version, version_id: v.id } });
    return (await c.query(`${withLatest} WHERE r.id=$1`, [r.id])).rows[0];
  }),
});

cap({
  name: 'list_rubrics', method: 'GET', path: '/officials-development/bodies/:id/rubrics', tag: TAG,
  summary: 'The body\'s assessment rubrics with their latest version, so officials can see exactly what they are assessed against. `version_id` returns that historical version instead.',
  input: z.object({ id, sport_id: id.optional(), official_role: role.optional(), include_archived: z.coerce.boolean().default(false), version_id: id.optional() }),
  async handler(_ctx, i) {
    await bodyById(i.id);
    const rows = await many(`${withLatest} WHERE r.body_id=$1 AND ($2::uuid IS NULL OR r.sport_id=$2) AND ($3::text IS NULL OR r.official_role=$3) AND ($4 OR r.archived_at IS NULL) ORDER BY s.name, r.official_role, r.min_grade_rank, r.name`, [i.id, i.sport_id ?? null, i.official_role ?? null, i.include_archived]);
    if (!i.version_id) return rows;
    const v = await one('SELECT v.* FROM off_rubric_versions v JOIN off_rubrics r ON r.id=v.rubric_id WHERE v.id=$1 AND r.body_id=$2', [i.version_id, i.id]);
    if (!v) throw notFound('Rubric version');
    return [{ ...rows.find((r) => r.id === v.rubric_id), version_id: v.id, version: v.version, scale: v.scale, dimensions: v.dimensions, version_published_at: v.published_at }];
  },
});

// ------------------------------------------------------------------ observations
const OBS_COLS = `o.id, o.body_id, bo.name AS body_name, o.fixture_id, o.fixture_official_id, o.official_id, ou.display_name AS official_name, o.assessor_id, au.display_name AS assessor_name, o.sport_id, s.name AS sport_name, o.official_role,
  o.assigned_by, o.purpose, o.purpose_note, o.due_on::text AS due_on, o.status, o.coi_declared, o.accepted_at, o.created_at, o.closed_at, o.row_version, f.scheduled_at, f.round, f.status AS fixture_status, e.id AS event_id, e.name AS event_name,
  (o.due_on IS NOT NULL AND o.due_on < current_date AND o.status IN ('assigned','accepted')) AS overdue, a.id AS assessment_id, a.status AS assessment_status`;
const OBS_FROM = `off_observations o JOIN governing_bodies b ON b.id=o.body_id JOIN organisations bo ON bo.id=b.organisation_id JOIN users ou ON ou.id=o.official_id JOIN users au ON au.id=o.assessor_id JOIN sports s ON s.id=o.sport_id
  JOIN fixtures f ON f.id=o.fixture_id JOIN events e ON e.id=f.event_id LEFT JOIN off_assessments a ON a.observation_id=o.id`;
export const observationRow = async (oid, c = pool) => (await c.query(`SELECT ${OBS_COLS} FROM ${OBS_FROM} WHERE o.id=$1`, [oid])).rows[0];

/** The live appointment that lets `assessorId` assess this official in this event, or null. */
export async function appointmentFor(c, { bodyId, assessorId, sportId, officialRole, eventId, officialId }) {
  const a = (await c.query(
    `SELECT a.* FROM off_assessors a WHERE a.body_id=$1 AND a.user_id=$2 AND a.sport_id=$3 AND (${ASSESSOR_STATUS('a')})='active' AND $4 = ANY(a.official_roles) AND (a.scope_event_id IS NULL OR a.scope_event_id=$5)
      ORDER BY (a.scope_event_id IS NULL) LIMIT 1`, [bodyId, assessorId, sportId, officialRole, eventId])).rows[0];
  if (!a) return null;
  const rank = (await currentGrade(officialId, sportId, c))?.grade_rank ?? 0;
  return rank <= a.max_grade_rank ? a : null;
}

cap({
  name: 'list_observable_assignments', method: 'GET', path: '/officials-development/bodies/:id/assignments', tag: TAG,
  summary: 'The confirmed official assignments (from #88) a body can have observed: fixtures from the last 45 days to the next 120 in its sports, where the event is sanctioned by the body (or one beneath it) or the official is licensed by it. Pick one to assign an assessor; each shows how many observations it already has. Licensing officer/admin.',
  input: z.object({ id, q: text(80).optional(), sport_id: id.optional(), unobserved: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    await devStaff(user, i.id);
    const ids = await subtree(i.id);
    const w = `fo.status IN ('accepted','completed') AND f.status <> 'cancelled' AND f.scheduled_at BETWEEN now() - interval '45 days' AND now() + interval '120 days'
      AND e.sport_id IN (SELECT sport_id FROM governing_body_sports WHERE body_id = ANY($1) AND ended_on IS NULL) AND ($2::uuid IS NULL OR e.sport_id=$2)
      AND (EXISTS (SELECT 1 FROM fed_sanctions sa WHERE sa.event_id=e.id AND sa.body_id = ANY($1) AND sa.status IN ('approved','suspended'))
        OR EXISTS (SELECT 1 FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id WHERE l.holder_id=fo.user_id AND l.body_id = ANY($1) AND t.holder_role='official' AND (${LIC_STATUS('l')})='active'))
      AND ($3::text IS NULL OR u.display_name ILIKE '%'||$3||'%' OR e.name ILIKE '%'||$3||'%')
      AND ($4::boolean IS NOT TRUE OR NOT EXISTS (SELECT 1 FROM off_observations o WHERE o.fixture_official_id=fo.id AND o.status IN ('assigned','accepted','completed')))`;
    const from = 'fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id JOIN events e ON e.id=f.event_id JOIN users u ON u.id=fo.user_id LEFT JOIN teams ht ON ht.id=f.home_team_id LEFT JOIN teams at ON at.id=f.away_team_id';
    const a = [ids, i.sport_id ?? null, i.q || null, i.unobserved];
    const total = await one(`SELECT count(*)::int AS n FROM ${from} WHERE ${w}`, a);
    const items = await many(`SELECT fo.id AS fixture_official_id, fo.role, fo.user_id AS official_id, u.display_name AS official_name, f.id AS fixture_id, f.scheduled_at, f.round, f.status AS fixture_status, e.id AS event_id, e.name AS event_name, e.sport_id,
        ht.name AS home_team, at.name AS away_team, (SELECT count(*)::int FROM off_observations o WHERE o.fixture_official_id=fo.id AND o.status IN ('assigned','accepted','completed')) AS observations
      FROM ${from} WHERE ${w} ORDER BY f.scheduled_at LIMIT $5 OFFSET $6`, [...a, i.limit, i.offset]);
    return { total: total.n, items: items.map(plain) };
  },
});

cap({
  name: 'assign_observation', method: 'POST', path: '/officials-development/observations', tag: TAG, status: 201,
  summary: 'Assign an appointed assessor to observe one confirmed official on an existing fixture (the body\'s licensing staff, or the organiser of an event the body has sanctioned). It points at the #88 assignment and changes nothing about it, the result or any case. The assessor must be a live appointee for that sport, role, grade and competition, and cannot be on the match crew. The assessor accepts with a conflict-of-interest declaration.',
  input: z.object({ body_id: id, fixture_official_id: id, assessor_id: id, purpose: z.enum(PURPOSES), purpose_note: text(300).optional(), due_on: day.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const fo = (await c.query('SELECT * FROM fixture_officials WHERE id=$1', [i.fixture_official_id])).rows[0];
    if (!fo) throw notFound('Official assignment');
    const f = (await c.query('SELECT * FROM fixtures WHERE id=$1', [fo.fixture_id])).rows[0];
    const ev = (await c.query('SELECT * FROM events WHERE id=$1', [f.event_id])).rows[0];
    const auth = await devStaff(user, i.body_id, { c, sportId: ev.sport_id, optional: true });
    const organiser = await runsEvent(user, ev, c);
    if (!auth?.staff && !organiser) throw auth ? forbidden(`Your role on ${auth.body.name} does not allow that`) : notFound('Official assignment');
    mustBeActive(await bodyById(i.body_id, c));
    if (!['accepted', 'completed'].includes(fo.status)) throw conflict('Only an official who confirmed the assignment can be observed');
    if (f.status === 'cancelled') throw conflict('That fixture was cancelled');
    const why = await inJurisdiction(c, i.body_id, { eventId: ev.id, officialId: fo.user_id });
    if (!why) throw badRequest('That fixture is outside this body\'s jurisdiction: it has not sanctioned the event and does not license the official');
    if (!auth?.staff && why !== 'sanctioned') throw forbidden('An organiser can assign assessors from the body that sanctioned the event');
    if (i.assessor_id === fo.user_id) throw badRequest('Nobody assesses themselves');
    if ((await c.query("SELECT 1 FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2 AND status IN ('invited','accepted','completed')", [f.id, i.assessor_id])).rowCount) throw badRequest('The assessor is on this match\'s crew');
    const appt = await appointmentFor(c, { bodyId: i.body_id, assessorId: i.assessor_id, sportId: ev.sport_id, officialRole: fo.role, eventId: ev.id, officialId: fo.user_id });
    if (!appt) throw badRequest('That person is not a live assessor for this sport, role, grade and competition');
    let o;
    try {
      o = (await c.query(`INSERT INTO off_observations(body_id, fixture_id, fixture_official_id, official_id, assessor_id, assessor_appointment_id, sport_id, official_role, purpose, purpose_note, due_on, assigned_by)
                          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [i.body_id, f.id, fo.id, fo.user_id, i.assessor_id, appt.id, ev.sport_id, fo.role, i.purpose, i.purpose_note || null, i.due_on ?? null, user.id])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('That assessor is already assigned to observe this official at this match'); throw e; }
    await logOff(c, i.body_id, 'observation', o.id, 'assigned', { to: 'assigned', actor: user.id, detail: { purpose: i.purpose, fixture_id: f.id } });
    await notify(c, i.assessor_id, { kind: 'official_observation_assigned', title: 'You are asked to assess a match', body: `${ev.name}: accept with your conflict-of-interest declaration.`, data: { observation_id: o.id }, dedupe_key: `off-obs-assigned:${o.id}` });
    if ((await settingsOf(c, i.body_id)).disclose_observation) await notify(c, fo.user_id, { kind: 'official_observation_scheduled', title: 'You will be observed', body: `An assessor will observe you at ${ev.name}.`, data: { observation_id: o.id }, dedupe_key: `off-obs-official:${o.id}` });
    return observationRow(o.id, c);
  }),
});

cap({
  name: 'respond_observation', method: 'POST', path: '/officials-development/observations/:id/respond', tag: TAG,
  summary: 'The assigned assessor accepts or declines. Accepting needs an explicit declaration of no conflict of interest; declaring a conflict declines the assignment and tells the body to reassign. The declaration note is private to the assessor and the body.',
  input: z.object({ id, response: z.enum(['accept', 'decline']), conflict: z.enum(['none', 'declared']), conflict_note: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const o = (await c.query('SELECT * FROM off_observations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!o || o.assessor_id !== user.id) throw notFound('Observation');
    if (o.status !== 'assigned') throw conflict(`This assignment is ${o.status}`);
    if (i.response === 'accept' && i.conflict !== 'none') throw badRequest('Declare no conflict of interest to accept; if you have one, decline');
    if (i.conflict === 'declared' && !i.conflict_note?.trim()) throw badRequest('Say what the conflict is');
    if (i.response === 'accept') {
      const ev = (await c.query('SELECT e.* FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1', [o.fixture_id])).rows[0];
      if (!(await appointmentFor(c, { bodyId: o.body_id, assessorId: user.id, sportId: o.sport_id, officialRole: o.official_role, eventId: ev.id, officialId: o.official_id }))) throw conflict('Your appointment is no longer live for this assignment');
    }
    const to = i.response === 'accept' ? 'accepted' : 'declined';
    await c.query('UPDATE off_observations SET status=$2, coi_declared=$3, coi_note_enc=$4, accepted_at=CASE WHEN $2=\'accepted\' THEN now() ELSE NULL END, closed_at=CASE WHEN $2=\'declined\' THEN now() ELSE NULL END, row_version=row_version+1 WHERE id=$1',
      [o.id, to, i.conflict === 'declared', sealText(i.conflict_note?.trim(), CTX.coi)]);
    await logOff(c, o.body_id, 'observation', o.id, i.response === 'accept' ? 'accepted' : (i.conflict === 'declared' ? 'declined_conflict' : 'declined'), { from: 'assigned', to, actor: user.id, detail: { conflict: i.conflict } });
    if (to === 'declined') await notify(c, o.assigned_by, { kind: 'official_observation_declined', title: i.conflict === 'declared' ? 'Assessor declared a conflict of interest' : 'Assessor declined', body: 'Assign another assessor.', data: { observation_id: o.id }, dedupe_key: `off-obs-declined:${o.id}` });
    return observationRow(o.id, c);
  }),
});

cap({
  name: 'cancel_observation', method: 'POST', path: '/officials-development/observations/:id/cancel', tag: TAG,
  summary: 'Cancel an observation that has not produced a submitted assessment (the body\'s licensing staff or the event organiser) with a reason. The record stays.',
  input: z.object({ id, reason: text(300).min(3) }),
  handler: ({ user }, i) => tx(async (c) => {
    const o = (await c.query('SELECT * FROM off_observations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!o) throw notFound('Observation');
    const ev = (await c.query('SELECT e.* FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1', [o.fixture_id])).rows[0];
    const auth = await devStaff(user, o.body_id, { c, sportId: o.sport_id, optional: true });
    if (!auth?.staff && !(await runsEvent(user, ev, c))) throw notFound('Observation');
    if (!['assigned', 'accepted'].includes(o.status)) throw conflict(`This assignment is ${o.status}`);
    if ((await c.query("SELECT 1 FROM off_assessments WHERE observation_id=$1 AND status IN ('submitted','published')", [o.id])).rowCount) throw conflict('An assessment was already submitted for this observation');
    await c.query("UPDATE off_observations SET status='cancelled', closed_at=now(), row_version=row_version+1 WHERE id=$1", [o.id]);
    await logOff(c, o.body_id, 'observation', o.id, 'cancelled', { from: o.status, to: 'cancelled', actor: user.id, reason: i.reason });
    await notify(c, o.assessor_id, { kind: 'official_observation_cancelled', title: 'Assessment assignment cancelled', body: i.reason, data: { observation_id: o.id }, dedupe_key: `off-obs-cancelled:${o.id}` });
    return observationRow(o.id, c);
  }),
});

cap({
  name: 'list_observations', method: 'GET', path: '/officials-development/observations', tag: TAG,
  summary: 'Observation assignments. As an assessor pass `as_assessor` (yours); as the official pass `mine` (only where the body tells officials in advance); as the body\'s licensing staff pass `body_id`. Filter by status, overdue or purpose.',
  input: z.object({ body_id: id.optional(), as_assessor: z.coerce.boolean().optional(), mine: z.coerce.boolean().optional(), status: z.enum(['assigned', 'accepted', 'declined', 'completed', 'cancelled']).optional(), overdue: z.coerce.boolean().optional(), purpose: z.enum(PURPOSES).optional(), ...page }),
  async handler({ user }, i) {
    if (!i.body_id && !i.as_assessor && !i.mine) throw badRequest('Give body_id, as_assessor or mine');
    if (i.body_id) await devStaff(user, i.body_id);
    const w = `($1::uuid IS NULL OR o.body_id=$1) AND ($2::uuid IS NULL OR o.assessor_id=$2) AND ($3::uuid IS NULL OR (o.official_id=$3 AND COALESCE((SELECT disclose_observation FROM off_settings x WHERE x.body_id=o.body_id), true))) AND ($4::text IS NULL OR o.status=$4)
      AND ($5::boolean IS NOT TRUE OR (o.due_on < current_date AND o.status IN ('assigned','accepted'))) AND ($6::text IS NULL OR o.purpose=$6)`;
    const a = [i.body_id ?? null, i.as_assessor ? user.id : null, i.mine ? user.id : null, i.status ?? null, i.overdue ?? null, i.purpose ?? null];
    const total = await one(`SELECT count(*)::int AS n FROM ${OBS_FROM} WHERE ${w}`, a);
    const items = await many(`SELECT ${OBS_COLS} FROM ${OBS_FROM} WHERE ${w} ORDER BY (o.status IN ('assigned','accepted')) DESC, o.due_on NULLS LAST, f.scheduled_at DESC LIMIT $7 OFFSET $8`, [...a, i.limit, i.offset]);
    return { total: total.n, items: items.map(plain) };
  },
});

cap({
  name: 'get_observation', method: 'GET', path: '/officials-development/observations/:id', tag: TAG,
  summary: 'One observation with its history: the assigned assessor, the body\'s licensing staff, the event organiser who assigned it, and the official (only where the body discloses observations).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const o = await observationRow(i.id);
    if (!o) throw notFound('Observation');
    const staff = (await devStaff(user, o.body_id, { optional: true, sportId: o.sport_id }))?.staff;
    const official = o.official_id === user.id && (await settingsOf(pool, o.body_id)).disclose_observation;
    if (o.assessor_id !== user.id && o.assigned_by !== user.id && !staff && !official) throw notFound('Observation');
    return { ...plain(o), as: { assessor: o.assessor_id === user.id, staff: !!staff, official: o.official_id === user.id }, history: await historyOf('observation', o.id) };
  },
});
