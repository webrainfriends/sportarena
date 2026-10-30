// Federation & Governing Body OS (#475): governing requirements (versioned administrative policy), the federation's own dates, and the governance
// calendar. Playing and scoring rules stay in the governed rulebook (#68); this owns the administrative requirements around them. The calendar
// REFERENCES canonical sources (sanctioned events, affiliations, licences) and adds only dates the federation itself sets (windows, congress, deadlines).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { gate } from '../federation-approvals.js';
import { LIC_STATUS, AFF_STATUS, POLICY_KINDS, authority, need, bodyById, mustBeActive, lockBody, lineage, subtree, logFed, historyOf, policyAt, paramsOf, today } from '../federation.js';

const TAG = 'Federation';
const text = (n) => z.string().trim().max(n);
const day = z.string().date();
const year = z.number().int().min(1990).max(2200);
const KIND = z.enum(Object.keys(POLICY_KINDS));
const DATE_KINDS = ['registration_window', 'transfer_window', 'congress', 'administrative', 'official_development', 'assessment', 'deadline'];
export const DATE_LABEL = { registration_window: 'Registration window', transfer_window: 'Transfer window', congress: 'Congress', administrative: 'Administrative date', official_development: 'Official development', assessment: 'Assessment', deadline: 'Deadline', sanctioned_competition: 'Sanctioned competition', licence_renewal: 'Licence expiries', affiliation_renewal: 'Affiliation expiries' };

// ------------------------------------------------------------------ policies
const POL_COLS = 'p.id, p.body_id, p.kind, p.title, p.sport_id, s.name AS sport_name, p.category, p.season_year, p.status, p.local_override, p.created_at';
const polFrom = 'fed_policies p LEFT JOIN sports s ON s.id=p.sport_id';
const VER_COLS = 'v.id, v.version, v.effective_from::text AS effective_from, v.summary, v.params, v.published_by, v.created_at';

