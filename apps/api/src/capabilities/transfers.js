// Player transfer, loan, release & clearance (#478 / #563). One governed workflow:
//   request → (amend: new version, old approvals void) → submit → every required party approves the CURRENT version → approved → complete.
// Completion is the only thing that moves a player, and it does so exactly once, through canonical records: team membership, competition registration
// (a dependency reference plus a submitted registration for the registrar to review) and the career timeline. Contracts are never edited.
// Money (fee_state) and external clearance are tracked separately and never make a transfer "complete" on their own. Outsiders get 404; youth need a guardian.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { isYouth, guardianLink, guardiansOf } from '../youth.js';
import { activeSportingSanction } from '../integrity.js';
import { authority, can } from '../federation.js';
import { canManageTeam } from './teams.js';
import { canManageCompetition } from './competitions.js';
import { KINDS, KIND_LABEL, PARTIES, PARTY_LABEL, OPEN, canMove, requiredParties, approvalState, windowCheck, completionBlockers, FEE_FLOW } from '../transfer.js';

const TAG = 'Transfers';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const ymd = (v) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : v == null ? null : String(v).slice(0, 10));
const stale = (t) => conflict(`This transfer was changed (now version ${t.version}); reload and decide on the current version`, { code: 'stale_version', current_version: t.version });

const teamOf = async (c, tid) => { if (!tid) return null; const t = (await c.query('SELECT id, name, sport_id, owner_id, organisation_id, parent_team_id FROM teams WHERE id=$1', [tid])).rows[0]; if (!t) throw notFound('Team'); return t; };
async function ctxOf(c, t) {
  const from = await teamOf(c, t.from_team_id); const to = await teamOf(c, t.to_team_id);
  let season = null; let cm = null; let body = null;
  if (t.season_id) {
    season = (await c.query('SELECT * FROM comp_seasons WHERE id=$1', [t.season_id])).rows[0];
    cm = (await c.query('SELECT * FROM comp_competitions WHERE id=$1', [season.competition_id])).rows[0];
    if (cm.organisation_id) body = (await c.query('SELECT id FROM governing_bodies WHERE organisation_id=$1', [cm.organisation_id])).rows[0] ?? null;
  }
  return { from, to, season, cm, body, youth: await isYouth(t.player_id, c) };
}
async function isAuthority(c, user, t, x) {
  if (!x.cm) return false;
  if (await canManageCompetition(user, x.cm, c)) return true;
  if (x.body) { const a = await authority(user, x.body.id, { c, optional: true }); return can(a, 'affiliations', t.sport_id); }
  return false;
}
/** May this caller decide for this party? Each party is decided by that party only; nobody signs for another without being that party. */
async function mayDecide(c, user, t, x, party) {
  if (party === 'player') return user.id === t.player_id;
  if (party === 'guardian') return !!(await guardianLink(user.id, t.player_id, c));
  if (party === 'source_club') return !!x.from && (await canManageTeam(user, x.from));
  if (party === 'destination_club') return !!x.to && (await canManageTeam(user, x.to));
  if (party === 'authority') return isAuthority(c, user, t, x);
  return false;
}
async function canRead(c, user, t, x) {
  if (isAdmin(user) || user.id === t.player_id || user.id === t.initiated_by) return true;
  if (await guardianLink(user.id, t.player_id, c)) return true;
  if ((x.from && (await canManageTeam(user, x.from))) || (x.to && (await canManageTeam(user, x.to)))) return true;
  return isAuthority(c, user, t, x);
}
const log = (c, t, action, actor, { from = null, to = null, detail = {} } = {}) =>
  c.query('INSERT INTO tr_events(transfer_id,version,action,from_status,to_status,actor_id,detail) VALUES ($1,$2,$3,$4,$5,$6,$7)', [t.id, t.version, action, from, to, actor, detail]);
const lockT = async (c, tid) => { const t = (await c.query('SELECT * FROM tr_transfers WHERE id=$1 FOR UPDATE', [tid])).rows[0]; if (!t) throw notFound('Transfer'); return t; };
const approvalsOf = (c, t) => c.query('SELECT party, decision, decided_by, decided_at FROM tr_approvals WHERE transfer_id=$1 AND version=$2 ORDER BY decided_at', [t.id, t.version]).then((r) => r.rows);

