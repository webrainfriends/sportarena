// Sports agent & player representation (issue #484) 3/5: consent and access. The athlete (or a guardian) shares *specific items* inside what the agreed
// mandate allows; every agent read goes through requireLive, so revoking, expiry, a lapsed verification or a withdrawn guardian consent end it at once.
import { z } from 'zod';
import { cap, id, capabilities } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { requireConsent } from '../youth.js';
import {
  CATEGORY_SUBJECT, CONSENT_FOR, SUBJECT_CATEGORY, SUBJECT_PURPOSE, TRANSFER_WORKFLOW_AVAILABLE, assess, athleteSideOf, canDecide, detectDealConflicts, inForce, loadMandate, logEvent, notifyAgentSide, requireLive,
} from '../representation.js';

const TAG = 'Representation';
const SUBJECT_TYPES = Object.keys(SUBJECT_CATEGORY);

/** What an item is called, for the people who may see it. Titles only; nothing private is copied. */
export async function subjectTitle(c, type, subjectId) {
  const q = (sql) => c.query(sql, [subjectId]).then((r) => r.rows[0] ?? null);
  if (type === 'passport_video') return (await q('SELECT title FROM passport_videos WHERE id=$1'))?.title ?? null;
  if (type === 'billboard_response') { const r = await q('SELECT p.title FROM billboard_responses r JOIN billboard_posts p ON p.id=r.post_id WHERE r.id=$1'); return r ? `Application: ${r.title}` : null; }
  if (type === 'player_contract') { const r = await q('SELECT contract_no, title FROM player_contracts WHERE id=$1'); return r ? `${r.contract_no} · ${r.title}` : null; }
  if (type === 'sponsorship') { const r = await q('SELECT coalesce(s.agreement_ref, sp.name) AS t, sp.name FROM sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id WHERE s.id=$1'); return r ? `Sponsorship · ${r.name}${r.t && r.t !== r.name ? ` (${r.t})` : ''}` : null; }
  return null;
}

/** The sport an item belongs to, when it has one (used to keep grants inside the mandate's sports). */
async function subjectSport(c, type, subjectId) {
  const q = (sql) => c.query(sql, [subjectId]).then((r) => r.rows[0]?.sport_id ?? null);
  if (type === 'passport_video') return q('SELECT sport_id FROM passport_videos WHERE id=$1');
  if (type === 'billboard_response') return q('SELECT p.sport_id FROM billboard_responses r JOIN billboard_posts p ON p.id=r.post_id WHERE r.id=$1');
  if (type === 'player_contract') return q('SELECT t.sport_id FROM player_contracts k JOIN teams t ON t.id=k.team_id WHERE k.id=$1');
  return null;
}

/** The athlete's own items of one kind that may be shared (ownership is checked here, and again on every grant). */
async function ownItems(c, athleteId, type, { limit = 50, offset = 0 } = {}) {
  if (type === 'passport_video') return (await c.query("SELECT v.id, v.title AS title, s.name AS sub FROM passport_videos v LEFT JOIN sports s ON s.id=v.sport_id WHERE v.user_id=$1 AND v.removed_at IS NULL AND v.status='approved' ORDER BY v.created_at DESC, v.id LIMIT $2 OFFSET $3", [athleteId, limit, offset])).rows;
  if (type === 'billboard_response') return (await c.query("SELECT r.id, p.title AS title, r.status AS sub FROM billboard_responses r JOIN billboard_posts p ON p.id=r.post_id WHERE r.responder_id=$1 ORDER BY r.created_at DESC, r.id LIMIT $2 OFFSET $3", [athleteId, limit, offset])).rows;
  if (type === 'player_contract') return (await c.query("SELECT k.id, k.contract_no || ' · ' || k.title AS title, k.status AS sub FROM player_contracts k WHERE k.payee_id=$1 AND k.status <> 'draft' AND k.status <> 'void' ORDER BY k.created_at DESC, k.id LIMIT $2 OFFSET $3", [athleteId, limit, offset])).rows;
  if (type === 'sponsorship') return (await c.query("SELECT s.id, 'Sponsorship · ' || sp.name AS title, s.status AS sub FROM sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id WHERE s.target_type='athlete' AND s.target_id=$1 AND s.status IN ('proposed','active','ended') ORDER BY s.created_at DESC, s.id LIMIT $2 OFFSET $3", [athleteId, limit, offset])).rows;
  return [];
}

const grantRow = (c, mandateId, type, subjectId) => c.query('SELECT * FROM representation_grants WHERE mandate_id=$1 AND subject_type=$2 AND subject_id=$3 AND revoked_at IS NULL', [mandateId, type, subjectId]).then((r) => r.rows[0] ?? null);

