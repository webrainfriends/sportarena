// Sports agent & player representation (issue #484) 2/5: the mandate. Versioned terms signed by every required party (athlete, guardian for a young person,
// agent), revocable by the athlete side at any moment, renewable by a new signed version. Terms are frozen once proposed; an amendment is a new version.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { guardiansOf, isYouth, requireConsent } from '../youth.js';
import {
  CONTACT_ACTIONS, DATA_ACCESS, PURPOSES, VERSION_COLS, actingFor, agentOfUser, agentRecipients, agentStanding, assess, athleteRecipients, athleteSideOf, canDecide, db, detectDealConflicts, diffTerms, inForce, ladderOf,
  loadAgent, loadMandate, logEvent, mandateTermsSchema, normaliseTerms, notifyAgentSide, notifyAthleteSide, raiseConflict, requiredParties, summariseTerm, sumLadders, termsOf, todayIso, totalsOf, versionsOf,
} from '../representation.js';

const TAG = 'Representation';
const text = (n) => z.string().trim().max(n);
const stale = () => conflict('This record changed; reload it and try again', { code: 'stale_version' });

// ------------------------------------------------------------------ views
const sigsOf = async (c, ids) => (ids.length ? (await c.query('SELECT version_id, party, signer_id, decision, comment, signed_at FROM representation_signatures WHERE version_id = ANY($1) ORDER BY signed_at, id', [ids])).rows : []);

async function viewVersions(c, versions) {
  const s = await sigsOf(c, versions.map((v) => v.id));
  const ids = [...new Set(s.map((x) => x.signer_id).concat(versions.map((v) => v.proposed_by)))];
  const names = new Map((await c.query('SELECT id, display_name FROM users WHERE id = ANY($1)', [ids])).rows.map((u) => [u.id, u.display_name]));
  const sports = new Map((await c.query('SELECT id, name, emoji FROM sports WHERE id = ANY($1)', [[...new Set(versions.flatMap((v) => v.sport_ids))]])).rows.map((x) => [x.id, x]));
  return versions.map((v) => ({
    ...v, sports: v.sport_ids.map((x) => sports.get(x)).filter(Boolean), proposed_by_name: names.get(v.proposed_by) ?? null,
    commission_summary: v.commission.map((t) => ({ key: t.key, label: t.label, text: summariseTerm(t) })),
    signatures: s.filter((x) => x.version_id === v.id).map((x) => ({ party: x.party, decision: x.decision, comment: x.comment, signed_at: x.signed_at, signer: names.get(x.signer_id) ?? null })),
    waiting_for: v.status === 'proposed' ? v.required_parties.filter((p) => !s.some((x) => x.version_id === v.id && x.party === p && x.decision === 'signed')) : [],
  }));
}

/** Which still-unsigned parties this person can sign for. Only the agent principal signs for the agent; staff never do. */
function partiesFor(ctx, version) {
  const out = [];
  if (ctx.side === 'athlete' || ctx.side === 'youth') out.push('athlete');
  if (ctx.side === 'guardian') out.push('guardian');
  if (ctx.acting?.via === 'principal') out.push('agent');
  return out.filter((p) => version.required_parties.includes(p));
}

export async function mandateSummary(c, m, ctx) {
  const agent = ctx.agent ?? await loadAgent(c, m.agent_id);
  const [athlete, inf] = await Promise.all([one('SELECT id, handle, display_name, avatar_emoji, avatar_color, avatar_url FROM users WHERE id=$1', [m.athlete_id]), inForce(c, m)]);
  const state = await assess(c, m, { agent, version: inf });
  // before anything is in force, show the terms that are waiting (the draft or the proposal)
  const v = inf ?? (await c.query(`SELECT ${VERSION_COLS} FROM representation_mandate_versions WHERE mandate_id=$1 AND status IN ('draft','proposed') ORDER BY version DESC LIMIT 1`, [m.id])).rows[0] ?? null;
  const pending = (await c.query("SELECT version, kind, proposed_by, required_parties FROM representation_mandate_versions WHERE mandate_id=$1 AND status='proposed'", [m.id])).rows[0] ?? null;
  const signed = pending ? (await c.query("SELECT party FROM representation_signatures s JOIN representation_mandate_versions v ON v.id=s.version_id WHERE v.mandate_id=$1 AND v.version=$2 AND s.decision='signed'", [m.id, pending.version])).rows.map((r) => r.party) : [];
  const mine = pending ? partiesFor(ctx, pending).filter((p) => !signed.includes(p)) : [];
  const sports = v ? (await c.query('SELECT name, emoji FROM sports WHERE id = ANY($1)', [v.sport_ids])).rows : [];
  const openConflicts = Number((await c.query("SELECT count(*) AS n FROM representation_conflicts WHERE mandate_id=$1 AND status='open'", [m.id])).rows[0].n);
  const pendingApprovals = Number((await c.query("SELECT count(*) AS n FROM representation_approvals WHERE mandate_id=$1 AND status='pending'", [m.id])).rows[0].n);
  return {
    id: m.id, mandate_no: m.mandate_no, status: m.status, row_version: m.row_version, current_version: m.current_version,
    live: state.live, not_live_reason: state.live ? null : state.reason, athlete, agent: { id: agent.id, display_name: agent.display_name, kind: agent.kind, status: agent.status },
    sports, purposes: v?.purposes ?? [], exclusive: v?.exclusive ?? false, starts_on: v?.starts_on ?? null, ends_on: v?.ends_on ?? null,
    pending_version: pending ? pending.version : null, needs_my_signature: mine.length > 0, show_on_profile: m.show_on_profile, open_conflicts: openConflicts, pending_approvals: pendingApprovals,
    ended_at: m.ended_at, end_kind: m.end_kind, created_at: m.created_at, side: ctx.side ?? (ctx.acting?.via === 'staff' ? 'staff' : 'agent'),
  };
}

