// Insurance panel providers: physios/doctors empanelled with an insurer, and "who can I see under my cover?" for the person insured.
// Linking needs both sides (insurer + provider). Lookup uses the caller's own active policies; it never exposes policy numbers.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { PUBLIC_USER } from '../helpers.js';
import { clinicalCredential, requireVerifiedProvider } from '../clinical-access.js';
import { notify } from '../notify.js';
import { myInsurer } from './insurance.js';

const TAG = 'Insurance';
export const PANEL_COVER = ['individual', 'team', 'group', 'organisation', 'event'];
const KINDS = z.array(z.enum(PANEL_COVER)).max(5);
const terms = {
  cashless: z.boolean().default(false), network_ref: z.string().trim().max(60).nullable().optional(), cover_types: KINDS.default([]), plan_ids: z.array(id).max(50).default([]),
  valid_from: z.string().date().nullable().optional(), valid_to: z.string().date().nullable().optional(), note: z.string().max(300).nullable().optional(),
};

const log = (c, memberId, actor, action, from, to, reason) => c.query('INSERT INTO insurer_panel_events(member_id, actor_id, action, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5,$6)', [memberId, actor, action, from ?? null, to ?? null, reason ?? null]);
const checkWindow = (i) => { if (i.valid_from && i.valid_to && i.valid_to < i.valid_from) throw badRequest('The end date is before the start'); };
async function checkPlans(c, insurerId, planIds) {
  if (!planIds?.length) return;
  const n = (await c.query('SELECT count(*)::int AS n FROM insurance_plans WHERE insurer_id=$1 AND id = ANY($2)', [insurerId, planIds])).rows[0].n;
  if (n !== new Set(planIds).size) throw badRequest("Choose that insurer's own plans");
}
const isProvider = (u) => u.roles.some((r) => ['physio', 'doctor'].includes(r));

