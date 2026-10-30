// Governing body administration depth (#574, extends #475): the compliance register (who is in good standing, who is at risk, who has lapsed),
// compliance exceptions with a reviewable lifecycle, and renewal campaigns. Everything reads the canonical affiliation / licence / sanction records with
// the same status rules the lists use; campaigns store only WHO was invited and read the outcome live from the renewal record that points back.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notify.js';
import { authority, can, need, mustBeActive, subtree, logFed, AFF_STATUS, LIC_STATUS, today, plain } from '../federation.js';
import { subjectFor } from '../federation-subjects.js';

const TAG = 'Federation';
const day = z.string().date();
const MAX_INVITES = 1000;

// ------------------------------------------------------------------ exceptions
/** The latest review closed this exception (accepted or remedied) and was written after the decision it is about. */
const CLOSED = (type, idExpr, atExpr) => `EXISTS (SELECT 1 FROM fed_exception_reviews r WHERE r.subject_type='${type}' AND r.subject_id=${idExpr} AND r.resolution IN ('accepted','remedied')
  AND (${atExpr} IS NULL OR r.created_at >= ${atExpr}) AND r.created_at = (SELECT max(r2.created_at) FROM fed_exception_reviews r2 WHERE r2.subject_type=r.subject_type AND r2.subject_id=r.subject_id))`;

const EXCEPTION_ROWS = `
  SELECT 'affiliation' AS type, a.id, a.body_id, o.name AS label, a.override_reason AS reason, a.decided_at AS at, 'override' AS kind, u.display_name AS by
    FROM fed_affiliations a JOIN organisations o ON o.id=a.organisation_id LEFT JOIN users u ON u.id=a.decided_by WHERE a.body_id = ANY($1) AND a.override_reason IS NOT NULL AND a.status IN ('approved','suspended')
  UNION ALL SELECT 'licence', l.id, l.body_id, uu.display_name || ' · ' || t.name, l.override_reason, l.decided_at, 'override', u.display_name
    FROM fed_licences l JOIN users uu ON uu.id=l.holder_id JOIN fed_licence_types t ON t.id=l.type_id LEFT JOIN users u ON u.id=l.decided_by WHERE l.body_id = ANY($1) AND l.override_reason IS NOT NULL AND l.status IN ('active','suspended')
  UNION ALL SELECT 'sanction', s.id, s.body_id, e.name, s.override_reason, s.decided_at, 'override', u.display_name
    FROM fed_sanctions s JOIN events e ON e.id=s.event_id LEFT JOIN users u ON u.id=s.decided_by WHERE s.body_id = ANY($1) AND s.override_reason IS NOT NULL AND s.status IN ('approved','suspended')
  UNION ALL SELECT 'sanction', s.id, s.body_id, e.name, CASE WHEN e.status='cancelled' THEN 'The event was cancelled after it was sanctioned' ELSE 'The event dates moved outside the sanctioned dates' END, e.created_at, 'event_moved', NULL
    FROM fed_sanctions s JOIN events e ON e.id=s.event_id WHERE s.body_id = ANY($1) AND s.status IN ('approved','suspended') AND (e.status='cancelled' OR e.starts_on < s.approved_starts_on OR e.ends_on > s.approved_ends_on)`;

/** Exceptions under the given bodies with the state of their latest review: unreviewed | remedy_required (open) | accepted | remedied (closed). */
export async function exceptionRows(bodyIds, { open = false, limit = 50, offset = 0, subject = null } = {}) {
  const sql = `FROM (${EXCEPTION_ROWS}) x
    LEFT JOIN LATERAL (SELECT r.resolution, r.note, r.due_on, r.created_at, ru.display_name AS reviewer FROM fed_exception_reviews r JOIN users ru ON ru.id=r.reviewed_by
                        WHERE r.subject_type=x.type AND r.subject_id=x.id AND (x.at IS NULL OR r.created_at >= x.at) ORDER BY r.created_at DESC, r.id LIMIT 1) rv ON true
    LEFT JOIN governing_bodies b ON b.id=x.body_id LEFT JOIN organisations bo ON bo.id=b.organisation_id
    WHERE (NOT $2::boolean OR rv.resolution IS NULL OR rv.resolution = 'remedy_required') AND ($3::text IS NULL OR (x.type=$3 AND x.id=$4::uuid))`;
  const [total, items] = await Promise.all([
    one(`SELECT count(*)::int AS n ${sql}`, [bodyIds, open, subject?.type ?? null, subject?.id ?? null]),
    many(`SELECT x.type, x.id, x.body_id, bo.name AS body_name, x.label, x.reason, x.at, x.kind, x.by, coalesce(rv.resolution, 'unreviewed') AS state, rv.note AS review_note, rv.due_on::text AS due_on, rv.created_at AS reviewed_at, rv.reviewer
            ${sql} ORDER BY x.at DESC NULLS LAST, x.id LIMIT $5 OFFSET $6`, [bodyIds, open, subject?.type ?? null, subject?.id ?? null, limit, offset]),
  ]);
  return { total: total.n, items };
}