async function getView(c, user, id) {
  const ctx = await loadMandate(c, user, id);
  const { mandate: m, agent } = ctx;
  const summary = await mandateSummary(c, m, ctx);
  const versions = await viewVersions(c, await versionsOf(c, m.id));
  const cur = versions.find((v) => v.version === m.current_version) ?? null;
  const pending = versions.find((v) => v.status === 'proposed') ?? null;
  const standing = await agentStanding(c, agent);
  const grants = (await c.query(
    `SELECT g.id, g.category, g.subject_type, g.subject_id, g.level, g.granted_at, g.revoked_at FROM representation_grants g WHERE g.mandate_id=$1 ORDER BY g.granted_at DESC, g.id`, [m.id])).rows;
  const events = (await c.query(
    `SELECT e.seq, e.action, e.actor_side, e.subject_type, e.subject_id, e.detail, e.created_at, u.display_name AS actor FROM representation_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.mandate_id=$1 ORDER BY e.seq DESC LIMIT 100`, [m.id])).rows;
  const deals = (await c.query("SELECT id, status, currency, deal_type, deal_ref FROM representation_deals WHERE mandate_id=$1 ORDER BY created_at", [m.id])).rows;
  const ladders = await Promise.all(deals.map((d) => ladderOf(c, d.id)));
  const sums = {};
  deals.forEach((d, n) => sumLadders(sums, d.currency, ladders[n]));
  const commission = totalsOf(sums);
  const mine = pending ? partiesFor(ctx, pending).filter((p) => !pending.signatures.some((s) => s.party === p && s.decision === 'signed')) : [];
  return {
    ...summary, versions, current: cur, pending, standing: { verified: standing.verified, checked: standing.checked, licences: standing.licences, expires_at: standing.expires_at },
    can: { sign_as: mine, revoke: !!ctx.side && ['active', 'proposed'].includes(m.status), end: ctx.acting?.via === 'principal' && m.status === 'active', grant: canDecide(ctx.side), edit_draft: m.status === 'draft', amend: m.status === 'active' || m.status === 'expired', withdraw: !!pending && pending.proposed_by === user.id },
    grants, deals: deals.map((d, n) => ({ ...d, ladder: ladders[n] })), commission, events,
  };
}
export { getView as mandateView };

// ------------------------------------------------------------------ lifecycle helpers
async function validateTerms(c, agent, terms, { forSend = false } = {}) {
  const t = normaliseTerms(terms);
  const sports = (await c.query('SELECT id FROM sports WHERE id = ANY($1)', [t.sport_ids])).rows.length;
  if (sports !== t.sport_ids.length) throw badRequest('One of the sports does not exist');
  const warnings = [];
  if (t.licence_id) {
    const l = (await c.query("SELECT valid_from::text AS valid_from, valid_to::text AS valid_to FROM agent_licences WHERE id=$1 AND agent_id=$2 AND status='declared'", [t.licence_id, agent.id])).rows[0];
    if (!l) throw badRequest('That licence is not one of this agent\'s declared licences');
    if (l.valid_to && l.valid_to < t.starts_on) throw badRequest('That licence has expired before the mandate starts');
    if (l.valid_to && l.valid_to < t.ends_on) warnings.push(`The licence runs out on ${l.valid_to}, before the mandate ends; access stops then unless it is renewed.`);
  }
  if (forSend && agent.status !== 'active') throw conflict('This agent is suspended', { code: 'agent_suspended' });
  return { terms: t, warnings };
}

const insertVersion = (c, mandateId, version, kind, t, user, extra = {}) => c.query(
  `INSERT INTO representation_mandate_versions(mandate_id, version, kind, status, based_on, sport_ids, territories, purposes, exclusive, starts_on, ends_on, notice_days, notice_terms_ref, data_access, contact_actions, allow_staff, licence_id, commission, reason, changes, proposed_by)
   VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING ${VERSION_COLS}`,
  [mandateId, version, kind, extra.based_on ?? null, t.sport_ids, t.territories, t.purposes, t.exclusive, t.starts_on, t.ends_on, t.notice_days, t.notice_terms_ref, t.data_access, t.contact_actions, t.allow_staff, t.licence_id, JSON.stringify(t.commission), extra.reason ?? null, JSON.stringify(extra.changes ?? []), user.id]);