cap({
  name: 'save_federation_policy', method: 'POST', path: '/federation/bodies/:id/policies', tag: TAG, status: 201,
  summary: 'Open a governing requirement for a body (secretary/admin): its kind (affiliation, licence, sanctioning conditions, eligibility, roster limits, competition entry, official grades, registration, transfers, discipline, para-classification), and the sport, category and season it applies to. One active policy per kind and scope; its wording is then published as dated versions (publish_policy_version). Playing and scoring rules belong to the rulebook, not here.',
  input: z.object({ id, kind: KIND, title: text(120).min(2), sport_id: id.optional(), category: text(60).default(''), season_year: year.optional(), local_override: z.enum(['allowed', 'locked']).default('allowed').describe('locked: nobody beneath this body may publish their own version of this requirement') }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await authority(user, i.id, { c });
    need(a, 'governance', i.sport_id ?? null);
    const above = (await lineage(i.id, c)).filter((x) => x !== i.id);
    if (above.length && (await c.query("SELECT 1 FROM fed_policies WHERE body_id = ANY($1) AND kind=$2 AND status='active' AND local_override='locked' AND (sport_id IS NULL OR sport_id IS NOT DISTINCT FROM $3) LIMIT 1", [above, i.kind, i.sport_id ?? null])).rowCount) throw conflict('A body above has locked this requirement; it cannot be overridden locally', { code: 'policy_locked' });
    if (i.sport_id && !(await c.query('SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL', [i.id, i.sport_id])).rowCount) throw badRequest('That sport is not one this body governs');
    let p;
    try { p = (await c.query('INSERT INTO fed_policies(body_id, kind, title, sport_id, category, season_year, created_by, local_override) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [i.id, i.kind, i.title, i.sport_id ?? null, i.category, i.season_year ?? null, user.id, i.local_override])).rows[0]; }
    catch (e) { if (e.code === '23505') throw conflict('There is already an active policy of this kind for that sport, category and season'); throw e; }
    await logFed(c, i.id, 'policy', p.id, 'created', { to: 'active', actor: user.id, detail: { kind: i.kind } });
    return p;
  }),
});

cap({
  name: 'publish_policy_version', method: 'POST', path: '/federation/policies/:id/versions', tag: TAG, status: 201,
  summary: 'Publish the next version of a requirement with the date it takes effect (secretary/admin). Versions are immutable and never edited: decisions made earlier keep the version they used, and decisions from the effective date on use this one. The date must be later than the previous version\'s.',
  input: z.object({ id, effective_from: day, summary: text(1000).optional(), params: z.record(z.string(), z.any()).default({}), approval_id: id.optional().describe('the second person\'s approval, where the body requires four eyes') }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query('SELECT * FROM fed_policies WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!p) throw notFound('Policy');
    const a = await authority(user, p.body_id, { c });
    need(a, 'governance', p.sport_id);
    if (p.status !== 'active') throw conflict('This policy is retired');
    const parsed = POLICY_KINDS[p.kind].params.safeParse(i.params);
    if (!parsed.success) throw badRequest(parsed.error.issues.map((x) => `${x.path.join('.') || 'params'}: ${x.message}`).join('; '));
    const last = (await c.query('SELECT version, effective_from::text AS effective_from FROM fed_policy_versions WHERE policy_id=$1 ORDER BY version DESC LIMIT 1', [p.id])).rows[0];
    if (last && i.effective_from <= last.effective_from) throw conflict(`The new version must take effect after version ${last.version} (${last.effective_from})`);
    await gate(c, user, { bodyId: p.body_id, actions: ['policy_publish'], subjectType: 'policy', subjectId: p.id, request: { effective_from: i.effective_from, params: parsed.data }, approvalId: i.approval_id });
    const v = (await c.query('INSERT INTO fed_policy_versions(policy_id, version, effective_from, summary, params, published_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, version, effective_from::text AS effective_from, summary, params, created_at',
      [p.id, (last?.version ?? 0) + 1, i.effective_from, i.summary || null, parsed.data, user.id])).rows[0];
    await logFed(c, p.body_id, 'policy', p.id, 'version_published', { actor: user.id, detail: { version: v.version, effective_from: v.effective_from } });
    return { ...v, policy_id: p.id, kind: p.kind, enforced: POLICY_KINDS[p.kind].enforced };
  }),
});

cap({
  name: 'retire_federation_policy', method: 'POST', path: '/federation/policies/:id/retire', tag: TAG,
  summary: 'Retire a requirement (secretary/admin). Its versions stay, and decisions made under them keep pointing at them.',
  input: z.object({ id, reason: text(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query('SELECT * FROM fed_policies WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!p) throw notFound('Policy');
    need(await authority(user, p.body_id, { c }), 'governance', p.sport_id);
    if (p.status === 'retired') throw conflict('Already retired');
    await c.query("UPDATE fed_policies SET status='retired' WHERE id=$1", [p.id]);
    await logFed(c, p.body_id, 'policy', p.id, 'retired', { from: 'active', to: 'retired', actor: user.id, reason: i.reason });
    return { id: p.id, status: 'retired' };
  }),
});

cap({
  name: 'list_federation_policies', method: 'GET', path: '/federation/bodies/:id/policies', tag: TAG, auth: 'public',
  summary: 'The governing requirements a body publishes (public): each with the version in force today and any version still to come. `include_inherited` adds the requirements of the bodies above it, which apply unless this body publishes its own.',
  input: z.object({ id, kind: KIND.optional(), include_inherited: z.coerce.boolean().default(true), include_retired: z.coerce.boolean().default(false) }),
  async handler(_ctx, i) {
    await bodyById(i.id);
    const ids = i.include_inherited ? await lineage(i.id) : [i.id];
    const rows = await many(
      `SELECT ${POL_COLS}, bo.name AS body_name, (p.body_id <> $1) AS inherited,
              (SELECT row_to_json(x) FROM (SELECT ${VER_COLS} FROM fed_policy_versions v WHERE v.policy_id=p.id AND v.effective_from <= current_date ORDER BY v.effective_from DESC LIMIT 1) x) AS current,
              (SELECT row_to_json(x) FROM (SELECT ${VER_COLS} FROM fed_policy_versions v WHERE v.policy_id=p.id AND v.effective_from > current_date ORDER BY v.effective_from LIMIT 1) x) AS upcoming
         FROM ${polFrom} JOIN governing_bodies b ON b.id=p.body_id JOIN organisations bo ON bo.id=b.organisation_id
        WHERE p.body_id = ANY($2) AND ($3::text IS NULL OR p.kind=$3) AND ($4 OR p.status='active') ORDER BY (p.body_id <> $1), p.kind, p.title, p.id`, [i.id, ids, i.kind ?? null, i.include_retired]);
    return rows.map((r) => ({ ...r, kind_label: POLICY_KINDS[r.kind].label, enforced: POLICY_KINDS[r.kind].enforced }));
  },
});

cap({
  name: 'get_federation_policy', method: 'GET', path: '/federation/policies/:id', tag: TAG, auth: 'public',
  summary: 'One requirement with every published version, newest first (public).',
  input: z.object({ id }),
  async handler(_ctx, i) {
    const p = await one(`SELECT ${POL_COLS}, bo.name AS body_name FROM ${polFrom} JOIN governing_bodies b ON b.id=p.body_id JOIN organisations bo ON bo.id=b.organisation_id WHERE p.id=$1`, [i.id]);
    if (!p) throw notFound('Policy');
    const versions = await many(`SELECT ${VER_COLS}, (v.effective_from <= current_date AND NOT EXISTS (SELECT 1 FROM fed_policy_versions n WHERE n.policy_id=v.policy_id AND n.effective_from <= current_date AND n.effective_from > v.effective_from)) AS in_force FROM fed_policy_versions v WHERE v.policy_id=$1 ORDER BY v.version DESC`, [i.id]);
    return { ...p, kind_label: POLICY_KINDS[p.kind].label, enforced: POLICY_KINDS[p.kind].enforced, versions, history: await historyOf('policy', i.id) };
  },
});

cap({
  name: 'resolve_federation_policy', method: 'GET', path: '/federation/bodies/:id/policy-at', tag: TAG, auth: 'public',
  summary: 'Which requirement applied to a sport, category and season on a given date (public): the most specific policy of the nearest body up the hierarchy, and the version in force on that date. This is what a decision is judged against, and the version id it records.',
  input: z.object({ id, kind: KIND, sport_id: id.optional(), category: text(60).default(''), season_year: z.coerce.number().int().min(1990).max(2200).optional(), on: day.optional() }),
  async handler(_ctx, i) {
    await bodyById(i.id);
    const r = await policyAt(i.id, i.kind, { sportId: i.sport_id ?? null, category: i.category, seasonYear: i.season_year ?? null, date: i.on ?? today() });
    return r ? { ...r, kind: i.kind, enforced: POLICY_KINDS[i.kind].enforced, params: paramsOf(i.kind, r) } : { kind: i.kind, enforced: POLICY_KINDS[i.kind].enforced, none: true };
  },
});

// ------------------------------------------------------------------ federation dates
cap({
  name: 'save_federation_date', method: 'POST', path: '/federation/bodies/:id/dates', tag: TAG, status: 201,
  summary: 'Add a date the federation itself sets: a registration or transfer window, congress, administrative date, official development or assessment day, or a deadline (secretary/admin). Pass `date_id` (and `version`) to change one. A registration window also gates licence types that require one.',
  input: z.object({ id, date_id: id.optional(), kind: z.enum(DATE_KINDS), title: text(120).min(2), starts_on: day, ends_on: day.optional(), sport_id: id.optional(), note: text(500).optional(), version: z.number().int().min(1).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await authority(user, i.id, { c });
    need(a, 'governance', i.sport_id ?? null);
    const ends = i.ends_on ?? i.starts_on;
    if (ends < i.starts_on) throw badRequest('The end date is before the start date');
    if (i.sport_id && !(await c.query('SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL', [i.id, i.sport_id])).rowCount) throw badRequest('That sport is not one this body governs');
    let d;
    if (i.date_id) {
      const cur = (await c.query('SELECT * FROM fed_dates WHERE id=$1 AND body_id=$2 FOR UPDATE', [i.date_id, i.id])).rows[0];
      if (!cur) throw notFound('Date');
      if (cur.status === 'cancelled') throw conflict('That date was cancelled');
      if (i.version && i.version !== cur.row_version) throw conflict('This date changed since you opened it; reload and try again', { code: 'stale_version' });
      d = (await c.query('UPDATE fed_dates SET kind=$2, title=$3, starts_on=$4, ends_on=$5, sport_id=$6, note=$7, row_version=row_version+1 WHERE id=$1 RETURNING *', [i.date_id, i.kind, i.title, i.starts_on, ends, i.sport_id ?? null, i.note || null])).rows[0];
    } else {
      d = (await c.query('INSERT INTO fed_dates(body_id, kind, title, starts_on, ends_on, sport_id, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [i.id, i.kind, i.title, i.starts_on, ends, i.sport_id ?? null, i.note || null, user.id])).rows[0];
    }
    await logFed(c, i.id, 'date', d.id, i.date_id ? 'updated' : 'created', { actor: user.id, detail: { kind: i.kind, starts_on: i.starts_on, ends_on: ends } });
    return (await c.query('SELECT id, body_id, kind, title, starts_on::text AS starts_on, ends_on::text AS ends_on, sport_id, note, status, row_version FROM fed_dates WHERE id=$1', [d.id])).rows[0];
  }),
});

cap({
  name: 'cancel_federation_date', method: 'POST', path: '/federation/dates/:id/cancel', tag: TAG,
  summary: 'Cancel a federation date (secretary/admin). It leaves the calendar but stays in history with the reason.',
  input: z.object({ id, reason: text(300).min(3) }),
  handler: ({ user }, i) => tx(async (c) => {
    const d = (await c.query('SELECT * FROM fed_dates WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!d) throw notFound('Date');
    need(await authority(user, d.body_id, { c }), 'governance', d.sport_id);
    if (d.status === 'cancelled') throw conflict('Already cancelled');
    await c.query("UPDATE fed_dates SET status='cancelled', cancelled_reason=$2, row_version=row_version+1 WHERE id=$1", [d.id, i.reason]);
    await logFed(c, d.body_id, 'date', d.id, 'cancelled', { from: 'active', to: 'cancelled', actor: user.id, reason: i.reason });
    return { id: d.id, status: 'cancelled' };
  }),
});

// ------------------------------------------------------------------ calendar
cap({
  name: 'get_federation_calendar', method: 'GET', path: '/federation/bodies/:id/calendar', tag: TAG,
  summary: 'The governance calendar between two dates (staff of the body, or of a body above it): sanctioned competitions, the federation\'s own windows, congress, deadlines and development dates, and the days affiliations and licences expire. Competitions, affiliations and licences are read live from their own records, so a change there shows here at once; expiries are counts per day, never a list of people.',
  input: z.object({ id, from: day, to: day, include_descendants: z.coerce.boolean().default(true), kinds: z.string().optional().describe('comma-separated kinds to keep') }),
  async handler({ user }, i) {
    await authority(user, i.id);
    if (i.to < i.from) throw badRequest('The end date is before the start date');
    if ((new Date(i.to) - new Date(i.from)) / 864e5 > 400) throw badRequest('Ask for at most about a year at a time');
    const ids = i.include_descendants ? await subtree(i.id) : [i.id];
    const keep = i.kinds ? new Set(i.kinds.split(',').map((x) => x.trim())) : null;
    const [comps, dates, lic, aff] = await Promise.all([
      many(`SELECT s.id, s.event_id, e.name AS title, s.approved_starts_on::text AS starts_on, s.approved_ends_on::text AS ends_on, s.status, s.sanction_no, s.body_id, b.abbreviation, sp.name AS sport_name,
                   (e.status='cancelled' OR e.starts_on < s.approved_starts_on OR e.ends_on > s.approved_ends_on) AS drift
              FROM fed_sanctions s JOIN events e ON e.id=s.event_id JOIN governing_bodies b ON b.id=s.body_id JOIN sports sp ON sp.id=e.sport_id
             WHERE s.body_id = ANY($1) AND s.status IN ('approved','suspended') AND s.approved_starts_on <= $3 AND s.approved_ends_on >= $2`, [ids, i.from, i.to]),
      many(`SELECT d.id, d.kind, d.title, d.starts_on::text AS starts_on, d.ends_on::text AS ends_on, d.note, d.sport_id, sp.name AS sport_name, d.body_id, b.abbreviation FROM fed_dates d JOIN governing_bodies b ON b.id=d.body_id LEFT JOIN sports sp ON sp.id=d.sport_id
             WHERE d.body_id = ANY($1) AND d.status='active' AND d.starts_on <= $3 AND d.ends_on >= $2`, [ids, i.from, i.to]),
      many(`SELECT l.expires_on::text AS day, count(*)::int AS n, l.body_id, b.abbreviation FROM fed_licences l JOIN governing_bodies b ON b.id=l.body_id WHERE l.body_id = ANY($1) AND l.status IN ('active','suspended') AND l.expires_on BETWEEN $2 AND $3 GROUP BY 1, 3, 4`, [ids, i.from, i.to]),
      many(`SELECT a.effective_to::text AS day, count(*)::int AS n, a.body_id, b.abbreviation FROM fed_affiliations a JOIN governing_bodies b ON b.id=a.body_id WHERE a.body_id = ANY($1) AND a.status IN ('approved','suspended') AND a.effective_to BETWEEN $2 AND $3 GROUP BY 1, 3, 4`, [ids, i.from, i.to]),
    ]);
    const items = [
      ...comps.map((r) => ({ kind: 'sanctioned_competition', title: r.title, starts_on: r.starts_on, ends_on: r.ends_on, status: r.status, body_id: r.body_id, body: r.abbreviation, sport_name: r.sport_name, source: { type: 'event', id: r.event_id, sanction_id: r.id }, meta: r.sanction_no, flag: r.drift ? 'dates_moved' : null })),
      ...dates.map((r) => ({ kind: r.kind, title: r.title, starts_on: r.starts_on, ends_on: r.ends_on, status: 'active', body_id: r.body_id, body: r.abbreviation, sport_name: r.sport_name, source: { type: 'federation_date', id: r.id }, meta: r.note, flag: null })),
      ...lic.map((r) => ({ kind: 'licence_renewal', title: `${r.n} licence${r.n === 1 ? '' : 's'} expire`, starts_on: r.day, ends_on: r.day, status: 'due', body_id: r.body_id, body: r.abbreviation, sport_name: null, source: { type: 'licences', id: null, expires_on: r.day }, meta: String(r.n), count: r.n, flag: null })),
      ...aff.map((r) => ({ kind: 'affiliation_renewal', title: `${r.n} affiliation${r.n === 1 ? '' : 's'} expire`, starts_on: r.day, ends_on: r.day, status: 'due', body_id: r.body_id, body: r.abbreviation, sport_name: null, source: { type: 'affiliations', id: null, expires_on: r.day }, meta: String(r.n), count: r.n, flag: null })),
    ].filter((x) => !keep || keep.has(x.kind)).map((x) => ({ ...x, kind_label: DATE_LABEL[x.kind] })).sort((a, b) => a.starts_on.localeCompare(b.starts_on) || a.title.localeCompare(b.title));
    return { from: i.from, to: i.to, kinds: Object.entries(DATE_LABEL).map(([kind, label]) => ({ kind, label })), items };
  },
});