cap({
  name: 'list_grantable_items', method: 'GET', path: '/representation/mandates/:id/grantable', tag: TAG,
  summary: 'The athlete side: your own items of one kind that you could share with this agent (approved videos, applications, contracts, sponsorships), with whether each is already shared. Only the kinds the agreed mandate allows can be shared.',
  input: z.object({ id, subject_type: z.enum(SUBJECT_TYPES), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }),
  async handler({ user }, i) {
    const ctx = await loadMandate(pool, user, i.id);
    if (!canDecide(ctx.side) && ctx.side !== 'youth') throw forbidden('Only the athlete or a guardian can see what could be shared');
    const v = await inForce(pool, ctx.mandate);
    const category = SUBJECT_CATEGORY[i.subject_type];
    const allowed = !!v && v.data_access.includes(category) && ctx.mandate.status === 'active' && (i.subject_type !== 'transfer' || TRANSFER_WORKFLOW_AVAILABLE);
    const items = allowed ? await ownItems(pool, ctx.mandate.athlete_id, i.subject_type, i) : [];
    const grants = new Map((await many('SELECT subject_id, level FROM representation_grants WHERE mandate_id=$1 AND subject_type=$2 AND revoked_at IS NULL', [i.id, i.subject_type])).map((g) => [g.subject_id, g.level]));
    return { subject_type: i.subject_type, allowed, reason: allowed ? null : i.subject_type === 'transfer' && !TRANSFER_WORKFLOW_AVAILABLE ? 'The transfer and loan workflow is not available yet' : 'The agreed mandate does not allow this kind of information. Amend it first.', items: items.map((x) => ({ ...x, shared: grants.has(x.id), level: grants.get(x.id) ?? null })) };
  },
});

cap({
  name: 'grant_representation_access', method: 'POST', path: '/representation/mandates/:id/grants', tag: TAG, status: 201,
  summary: 'Share one specific item with the agent: an approved recruitment video, one of your applications, a player contract you are party to, or a sponsorship agreement made with you. The mandate must be in force and must allow that kind of information and purpose. level=participate (contracts only) also lets the agent comment and keep negotiation notes; it never lets them sign. A guardian decides for a young person. Repeating updates the level.',
  input: z.object({ id, subject_type: z.enum(SUBJECT_TYPES), subject_id: id, level: z.enum(['view', 'participate']).default('view') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await loadMandate(c, user, i.id, { lock: true });
      const m = ctx.mandate;
      if (!canDecide(ctx.side)) throw forbidden(ctx.side === 'youth' ? 'A guardian decides what is shared for a young person' : 'Only the athlete or a guardian can share an item');
      if (m.status !== 'active') throw conflict('Only a mandate in force can receive shared items', { code: 'not_active' });
      const state = await assess(c, m, { agent: ctx.agent });
      const v = state.version ?? await inForce(c, m);
      const category = SUBJECT_CATEGORY[i.subject_type];
      if (i.subject_type === 'transfer' && !TRANSFER_WORKFLOW_AVAILABLE) throw conflict('The transfer and loan workflow is not available yet, so nothing can be shared from it', { code: 'workflow_unavailable' });
      if (!v.data_access.includes(category)) throw conflict('The agreed mandate does not allow this kind of information. Amend the mandate first.', { code: 'data_not_permitted', category });
      if (!v.purposes.includes(SUBJECT_PURPOSE[i.subject_type])) throw conflict('The agreed mandate does not include the purpose this item belongs to', { code: 'purpose_not_in_mandate' });
      if (i.level === 'participate' && i.subject_type !== 'player_contract') throw badRequest('Only contract discussions can be shared at the participate level');
      const mine = (await ownItems(c, m.athlete_id, i.subject_type, { limit: 100000, offset: 0 })).some((x) => x.id === i.subject_id);
      if (!mine) throw notFound('Item'); // not the athlete's own, or not shareable: say the same thing
      const sport = await subjectSport(c, i.subject_type, i.subject_id);
      if (sport && !v.sport_ids.includes(sport)) throw conflict('That item belongs to a sport the mandate does not cover', { code: 'sport_not_in_mandate' });
      await requireConsent(m.athlete_id, CONSENT_FOR[category], 'sharing this with an agent', c);
      const prior = await grantRow(c, m.id, i.subject_type, i.subject_id);
      let g;
      if (prior) { g = (await c.query('UPDATE representation_grants SET level=$2 WHERE id=$1 RETURNING *', [prior.id, i.level])).rows[0]; }
      else g = (await c.query('INSERT INTO representation_grants(mandate_id, category, subject_type, subject_id, level, granted_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [m.id, category, i.subject_type, i.subject_id, i.level, user.id])).rows[0];
      await logEvent(c, m.id, user.id, ctx.side, prior ? 'grant_changed' : 'grant_made', { subject_type: i.subject_type, subject_id: i.subject_id, detail: { level: i.level } });
      if (!prior && (i.subject_type === 'player_contract' || i.subject_type === 'sponsorship')) await detectDealConflicts(c, { mandate: m, agent: ctx.agent, subjectType: i.subject_type, subjectId: i.subject_id, actor: user.id });
      if (!prior) await notifyAgentSide(c, m, { kind: 'representation_grant', title: 'An athlete shared an item with you', body: `${await subjectTitle(c, i.subject_type, i.subject_id)} (${i.level === 'participate' ? 'you may take part' : 'view'}).` }, user.id);
      await audit(c, user.id, 'grant_representation_access', 'representation_mandates', m.id);
      return { ...g, title: await subjectTitle(c, i.subject_type, i.subject_id) };
    });
  },
});

cap({
  name: 'revoke_representation_grant', method: 'DELETE', path: '/representation/grants/:id', tag: TAG,
  summary: 'Stop sharing one item with the agent. Effective at once for every API, MCP, file and export route; the agent keeps their own notes and records about it. The athlete, a guardian or the young person can do this.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const g = (await c.query('SELECT * FROM representation_grants WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!g) throw notFound('Grant');
      const ctx = await loadMandate(c, user, g.mandate_id, { lock: true });
      if (!ctx.side) throw notFound('Grant');
      if (g.revoked_at) return { id: g.id, revoked: true };
      await c.query('UPDATE representation_grants SET revoked_at=now(), revoked_by=$2 WHERE id=$1', [g.id, user.id]);
      await logEvent(c, g.mandate_id, user.id, ctx.side, 'grant_revoked', { subject_type: g.subject_type, subject_id: g.subject_id });
      await notifyAgentSide(c, ctx.mandate, { kind: 'representation_grant_revoked', title: 'An athlete stopped sharing an item', body: 'You can no longer open it. Your own notes and records about it are kept.' }, user.id);
      return { id: g.id, revoked: true };
    });
  },
});

