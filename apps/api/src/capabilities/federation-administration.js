// Federation governance depth (#574), on top of the #475 module: the jurisdictions a body administers (so roles can be delegated by region, state or
// district), renewal campaigns, and the compliance-exception register with its reviews. Everything here is a view or a workflow over the canonical
// affiliations, licences and sanctions: no record is copied, and decisions stay in the immutable `fed_events` history.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { authority, canSome, need, jurisdictionScope, lockBody, bodyById, mustBeActive, subtree, logFed, historyOf, EXC_COLS, EXC_FROM, AFF_STATUS, LIC_STATUS, today } from '../federation.js';
import { coveredRecords, renewalStateSql, contactsOf } from '../federation-campaigns.js';

const TAG = 'Federation';
const text = (n) => z.string().trim().max(n);
const day = z.string().date();

// ------------------------------------------------------------------ jurisdictions
cap({
  name: 'save_federation_jurisdiction', method: 'POST', path: '/federation/bodies/:id/jurisdictions', tag: TAG, status: 201,
  summary: 'Add a region, state or district the body administers (owner/admin or secretary). Records can then be filed under it and roles limited to it. Names are unique per level; archive one to retire it (records keep it).',
  input: z.object({ id, level: z.enum(['region', 'state', 'district']), name: text(80).min(1) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await authority(user, i.id, { c });
    need(a, 'governance');
    const b = await lockBody(c, i.id);
    mustBeActive(await bodyById(b.id, c));
    let j;
    try { j = (await c.query('INSERT INTO fed_jurisdictions(body_id, level, name, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [b.id, i.level, i.name.trim(), user.id])).rows[0]; }
    catch (e) { if (e.code === '23505') throw conflict(`${i.name} already exists at that level`); throw e; }
    await logFed(c, b.id, 'jurisdiction', j.id, 'added', { to: 'active', actor: user.id, detail: { level: j.level, name: j.name } });
    return j;
  }),
});

cap({
  name: 'archive_federation_jurisdiction', method: 'POST', path: '/federation/jurisdictions/:id/archive', tag: TAG,
  summary: 'Retire a jurisdiction (owner/admin or secretary). Records and roles that use it keep it; it just stops being offered for new ones.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const j = (await c.query('SELECT * FROM fed_jurisdictions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!j) throw notFound('Jurisdiction');
    need(await authority(user, j.body_id, { c }), 'governance');
    if (j.archived_at) return j;
    const r = (await c.query('UPDATE fed_jurisdictions SET archived_at=now() WHERE id=$1 RETURNING *', [j.id])).rows[0];
    await logFed(c, j.body_id, 'jurisdiction', j.id, 'archived', { from: 'active', to: 'archived', actor: user.id, detail: { name: j.name } });
    return r;
  }),
});