cap({
  name: 'invite_panel_provider', method: 'POST', path: '/insurance/panel', tag: TAG, auth: ['insurer'], status: 201,
  summary: 'Insurer: invite a physio/doctor onto your panel (network). They must accept before they are listed. Set whether treatment is cashless (information for patients), your network reference, which kinds of cover and which of your plans it applies to (empty = all), and validity dates.',
  input: z.object({ provider_id: id, ...terms }),
  async handler({ user }, i) {
    const ins = await myInsurer(user); checkWindow(i);
    if (!(await one("SELECT 1 FROM provider_profiles WHERE user_id=$1 UNION SELECT 1 FROM active_sport_profiles WHERE user_id=$1 AND role IN ('physio','doctor')", [i.provider_id]))) throw badRequest('That person is not a registered physio or doctor');
    return tx(async (c) => {
      await checkPlans(c, ins.id, i.plan_ids);
      let r;
      try {
        r = (await c.query("INSERT INTO insurer_panel_members(insurer_id, provider_id, status, proposed_by, cashless, network_ref, cover_types, plan_ids, valid_from, valid_to, note) VALUES ($1,$2,'invited','insurer',$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [ins.id, i.provider_id, i.cashless, i.network_ref ?? null, i.cover_types, i.plan_ids, i.valid_from ?? null, i.valid_to ?? null, i.note ?? null])).rows[0];
      } catch (e) { if (e.code === '23505') throw conflict('This provider is already on your panel or has a pending request/invitation'); throw e; }
      await log(c, r.id, user.id, 'invited', null, 'invited');
      await notify(c, i.provider_id, { kind: 'panel_invite', title: 'Panel invitation', body: 'An insurer invited you to join its panel. Open Health to respond.', data: { panel_id: r.id } });
      return r;
    });
  },
});

cap({
  name: 'request_panel_membership', credential: true, method: 'POST', path: '/insurance/panel/requests', tag: TAG, auth: ['physio', 'doctor'], status: 201,
  summary: 'Physio/doctor: ask an insurer to add you to its panel. You need a current verified credential; the insurer approves or declines and sets the terms.',
  input: z.object({ insurer_id: id, network_ref: z.string().trim().max(60).nullable().optional(), note: z.string().max(300).nullable().optional() }),
  async handler({ user }, i) {
    await requireVerifiedProvider(user.id, { action: 'request_panel_membership' });
    const ins = await one("SELECT id, owner_id FROM insurers WHERE id=$1 AND status='active'", [i.insurer_id]);
    if (!ins) throw notFound('Insurer');
    return tx(async (c) => {
      let r;
      try {
        r = (await c.query("INSERT INTO insurer_panel_members(insurer_id, provider_id, status, proposed_by, network_ref, note) VALUES ($1,$2,'requested','provider',$3,$4) RETURNING *", [ins.id, user.id, i.network_ref ?? null, i.note ?? null])).rows[0];
      } catch (e) { if (e.code === '23505') throw conflict('You are already on this insurer\'s panel or a request is pending'); throw e; }
      await log(c, r.id, user.id, 'requested', null, 'requested');
      if (ins.owner_id) await notify(c, ins.owner_id, { kind: 'panel_request', title: 'Panel request', body: 'A physio/doctor asked to join your panel.', data: { panel_id: r.id } });
      return r;
    });
  },
});

cap({
  name: 'respond_panel_link', credential: true, method: 'POST', path: '/insurance/panel/:id/respond', tag: TAG, auth: ['insurer', 'physio', 'doctor'],
  summary: 'Answer a pending link: the provider accepts or declines an insurer\'s invitation (accepting needs a current verified credential); the insurer approves or declines a provider\'s request (and may set terms when approving).',
  input: z.object({ id, accept: z.boolean(), reason: z.string().max(300).optional(), cashless: z.boolean().optional(), cover_types: KINDS.optional(), plan_ids: z.array(id).max(50).optional(), valid_from: z.string().date().nullable().optional(), valid_to: z.string().date().nullable().optional() }),
  async handler({ user }, i) {
    checkWindow(i);
    const m = await one('SELECT m.*, n.owner_id FROM insurer_panel_members m JOIN insurers n ON n.id=m.insurer_id WHERE m.id=$1', [i.id]);
    if (!m) throw notFound('Panel link');
    const byProvider = m.proposed_by === 'insurer' && m.status === 'invited' && m.provider_id === user.id;
    const byInsurer = m.proposed_by === 'provider' && m.status === 'requested' && m.owner_id === user.id;
    if (!byProvider && !byInsurer) throw forbidden('This link is not waiting for your answer');
    if (byProvider && i.accept) await requireVerifiedProvider(user.id, { action: 'accept_panel_invite' });
    return tx(async (c) => {
      const cur = (await c.query('SELECT * FROM insurer_panel_members WHERE id=$1 FOR UPDATE', [m.id])).rows[0];
      if (cur.status !== m.status) throw conflict('This link was just changed; reload');
      const next = i.accept ? 'active' : 'declined';
      if (byInsurer && i.accept) await checkPlans(c, m.insurer_id, i.plan_ids);
      const t = byInsurer && i.accept ? { cashless: i.cashless ?? cur.cashless, cover_types: i.cover_types ?? cur.cover_types, plan_ids: i.plan_ids ?? cur.plan_ids, valid_from: i.valid_from ?? cur.valid_from, valid_to: i.valid_to ?? cur.valid_to } : cur;
      const r = (await c.query('UPDATE insurer_panel_members SET status=$2, cashless=$3, cover_types=$4, plan_ids=$5, valid_from=$6, valid_to=$7, updated_at=now() WHERE id=$1 RETURNING *', [m.id, next, t.cashless, t.cover_types, t.plan_ids, t.valid_from, t.valid_to])).rows[0];
      await log(c, m.id, user.id, i.accept ? 'accepted' : 'declined', m.status, next, i.reason);
      return r;
    });
  },
});

cap({
  name: 'update_panel_member', method: 'PATCH', path: '/insurance/panel/:id', tag: TAG, auth: ['insurer'],
  summary: 'Insurer: change the terms of an active panel member (cashless, network reference, cover kinds, plans, validity). Changes are recorded.',
  input: z.object({ id, cashless: z.boolean().optional(), network_ref: z.string().trim().max(60).nullable().optional(), cover_types: KINDS.optional(), plan_ids: z.array(id).max(50).optional(), valid_from: z.string().date().nullable().optional(), valid_to: z.string().date().nullable().optional(), note: z.string().max(300).nullable().optional() }),
  async handler({ user }, i) {
    const ins = await myInsurer(user); checkWindow(i);
    return tx(async (c) => {
      const cur = (await c.query("SELECT * FROM insurer_panel_members WHERE id=$1 AND insurer_id=$2 AND status='active' FOR UPDATE", [i.id, ins.id])).rows[0];
      if (!cur) throw notFound('Panel member');
      await checkPlans(c, ins.id, i.plan_ids);
      const v = (k) => (i[k] === undefined ? cur[k] : i[k]);
      const r = (await c.query('UPDATE insurer_panel_members SET cashless=$2, network_ref=$3, cover_types=$4, plan_ids=$5, valid_from=$6, valid_to=$7, note=$8, updated_at=now() WHERE id=$1 RETURNING *', [cur.id, v('cashless'), v('network_ref'), v('cover_types'), v('plan_ids'), v('valid_from'), v('valid_to'), v('note')])).rows[0];
      await log(c, cur.id, user.id, 'terms_updated');
      return r;
    });
  },
});

cap({
  name: 'end_panel_membership', method: 'POST', path: '/insurance/panel/:id/end', tag: TAG, auth: ['insurer', 'physio', 'doctor'],
  summary: 'Either side ends a panel link (or the provider/insurer withdraws a pending one). The row and its history are kept.',
  input: z.object({ id, reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    const m = await one('SELECT m.*, n.owner_id FROM insurer_panel_members m JOIN insurers n ON n.id=m.insurer_id WHERE m.id=$1', [i.id]);
    if (!m || (m.provider_id !== user.id && m.owner_id !== user.id)) throw notFound('Panel link');
    if (!['invited', 'requested', 'active'].includes(m.status)) throw conflict('This link has already ended');
    return tx(async (c) => {
      const r = (await c.query("UPDATE insurer_panel_members SET status='ended', ended_at=now(), ended_by=$2, updated_at=now() WHERE id=$1 AND status=$3 RETURNING *", [m.id, user.id, m.status])).rows[0];
      if (!r) throw conflict('This link was just changed; reload');
      await log(c, m.id, user.id, 'ended', m.status, 'ended', i.reason);
      return r;
    });
  },
});

cap({
  name: 'list_my_panel', method: 'GET', path: '/insurance/panel/mine', tag: TAG, auth: ['insurer', 'physio', 'doctor'],
  summary: 'Insurer: your panel (providers, state, terms) and pending requests. Physio/doctor: the insurers you are linked to, invitations waiting for you and your pending requests. Includes the history of each link.',
  input: z.object({ status: z.enum(['invited', 'requested', 'active', 'declined', 'ended']).optional(), ...page }),
  async handler({ user }, i) {
    const asInsurer = user.roles.includes('insurer') ? await myInsurer(user, { required: false }) : null;
    const rows = await many(
      `SELECT m.*, n.name AS insurer_name, (n.verified_at IS NOT NULL) AS insurer_verified, ${PUBLIC_USER.replace('u.id,', 'u.id AS provider_user_id,')}, pp.provider_type, pp.city,
              (SELECT json_agg(json_build_object('action', e.action, 'to_status', e.to_status, 'reason', e.reason, 'at', e.created_at) ORDER BY e.created_at) FROM insurer_panel_events e WHERE e.member_id=m.id) AS history
         FROM insurer_panel_members m JOIN insurers n ON n.id=m.insurer_id JOIN users u ON u.id=m.provider_id LEFT JOIN provider_profiles pp ON pp.user_id=m.provider_id
        WHERE (m.provider_id=$1 OR m.insurer_id=$2) AND ($3::text IS NULL OR m.status=$3) ORDER BY m.updated_at DESC, m.id LIMIT $4 OFFSET $5`, [user.id, asInsurer?.id ?? null, i.status ?? null, i.limit, i.offset]);
    return rows.map((m) => ({ ...m, as: m.provider_id === user.id ? 'provider' : 'insurer', waiting_for_me: (m.status === 'invited' && m.provider_id === user.id) || (m.status === 'requested' && m.insurer_id === asInsurer?.id) }));
  },
});

const LIVE = "m.status='active' AND (m.valid_from IS NULL OR m.valid_from <= current_date) AND (m.valid_to IS NULL OR m.valid_to >= current_date)";
const PUB = `${PUBLIC_USER}, pp.provider_type, pp.headline, pp.clinic, pp.city, pp.remote_ok, pp.in_person, pp.specialties, pp.languages, pp.accepting_patients`;

/** keep only providers whose clinical credential is current right now (computed live, same rule as booking) */
async function currentlyVerified(rows) {
  const out = [];
  for (const r of rows) if ((await clinicalCredential(r.id, {})).ok) out.push(r);
  return out;
}

cap({
  name: 'list_insurer_panel', method: 'GET', path: '/insurance/insurers/:id/panel', tag: TAG, auth: 'public',
  summary: 'An insurer\'s current panel: public provider profile fields only, whether treatment is cashless, and which kinds of cover it applies to. Only providers who are active on the panel, inside their validity dates and whose professional verification is current are listed.',
  input: z.object({ id, provider_type: z.enum(['physio', 'doctor']).optional(), city: z.string().max(80).optional(), cashless: z.coerce.boolean().optional(), ...page }),
  async handler(_, i) {
    const rows = await many(
      `SELECT ${PUB}, m.id AS panel_id, m.cashless, m.cover_types, m.plan_ids FROM insurer_panel_members m JOIN users u ON u.id=m.provider_id JOIN provider_profiles pp ON pp.user_id=u.id
        WHERE m.insurer_id=$1 AND ${LIVE} AND pp.listed AND ($2::text IS NULL OR pp.provider_type=$2) AND ($3::text IS NULL OR pp.city ILIKE $3) AND (NOT $4 OR m.cashless) ORDER BY u.display_name, u.id LIMIT $5 OFFSET $6`,
      [i.id, i.provider_type ?? null, i.city ?? null, !!i.cashless, i.limit, i.offset]);
    return currentlyVerified(rows);
  },
});

cap({
  name: 'list_provider_insurers', method: 'GET', path: '/providers/:id/insurers', tag: TAG, auth: 'public',
  summary: 'The insurers whose panel a physio/doctor is currently on (name, verified flag, cashless, kinds of cover). Empty when their professional verification is not current.',
  input: z.object({ id }),
  async handler(_, i) {
    if (!(await clinicalCredential(i.id, {})).ok) return [];
    return many(`SELECT n.id AS insurer_id, n.name AS insurer, (n.verified_at IS NOT NULL) AS insurer_verified, m.cashless, m.cover_types FROM insurer_panel_members m JOIN insurers n ON n.id=m.insurer_id WHERE m.provider_id=$1 AND ${LIVE} AND n.status='active' ORDER BY n.name`, [i.id]);
  },
});

/**
 * The covers `userId` is currently insured through: their own policy, a team they play for, an event they are in. One entry per active policy.
 * Each resolver answers "does this person benefit from a policy on that subject?"; further cover kinds plug in here.
 */
export async function myCovers(userId) {
  return many(
    `SELECT p.id AS policy_id, p.plan_id, pl.name AS plan_name, pl.insurer_id, coalesce(n.name, pl.insurer) AS insurer, p.subject_type AS cover_for, p.subject_id, p.ends_on,
            CASE p.subject_type WHEN 'team' THEN (SELECT name FROM teams WHERE id=p.subject_id) WHEN 'event' THEN (SELECT name FROM events WHERE id=p.subject_id) END AS subject_name
       FROM insurance_policies p JOIN insurance_plans pl ON pl.id=p.plan_id LEFT JOIN insurers n ON n.id=pl.insurer_id
      WHERE p.status='active' AND p.starts_on <= current_date AND p.ends_on >= current_date AND pl.insurer_id IS NOT NULL AND (
        (p.subject_type='individual' AND p.subject_id=$1)
        OR (p.subject_type='team' AND EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=p.subject_id AND m.user_id=$1 AND m.status='active'))
        OR (p.subject_type='event' AND (EXISTS (SELECT 1 FROM event_entries e WHERE e.event_id=p.subject_id AND e.status='accepted' AND (e.user_id=$1 OR e.team_id IN (SELECT team_id FROM team_members WHERE user_id=$1 AND status='active')))
                                      OR EXISTS (SELECT 1 FROM event_participants x WHERE x.event_id=p.subject_id AND x.user_id=$1))))`, [userId]);
}

cap({
  name: 'list_covered_providers', method: 'GET', path: '/insurance/covered-providers', tag: TAG,
  summary: 'Physios/doctors you can see under your insurance: for each of your active policies (your own, your team\'s, an event you are in…), the providers on that insurer\'s panel whose terms cover that kind of cover and plan. Shows which cover applies and whether it is cashless; never policy numbers. Filter by type, city or cashless.',
  input: z.object({ provider_type: z.enum(['physio', 'doctor']).optional(), city: z.string().max(80).optional(), cashless: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    const covers = await myCovers(user.id);
    if (!covers.length) return { covers: [], providers: [] };
    const rows = await many(
      `SELECT ${PUB}, m.id AS panel_id, m.insurer_id, m.cashless, m.cover_types, m.plan_ids FROM insurer_panel_members m JOIN users u ON u.id=m.provider_id JOIN provider_profiles pp ON pp.user_id=u.id
        WHERE ${LIVE} AND pp.listed AND m.insurer_id = ANY($1) AND u.id <> $2 AND ($3::text IS NULL OR pp.provider_type=$3) AND ($4::text IS NULL OR pp.city ILIKE $4) AND (NOT $5 OR m.cashless) ORDER BY u.display_name, u.id`,
      [[...new Set(covers.map((c) => c.insurer_id))], user.id, i.provider_type ?? null, i.city ?? null, !!i.cashless]);
    const out = [];
    for (const r of rows) {
      const via = covers.filter((c) => c.insurer_id === r.insurer_id && (!r.cover_types.length || r.cover_types.includes(c.cover_for)) && (!r.plan_ids.length || r.plan_ids.includes(c.plan_id)))
        .map((c) => ({ policy_id: c.policy_id, insurer: c.insurer, plan: c.plan_name, cover_for: c.cover_for, subject: c.subject_name, ends_on: c.ends_on }));
      if (via.length && (await clinicalCredential(r.id, {})).ok) { const { plan_ids, insurer_id, ...pub } = r; out.push({ ...pub, covered_by: via }); }
    }
    return { covers: covers.map(({ plan_id, insurer_id, ...c }) => c), providers: out.slice(i.offset, i.offset + i.limit) };
  },
});