const overlaps = (a, b) => a.some((x) => b.includes(x));
/** An exclusive mandate cannot coexist with another that overlaps in sport, territory, purpose and time. Refused at proposal and again when the last signature would activate it. */
async function exclusivityCheck(c, mandate, v) {
  const others = (await c.query(
    `SELECT m.id AS mandate_id, m.mandate_no, v.sport_ids, v.territories, v.purposes, v.exclusive FROM representation_mandates m JOIN representation_mandate_versions v ON v.mandate_id=m.id AND v.version=m.current_version
      WHERE m.athlete_id=$1 AND m.id <> $2 AND m.status='active' AND v.ends_on >= $3 AND v.starts_on <= $4`, [mandate.athlete_id, mandate.id, v.starts_on, v.ends_on])).rows;
  for (const o of others) {
    const terr = v.territories.includes('WW') || o.territories.includes('WW') || overlaps(v.territories, o.territories);
    if ((v.exclusive || o.exclusive) && overlaps(v.sport_ids, o.sport_ids) && terr && overlaps(v.purposes, o.purposes)) {
      throw conflict(`This overlaps with ${o.mandate_no}, and one of them is exclusive. End or amend the other mandate first.`, { code: 'exclusivity_overlap', other_mandate_id: o.mandate_id });
    }
  }
  return others;
}