async function present(c, user, t, x) {
  const decisions = await approvalsOf(c, t);
  const required = requiredParties(t, { youth: x.youth, seasoned: !!x.season });
  const state = approvalState(required, decisions);
  const window = windowCheck(x.season, t.effective_on);
  const events = (await c.query('SELECT version, action, from_status, to_status, actor_id, detail, created_at FROM tr_events WHERE transfer_id=$1 ORDER BY created_at, id', [t.id])).rows;
  const { reason_enc, window_exception_enc, ...pub } = t;
  const mine = [];
  for (const p of PARTIES) if (await mayDecide(c, user, t, x, p)) mine.push(p);
  return {
    ...pub, effective_on: ymd(t.effective_on), loan_ends_on: ymd(t.loan_ends_on), kind_label: KIND_LABEL[t.kind],
    from_team: x.from && { id: x.from.id, name: x.from.name }, to_team: x.to && { id: x.to.id, name: x.to.name },
    season: x.season && { id: x.season.id, label: x.season.label, transfer_opens_on: ymd(x.season.transfer_opens_on), transfer_closes_on: ymd(x.season.transfer_closes_on) },
    reason: reason_enc ? decrypt(reason_enc, 'tr_transfers.reason') : null,
    approvals: { ...state, labels: Object.fromEntries(PARTIES.map((p) => [p, PARTY_LABEL[p]])), decisions: decisions.map((d) => ({ party: d.party, decision: d.decision, decided_at: d.decided_at })) },
    window, my_parties: mine.filter((p) => required.includes(p) && !decisions.some((d) => d.party === p)), events,
  };
}

const feeIn = z.object({ minor: z.number().int().min(0).max(1_000_000_000_000), currency: z.string().regex(/^[A-Z]{3}$/).default('USD') });