cap({
  name: 'list_compliance_exceptions', method: 'GET', path: '/federation/bodies/:id/exceptions', tag: TAG,
  summary: 'Compliance exceptions under a body (and optionally the bodies recognised beneath it): decisions approved over a failed requirement, and sanctioned events that moved outside their approved dates. Each carries the state of its latest review: unreviewed, remedy_required (open), accepted or remedied (closed). `open=true` hides the closed ones. Needs a reporting role.',
  input: z.object({ id, include_descendants: z.coerce.boolean().default(true), open: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    need(auth, 'reports');
    return exceptionRows(i.include_descendants ? await subtree(i.id) : [i.id], { open: i.open, limit: i.limit, offset: i.offset });
  },
});

cap({
  name: 'review_compliance_exception', method: 'POST', path: '/federation/bodies/:id/exceptions/review', tag: TAG, status: 201,
  summary: 'Record a compliance review of one exception on this body (compliance role or owner/admin): `accepted` (reason noted), `remedy_required` (with a `due_on` date; the organisation or holder is told) or `remedied` (the fix is confirmed). Reviews are appended and never edited, so the exception keeps its full review history; a later decision on the same record reopens it.',
  input: z.object({ id, subject_type: z.enum(['affiliation', 'licence', 'sanction']), subject_id: id, resolution: z.enum(['accepted', 'remedy_required', 'remedied']), note: z.string().trim().min(3).max(500), due_on: day.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await subjectFor(user, i.subject_type, i.subject_id, { c, lock: true });
    if (s.row.body_id !== i.id || !s.auth) throw notFound('Exception');
    if (!can(s.auth, 'compliance', s.sportId)) throw forbidden('Only the body\'s compliance officers and admins review exceptions');
    if (i.resolution === 'remedy_required' && !i.due_on) throw badRequest('Give the date the remedy is due');
    if (i.due_on && i.resolution !== 'remedy_required') throw badRequest('Only a remedy has a due date');
    if (i.due_on && i.due_on < today()) throw badRequest('The due date is in the past');
    const open = (await exceptionRows([i.id], { limit: 1, subject: { type: i.subject_type, id: i.subject_id } })).items[0];
    if (!open) throw notFound('Exception');
    if (i.resolution === 'remedied' && open.state !== 'remedy_required') throw conflict('Only an exception with a required remedy can be marked remedied');
    const r = (await c.query('INSERT INTO fed_exception_reviews(body_id, subject_type, subject_id, resolution, note, due_on, reviewed_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [i.id, i.subject_type, i.subject_id, i.resolution, i.note, i.due_on ?? null, user.id])).rows[0];
    await logFed(c, i.id, 'exception', i.subject_id, i.resolution, { from: open.state, to: i.resolution, actor: user.id, reason: i.note, detail: { subject_type: i.subject_type, due_on: i.due_on ?? null } });
    if (i.resolution === 'remedy_required') {
      const who = i.subject_type === 'affiliation' ? (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('owner','admin')", [s.row.organisation_id])).rows.map((x) => x.user_id)
        : i.subject_type === 'licence' ? [...new Set([s.row.holder_id, s.row.applicant_id])] : [s.event.organiser_id];
      for (const uid of who) await notify(c, uid, { kind: 'federation_exception_remedy', title: 'Action needed by the federation', body: `${s.auth.body.name} asks for a fix by ${i.due_on}: ${i.note}`, data: { subject_type: i.subject_type, subject_id: i.subject_id }, dedupe_key: `fed-exc:${r.id}:${uid}` });
    }
    return plain(r);
  }),
});

// ------------------------------------------------------------------ compliance register
const KINDS = {
  affiliation: {
    latest: `SELECT DISTINCT ON (a.body_id, a.organisation_id) a.id, a.body_id, a.organisation_id AS party_id, a.affiliation_no AS number, a.season_year, a.effective_to AS ends_on, a.fee_status, a.override_reason, a.decided_at, c.sport_id,
                    (${AFF_STATUS('a')}) AS eff, o.name AS label, c.name AS sub,
                    EXISTS (SELECT 1 FROM fed_affiliations n WHERE n.previous_id=a.id AND n.status NOT IN ('withdrawn','rejected')) AS renewal_started
               FROM fed_affiliations a JOIN fed_affiliation_categories c ON c.id=a.category_id JOIN organisations o ON o.id=a.organisation_id
              WHERE a.body_id = ANY($1) AND a.status IN ('approved','suspended','expired') ORDER BY a.body_id, a.organisation_id, a.effective_to DESC, a.created_at DESC`,
    live: 'approved',
  },
  licence: {
    latest: `SELECT DISTINCT ON (l.body_id, l.holder_id, l.type_id) l.id, l.body_id, l.holder_id AS party_id, l.licence_no AS number, extract(year FROM l.issued_on)::int AS season_year, l.expires_on AS ends_on, l.fee_status, l.override_reason, l.decided_at, t.sport_id,
                    (${LIC_STATUS('l')}) AS eff, u.display_name AS label, t.name AS sub,
                    EXISTS (SELECT 1 FROM fed_licences n WHERE n.previous_id=l.id AND n.status NOT IN ('withdrawn','rejected')) AS renewal_started
               FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id JOIN users u ON u.id=l.holder_id
              WHERE l.body_id = ANY($1) AND l.status IN ('active','suspended','expired') ORDER BY l.body_id, l.holder_id, l.type_id, l.expires_on DESC, l.created_at DESC`,
    live: 'active',
  },
};
const REGISTER = (kind) => `WITH latest AS (${KINDS[kind].latest}), reg AS (
  SELECT x.*, array_remove(ARRAY[
      CASE WHEN x.eff='suspended' THEN 'suspended' END,
      CASE WHEN x.eff='expired' THEN 'expired' END,
      CASE WHEN x.fee_status='due' THEN 'fee_due' END,
      CASE WHEN x.eff='${KINDS[kind].live}' AND x.ends_on <= current_date + 30 AND NOT x.renewal_started THEN 'ending_soon' END,
      CASE WHEN x.override_reason IS NOT NULL AND x.eff IN ('${KINDS[kind].live}','suspended') AND NOT ${CLOSED(kind, 'x.id', 'x.decided_at')} THEN 'open_exception' END], NULL) AS reasons
    FROM latest x)
  SELECT reg.*, CASE WHEN 'suspended' = ANY(reasons) OR 'expired' = ANY(reasons) THEN 'non_compliant' WHEN cardinality(reasons) > 0 THEN 'at_risk' ELSE 'good_standing' END AS standing FROM reg`;

cap({
  name: 'get_compliance_register', method: 'GET', path: '/federation/bodies/:id/compliance', tag: TAG,
  summary: 'The compliance register: for every affiliated organisation (kind=affiliation) or licence holder (kind=licence) under the body, whether they are in good standing, at risk (fee due, ending within 30 days with no renewal started, or an open exception) or non-compliant (suspended or expired), with the reasons. Read live from the canonical records; `standing` and `q` filter the list and `counts` always covers the whole filtered scope. Needs a reporting role.',
  input: z.object({ id, kind: z.enum(['affiliation', 'licence']).default('affiliation'), include_descendants: z.coerce.boolean().default(true), standing: z.enum(['good_standing', 'at_risk', 'non_compliant']).optional(), sport_id: id.optional(), q: z.string().trim().max(80).optional(), ...page }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    need(auth, 'reports');
    const ids = i.include_descendants ? await subtree(i.id) : [i.id];
    const base = `FROM (${REGISTER(i.kind)}) r JOIN governing_bodies b ON b.id=r.body_id JOIN organisations bo ON bo.id=b.organisation_id LEFT JOIN sports sp ON sp.id=r.sport_id
                   WHERE ($2::uuid IS NULL OR r.sport_id=$2) AND ($3::text IS NULL OR r.label ILIKE '%'||$3||'%' OR r.number ILIKE '%'||$3||'%')`;
    const scope = [ids, i.sport_id ?? null, i.q || null];
    const [counts, total, items] = await Promise.all([
      many(`SELECT r.standing, count(*)::int AS n ${base} GROUP BY 1`, scope),
      one(`SELECT count(*)::int AS n ${base} AND ($4::text IS NULL OR r.standing=$4)`, [...scope, i.standing ?? null]),
      many(`SELECT r.id, r.body_id, bo.name AS body_name, r.party_id, r.label, r.sub, sp.name AS sport_name, r.number, r.season_year, r.eff AS status, r.ends_on::text AS ends_on, r.fee_status, r.renewal_started, r.reasons, r.standing
              ${base} AND ($4::text IS NULL OR r.standing=$4) ORDER BY (r.standing='non_compliant') DESC, (r.standing='at_risk') DESC, r.ends_on, r.id LIMIT $5 OFFSET $6`, [...scope, i.standing ?? null, i.limit, i.offset]),
    ]);
    const by = Object.fromEntries(counts.map((x) => [x.standing, x.n]));
    return { kind: i.kind, counts: { good_standing: by.good_standing ?? 0, at_risk: by.at_risk ?? 0, non_compliant: by.non_compliant ?? 0 }, total: total.n, items };
  },
});

// ------------------------------------------------------------------ renewal campaigns
/** Staff who may run a campaign of this kind: the registrar (affiliations) or licensing officer (licences), compliance, or an admin. A role limited to one sport only covers that sport. */
function mayCampaign(auth, kind, sportId) {
  if (!auth || auth.viaAncestor) return false;
  if (auth.admin) return true;
  const own = kind === 'affiliation' ? 'registrar' : 'licensing';
  return auth.roles.some((r) => (r.role === own || r.role === 'compliance') && (!r.sport_id || r.sport_id === sportId));
}
function mustCampaign(auth, kind, sportId) { if (!mayCampaign(auth, kind, sportId)) throw forbidden(`Your role on ${auth?.body?.name ?? 'this body'} does not allow renewal campaigns`); }

const MATCH = {
  affiliation: `SELECT a.id AS subject_id, a.organisation_id AS party_id, a.affiliation_no AS number, a.effective_to AS ends_on, o.name AS label, c.name AS sub
      FROM fed_affiliations a JOIN fed_affiliation_categories c ON c.id=a.category_id JOIN organisations o ON o.id=a.organisation_id
     WHERE a.body_id=$1 AND (${AFF_STATUS('a')}) IN ('approved','expired') AND a.effective_to BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR c.sport_id=$4)
       AND NOT EXISTS (SELECT 1 FROM fed_affiliations n WHERE n.previous_id=a.id AND n.status NOT IN ('withdrawn','rejected')) ORDER BY a.effective_to, a.id`,
  licence: `SELECT l.id AS subject_id, l.holder_id AS party_id, l.licence_no AS number, l.expires_on AS ends_on, u.display_name AS label, t.name AS sub
      FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id JOIN users u ON u.id=l.holder_id
     WHERE l.body_id=$1 AND (${LIC_STATUS('l')}) IN ('active','expired') AND l.expires_on BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR t.sport_id=$4)
       AND NOT EXISTS (SELECT 1 FROM fed_licences n WHERE n.previous_id=l.id AND n.status NOT IN ('withdrawn','rejected')) ORDER BY l.expires_on, l.id`,
};
// What became of each invitation, read live from the renewal that points back at the record.
const OUTCOME = {
  affiliation: `FROM fed_campaign_targets t JOIN fed_affiliations s ON s.id=t.subject_id JOIN organisations o ON o.id=s.organisation_id JOIN fed_affiliation_categories cat ON cat.id=s.category_id
      LEFT JOIN LATERAL (SELECT n.id, n.status FROM fed_affiliations n WHERE n.previous_id=s.id AND n.status NOT IN ('withdrawn','rejected') ORDER BY n.created_at DESC LIMIT 1) n ON true`,
  licence: `FROM fed_campaign_targets t JOIN fed_licences s ON s.id=t.subject_id JOIN users u ON u.id=s.holder_id JOIN fed_licence_types cat ON cat.id=s.type_id
      LEFT JOIN LATERAL (SELECT n.id, n.status FROM fed_licences n WHERE n.previous_id=s.id AND n.status NOT IN ('withdrawn','rejected') ORDER BY n.created_at DESC LIMIT 1) n ON true`,
};
const OUTCOME_SQL = (kind) => `CASE WHEN n.status = '${kind === 'affiliation' ? 'approved' : 'active'}' THEN 'renewed' WHEN n.id IS NOT NULL THEN 'in_progress'
  WHEN (${kind === 'affiliation' ? AFF_STATUS('s') : LIC_STATUS('s')}) = 'expired' THEN 'lapsed' ELSE 'waiting' END`;

async function campaignStats(camp, db = pool) {
  const rows = (await db.query(`SELECT ${OUTCOME_SQL(camp.kind)} AS outcome, count(*)::int AS n ${OUTCOME[camp.kind]} WHERE t.campaign_id=$1 GROUP BY 1`, [camp.id])).rows;
  const by = Object.fromEntries(rows.map((r) => [r.outcome, r.n]));
  return { invited: camp.invited, renewed: by.renewed ?? 0, in_progress: by.in_progress ?? 0, waiting: by.waiting ?? 0, lapsed: by.lapsed ?? 0 };
}
const CAMP_COLS = 'k.id, k.body_id, k.name, k.kind, k.sport_id, sp.name AS sport_name, k.ends_from::text AS ends_from, k.ends_to::text AS ends_to, k.message, k.status, k.invited, k.sent_at, k.closed_at, k.created_at, su.display_name AS sent_by_name';
const CAMP_FROM = 'fed_campaigns k LEFT JOIN sports sp ON sp.id=k.sport_id LEFT JOIN users su ON su.id=k.sent_by';

cap({
  name: 'create_renewal_campaign', method: 'POST', path: '/federation/bodies/:id/campaigns', tag: TAG, status: 201,
  summary: 'Plan a renewal campaign: invite every affiliation (kind=affiliation) or licence (kind=licence) of this body that runs out between two dates, optionally for one sport, with an optional message. It starts as a draft and shows how many would be invited; nothing is sent until you send it. Records that already have a renewal started are never invited. Registrar / licensing officer / compliance / admin.',
  input: z.object({ id, name: z.string().trim().min(2).max(120), kind: z.enum(['affiliation', 'licence']), sport_id: id.optional(), ends_from: day, ends_to: day, message: z.string().trim().max(1000).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const auth = await authority(user, i.id, { c });
    mustCampaign(auth, i.kind, i.sport_id ?? null);
    mustBeActive(auth.body);
    if (i.ends_to < i.ends_from) throw badRequest('The end of the window is before its start');
    if ((new Date(i.ends_to) - new Date(i.ends_from)) / 864e5 > 400) throw badRequest('A campaign window can span at most 400 days');
    if (i.sport_id && !(await c.query('SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL', [i.id, i.sport_id])).rowCount) throw badRequest('That sport is not one this body governs');
    const k = (await c.query('INSERT INTO fed_campaigns(body_id, name, kind, sport_id, ends_from, ends_to, message, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [i.id, i.name, i.kind, i.sport_id ?? null, i.ends_from, i.ends_to, i.message ?? null, user.id])).rows[0];
    await logFed(c, i.id, 'campaign', k.id, 'created', { to: 'draft', actor: user.id, detail: { kind: i.kind, ends_from: i.ends_from, ends_to: i.ends_to } });
    return campaignView(k.id, c);
  }),
});

async function campaignView(campId, c) {
  const camp = (await c.query(`SELECT ${CAMP_COLS} FROM ${CAMP_FROM} WHERE k.id=$1`, [campId])).rows[0];
  if (!camp) throw notFound('Campaign');
  const preview = camp.status === 'draft' ? (await c.query(`SELECT count(*)::int AS n FROM (${MATCH[camp.kind]}) m`, [camp.body_id, camp.ends_from, camp.ends_to, camp.sport_id])).rows[0].n : null;
  return { ...plain(camp), would_invite: preview, stats: camp.status === 'draft' ? null : await campaignStats(camp, c) };
}

cap({
  name: 'send_renewal_campaign', method: 'POST', path: '/federation/campaigns/:id/send', tag: TAG,
  summary: 'Send a draft renewal campaign: every matching affiliation (its organisation\'s owners and admins) or licence (the holder, or their guardian-applicant) is told it is time to renew, once, and the invitation is recorded. A campaign is sent exactly once and invites at most 1,000 records; narrow the window or sport for more. The body must be active.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const camp = (await c.query('SELECT * FROM fed_campaigns WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!camp) throw notFound('Campaign');
    const auth = await authority(user, camp.body_id, { c, optional: true });
    if (!auth) throw notFound('Campaign');
    mustCampaign(auth, camp.kind, camp.sport_id);
    mustBeActive(auth.body);
    if (camp.status !== 'draft') throw conflict(`This campaign is already ${camp.status}`);
    const found = (await c.query(`${MATCH[camp.kind]} LIMIT ${MAX_INVITES + 1}`, [camp.body_id, camp.ends_from, camp.ends_to, camp.sport_id])).rows.map(plain);
    if (!found.length) throw badRequest('Nothing matches this window: every record in it is already renewing, or none runs out then');
    if (found.length > MAX_INVITES) throw badRequest(`This would invite more than ${MAX_INVITES} records; narrow the window or pick a sport`);
    for (const t of found) {
      await c.query('INSERT INTO fed_campaign_targets(campaign_id, subject_type, subject_id) VALUES ($1,$2,$3)', [camp.id, camp.kind, t.subject_id]);
      const who = camp.kind === 'affiliation'
        ? (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('owner','admin')", [t.party_id])).rows.map((x) => x.user_id)
        : (await c.query('SELECT DISTINCT u FROM (SELECT holder_id AS u FROM fed_licences WHERE id=$1 UNION SELECT applicant_id FROM fed_licences WHERE id=$1) x', [t.subject_id])).rows.map((x) => x.u);
      const what = camp.kind === 'affiliation' ? `Affiliation ${t.number}` : `Licence ${t.number}`;
      for (const uid of who) {
        await notify(c, uid, { kind: 'federation_campaign', title: camp.name, body: `${auth.body.name}: ${what} ${t.ends_on < today() ? 'ended' : 'ends'} on ${t.ends_on}. ${camp.message ? `${camp.message} ` : ''}Renew it to stay in good standing.`,
          data: { campaign_id: camp.id, subject_type: camp.kind, subject_id: t.subject_id }, dedupe_key: `fed-camp:${camp.id}:${t.subject_id}:${uid}` });
      }
    }
    await c.query("UPDATE fed_campaigns SET status='sent', invited=$2, sent_by=$3, sent_at=now() WHERE id=$1", [camp.id, found.length, user.id]);
    await logFed(c, camp.body_id, 'campaign', camp.id, 'sent', { from: 'draft', to: 'sent', actor: user.id, detail: { invited: found.length } });
    return campaignView(camp.id, c);
  }),
});

cap({
  name: 'close_renewal_campaign', method: 'POST', path: '/federation/campaigns/:id/close', tag: TAG,
  summary: 'Close a sent campaign. Its invitations and outcomes stay readable; closing only marks the campaign as finished.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const camp = (await c.query('SELECT * FROM fed_campaigns WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!camp) throw notFound('Campaign');
    const auth = await authority(user, camp.body_id, { c, optional: true });
    if (!auth) throw notFound('Campaign');
    mustCampaign(auth, camp.kind, camp.sport_id);
    if (camp.status !== 'sent') throw conflict(camp.status === 'draft' ? 'A draft has nothing to close; send it first' : 'This campaign is already closed');
    await c.query("UPDATE fed_campaigns SET status='closed', closed_by=$2, closed_at=now() WHERE id=$1", [camp.id, user.id]);
    await logFed(c, camp.body_id, 'campaign', camp.id, 'closed', { from: 'sent', to: 'closed', actor: user.id });
    return campaignView(camp.id, c);
  }),
});

cap({
  name: 'list_renewal_campaigns', method: 'GET', path: '/federation/bodies/:id/campaigns', tag: TAG,
  summary: 'The body\'s renewal campaigns, newest first, each with who was invited and what became of it so far: renewed, renewal in progress, still waiting, lapsed. A draft shows how many it would invite. Needs a reporting role.',
  input: z.object({ id, status: z.enum(['draft', 'sent', 'closed']).optional(), ...page }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    need(auth, 'reports');
    const [total, rows] = await Promise.all([
      one('SELECT count(*)::int AS n FROM fed_campaigns WHERE body_id=$1 AND ($2::text IS NULL OR status=$2)', [i.id, i.status ?? null]),
      many(`SELECT ${CAMP_COLS} FROM ${CAMP_FROM} WHERE k.body_id=$1 AND ($2::text IS NULL OR k.status=$2) ORDER BY k.created_at DESC, k.id LIMIT $3 OFFSET $4`, [i.id, i.status ?? null, i.limit, i.offset]),
    ]);
    const items = [];
    for (const k of rows) {
      const would = k.status === 'draft' ? (await one(`SELECT count(*)::int AS n FROM (${MATCH[k.kind]}) m`, [k.body_id, k.ends_from, k.ends_to, k.sport_id])).n : null;
      items.push({ ...plain(k), would_invite: would, stats: k.status === 'draft' ? null : await campaignStats(k) });
    }
    return { total: total.n, items, can_manage: mayCampaign(auth, 'affiliation', null) || mayCampaign(auth, 'licence', null) };
  },
});

cap({
  name: 'get_renewal_campaign', method: 'GET', path: '/federation/campaigns/:id', tag: TAG,
  summary: 'One renewal campaign with its totals and, once sent, every invited record and its outcome (renewed, in_progress, waiting, lapsed), filterable by outcome. Needs a reporting role on the campaign\'s body.',
  input: z.object({ id, outcome: z.enum(['renewed', 'in_progress', 'waiting', 'lapsed']).optional(), ...page }),
  async handler({ user }, i) {
    const camp = await one('SELECT * FROM fed_campaigns WHERE id=$1', [i.id]);
    if (!camp) throw notFound('Campaign');
    const auth = await authority(user, camp.body_id, { optional: true });
    if (!auth) throw notFound('Campaign');
    need(auth, 'reports');
    const view = await campaignView(camp.id, pool);
    const label = camp.kind === 'affiliation' ? 'o.name' : 'u.display_name';
    const number = camp.kind === 'affiliation' ? 's.affiliation_no' : 's.licence_no';
    const ends = camp.kind === 'affiliation' ? 's.effective_to' : 's.expires_on';
    const total = camp.status === 'draft' ? 0 : (await one(`SELECT count(*)::int AS n ${OUTCOME[camp.kind]} WHERE t.campaign_id=$1 AND ($2::text IS NULL OR ${OUTCOME_SQL(camp.kind)} = $2)`, [camp.id, i.outcome ?? null])).n;
    const items = camp.status === 'draft' ? [] : await many(
      `SELECT t.subject_id, t.invited_at, ${label} AS label, cat.name AS sub, ${number} AS number, ${ends}::text AS ends_on, ${OUTCOME_SQL(camp.kind)} AS outcome, n.id AS renewal_id ${OUTCOME[camp.kind]}
        WHERE t.campaign_id=$1 AND ($2::text IS NULL OR ${OUTCOME_SQL(camp.kind)} = $2) ORDER BY ${ends}, t.subject_id LIMIT $3 OFFSET $4`, [camp.id, i.outcome ?? null, i.limit, i.offset]);
    return { ...view, total, items, can_manage: mayCampaign(auth, camp.kind, camp.sport_id) };
  },
});