cap({
  name: 'list_federation_jurisdictions', method: 'GET', path: '/federation/bodies/:id/jurisdictions', tag: TAG, auth: 'public',
  summary: 'The regions, states and districts a body administers (names only), for pickers on applications and role grants. `include_archived` adds retired ones (staff only, by default off).',
  input: z.object({ id, include_archived: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    await bodyById(i.id);
    const staff = user ? await authority(user, i.id, { optional: true }) : null;
    return many(`SELECT j.id, j.level, j.name, j.archived_at,
        CASE WHEN $3 THEN (SELECT count(*)::int FROM fed_affiliations a WHERE a.jurisdiction_id=j.id) + (SELECT count(*)::int FROM fed_licences l WHERE l.jurisdiction_id=j.id) + (SELECT count(*)::int FROM fed_sanctions s WHERE s.jurisdiction_id=j.id) END AS records
      FROM fed_jurisdictions j WHERE j.body_id=$1 AND ($2 OR j.archived_at IS NULL) ORDER BY j.level, j.name`, [i.id, !!staff && i.include_archived, !!staff]);
  },
});

// ------------------------------------------------------------------ compliance exceptions
const EXC_STATUS = z.enum(['open', 'overdue', 'resolved', 'all']);
const EXC_WHERE = `e.body_id = ANY($1) AND ($2::uuid[] IS NULL OR x.jurisdiction_id = ANY($2)) AND ($3::text IS NULL OR e.subject_type=$3)
  AND ($4::text='all' OR ($4='open' AND e.status IN ('open','extended')) OR ($4='overdue' AND e.status IN ('open','extended') AND e.review_due < current_date) OR ($4='resolved' AND e.status IN ('remedied','accepted')))
  AND ($5::text IS NULL OR x.label ILIKE '%'||$5||'%') AND ($6::uuid IS NULL OR x.sport_id=$6)`;

cap({
  name: 'list_federation_exceptions', method: 'GET', path: '/federation/bodies/:id/exceptions', tag: TAG,
  summary: 'The compliance-exception register: every decision approved over a failed requirement, with the failed requirements, who decided, when a review is due and how reviews went. `status` is open (default), overdue (review date passed), resolved or all. Staff of the body (limited to their jurisdictions if their role is), or of a body above it. Evidence and private club data are never included.',
  input: z.object({ id, status: EXC_STATUS.default('open'), subject_type: z.enum(['affiliation', 'licence', 'sanction']).optional(), sport_id: id.optional(), q: text(80).optional(), include_descendants: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    const scope = jurisdictionScope(auth);
    const ids = i.include_descendants && !scope ? await subtree(i.id) : [i.id];
    const a = [ids, scope, i.subject_type ?? null, i.status, i.q || null, i.sport_id ?? null];
    const from = `${EXC_FROM}`, w = `${EXC_WHERE}`;
    const [total, summary, items] = await Promise.all([
      one(`SELECT count(*)::int AS n FROM (SELECT ${EXC_COLS} FROM ${from}) x JOIN fed_exceptions e ON e.id=x.id WHERE ${w}`, a),
      one(`SELECT count(*) FILTER (WHERE e.status IN ('open','extended'))::int AS open, count(*) FILTER (WHERE e.status IN ('open','extended') AND e.review_due < current_date)::int AS overdue, count(*) FILTER (WHERE e.status IN ('remedied','accepted'))::int AS resolved
             FROM (SELECT ${EXC_COLS} FROM ${from}) x JOIN fed_exceptions e ON e.id=x.id WHERE e.body_id = ANY($1) AND ($2::uuid[] IS NULL OR x.jurisdiction_id = ANY($2))`, [ids, scope]),
      many(`SELECT x.*, j.name AS jurisdiction_name FROM (SELECT ${EXC_COLS} FROM ${from}) x JOIN fed_exceptions e ON e.id=x.id LEFT JOIN fed_jurisdictions j ON j.id=x.jurisdiction_id WHERE ${w}
             ORDER BY (e.status IN ('open','extended')) DESC, e.review_due, e.id LIMIT $7 OFFSET $8`, [...a, i.limit, i.offset]),
    ]);
    return { total: total.n, summary, items };
  },
});

cap({
  name: 'review_federation_exception', method: 'POST', path: '/federation/exceptions/:id/review', tag: TAG,
  summary: 'Record a review of a compliance exception (compliance officer or admin, within their jurisdictions): `remedied` (the requirement is now met), `extended` (keep it open to a new review date) or `accepted` (a standing, justified exception). A note is required. Every review is kept in the immutable history; the decision on the record itself is never changed. Pass `version` to refuse a review of an exception that changed meanwhile.',
  input: z.object({ id, outcome: z.enum(['remedied', 'extended', 'accepted']), note: text(500).min(5), review_due: day.optional(), version: z.number().int().min(1).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const e = (await c.query('SELECT * FROM fed_exceptions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!e) throw notFound('Exception');
    const auth = await authority(user, e.body_id, { c, optional: true });
    if (!auth) throw notFound('Exception');
    const x = (await c.query(`SELECT ${EXC_COLS} FROM ${EXC_FROM} WHERE e.id=$1`, [e.id])).rows[0];
    need(auth, 'exceptions', x.sport_id, x.jurisdiction_id);
    if (!['open', 'extended'].includes(e.status)) throw conflict('This exception has already been closed');
    if (i.version && i.version !== e.row_version) throw conflict('This exception changed since you opened it; reload and review again', { code: 'stale' });
    if (i.outcome === 'extended') {
      if (!i.review_due) throw badRequest('Give the new review date');
      if (i.review_due <= today()) throw badRequest('The new review date must be in the future');
    }
    const due = i.outcome === 'extended' ? i.review_due : e.review_due;
    await c.query('UPDATE fed_exceptions SET status=$2, review_due=$3, reviewed_by=$4, reviewed_at=now(), review_note=$5, review_count=review_count+1, row_version=row_version+1, updated_at=now() WHERE id=$1',
      [e.id, i.outcome, due, user.id, i.note]);
    await logFed(c, e.body_id, 'exception', e.id, `review_${i.outcome}`, { from: e.status, to: i.outcome, actor: user.id, reason: i.note, detail: { review_due: due, subject_type: e.subject_type, subject_id: e.subject_id } });
    await audit(c, user.id, `federation_exception_${i.outcome}`, 'fed_exceptions', e.id);
    return { ...(await c.query(`SELECT ${EXC_COLS} FROM ${EXC_FROM} WHERE e.id=$1`, [e.id])).rows[0], history: await historyOf('exception', e.id, c) };
  }),
});

cap({
  name: 'get_federation_compliance', method: 'GET', path: '/federation/bodies/:id/compliance', tag: TAG,
  summary: 'Compliance standing across the body: how many affiliations, licences and sanctions in force are in good standing (no open exception) versus under an open exception, how many exceptions are overdue for review, and what expires within 30 days. Read live from the same status rules as the registers. Staff of the body (limited to their jurisdictions if their role is), or of a body above it.',
  input: z.object({ id, include_descendants: z.coerce.boolean().default(true) }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    const scope = jurisdictionScope(auth);
    const ids = i.include_descendants && !scope ? await subtree(i.id) : [i.id];
    const J = (al) => `($2::uuid[] IS NULL OR ${al}.jurisdiction_id = ANY($2))`;
    const ex = (type, al) => `EXISTS (SELECT 1 FROM fed_exceptions e WHERE e.subject_type='${type}' AND e.subject_id=${al}.id AND e.status IN ('open','extended'))`;
    const [aff, lic, san, exc] = await Promise.all([
      one(`SELECT count(*)::int AS in_force, count(*) FILTER (WHERE ${ex('affiliation', 'a')})::int AS under_exception, count(*) FILTER (WHERE a.effective_to <= current_date + 30)::int AS expiring_30 FROM fed_affiliations a WHERE a.body_id = ANY($1) AND (${AFF_STATUS('a')})='approved' AND ${J('a')}`, [ids, scope]),
      one(`SELECT count(*)::int AS in_force, count(*) FILTER (WHERE ${ex('licence', 'l')})::int AS under_exception, count(*) FILTER (WHERE l.expires_on <= current_date + 30)::int AS expiring_30 FROM fed_licences l WHERE l.body_id = ANY($1) AND (${LIC_STATUS('l')})='active' AND ${J('l')}`, [ids, scope]),
      one(`SELECT count(*)::int AS in_force, count(*) FILTER (WHERE ${ex('sanction', 's')})::int AS under_exception, count(*) FILTER (WHERE s.approved_ends_on <= current_date + 30)::int AS expiring_30 FROM fed_sanctions s WHERE s.body_id = ANY($1) AND s.status='approved' AND ${J('s')}`, [ids, scope]),
      one(`SELECT count(*) FILTER (WHERE e.status IN ('open','extended'))::int AS open, count(*) FILTER (WHERE e.status IN ('open','extended') AND e.review_due < current_date)::int AS overdue, count(*) FILTER (WHERE e.status IN ('remedied','accepted'))::int AS resolved
             FROM fed_exceptions e LEFT JOIN fed_affiliations a ON e.subject_type='affiliation' AND a.id=e.subject_id LEFT JOIN fed_licences l ON e.subject_type='licence' AND l.id=e.subject_id LEFT JOIN fed_sanctions s ON e.subject_type='sanction' AND s.id=e.subject_id
            WHERE e.body_id = ANY($1) AND ($2::uuid[] IS NULL OR coalesce(a.jurisdiction_id, l.jurisdiction_id, s.jurisdiction_id) = ANY($2))`, [ids, scope]),
    ]);
    const std = (r) => ({ ...r, good_standing: r.in_force - r.under_exception });
    return { scope: { include_descendants: !scope && i.include_descendants, bodies: ids.length, limited_to_jurisdictions: !!scope }, affiliations: std(aff), licences: std(lic), sanctions: std(san), exceptions: exc, can_review: canSome(auth, 'exceptions') };
  },
});

// ------------------------------------------------------------------ renewal campaigns
const CAMPAIGN_COLS = `c.id, c.body_id, c.name, c.target, c.category_ids, c.jurisdiction_ids, c.sport_id, c.window_from::text AS window_from, c.window_to::text AS window_to, c.reminder_days, c.message, c.status, c.launched_at, c.closed_at, c.row_version, c.created_at,
  (SELECT count(*)::int FROM fed_campaign_recipients r WHERE r.campaign_id=c.id) AS recipients`;
const campaignInput = z.object({
  target: z.enum(['affiliation', 'licence']), category_ids: z.array(id).max(100).default([]).describe('affiliation categories or licence types; empty = all'), jurisdiction_ids: z.array(id).max(100).default([]).describe('empty = every jurisdiction'),
  sport_id: id.optional(), window_from: day, window_to: day,
});

/** May the caller run a campaign for this target over these jurisdictions? Limited roles may only target their own. */
function needCampaign(auth, c) {
  const perm = c.target === 'affiliation' ? 'affiliations' : 'licences';
  if (auth.admin) return;
  const mine = auth.roles.filter((r) => ({ affiliations: ['registrar'], licences: ['licensing'] })[perm].includes(r.role) && (!r.sport_id || !c.sport_id || r.sport_id === c.sport_id));
  if (!mine.length) throw forbidden(`Your role on ${auth.body.name} does not allow that`);
  if (mine.some((r) => !r.jurisdiction_ids?.length)) return;
  const allowed = new Set(mine.flatMap((r) => r.jurisdiction_ids));
  if (!c.jurisdiction_ids?.length || !c.jurisdiction_ids.every((j) => allowed.has(j))) throw forbidden('Your role covers only some jurisdictions: pick campaign jurisdictions within them');
}
async function checkTargets(c, bodyId, i) {
  if (new Date(i.window_to) < new Date(i.window_from)) throw badRequest('The window ends before it starts');
  const table = i.target === 'affiliation' ? 'fed_affiliation_categories' : 'fed_licence_types';
  const cats = [...new Set(i.category_ids)];
  if (cats.length && (await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE body_id=$1 AND id = ANY($2)`, [bodyId, cats])).rows[0].n !== cats.length) throw badRequest('Pick categories or types that belong to this body');
  const js = [...new Set(i.jurisdiction_ids)];
  if (js.length && (await c.query('SELECT count(*)::int AS n FROM fed_jurisdictions WHERE body_id=$1 AND id = ANY($2)', [bodyId, js])).rows[0].n !== js.length) throw badRequest('Pick jurisdictions that belong to this body');
  if (i.sport_id && !(await c.query('SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL', [bodyId, i.sport_id])).rowCount) throw badRequest('That sport is not one this body governs');
  return { ...i, category_ids: cats, jurisdiction_ids: js };
}

cap({
  name: 'preview_renewal_campaign', method: 'POST', path: '/federation/bodies/:id/campaigns/preview', tag: TAG,
  summary: 'Count the records a renewal campaign would cover (in force, ending inside the window, matching categories/types, jurisdictions and sport, not yet renewed) before it is saved or launched. Registrar (affiliations) or licensing officer (licences), or admin.',
  input: campaignInput.extend({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const auth = await authority(user, i.id, { c });
    const camp = await checkTargets(c, i.id, i);
    needCampaign(auth, camp);
    const rows = await coveredRecords(c, { ...camp, body_id: i.id });
    return { records: rows.length, capped: rows.length >= 5000, by_jurisdiction: Object.entries(rows.reduce((m, r) => ({ ...m, [r.jurisdiction_id ?? 'none']: (m[r.jurisdiction_id ?? 'none'] ?? 0) + 1 }), {})).map(([jurisdiction_id, n]) => ({ jurisdiction_id: jurisdiction_id === 'none' ? null : jurisdiction_id, records: n })) };
  }),
});

cap({
  name: 'save_renewal_campaign', method: 'POST', path: '/federation/bodies/:id/campaigns', tag: TAG, status: 201,
  summary: 'Create a renewal campaign as a draft, or (with `campaign_id`) change a draft: what to renew (affiliations or licences, optionally by category/type, jurisdiction and sport), the window in which records end, the reminder schedule (days before the end date) and an optional message. Nothing is sent until it is launched.',
  input: campaignInput.extend({ id, campaign_id: id.optional(), name: text(120).min(2), reminder_days: z.array(z.number().int().min(1).max(365)).min(1).max(6).default([30, 14, 7]), message: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const auth = await authority(user, i.id, { c });
    const b = await lockBody(c, i.id);
    mustBeActive(await bodyById(b.id, c));
    const camp = await checkTargets(c, b.id, i);
    needCampaign(auth, camp);
    const days = [...new Set(i.reminder_days)].sort((x, y) => y - x);
    if (i.campaign_id) {
      const cur = (await c.query('SELECT * FROM fed_campaigns WHERE id=$1 AND body_id=$2 FOR UPDATE', [i.campaign_id, b.id])).rows[0];
      if (!cur) throw notFound('Campaign');
      if (cur.status !== 'draft') throw conflict('Only a draft campaign can be changed');
      await c.query('UPDATE fed_campaigns SET name=$2, target=$3, category_ids=$4, jurisdiction_ids=$5, sport_id=$6, window_from=$7, window_to=$8, reminder_days=$9, message=$10, row_version=row_version+1, updated_at=now() WHERE id=$1',
        [cur.id, i.name, camp.target, camp.category_ids, camp.jurisdiction_ids, i.sport_id ?? null, i.window_from, i.window_to, days, i.message || null]);
      await logFed(c, b.id, 'campaign', cur.id, 'updated', { actor: user.id });
      return (await c.query(`SELECT ${CAMPAIGN_COLS} FROM fed_campaigns c WHERE c.id=$1`, [cur.id])).rows[0];
    }
    const r = (await c.query('INSERT INTO fed_campaigns(body_id, name, target, category_ids, jurisdiction_ids, sport_id, window_from, window_to, reminder_days, message, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
      [b.id, i.name, camp.target, camp.category_ids, camp.jurisdiction_ids, i.sport_id ?? null, i.window_from, i.window_to, days, i.message || null, user.id])).rows[0];
    await logFed(c, b.id, 'campaign', r.id, 'created', { to: 'draft', actor: user.id, detail: { target: camp.target } });
    return (await c.query(`SELECT ${CAMPAIGN_COLS} FROM fed_campaigns c WHERE c.id=$1`, [r.id])).rows[0];
  }),
});

async function campaignFor(user, campaignId, c, { lock = false } = {}) {
  const camp = (await c.query(`SELECT * FROM fed_campaigns WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [campaignId])).rows[0];
  if (!camp) throw notFound('Campaign');
  const auth = await authority(user, camp.body_id, { c, optional: true });
  if (!auth) throw notFound('Campaign');
  return { camp, auth };
}

cap({
  name: 'launch_renewal_campaign', method: 'POST', path: '/federation/campaigns/:id/launch', tag: TAG,
  summary: 'Start a draft campaign: fix the list of records it covers as of today, tell their contacts (a club\'s owners/admins, or a licence holder and their guardian-applicant) to renew, and keep reminding them on the schedule until they renew. The body\'s own automatic expiry reminders skip these records so nobody is told twice. Records are not changed.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const { camp, auth } = await campaignFor(user, i.id, c, { lock: true });
    needCampaign(auth, { target: camp.target, jurisdiction_ids: camp.jurisdiction_ids, sport_id: camp.sport_id });
    mustBeActive(await bodyById(camp.body_id, c));
    if (camp.status !== 'draft') throw conflict(`This campaign is already ${camp.status}`);
    const rows = await coveredRecords(c, camp);
    if (!rows.length) throw badRequest('No records match this campaign: widen the window or the filters');
    await c.query('INSERT INTO fed_campaign_recipients(campaign_id, subject_type, subject_id) SELECT $1, $2, x FROM unnest($3::uuid[]) x ON CONFLICT DO NOTHING', [camp.id, camp.target, rows.map((r) => r.id)]);
    await c.query("UPDATE fed_campaigns SET status='running', launched_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1", [camp.id]);
    const bodyName = (await bodyById(camp.body_id, c)).name;
    let sent = 0;
    for (const r of rows) {
      for (const uid of await contactsOf(c, camp.target, r.id)) {
        if (await notify(c, uid, { kind: 'federation_renewal_campaign', title: `Renew your ${camp.target === 'affiliation' ? 'affiliation' : 'licence'}`, body: `${bodyName}: ${camp.message || `your ${camp.target} ends on ${r.ends_on}. Renew it to stay in good standing.`}`, data: { campaign_id: camp.id, [`${camp.target}_id`]: r.id }, dedupe_key: `fed-camp:${camp.id}:${r.id}:launch:${uid}` })) sent++;
      }
      await c.query('UPDATE fed_campaign_recipients SET reminders=1, last_reminded_at=now() WHERE campaign_id=$1 AND subject_id=$2', [camp.id, r.id]);
    }
    await logFed(c, camp.body_id, 'campaign', camp.id, 'launched', { from: 'draft', to: 'running', actor: user.id, detail: { recipients: rows.length, notified: sent } });
    await audit(c, user.id, 'federation_campaign_launched', 'fed_campaigns', camp.id);
    return (await c.query(`SELECT ${CAMPAIGN_COLS} FROM fed_campaigns c WHERE c.id=$1`, [camp.id])).rows[0];
  }),
});

cap({
  name: 'close_renewal_campaign', method: 'POST', path: '/federation/campaigns/:id/close', tag: TAG,
  summary: 'End a campaign: a running one is closed (reminders stop, results are kept), a draft is cancelled. The history and each record\'s outcome stay readable.',
  input: z.object({ id, reason: text(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { camp, auth } = await campaignFor(user, i.id, c, { lock: true });
    needCampaign(auth, { target: camp.target, jurisdiction_ids: camp.jurisdiction_ids, sport_id: camp.sport_id });
    if (!['draft', 'running'].includes(camp.status)) throw conflict(`This campaign is already ${camp.status}`);
    const to = camp.status === 'draft' ? 'cancelled' : 'closed';
    await c.query('UPDATE fed_campaigns SET status=$2, closed_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1', [camp.id, to]);
    await logFed(c, camp.body_id, 'campaign', camp.id, to, { from: camp.status, to, actor: user.id, reason: i.reason });
    return (await c.query(`SELECT ${CAMPAIGN_COLS} FROM fed_campaigns c WHERE c.id=$1`, [camp.id])).rows[0];
  }),
});

const progress = async (camp, scope, c = null) => {
  const q = c ? (s, a) => c.query(s, a).then((r) => r.rows) : many;
  const stateSql = renewalStateSql(camp.target);
  const table = camp.target === 'affiliation' ? 'fed_affiliations' : 'fed_licences';
  return (await q(`SELECT ${stateSql} AS state, count(*)::int AS n FROM fed_campaign_recipients cr JOIN ${table} r ON r.id=cr.subject_id WHERE cr.campaign_id=$1 AND ($2::uuid[] IS NULL OR r.jurisdiction_id = ANY($2)) GROUP BY 1`, [camp.id, scope]))
    .reduce((m, r) => ({ ...m, [r.state]: r.n }), { renewed: 0, in_progress: 0, awaiting: 0, lapsed: 0 });
};

cap({
  name: 'list_renewal_campaigns', method: 'GET', path: '/federation/bodies/:id/campaigns', tag: TAG,
  summary: 'The body\'s renewal campaigns with how far each has got (renewed, in progress, awaiting, lapsed). Staff of the body, or of a body above it; limited-jurisdiction roles see progress for their own jurisdictions only.',
  input: z.object({ id, status: z.enum(['draft', 'running', 'closed', 'cancelled']).optional(), ...page }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    const scope = jurisdictionScope(auth);
    const items = await many(`SELECT ${CAMPAIGN_COLS} FROM fed_campaigns c WHERE c.body_id=$1 AND ($2::text IS NULL OR c.status=$2) ORDER BY (c.status='running') DESC, c.created_at DESC, c.id LIMIT $3 OFFSET $4`, [i.id, i.status ?? null, i.limit, i.offset]);
    const total = await one('SELECT count(*)::int AS n FROM fed_campaigns c WHERE c.body_id=$1 AND ($2::text IS NULL OR c.status=$2)', [i.id, i.status ?? null]);
    return { total: total.n, items: await Promise.all(items.map(async (c) => ({ ...c, progress: c.status === 'draft' ? null : await progress(c, scope) }))) };
  },
});

cap({
  name: 'get_renewal_campaign', method: 'GET', path: '/federation/campaigns/:id', tag: TAG,
  summary: 'One campaign: its settings, progress, and the covered records one by one (name, end date, jurisdiction, reminders sent, and whether it was renewed). Filter by `state`. Staff of the body, or of a body above it.',
  input: z.object({ id, state: z.enum(['renewed', 'in_progress', 'awaiting', 'lapsed']).optional(), ...page }),
  async handler({ user }, i) {
    const { camp, auth } = await campaignFor(user, i.id, pool);
    const scope = jurisdictionScope(auth);
    const aff = camp.target === 'affiliation';
    const stateSql = renewalStateSql(camp.target);
    const label = aff ? 'o.name' : "u.display_name || ' · ' || t.name";
    const from = aff ? 'fed_affiliations r JOIN organisations o ON o.id=r.organisation_id' : 'fed_licences r JOIN users u ON u.id=r.holder_id JOIN fed_licence_types t ON t.id=r.type_id';
    const end = aff ? 'r.effective_to' : 'r.expires_on';
    const w = `cr.campaign_id=$1 AND ($2::uuid[] IS NULL OR r.jurisdiction_id = ANY($2)) AND ($3::text IS NULL OR (${stateSql})=$3)`;
    const [recipients, total, head] = await Promise.all([
      many(`SELECT r.id AS subject_id, ${label} AS label, ${end}::text AS ends_on, ${stateSql} AS state, r.jurisdiction_id, j.name AS jurisdiction_name, cr.reminders, cr.last_reminded_at
              FROM fed_campaign_recipients cr JOIN ${from} ON r.id=cr.subject_id LEFT JOIN fed_jurisdictions j ON j.id=r.jurisdiction_id WHERE ${w} ORDER BY ${end}, r.id LIMIT $4 OFFSET $5`, [camp.id, scope, i.state ?? null, i.limit, i.offset]),
      one(`SELECT count(*)::int AS n FROM fed_campaign_recipients cr JOIN ${from} ON r.id=cr.subject_id WHERE ${w}`, [camp.id, scope, i.state ?? null]),
      one(`SELECT ${CAMPAIGN_COLS} FROM fed_campaigns c WHERE c.id=$1`, [camp.id]),
    ]);
    return { ...head, progress: camp.status === 'draft' ? null : await progress(camp, scope), history: await historyOf('campaign', camp.id), can_manage: (() => { try { needCampaign(auth, { target: camp.target, jurisdiction_ids: camp.jurisdiction_ids, sport_id: camp.sport_id }); return true; } catch { return false; } })(), total: total.n, recipients };
  },
});