async function activate(c, mandate, version, actor) {
  const others = await exclusivityCheck(c, mandate, version);
  await c.query("UPDATE representation_mandate_versions SET status='superseded', decided_at=coalesce(decided_at, now()) WHERE mandate_id=$1 AND status='in_force'", [mandate.id]);
  await c.query("UPDATE representation_mandate_versions SET status='in_force', decided_at=now(), row_version=row_version+1 WHERE id=$1", [version.id]);
  const m = (await c.query(
    `UPDATE representation_mandates SET current_version=$2, status='active', started_at=coalesce(started_at, now()), ended_at=NULL, end_kind=NULL, end_reason=NULL, ended_by=NULL, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
    [mandate.id, version.version])).rows[0];
  await logEvent(c, mandate.id, actor, 'system', version.version === 1 ? 'mandate_active' : 'version_in_force', { detail: { version: version.version, kind: version.kind } });
  const agent = await loadAgent(c, mandate.agent_id);
  // another agent with overlapping, non-exclusive scope for the same athlete is disclosed once, not forbidden: the athlete decides
  const rivals = [];
  for (const o of others) {
    if (o.mandate_id === mandate.id || !overlaps(version.sport_ids, o.sport_ids) || !overlaps(version.purposes, o.purposes)) continue;
    if ((await c.query('SELECT agent_id FROM representation_mandates WHERE id=$1', [o.mandate_id])).rows[0].agent_id !== mandate.agent_id) rivals.push(o.mandate_no);
  }
  if (rivals.length) await raiseConflict(c, { agent, mandate: m, athleteId: mandate.athlete_id, kind: 'dual_representation', subject_type: 'mandate', subject_id: mandate.id, counterparty: rivals.sort().join(', ').slice(0, 160), detail: `The athlete also has ${rivals.join(', ')} with another agent covering overlapping sports and purposes.`, raised_by: 'system', raised_user: actor });
  const msg = { kind: 'representation_active', title: version.version === 1 ? 'Representation agreed' : 'Representation updated', body: `${m.mandate_no} is in force. What the agent can see and do is exactly what the agreed terms list.` };
  await notifyAthleteSide(c, m, msg, actor);
  await notifyAgentSide(c, m, msg, actor);
  return m;
}

/** Put a draft or amendment in front of the parties: check, freeze, record the proposer's own signature, and either activate or tell the others. */
async function propose(c, user, ctx, mandate, version) {
  const youth = await isYouth(mandate.athlete_id, c);
  if (youth) await requireConsent(mandate.athlete_id, 'recruitment', 'a representation mandate', c);
  const agent = ctx.agent;
  if (agent.status !== 'active') throw conflict('This agent is suspended', { code: 'agent_suspended' });
  if (!(await agentStanding(c, agent)).verified) throw conflict('The agent\'s verification is not current; representation can only be agreed with a verified agent', { code: 'agent_unverified' });
  if (version.ends_on < todayIso()) throw badRequest('The mandate period has already ended');
  await exclusivityCheck(c, mandate, version);
  const required = requiredParties({ youth });
  await c.query("UPDATE representation_mandate_versions SET status='proposed', required_parties=$2, proposed_at=now(), row_version=row_version+1 WHERE id=$1", [version.id, required]);
  version.required_parties = required; version.status = 'proposed';
  const mine = partiesFor(ctx, version);
  for (const party of mine) await c.query("INSERT INTO representation_signatures(version_id, party, signer_id, decision) VALUES ($1,$2,$3,'signed') ON CONFLICT (version_id, party) DO NOTHING", [version.id, party, user.id]);
  await c.query("UPDATE representation_mandates SET status=CASE WHEN status='draft' THEN 'proposed' ELSE status END, row_version=row_version+1, updated_at=now() WHERE id=$1", [mandate.id]);
  await logEvent(c, mandate.id, user.id, ctx.side ?? 'agent', 'version_proposed', { detail: { version: version.version, kind: version.kind } });
  if (await settled(c, version)) return activate(c, mandate, version, user.id);
  const m = (await c.query('SELECT * FROM representation_mandates WHERE id=$1', [mandate.id])).rows[0];
  const msg = { kind: 'representation_proposed', title: 'A representation needs your signature', body: `${m.mandate_no} (version ${version.version}) is waiting for signatures. Read exactly what it allows before you sign.` };
  if (ctx.side) await notifyAgentSide(c, m, msg, user.id); else await notifyAthleteSide(c, m, msg, user.id);
  return m;
}
async function settled(c, version) {
  const signed = new Set((await c.query("SELECT party FROM representation_signatures WHERE version_id=$1 AND decision='signed'", [version.id])).rows.map((r) => r.party));
  return version.required_parties.every((p) => signed.has(p));
}

// ------------------------------------------------------------------ create / draft / send
const termsInput = mandateTermsSchema;

cap({
  name: 'create_mandate', method: 'POST', path: '/representation/mandates', tag: TAG, status: 201,
  summary: 'Start a representation mandate between an athlete and a verified agent or agency. The athlete (or, for a young person, a guardian) names the agent with agent_id; an agent names the athlete with athlete_id. Terms: sports, territories, purposes (outreach, contract negotiation, transfer, sponsorship, media), exclusive or not, dates, notice reference, what data and actions are allowed, whether agency staff may act, the licence relied on, and commission terms. Nothing here can reach medical records, private coaching, family finances, passwords or unrelated messages. send=true proposes it straight away. Safe to retry with the same client_key.',
  input: z.object({ athlete_id: id.optional(), agent_id: id.optional(), terms: termsInput, send: z.boolean().default(false), client_key: z.string().min(1).max(64).optional() }),
  async handler(ctx0, i) {
    try { return await createMandate(ctx0, i); } catch (e) {
      // two parallel retries with the same key: the loser gets the winner's mandate
      if (e.code === '23505' && i.client_key) { const dup = await one('SELECT id FROM representation_mandates WHERE created_by=$1 AND client_key=$2', [ctx0.user.id, i.client_key]); if (dup) return tx((c) => getView(c, ctx0.user, dup.id)); }
      throw e;
    }
  },
});
async function createMandate({ user }, i) {
    return tx(async (c) => {
      if (i.client_key) {
        const dup = (await c.query('SELECT id FROM representation_mandates WHERE created_by=$1 AND client_key=$2', [user.id, i.client_key])).rows[0];
        if (dup) return getView(c, user, dup.id);
      }
      const athleteId = i.athlete_id ?? user.id;
      const side = await athleteSideOf(c, user, athleteId);
      let agent, ctx;
      if (side) {
        if (side === 'youth') throw forbidden('A guardian proposes a mandate for a young person');
        if (!i.agent_id) throw badRequest('Give agent_id: the agent or agency you want to represent you');
        agent = await loadAgent(c, i.agent_id);
        if (!agent) throw notFound('Agent');
        ctx = { side, agent, acting: null };
      } else {
        agent = await agentOfUser(c, user.id);
        if (!agent || !i.athlete_id) throw forbidden('Only the athlete, a guardian of a young athlete, or the agent can start a mandate');
        if (i.agent_id && i.agent_id !== agent.id) throw forbidden('You can only propose for your own agent profile');
        if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [athleteId])).rowCount) throw notFound('Athlete');
        ctx = { side: null, agent, acting: await actingFor(c, user, agent) };
      }
      if (agent.user_id === athleteId) throw badRequest('You cannot represent yourself');
      if ((await c.query("SELECT 1 FROM agent_staff WHERE agent_id=$1 AND user_id=$2 AND status='active'", [agent.id, athleteId])).rowCount) throw conflict('Delegated staff cannot also be clients of the same agent', { code: 'conflict_of_interest' });
      const { terms, warnings } = await validateTerms(c, agent, i.terms);
      const no = (await c.query("SELECT 'REP-' || to_char(now(),'YYYY') || '-' || lpad(nextval('representation_mandate_no_seq')::text, 4, '0') AS n")).rows[0].n;
      const m = (await c.query('INSERT INTO representation_mandates(mandate_no, athlete_id, agent_id, client_key, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [no, athleteId, agent.id, i.client_key ?? null, user.id])).rows[0];
      const v = (await insertVersion(c, m.id, 1, 'initial', terms, user, { changes: diffTerms(null, terms) })).rows[0];
      await logEvent(c, m.id, user.id, side ?? 'agent', 'mandate_drafted');
      await audit(c, user.id, 'create_mandate', 'representation_mandates', m.id);
      if (i.send) await propose(c, user, ctx, m, v);
      const view = await getView(c, user, m.id);
      return warnings.length ? { ...view, warnings } : view;
    });
}

cap({
  name: 'update_mandate_draft', method: 'PATCH', path: '/representation/mandates/:id', tag: TAG,
  summary: 'Edit the terms of a mandate that has not been proposed yet. Once proposed, a version is frozen; propose an amendment instead. Send row_version from the last read.',
  input: z.object({ id, row_version: z.coerce.number().int().min(1), terms: termsInput }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await loadMandate(c, user, i.id, { lock: true });
      if (ctx.mandate.status !== 'draft') throw conflict(`A ${ctx.mandate.status} mandate cannot be edited. Propose an amendment.`, { code: 'not_draft' });
      if (ctx.mandate.row_version !== i.row_version) throw stale();
      const { terms, warnings } = await validateTerms(c, ctx.agent, i.terms);
      await c.query(
        `UPDATE representation_mandate_versions SET sport_ids=$2, territories=$3, purposes=$4, exclusive=$5, starts_on=$6, ends_on=$7, notice_days=$8, notice_terms_ref=$9, data_access=$10, contact_actions=$11, allow_staff=$12, licence_id=$13, commission=$14, changes=$15
          WHERE mandate_id=$1 AND version=1 AND status='draft'`,
        [i.id, terms.sport_ids, terms.territories, terms.purposes, terms.exclusive, terms.starts_on, terms.ends_on, terms.notice_days, terms.notice_terms_ref, terms.data_access, terms.contact_actions, terms.allow_staff, terms.licence_id, JSON.stringify(terms.commission), JSON.stringify(diffTerms(null, terms))]);
      await c.query('UPDATE representation_mandates SET row_version=row_version+1, updated_at=now() WHERE id=$1', [i.id]);
      const view = await getView(c, user, i.id);
      return warnings.length ? { ...view, warnings } : view;
    });
  },
});

cap({
  name: 'send_mandate', method: 'POST', path: '/representation/mandates/:id/send', tag: TAG,
  summary: 'Propose the draft to the other parties. Your own signature is recorded; the mandate is in force only when every required party has signed the exact version (for a young person: the guardian and the young person as well as the agent).',
  input: z.object({ id, row_version: z.coerce.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await loadMandate(c, user, i.id, { lock: true });
      const m = ctx.mandate;
      if (m.status !== 'draft') throw conflict(`This mandate is already ${m.status}`, { code: 'not_draft' });
      if (m.row_version !== i.row_version) throw stale();
      if (ctx.side === 'youth') throw forbidden('A guardian sends a mandate for a young person');
      const v = (await c.query(`SELECT ${VERSION_COLS} FROM representation_mandate_versions WHERE mandate_id=$1 AND version=1 FOR UPDATE`, [m.id])).rows[0];
      await propose(c, user, ctx, m, v);
      return getView(c, user, m.id);
    });
  },
});

cap({
  name: 'propose_mandate_version', method: 'POST', path: '/representation/mandates/:id/versions', tag: TAG, status: 201,
  summary: 'Propose a change or a renewal as a new version. An amendment changes any terms; a renewal extends the end date (and may be proposed after the mandate has expired). Every required party signs the new version; until then the version in force stays as it was. base_version must be the version in force.',
  input: z.object({ id, kind: z.enum(['amendment', 'renewal']), base_version: z.coerce.number().int().min(1), terms: termsInput, reason: text(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await loadMandate(c, user, i.id, { lock: true });
      const m = ctx.mandate;
      if (ctx.side === 'youth') throw forbidden('A guardian proposes changes for a young person');
      if (ctx.acting && ctx.acting.via !== 'principal') throw forbidden('Only the agent can propose for the agent side');
      if (!['active', 'expired'].includes(m.status)) throw conflict(`A ${m.status} mandate cannot be amended${m.status === 'revoked' ? '; start a new mandate' : ''}`, { code: 'not_amendable' });
      if (m.current_version !== i.base_version) throw stale();
      if ((await c.query("SELECT 1 FROM representation_mandate_versions WHERE mandate_id=$1 AND status='proposed'", [m.id])).rowCount) throw conflict('A version is already waiting for signatures; withdraw it first', { code: 'pending_exists' });
      const { terms, warnings } = await validateTerms(c, ctx.agent, i.terms);
      const cur = await inForce(c, m);
      if (i.kind === 'renewal' && terms.ends_on <= cur.ends_on) throw badRequest('A renewal must end later than the current mandate');
      const next = Number((await c.query('SELECT max(version) AS v FROM representation_mandate_versions WHERE mandate_id=$1', [m.id])).rows[0].v) + 1;
      const v = (await insertVersion(c, m.id, next, i.kind, terms, user, { based_on: cur.version, reason: i.reason, changes: diffTerms(termsOf(cur), terms) })).rows[0];
      await propose(c, user, ctx, m, v);
      const view = await getView(c, user, m.id);
      return warnings.length ? { ...view, warnings } : view;
    });
  },
});

cap({
  name: 'decide_mandate_version', method: 'POST', path: '/representation/mandates/:id/versions/:version/decision', tag: TAG,
  summary: 'Sign or decline the proposed version. You sign for exactly one party (athlete, guardian or agent); nobody signs for another. When the last required party signs, the version comes into force and replaces the one before. Repeating a signature changes nothing.',
  input: z.object({ id, version: z.coerce.number().int().min(1), decision: z.enum(['sign', 'decline']), comment: text(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await loadMandate(c, user, i.id, { lock: true });
      const m = ctx.mandate;
      const v = (await c.query(`SELECT ${VERSION_COLS} FROM representation_mandate_versions WHERE mandate_id=$1 AND version=$2 FOR UPDATE`, [m.id, i.version])).rows[0];
      if (!v) throw notFound('Version');
      if (v.status !== 'proposed') {
        const mine = (await c.query('SELECT 1 FROM representation_signatures WHERE version_id=$1 AND signer_id=$2 AND decision=$3', [v.id, user.id, i.decision === 'sign' ? 'signed' : 'declined'])).rowCount;
        if (mine) return getView(c, user, m.id); // a repeated decision is not an error
        throw conflict(`That version is ${v.status}`, { code: 'not_pending' });
      }
      const parties = partiesFor(ctx, v);
      if (!parties.length) throw forbidden('You are not a required signer of this version, or you already signed it');
      if (i.decision === 'decline') {
        const party = parties[0];
        await c.query("INSERT INTO representation_signatures(version_id, party, signer_id, decision, comment) VALUES ($1,$2,$3,'declined',$4) ON CONFLICT (version_id, party) DO NOTHING", [v.id, party, user.id, i.comment ?? null]);
        await c.query("UPDATE representation_mandate_versions SET status='declined', decided_at=now(), row_version=row_version+1 WHERE id=$1", [v.id]);
        if (m.status === 'proposed') await c.query("UPDATE representation_mandates SET status='declined', row_version=row_version+1, updated_at=now() WHERE id=$1", [m.id]);
        await logEvent(c, m.id, user.id, ctx.side ?? 'agent', 'version_declined', { detail: { version: v.version, party } });
        const msg = { kind: 'representation_declined', title: 'A representation was declined', body: `${m.mandate_no} version ${v.version} was declined.${i.comment ? ` "${i.comment}"` : ''}` };
        if (ctx.side) await notifyAgentSide(c, m, msg, user.id); else await notifyAthleteSide(c, m, msg, user.id);
        return getView(c, user, m.id);
      }
      if (parties.includes('agent')) {
        if (!(await agentStanding(c, ctx.agent)).verified) throw conflict('The agent\'s verification is not current', { code: 'agent_unverified' });
        if (ctx.agent.status !== 'active') throw conflict('This agent is suspended', { code: 'agent_suspended' });
      }
      if (await isYouth(m.athlete_id, c)) await requireConsent(m.athlete_id, 'recruitment', 'a representation mandate', c);
      for (const party of parties) await c.query("INSERT INTO representation_signatures(version_id, party, signer_id, decision, comment) VALUES ($1,$2,$3,'signed',$4) ON CONFLICT (version_id, party) DO NOTHING", [v.id, party, user.id, i.comment ?? null]);
      await logEvent(c, m.id, user.id, ctx.side ?? 'agent', 'version_signed', { detail: { version: v.version, parties } });
      if (await settled(c, v)) await activate(c, m, v, user.id);
      return getView(c, user, m.id);
    });
  },
});

cap({
  name: 'withdraw_mandate_version', method: 'POST', path: '/representation/mandates/:id/versions/:version/withdraw', tag: TAG,
  summary: 'Take back a version you proposed while it is still waiting for signatures. A withdrawn first version withdraws the mandate; the version in force is untouched.',
  input: z.object({ id, version: z.coerce.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await loadMandate(c, user, i.id, { lock: true });
      const v = (await c.query(`SELECT ${VERSION_COLS} FROM representation_mandate_versions WHERE mandate_id=$1 AND version=$2 FOR UPDATE`, [i.id, i.version])).rows[0];
      if (!v) throw notFound('Version');
      if (v.status === 'withdrawn') return getView(c, user, i.id);
      if (v.status !== 'proposed') throw conflict(`That version is ${v.status}`, { code: 'not_pending' });
      if (v.proposed_by !== user.id) throw forbidden('Only the person who proposed it can withdraw it');
      await c.query("UPDATE representation_mandate_versions SET status='withdrawn', decided_at=now(), row_version=row_version+1 WHERE id=$1", [v.id]);
      if (ctx.mandate.status === 'proposed') await c.query("UPDATE representation_mandates SET status='withdrawn', row_version=row_version+1, updated_at=now() WHERE id=$1", [i.id]);
      await logEvent(c, i.id, user.id, ctx.side ?? 'agent', 'version_withdrawn', { detail: { version: v.version } });
      return getView(c, user, i.id);
    });
  },
});

// ------------------------------------------------------------------ end (revoke)
cap({
  name: 'end_mandate', method: 'POST', path: '/representation/mandates/:id/end', tag: TAG,
  summary: 'End a mandate now. The athlete, a guardian or the young person themself revokes it with immediate effect: the agent loses all access to the athlete\'s information and every grant is closed, while the terms, notes, commission records and history stay. The agent can end it from their side. Repeating does nothing.',
  input: z.object({ id, reason: text(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await loadMandate(c, user, i.id, { lock: true });
      const m = ctx.mandate;
      if (ctx.acting && ctx.acting.via !== 'principal') throw forbidden('Only the agent can end a mandate from the agent side');
      if (['revoked', 'expired', 'declined', 'withdrawn'].includes(m.status)) return getView(c, user, m.id);
      if (m.status === 'draft') throw conflict('A draft is not in force; delete the idea by leaving it, or send it', { code: 'not_in_force' });
      const kind = ctx.side === 'guardian' ? 'revoked_by_guardian' : ctx.side ? 'revoked_by_athlete' : 'ended_by_agent';
      await c.query("UPDATE representation_mandates SET status='revoked', ended_at=now(), end_kind=$2, end_reason=$3, ended_by=$4, show_on_profile=false, row_version=row_version+1, updated_at=now() WHERE id=$1", [m.id, kind, i.reason ?? null, user.id]);
      await c.query("UPDATE representation_mandate_versions SET status='withdrawn', decided_at=now(), row_version=row_version+1 WHERE mandate_id=$1 AND status='proposed'", [m.id]);
      await c.query('UPDATE representation_grants SET revoked_at=now(), revoked_by=$2 WHERE mandate_id=$1 AND revoked_at IS NULL', [m.id, user.id]);
      await c.query("UPDATE representation_approvals SET status='cancelled', row_version=row_version+1 WHERE mandate_id=$1 AND status='pending'", [m.id]);
      await logEvent(c, m.id, user.id, ctx.side ?? 'agent', 'mandate_ended', { detail: { kind, reason: i.reason ?? null } });
      await audit(c, user.id, 'end_mandate', 'representation_mandates', m.id);
      const msg = { kind: 'representation_ended', title: 'A representation has ended', body: `${m.mandate_no} ended${i.reason ? `: ${i.reason}` : ''}. Access stopped immediately; records and commission history stay.` };
      if (ctx.side) await notifyAgentSide(c, m, msg, user.id); else await notifyAthleteSide(c, m, msg, user.id);
      return getView(c, user, m.id);
    });
  },
});

cap({
  name: 'set_representation_profile_visibility', method: 'POST', path: '/representation/mandates/:id/profile-visibility', tag: TAG,
  summary: 'Opt in or out of showing this representation on your public profile. It is off by default, shows only while the mandate is in force and the agent is listed and verified, and never shows terms or commission. A guardian decides for a young person (young people have no public profile).',
  input: z.object({ id, show: z.boolean() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await loadMandate(c, user, i.id, { lock: true });
      if (!canDecide(ctx.side)) throw forbidden('Only the athlete or a guardian decides what the public profile shows');
      if (i.show && (await isYouth(ctx.mandate.athlete_id, c))) throw conflict('Young people have no public profile', { code: 'youth_profile' });
      await c.query('UPDATE representation_mandates SET show_on_profile=$2, row_version=row_version+1, updated_at=now() WHERE id=$1', [i.id, i.show]);
      await logEvent(c, i.id, user.id, ctx.side, i.show ? 'profile_visibility_on' : 'profile_visibility_off');
      return getView(c, user, i.id);
    });
  },
});

// ------------------------------------------------------------------ lists and views
cap({
  name: 'list_mandates', method: 'GET', path: '/representation/mandates', tag: TAG,
  summary: 'Mandates you are part of. as=athlete (yours, or athlete_id of a young person you are guardian of) or as=agent (the agent profile you work for). Includes whether each is live right now and why not.',
  input: z.object({ as: z.enum(['athlete', 'agent']).default('athlete'), athlete_id: id.optional(), status: z.enum(['draft', 'proposed', 'active', 'declined', 'withdrawn', 'revoked', 'expired']).optional(), ...page }),
  async handler({ user }, i) {
    let rows;
    if (i.as === 'athlete') {
      const athleteId = i.athlete_id ?? user.id;
      if (!(await athleteSideOf(pool, user, athleteId))) throw notFound('Athlete');
      rows = await many("SELECT m.* FROM representation_mandates m WHERE m.athlete_id=$1 AND ($2::text IS NULL OR m.status=$2) AND (m.status <> 'draft' OR m.created_by=$3 OR EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=$3 AND l.child_id=m.athlete_id AND l.status='active' AND l.revoked_at IS NULL)) ORDER BY m.created_at DESC, m.id LIMIT $4 OFFSET $5", [athleteId, i.status ?? null, user.id, i.limit, i.offset]);
    } else {
      const staff = await many("SELECT agent_id FROM agent_staff WHERE user_id=$1 AND status='active'", [user.id]);
      const own = await agentOfUser(pool, user.id);
      const agentIds = [...(own ? [own.id] : []), ...staff.map((s) => s.agent_id)];
      rows = agentIds.length ? await many("SELECT m.* FROM representation_mandates m WHERE m.agent_id = ANY($1) AND ($2::text IS NULL OR m.status=$2) AND (m.status <> 'draft' OR m.created_by=$3) ORDER BY m.created_at DESC, m.id LIMIT $4 OFFSET $5", [agentIds, i.status ?? null, user.id, i.limit, i.offset]) : [];
    }
    const out = [];
    for (const m of rows) {
      const agent = await loadAgent(pool, m.agent_id);
      const side = await athleteSideOf(pool, user, m.athlete_id);
      const acting = side ? null : await actingFor(pool, user, agent);
      if (!side && !acting) continue;
      out.push(await mandateSummary(pool, m, { side, agent, acting }));
    }
    return out;
  },
});

cap({
  name: 'get_mandate', method: 'GET', path: '/representation/mandates/:id', tag: TAG,
  summary: 'One mandate with every version and its signatures, what is in force and what is waiting, whether it is live right now, the agent\'s verification and what was checked, the grants made, commission accounts and the full history. The athlete side and the agent side both read their business record here, also after the mandate ended.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx((c) => getView(c, user, i.id)),
});

cap({
  name: 'get_mandate_document', method: 'GET', path: '/representation/mandates/:id/document', tag: TAG,
  summary: 'The agreed terms of a signed version as a plain-text document with its signatures and a SHA-256 of the text, for filing or sharing between the parties. Built from the frozen version, so it is identical every time.',
  input: z.object({ id, version: z.coerce.number().int().min(1).optional() }),
  async handler({ user }, i) {
    const c = pool;
    const ctx = await loadMandate(c, user, i.id);
    const m = ctx.mandate;
    const vs = await viewVersions(c, await versionsOf(c, m.id));
    const v = i.version ? vs.find((x) => x.version === i.version) : [...vs].reverse().find((x) => ['in_force', 'superseded'].includes(x.status)) ?? vs[vs.length - 1];
    if (!v) throw notFound('Version');
    const athlete = (await c.query('SELECT display_name FROM users WHERE id=$1', [m.athlete_id])).rows[0];
    const names = v.sports.map((s) => s.name).join(', ');
    const lines = [
      `REPRESENTATION MANDATE ${m.mandate_no} · version ${v.version} (${v.status})`, '',
      `Athlete: ${athlete.display_name}`, `Agent: ${ctx.agent.display_name} (${ctx.agent.kind})`, '',
      `Period: ${v.starts_on} to ${v.ends_on}`, `Sports: ${names}`, `Territories: ${v.territories.join(', ')}`, `Exclusive: ${v.exclusive ? 'yes' : 'no'}`,
      `Notice: ${v.notice_days != null ? `${v.notice_days} days` : 'not stated'}${v.notice_terms_ref ? ` · terms reference: ${v.notice_terms_ref}` : ''}`, '',
      'Purposes:', ...v.purposes.map((p) => `  - ${PURPOSES[p]}`), '',
      'Information the agent may see (each private item only after the athlete shares that exact item):', ...(v.data_access.length ? v.data_access.map((d) => `  - ${DATA_ACCESS[d]}`) : ['  - none']), '',
      'Actions the agent may take:', ...(v.contact_actions.length ? v.contact_actions.map((a) => `  - ${CONTACT_ACTIONS[a]}`) : ['  - none']),
      `Agency staff may act: ${v.allow_staff ? 'yes' : 'no'}`, '',
      'Commission:', ...(v.commission.length ? v.commission_summary.map((t) => `  - ${t.label}: ${t.text}`) : ['  - none agreed']), '',
      'Never available under any mandate: medical and health records, private coaching notes, family finances, passwords, unrelated messages.',
      'Never done by the agent: accepting a position or offer, signing a contract or amendment, approving a transfer. Those stay with the athlete (and a guardian for a young person).', '',
      'Signatures:', ...(v.signatures.length ? v.signatures.map((s) => `  - ${s.party}: ${s.decision} by ${s.signer} on ${new Date(s.signed_at).toISOString().slice(0, 10)}`) : ['  - none yet']),
    ];
    const body = lines.join('\n');
    return { filename: `${m.mandate_no}-v${v.version}.txt`, content_type: 'text/plain', version: v.version, status: v.status, sha256: createHash('sha256').update(body).digest('hex'), text: body };
  },
});

cap({
  name: 'get_my_representation', method: 'GET', path: '/me/representation', tag: TAG,
  summary: 'The athlete\'s view: current and past representation, exactly what each agent may see and do, agent activity, approvals waiting for you, conflicts to decide, and commission summary per currency. A guardian passes athlete_id for a young person.',
  input: z.object({ athlete_id: id.optional() }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    const side = await athleteSideOf(pool, user, athleteId);
    if (!side) throw notFound('Athlete');
    const rows = await many("SELECT m.* FROM representation_mandates m WHERE m.athlete_id=$1 AND (m.status <> 'draft' OR m.created_by=$2) ORDER BY m.created_at DESC, m.id", [athleteId, user.id]);
    const mandates = [];
    for (const m of rows) {
      const agent = await loadAgent(pool, m.agent_id);
      const s = await mandateSummary(pool, m, { side, agent });
      const v = await inForce(pool, m);
      mandates.push({ ...s, permissions: v ? { data_access: v.data_access, contact_actions: v.contact_actions, allow_staff: v.allow_staff, notice_days: v.notice_days } : null, grants: Number((await pool.query('SELECT count(*) AS n FROM representation_grants WHERE mandate_id=$1 AND revoked_at IS NULL', [m.id])).rows[0].n) });
    }
    const ids = rows.map((m) => m.id);
    const approvals = ids.length ? await many("SELECT a.id, a.mandate_id, a.kind, a.summary, a.status, a.expires_at, a.created_at, u.display_name AS requested_by_name FROM representation_approvals a JOIN users u ON u.id=a.requested_by WHERE a.mandate_id = ANY($1) AND a.status='pending' ORDER BY a.created_at", [ids]) : [];
    const conflicts = ids.length ? await many("SELECT id, mandate_id, kind, subject_type, subject_id, counterparty, status, can_acknowledge, raised_by, created_at FROM representation_conflicts WHERE mandate_id = ANY($1) AND status='open' ORDER BY created_at", [ids]) : [];
    const activity = ids.length ? await many("SELECT e.seq, e.mandate_id, e.action, e.actor_side, e.subject_type, e.created_at, u.display_name AS actor FROM representation_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.mandate_id = ANY($1) AND e.actor_side IN ('agent','staff','system') ORDER BY e.seq DESC LIMIT 30", [ids]) : [];
    const deals = ids.length ? await many("SELECT d.id, d.currency FROM representation_deals d WHERE d.mandate_id = ANY($1) AND d.status='confirmed'", [ids]) : [];
    const sums = {};
    for (const d of deals) sumLadders(sums, d.currency, await ladderOf(pool, d.id));
    return { athlete_id: athleteId, side, mandates, approvals, conflicts, activity, commission: totalsOf(sums) };
  },
});

/** Opt-in public representation for a person's profile. Only while in force, listed and verified; never terms or commission. */
export async function publicRepresentation(athleteId) {
  const rows = await many("SELECT m.* FROM representation_mandates m WHERE m.athlete_id=$1 AND m.status='active' AND m.show_on_profile ORDER BY m.started_at, m.id", [athleteId]);
  const out = [];
  for (const m of rows) {
    const agent = await loadAgent(pool, m.agent_id);
    const st = await assess(pool, m, { agent });
    if (!st.live || !agent.is_public) continue;
    const sports = (await pool.query('SELECT name, emoji FROM sports WHERE id = ANY($1)', [st.version.sport_ids])).rows;
    out.push({ agent: { id: agent.id, display_name: agent.display_name, kind: agent.kind, verified: true }, sports, purposes: st.version.purposes, since: m.started_at });
  }
  return out;
}