cap({
  name: 'list_representation_grants', method: 'GET', path: '/representation/mandates/:id/grants', tag: TAG,
  summary: 'What has been shared under a mandate. The athlete side sees every item with its title, live or revoked. The agent side sees titles only of items that are shared right now.',
  input: z.object({ id, include_revoked: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const ctx = await loadMandate(pool, user, i.id);
    const rows = await many(`SELECT id, category, subject_type, subject_id, level, granted_at, revoked_at FROM representation_grants WHERE mandate_id=$1 ${i.include_revoked || ctx.side ? '' : 'AND revoked_at IS NULL'} ORDER BY granted_at DESC, id`, [i.id]);
    const live = (await assess(pool, ctx.mandate, { agent: ctx.agent })).live;
    return Promise.all(rows.filter((g) => (ctx.side ? (i.include_revoked || !g.revoked_at) : !g.revoked_at)).map(async (g) => ({ ...g, title: ctx.side || (live && !g.revoked_at) ? await subjectTitle(pool, g.subject_type, g.subject_id) : null })));
  },
});

cap({
  name: 'get_represented_athlete', method: 'GET', path: '/representation/mandates/:id/athlete', tag: TAG,
  summary: 'The agent side: what the athlete allowed you to see right now - the public Sports Passport (exactly what anyone can see) and the recruitment videos shared with you one by one. Live-checked on every call and audit-logged; it stops at once on revocation, expiry, suspension, a lapsed verification or a withdrawn guardian consent. No medical, coaching, family-finance or contact details are ever included.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const live = await requireLive(pool, user, i.id, { category: 'public_passport', staff: 'view' });
    const m = live.mandate;
    const person = capabilities.find((x) => x.name === 'get_person');
    let passport = null;
    try { passport = await person.handler({ user: null }, { id: m.athlete_id }); } catch (e) { if (e.status !== 404) throw e; passport = { restricted: true, note: 'This person\'s profile is not public' }; }
    let videos = [];
    if (live.version.data_access.includes('recruitment_materials')) {
      try {
        await requireLive(pool, user, i.id, { category: 'recruitment_materials', purpose: 'opportunity_outreach', staff: 'view' });
        videos = await many(
          `SELECT v.id, v.title, v.link_url, v.content_type, g.level FROM representation_grants g JOIN passport_videos v ON v.id=g.subject_id AND v.user_id=$2 AND v.removed_at IS NULL AND v.status='approved'
            WHERE g.mandate_id=$1 AND g.subject_type='passport_video' AND g.revoked_at IS NULL ORDER BY v.created_at DESC`, [i.id, m.athlete_id]);
      } catch (e) { if (e.status !== 403) throw e; }
    }
    await audit(null, user.id, 'read_represented_athlete', 'representation_mandates', m.id);
    return { mandate_id: m.id, athlete_id: m.athlete_id, passport, shared_videos: videos, as_of: new Date().toISOString() };
  },
});