cap({
  name: 'request_transfer', method: 'POST', path: '/transfers', tag: TAG, status: 201,
  summary: 'Start a transfer, loan, loan extension/recall, release, dual registration or international clearance for a player between canonical teams, optionally in a competition season. Nothing moves until every required party approves the current version and it is completed. Idempotent with an `idempotency_key`.',
  input: z.object({
    kind: z.enum(KINDS), player_id: id, from_team_id: id.optional(), to_team_id: id.optional(), season_id: id.optional(), parent_id: id.optional(),
    effective_on: day, loan_ends_on: day.optional(), term: z.record(z.string().max(60), z.union([z.string().max(300), z.number(), z.boolean()])).default({}),
    reason: z.string().trim().max(1000).optional(), reference: z.string().trim().max(120).optional(), fee: feeIn.optional(), idempotency_key: z.string().min(8).max(80).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    if (i.idempotency_key) {
      const had = (await c.query('SELECT * FROM tr_transfers WHERE initiated_by=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
      if (had) return present(c, user, had, await ctxOf(c, had));
    }
    const from = await teamOf(c, i.from_team_id); const to = await teamOf(c, i.to_team_id);
    const sportId = (from ?? to).sport_id;
    if (from && to && from.sport_id !== to.sport_id) throw badRequest('Both teams must play the same sport');
    if (i.kind === 'release' && (!from || to)) throw badRequest('A release names the current team and no destination');
    if (i.kind !== 'release' && !to) throw badRequest('Name the destination team');
    if (!['international', 'dual_registration'].includes(i.kind) && !from) throw badRequest('Name the current team');
    if (from && !(await c.query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [from.id, i.player_id])).rowCount) throw badRequest('The player is not an active member of the current team');
    let season = null;
    if (i.season_id) {
      season = (await c.query('SELECT s.*, cm.sport_id AS comp_sport FROM comp_seasons s JOIN comp_competitions cm ON cm.id=s.competition_id WHERE s.id=$1', [i.season_id])).rows[0];
      if (!season) throw notFound('Season');
      if (season.comp_sport !== sportId) throw badRequest('The season is for a different sport');
      if (['completed', 'archived'].includes(season.status)) throw conflict('That season is closed', { code: 'season_closed' });
    }
    if (['loan_extension', 'loan_recall'].includes(i.kind)) {
      const p = i.parent_id && (await c.query("SELECT * FROM tr_transfers WHERE id=$1 AND kind='loan' AND status='completed' AND loan_state IN ('active','extended') AND player_id=$2", [i.parent_id, i.player_id])).rows[0];
      if (!p) throw badRequest('Name the player\'s active loan');
      if (i.kind === 'loan_recall' && (p.to_team_id !== i.from_team_id || p.from_team_id !== i.to_team_id)) throw badRequest('A recall runs from the loan club back to the parent club');
      if (i.kind === 'loan_extension' && (!i.loan_ends_on || i.loan_ends_on <= ymd(p.loan_ends_on))) throw badRequest('An extension needs a later end date than the current loan');
    } else if (i.parent_id) throw badRequest('Only an extension or a recall refers to a loan');
    if (['loan', 'loan_extension'].includes(i.kind) && !i.loan_ends_on) throw badRequest('A loan needs an end date');
    const x0 = { from, to, season, cm: null, body: null };
    const mayStart = user.id === i.player_id || (await guardianLink(user.id, i.player_id, c)) || (from && (await canManageTeam(user, from))) || (to && (await canManageTeam(user, to)))
      || (season && (await isAuthority(c, user, { sport_id: sportId }, { ...x0, cm: (await c.query('SELECT * FROM comp_competitions WHERE id=$1', [season.competition_id])).rows[0] }))) || isAdmin(user);
    if (!mayStart) throw notFound('Player');
    try {
      const t = (await c.query(
        `INSERT INTO tr_transfers(kind,player_id,sport_id,from_team_id,to_team_id,season_id,parent_id,effective_on,loan_ends_on,loan_state,term,reason_enc,reference,fee_minor,fee_currency,fee_state,clearance_status,initiated_by,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [i.kind, i.player_id, sportId, i.from_team_id ?? null, i.to_team_id ?? null, i.season_id ?? null, i.parent_id ?? null, i.effective_on, i.loan_ends_on ?? null, null, i.term,
          i.reason ? encrypt(i.reason, 'tr_transfers.reason') : null, i.reference ?? null, i.fee?.minor ?? 0, i.fee?.currency ?? 'USD', i.fee?.minor ? 'agreed' : 'none', i.kind === 'international' ? 'requested' : 'not_required', user.id, i.idempotency_key ?? null])).rows[0];
      await log(c, t, 'requested', user.id, { to: 'draft', detail: { kind: t.kind } });
      await audit(c, user.id, 'transfer.request', 'transfer', t.id);
      return present(c, user, t, await ctxOf(c, t));
    } catch (e) {
      if (e.code === '23505' && /tr_transfers_one_open/.test(e.constraint ?? e.message)) throw conflict('This player already has an open transfer in this sport', { code: 'open_transfer' });
      throw e;
    }
  }),
});

cap({
  name: 'get_transfer', method: 'GET', path: '/transfers/:id', tag: TAG,
  summary: 'One transfer with its required parties, who has approved the current version, the transfer-window check, clearance, fee state and full history. Only the player, a guardian, the clubs\' managers, the competition authority or the platform team can read it.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const t = (await pool.query('SELECT * FROM tr_transfers WHERE id=$1', [i.id])).rows[0];
    if (!t) throw notFound('Transfer');
    const x = await ctxOf(pool, t);
    if (!(await canRead(pool, user, t, x))) throw notFound('Transfer');
    if (user.id !== t.player_id) await audit(pool, user.id, 'transfer.read', 'transfer', t.id);
    return present(pool, user, t, x);
  },
});

cap({
  name: 'list_transfers', method: 'GET', path: '/transfers', tag: TAG,
  summary: 'Transfers you may see: your own, your children\'s, those of teams you manage and those in competitions you run. Filter by status, kind or team.',
  input: z.object({ status: z.enum(['draft', 'submitted', 'approved', 'completed', 'rejected', 'withdrawn', 'cancelled']).optional(), kind: z.enum(KINDS).optional(), team_id: id.optional(), season_id: id.optional(), ...page }),
  handler: async ({ user }, i) => {
    const rows = await many(
      `SELECT t.id,t.kind,t.status,t.version,t.player_id,t.from_team_id,t.to_team_id,t.season_id,t.effective_on,t.loan_ends_on,t.loan_state,t.fee_state,t.clearance_status,t.created_at,
              pu.display_name AS player_name, ft.name AS from_team, tt.name AS to_team
         FROM tr_transfers t JOIN users pu ON pu.id=t.player_id LEFT JOIN teams ft ON ft.id=t.from_team_id LEFT JOIN teams tt ON tt.id=t.to_team_id
         LEFT JOIN comp_seasons s ON s.id=t.season_id LEFT JOIN comp_competitions cm ON cm.id=s.competition_id
        WHERE ($1::boolean OR t.player_id=$2 OR t.initiated_by=$2
               OR EXISTS (SELECT 1 FROM guardian_links g WHERE g.guardian_id=$2 AND g.child_id=t.player_id AND g.status='active' AND g.revoked_at IS NULL)
               OR ft.owner_id=$2 OR tt.owner_id=$2 OR cm.owner_id=$2
               OR EXISTS (SELECT 1 FROM team_members m WHERE m.user_id=$2 AND m.status='active' AND m.role IN ('captain','manager') AND m.team_id IN (t.from_team_id, t.to_team_id))
               OR EXISTS (SELECT 1 FROM organisation_members om WHERE om.user_id=$2 AND om.status='active' AND om.role IN ('owner','admin') AND om.organisation_id IN (ft.organisation_id, tt.organisation_id, cm.organisation_id)))
          AND ($3::text IS NULL OR t.status=$3) AND ($4::text IS NULL OR t.kind=$4) AND ($5::uuid IS NULL OR t.from_team_id=$5 OR t.to_team_id=$5) AND ($6::uuid IS NULL OR t.season_id=$6)
        ORDER BY t.created_at DESC LIMIT $7 OFFSET $8`,
      [isAdmin(user), user.id, i.status ?? null, i.kind ?? null, i.team_id ?? null, i.season_id ?? null, i.limit, i.offset]);
    const items = [];
    for (const r of rows) {
      // approval progress for the CURRENT version, so a list can show "2 of 3 approved" without opening each transfer
      const t = { kind: r.kind, from_team_id: r.from_team_id, to_team_id: r.to_team_id };
      const required = requiredParties(t, { youth: await isYouth(r.player_id, pool), seasoned: !!r.season_id });
      const decided = (await pool.query("SELECT party, decision FROM tr_approvals WHERE transfer_id=$1 AND version=$2", [r.id, r.version])).rows;
      const st = approvalState(required, decided);
      items.push({ ...r, effective_on: ymd(r.effective_on), loan_ends_on: ymd(r.loan_ends_on), kind_label: KIND_LABEL[r.kind], approvals: { required: required.length, approved: st.approved.length, rejected: st.rejected.length } });
    }
    return { items, limit: i.limit, offset: i.offset };
  },
});

cap({
  name: 'amend_transfer', method: 'PATCH', path: '/transfers/:id', tag: TAG,
  summary: 'Change the date, loan end, term, reference or fee of an open transfer. The version goes up, every earlier approval stops counting and the transfer returns to review, so a changed transfer can never complete on stale approvals.',
  input: z.object({ id, expected_version: z.number().int().min(1), effective_on: day.optional(), loan_ends_on: day.nullable().optional(), term: z.record(z.string().max(60), z.union([z.string().max(300), z.number(), z.boolean()])).optional(), reference: z.string().trim().max(120).optional(), reason: z.string().trim().max(1000).optional(), fee: feeIn.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const t = await lockT(c, i.id); const x = await ctxOf(c, t);
    if (!(await canRead(c, user, t, x))) throw notFound('Transfer');
    if (!OPEN.includes(t.status)) throw conflict(`A ${t.status} transfer cannot be changed`, { code: 'closed' });
    if (t.version !== i.expected_version) throw stale(t);
    const effective = i.effective_on ?? ymd(t.effective_on);
    const ends = i.loan_ends_on === undefined ? ymd(t.loan_ends_on) : i.loan_ends_on;
    if (ends && ends < effective) throw badRequest('The loan cannot end before it starts');
    const next = t.status === 'draft' ? 'draft' : 'submitted';
    const r = (await c.query(
      `UPDATE tr_transfers SET version=version+1, status=$2, effective_on=$3, loan_ends_on=$4, term=$5, reference=coalesce($6,reference), reason_enc=coalesce($7,reason_enc),
              fee_minor=coalesce($8,fee_minor), fee_currency=coalesce($9,fee_currency), fee_state=CASE WHEN $8::bigint>0 AND fee_state='none' THEN 'agreed' ELSE fee_state END, updated_at=now() WHERE id=$1 RETURNING *`,
      [t.id, next, effective, ends, i.term ?? t.term, i.reference ?? null, i.reason ? encrypt(i.reason, 'tr_transfers.reason') : null, i.fee?.minor ?? null, i.fee?.currency ?? null])).rows[0];
    await log(c, r, 'amended', user.id, { from: t.status, to: next, detail: { from_version: t.version } });
    await audit(c, user.id, 'transfer.amend', 'transfer', t.id);
    return present(c, user, r, x);
  }),
});

cap({
  name: 'submit_transfer', method: 'POST', path: '/transfers/:id/submit', tag: TAG,
  summary: 'Send a draft transfer to every required party for approval. They are notified with minimal detail.',
  input: z.object({ id, expected_version: z.number().int().min(1) }),
  handler: ({ user }, i) => tx(async (c) => {
    const t = await lockT(c, i.id); const x = await ctxOf(c, t);
    if (!(await canRead(c, user, t, x))) throw notFound('Transfer');
    if (t.version !== i.expected_version) throw stale(t);
    if (!canMove(t.status, 'submitted') || t.status !== 'draft') throw conflict(`A ${t.status} transfer cannot be submitted`, { code: 'bad_transition' });
    const r = (await c.query("UPDATE tr_transfers SET status='submitted', updated_at=now() WHERE id=$1 RETURNING *", [t.id])).rows[0];
    await log(c, r, 'submitted', user.id, { from: 'draft', to: 'submitted' });
    const recipients = new Set([t.player_id, ...(x.youth ? await guardiansOf(t.player_id, c) : []), x.from?.owner_id, x.to?.owner_id].filter(Boolean));
    recipients.delete(user.id);
    for (const uid of recipients) await notify(c, uid, { kind: 'transfer_review', title: 'A transfer needs your decision', body: 'Open Transfers to review and decide.', data: { transfer_id: t.id } });
    return present(c, user, r, x);
  }),
});

cap({
  name: 'decide_transfer', method: 'POST', path: '/transfers/:id/decision', tag: TAG,
  summary: 'Approve or reject on behalf of ONE party you actually are (player, guardian, current club, destination club or competition authority). The decision applies to the version you name; a changed transfer needs fresh decisions. Any rejection ends the transfer; when every required party has approved it becomes approved.',
  input: z.object({ id, party: z.enum(PARTIES), decision: z.enum(['approved', 'rejected']), expected_version: z.number().int().min(1), note: z.string().trim().max(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const t = await lockT(c, i.id); const x = await ctxOf(c, t);
    if (!(await canRead(c, user, t, x))) throw notFound('Transfer');
    if (t.version !== i.expected_version) throw stale(t);
    if (t.status !== 'submitted') throw conflict(`A ${t.status} transfer is not awaiting decisions`, { code: 'not_submitted' });
    const required = requiredParties(t, { youth: x.youth, seasoned: !!x.season });
    if (!required.includes(i.party)) throw badRequest(`${PARTY_LABEL[i.party]} is not a required party of this transfer`);
    if (!(await mayDecide(c, user, t, x, i.party))) throw forbidden(`You are not the ${PARTY_LABEL[i.party].toLowerCase()} for this transfer`);
    try {
      await c.query('INSERT INTO tr_approvals(transfer_id,version,party,decision,decided_by,note_enc) VALUES ($1,$2,$3,$4,$5,$6)', [t.id, t.version, i.party, i.decision, user.id, i.note ? encrypt(i.note, 'tr_approvals.note') : null]);
    } catch (e) { if (e.code === '23505') throw conflict('That party has already decided this version', { code: 'already_decided' }); throw e; }
    await log(c, t, i.decision === 'approved' ? 'approved_by' : 'rejected_by', user.id, { detail: { party: i.party } });
    const st = approvalState(required, await approvalsOf(c, t));
    let status = t.status;
    if (st.rejected.length) status = 'rejected'; else if (st.complete) status = 'approved';
    if (status !== t.status) {
      await c.query('UPDATE tr_transfers SET status=$2, updated_at=now() WHERE id=$1', [t.id, status]);
      await log(c, t, status === 'approved' ? 'approved' : 'rejected_by', user.id, { from: t.status, to: status });
      await notify(c, t.initiated_by, { kind: 'transfer_update', title: status === 'approved' ? 'A transfer is fully approved' : 'A transfer was declined', body: 'Open Transfers for the outcome.', data: { transfer_id: t.id } });
    }
    await audit(c, user.id, 'transfer.decide', 'transfer', t.id);
    return present(c, user, { ...t, status }, x);
  }),
});

cap({
  name: 'set_transfer_clearance', method: 'POST', path: '/transfers/:id/clearance', tag: TAG,
  summary: 'Record the external clearance (request, receipt or refusal) with the federation reference exactly as supplied. Only the competition authority can mark it verified; typed or uploaded evidence is never verified automatically.',
  input: z.object({ id, status: z.enum(['requested', 'received', 'refused']), reference: z.string().trim().max(120).optional(), source: z.string().trim().max(160).optional(), verified: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    const t = await lockT(c, i.id); const x = await ctxOf(c, t);
    const auth = await isAuthority(c, user, t, x);
    const club = (x.to && (await canManageTeam(user, x.to))) || (x.from && (await canManageTeam(user, x.from)));
    if (!(await canRead(c, user, t, x))) throw notFound('Transfer');
    if (!auth && !club) throw forbidden('Only the clubs or the competition authority record clearance');
    if (!OPEN.includes(t.status)) throw conflict('Clearance is closed for this transfer', { code: 'closed' });
    if (i.verified && !auth) throw forbidden('Only the competition authority can verify a clearance');
    if (i.status === 'received' && !i.reference) throw badRequest('Give the reference the federation issued');
    const r = (await c.query('UPDATE tr_transfers SET clearance_status=$2, clearance_ref=coalesce($3,clearance_ref), clearance_source=coalesce($4,clearance_source), clearance_verified=$5, updated_at=now() WHERE id=$1 RETURNING *',
      [t.id, i.status, i.reference ?? null, i.source ?? null, i.verified && auth])).rows[0];
    await log(c, r, 'clearance', user.id, { detail: { status: i.status, verified: r.clearance_verified } });
    return present(c, user, r, x);
  }),
});

cap({
  name: 'set_transfer_fee_state', method: 'POST', path: '/transfers/:id/fee', tag: TAG,
  summary: 'Move the fee through none → agreed → invoiced → paid → cleared, with the canonical invoice reference. Money state never changes the sporting state: a paid fee does not complete a transfer and an unpaid one does not block it.',
  input: z.object({ id, fee_state: z.enum(['agreed', 'invoiced', 'paid', 'cleared', 'none']), invoice_ref: z.string().trim().max(120).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const t = await lockT(c, i.id); const x = await ctxOf(c, t);
    if (!(await canRead(c, user, t, x))) throw notFound('Transfer');
    if (!((x.to && (await canManageTeam(user, x.to))) || (x.from && (await canManageTeam(user, x.from))) || (await isAuthority(c, user, t, x)))) throw forbidden('Only the clubs or the authority manage the fee');
    if (!FEE_FLOW[t.fee_state].includes(i.fee_state)) throw conflict(`The fee cannot go from ${t.fee_state} to ${i.fee_state}`, { code: 'bad_fee_transition', allowed: FEE_FLOW[t.fee_state] });
    if (i.fee_state === 'agreed' && !t.fee_minor) throw badRequest('Set a fee amount first');
    const r = (await c.query('UPDATE tr_transfers SET fee_state=$2, fee_invoice_ref=coalesce($3,fee_invoice_ref), updated_at=now() WHERE id=$1 RETURNING *', [t.id, i.fee_state, i.invoice_ref ?? null])).rows[0];
    await log(c, r, 'fee', user.id, { detail: { from: t.fee_state, to: i.fee_state } });
    return present(c, user, r, x);
  }),
});

cap({
  name: 'grant_transfer_window_exception', method: 'POST', path: '/transfers/:id/window-exception', tag: TAG,
  summary: 'The competition authority lets this one movement happen outside the transfer window (or despite a sanction check), with a mandatory reason that is audited. It never changes the window itself.',
  input: z.object({ id, reason: z.string().trim().min(5).max(500) }),
  handler: ({ user }, i) => tx(async (c) => {
    const t = await lockT(c, i.id); const x = await ctxOf(c, t);
    if (!(await canRead(c, user, t, x))) throw notFound('Transfer');
    if (!(await isAuthority(c, user, t, x))) throw forbidden('Only the competition authority grants an exception');
    if (!OPEN.includes(t.status)) throw conflict('This transfer is closed', { code: 'closed' });
    const r = (await c.query('UPDATE tr_transfers SET window_exception_enc=$2, window_exception_by=$3, updated_at=now() WHERE id=$1 RETURNING *', [t.id, encrypt(i.reason, 'tr_transfers.window_exception'), user.id])).rows[0];
    await log(c, r, 'window_exception', user.id, {});
    await audit(c, user.id, 'transfer.window_exception', 'transfer', t.id);
    return present(c, user, r, x);
  }),
});

cap({
  name: 'withdraw_transfer', method: 'POST', path: '/transfers/:id/withdraw', tag: TAG,
  summary: 'Withdraw (initiator, player or a club) or cancel (competition authority) an open transfer. History is kept; nothing is deleted and a completed transfer cannot be withdrawn.',
  input: z.object({ id, reason: z.string().trim().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const t = await lockT(c, i.id); const x = await ctxOf(c, t);
    if (!(await canRead(c, user, t, x))) throw notFound('Transfer');
    if (!OPEN.includes(t.status)) throw conflict(`A ${t.status} transfer cannot be withdrawn`, { code: 'closed' });
    const auth = await isAuthority(c, user, t, x);
    const to = auth && user.id !== t.initiated_by ? 'cancelled' : 'withdrawn';
    const r = (await c.query('UPDATE tr_transfers SET status=$2, updated_at=now() WHERE id=$1 RETURNING *', [t.id, to])).rows[0];
    await log(c, r, to, user.id, { from: t.status, to, detail: { reason: i.reason ?? null } });
    return present(c, user, r, x);
  }),
});

/** Exactly-once movement through canonical records. Called inside the completion transaction with the transfer row locked. */
async function applyMovement(c, t, x, actor) {
  const leave = async (teamId) => { if (teamId) await c.query("UPDATE team_members SET status='left' WHERE team_id=$1 AND user_id=$2 AND status<>'left'", [teamId, t.player_id]); };
  const join = async (teamId) => {
    await c.query(`INSERT INTO team_members(team_id,user_id,role,status) VALUES ($1,$2,'player','active') ON CONFLICT (team_id,user_id) DO UPDATE SET status='active'`, [teamId, t.player_id]);
  };
  const endStint = async (teamId) => { if (teamId) await c.query('UPDATE career_memberships SET ends_on=$3, updated_at=now(), row_version=row_version+1 WHERE user_id=$1 AND team_id=$2 AND ends_on IS NULL AND archived_at IS NULL AND starts_on <= $3', [t.player_id, teamId, ymd(t.effective_on)]); };
  const startStint = async (teamId) => {
    if (!teamId) return;
    await c.query(
      `INSERT INTO career_memberships(user_id,sport_id,team_id,organisation_id,starts_on,source,created_by,idempotency_key) VALUES ($1,$2,$3,(SELECT organisation_id FROM teams WHERE id=$3),$4,'staff',$5,$6) ON CONFLICT DO NOTHING`,
      [t.player_id, t.sport_id, teamId, ymd(t.effective_on), actor, `tr:${t.id}:${teamId}`.slice(0, 80)]);
  };
  const handoff = async (leaving, arriving) => {
    if (!x.season) return;
    const ev = x.season.event_id;
    if (leaving) {
      const live = (await c.query("SELECT * FROM reg_registrations WHERE event_id=$1 AND user_id=$2 AND team_id=$3 AND status IN ('submitted','under_review','registered','suspended') FOR UPDATE", [ev, t.player_id, leaving])).rows[0];
      if (live) {
        const w = (await c.query("UPDATE reg_registrations SET status='withdrawn', row_version=row_version+1, effective_to=$2, updated_at=now() WHERE id=$1 RETURNING *", [live.id, ymd(t.effective_on)])).rows[0];
        await c.query(`INSERT INTO reg_history(registration_id,row_version,action,from_status,to_status,actor_id,snapshot) VALUES ($1,$2,'withdrawn',$3,'withdrawn',$4,$5)`, [live.id, w.row_version, live.status, actor, JSON.stringify({ ...w, reason: `transfer:${t.id}` })]);
      }
    }
    if (arriving) {
      await c.query(
        `INSERT INTO reg_dependencies(event_id,user_id,kind,status,source_ref,source_label,valid_from,recorded_by) VALUES ($1,$2,$3,'clear',$4,$5,$6,$7)`,
        [ev, t.player_id, t.kind === 'loan' || t.kind === 'loan_extension' ? 'loan' : 'transfer', `transfer:${t.id}`, 'Approved transfer', ymd(t.effective_on), actor]);
      const already = (await c.query("SELECT 1 FROM reg_registrations WHERE event_id=$1 AND user_id=$2 AND status IN ('submitted','under_review','registered','suspended')", [ev, t.player_id])).rowCount;
      if (!already) {
        const r = (await c.query(
          `INSERT INTO reg_registrations(event_id,team_id,user_id,status,source,submitted_by,effective_from) VALUES ($1,$2,$3,'submitted','staff',$4,$5) RETURNING *`, [ev, arriving, t.player_id, actor, ymd(t.effective_on)])).rows[0];
        await c.query(`INSERT INTO reg_history(registration_id,row_version,action,to_status,actor_id,snapshot) VALUES ($1,$2,'submitted','submitted',$3,$4)`, [r.id, r.row_version, actor, JSON.stringify({ ...r, reason: `transfer:${t.id}` })]);
      }
    }
  };
  switch (t.kind) {
    case 'permanent': case 'international':
      await leave(t.from_team_id); await endStint(t.from_team_id); await join(t.to_team_id); await startStint(t.to_team_id); await handoff(t.from_team_id, t.to_team_id); break;
    case 'loan':
      await join(t.to_team_id); await startStint(t.to_team_id); await handoff(null, t.to_team_id); break; // parent membership stays: the player is on loan, not gone
    case 'dual_registration':
      await join(t.to_team_id); await startStint(t.to_team_id); await handoff(null, t.to_team_id); break;
    case 'release':
      await leave(t.from_team_id); await endStint(t.from_team_id); await handoff(t.from_team_id, null); break;
    case 'loan_recall':
      await leave(t.from_team_id); await endStint(t.from_team_id); await join(t.to_team_id); await handoff(t.from_team_id, t.to_team_id);
      await c.query("UPDATE tr_transfers SET loan_state='recalled', updated_at=now() WHERE id=$1", [t.parent_id]); break;
    case 'loan_extension':
      await c.query("UPDATE tr_transfers SET loan_ends_on=$2, loan_state='extended', updated_at=now() WHERE id=$1", [t.parent_id, ymd(t.loan_ends_on)]); break;
    default: break;
  }
}

cap({
  name: 'complete_transfer', method: 'POST', path: '/transfers/:id/complete', tag: TAG,
  summary: 'Make an approved transfer effective: updates team membership, withdraws/submits the competition registration (the registrar still reviews it), writes the career timeline and records the transfer reference for eligibility — exactly once, even if retried. Blocked by a closed window, an unmet clearance or an active sporting sanction unless the authority granted an exception. Fee state is independent.',
  input: z.object({ id, expected_version: z.number().int().min(1) }),
  handler: ({ user }, i) => tx(async (c) => {
    const t = await lockT(c, i.id); const x = await ctxOf(c, t);
    if (!(await canRead(c, user, t, x))) throw notFound('Transfer');
    if (t.status === 'completed') return present(c, user, t, x); // idempotent retry
    if (t.version !== i.expected_version) throw stale(t);
    if (t.status !== 'approved') throw conflict(`A ${t.status} transfer cannot be completed`, { code: 'not_approved' });
    const may = (x.to && (await canManageTeam(user, x.to))) || (x.from && (await canManageTeam(user, x.from))) || (await isAuthority(c, user, t, x)) || isAdmin(user);
    if (!may) throw forbidden('Only the clubs or the competition authority complete a transfer');
    const approvals = approvalState(requiredParties(t, { youth: x.youth, seasoned: !!x.season }), await approvalsOf(c, t));
    const sanction = await activeSportingSanction(c, t.player_id, t.sport_id, ymd(t.effective_on));
    const blockers = completionBlockers(t, { approvals, window: windowCheck(x.season, t.effective_on), sanction });
    if (blockers.length) throw conflict('This transfer cannot be completed yet', { code: 'blocked', blockers });
    await applyMovement(c, t, x, user.id);
    const r = (await c.query(
      `UPDATE tr_transfers SET status='completed', completed_by=$2, completed_at=now(), loan_state=CASE WHEN kind='loan' THEN 'active' ELSE loan_state END, updated_at=now() WHERE id=$1 RETURNING *`, [t.id, user.id])).rows[0];
    await log(c, r, 'completed', user.id, { from: 'approved', to: 'completed' });
    await audit(c, user.id, 'transfer.complete', 'transfer', t.id);
    await notify(c, t.player_id, { kind: 'transfer_update', title: 'Your transfer is complete', body: 'Open your career timeline to see the change.', data: { transfer_id: t.id } });
    return present(c, user, r, x);
  }),
});
