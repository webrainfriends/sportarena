// Player contracts and amendments (issue #333). A contract connects an accepted playing opportunity (Billboard, #67) to versioned terms, signatures
// from every party, and the money that follows (see player-contract-money.js). Every amendment is a new version; a signed version is never edited.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, PUBLIC_USER } from '../helpers.js';
import { encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { guardiansOf, hiddenYouth, isYouth, requireConsent } from '../youth.js';
import { onContractRevision } from '../representation.js';
import {
  FINANCE_THRESHOLD_CENTS, ROLES, dayOf, VERSION_COLS, accessFor, accrueContract, blockFor, committedValue, conflictStale, diffTerms, expectedEarnings, financeAuthorities, isSoleAuthority,
  ladderFor, loadContract, loadPayer, normaliseTerms, readinessFor, requiredParties, termsSchema, todayIso, versionAt, versionTerms, versionsOf,
} from '../player-contracts.js';

const TAG = 'Player contracts';
const AMENDMENT_TYPES = ['fee_change', 'term_extension', 'add_bonus', 'correction', 'early_termination', 'pause'];
const SUMMARY = `k.id, k.contract_no, k.team_id, k.event_id, k.payee_id, k.title, k.role, k.status, k.currency, k.current_version, k.row_version, k.ended_on::text AS ended_on, k.response_id, k.created_at`;

async function payerName(contract, c) {
  const p = await loadPayer(contract, c);
  return { type: p.type, id: p.row.id, name: p.row.name, organisation_id: p.row.organisation_id ?? null };
}
const pendingOf = (versions) => versions.find((v) => v.status === 'proposed') ?? null;
const sigs = async (c, versionIds) => (versionIds.length ? (await c.query('SELECT version_id, party, signer_id, decision, comment, signed_at FROM player_contract_signatures WHERE version_id = ANY($1) ORDER BY signed_at, id', [versionIds])).rows : []);

/** Which of the version's still-unsigned parties this person can sign for. */
async function partiesFor(user, contract, version, access, c) {
  const out = [];
  if (access.isPayee && access.consent) out.push('player');
  if (access.guardian) out.push('guardian');
  if (access.staff.manage) out.push('team');
  if (access.staff.finance && (user.id !== version.proposed_by || await isSoleAuthority(user, access.payer, c))) out.push('finance');
  return out.filter((p) => version.required_parties.includes(p));
}

async function notifyParties(c, contract, access, exceptId, msg) {
  const to = new Set([contract.payee_id, ...(access.youth ? await guardiansOf(contract.payee_id, c) : [])]);
  const payer = access.payer;
  to.add(payer.type === 'team' ? payer.row.owner_id : payer.row.organizer_id);
  to.delete(exceptId);
  for (const u of to) await notify(c, u, { ...msg, data: { ...(msg.data ?? {}), contract_id: contract.id } });
}

/** Activate a version once every required party has signed: it becomes the version in force and earnings are brought up to date. */
async function activate(c, contract, version, actor) {
  await c.query("UPDATE player_contract_versions SET status='superseded', decided_at=coalesce(decided_at, now()) WHERE contract_id=$1 AND status='in_force'", [contract.id]);
  await c.query("UPDATE player_contract_versions SET status='in_force', decided_at=now(), row_version=row_version+1 WHERE id=$1", [version.id]);
  const first = version.version === 1 || contract.status === 'offered';
  await c.query("UPDATE player_contracts SET current_version=$2, status=CASE WHEN status='offered' THEN 'active' ELSE status END, row_version=row_version+1, updated_at=now() WHERE id=$1", [contract.id, version.version]);
  if (first && contract.legacy_payout_id) {
    // the fee recorded when the application was accepted is now settled through this contract; the row is kept, never deleted
    await c.query("UPDATE team_payouts SET status='cancelled', note=left(coalesce(note,'') || ' · moved to contract ' || $2, 200) WHERE id=$1 AND status='due'", [contract.legacy_payout_id, contract.contract_no]);
  }
  await accrueContract(c, contract.id, actor);
}

async function financeNeeded(payer, valueCents, increaseCents, retroactive) {
  if (!payer.row.organisation_id) return false;
  return retroactive || increaseCents > FINANCE_THRESHOLD_CENTS() || (increaseCents === null && valueCents >= FINANCE_THRESHOLD_CENTS());
}

/** Put a draft or amendment in front of the parties: freeze it, record the proposer's own signature(s), and tell everyone else. */
async function propose(c, user, contract, version, access, { initial }) {
  const youth = access.youth;
  const prior = initial ? null : (await versionsOf(c, contract.id)).find((v) => v.status === 'in_force');
  const increase = initial ? null : Number(version.value_cents) - Number(prior?.value_cents ?? 0);
  const needFin = await financeNeeded(access.payer, Number(version.value_cents), increase, version.retroactive);
  const required = requiredParties({ youth, financeNeeded: needFin });
  await c.query("UPDATE player_contract_versions SET status='proposed', required_parties=$2, proposed_at=now(), row_version=row_version+1 WHERE id=$1", [version.id, required]);
  version.required_parties = required; version.status = 'proposed';
  const mine = await partiesFor(user, contract, version, access, c);
  await onContractRevision(c, contract, version.version); // agents who were shared this contract and are live get a review item (no terms in the notice)
  for (const party of mine) await c.query("INSERT INTO player_contract_signatures(version_id, party, signer_id, decision) VALUES ($1,$2,$3,'signed') ON CONFLICT (version_id, party) DO NOTHING", [version.id, party, user.id]);
  return { required, signed: mine };
}

async function settle(c, contract, version) {
  const signed = new Set((await c.query("SELECT party FROM player_contract_signatures WHERE version_id=$1 AND decision='signed'", [version.id])).rows.map((r) => r.party));
  return version.required_parties.every((p) => signed.has(p));
}

const termsInput = termsSchema;

async function viewVersions(c, versions) {
  const s = await sigs(c, versions.map((v) => v.id));
  const names = new Map((await c.query('SELECT id, display_name, handle FROM users WHERE id = ANY($1)', [[...new Set(s.map((x) => x.signer_id).concat(versions.map((v) => v.proposed_by)))]])).rows.map((u) => [u.id, u]));
  return versions.map((v) => ({
    ...v, proposed_by_name: names.get(v.proposed_by)?.display_name ?? null,
    signatures: s.filter((x) => x.version_id === v.id).map((x) => ({ party: x.party, decision: x.decision, signed_at: x.signed_at, signer: names.get(x.signer_id)?.display_name ?? null, comment: x.comment })),
    waiting_for: v.status === 'proposed' ? v.required_parties.filter((p) => !s.some((x) => x.version_id === v.id && x.party === p && x.decision === 'signed')) : [],
  }));
}

// ------------------------------------------------------------------ candidates
cap({
  name: 'list_contract_candidates', method: 'GET', path: '/player-contracts/candidates', tag: TAG,
  summary: 'Accepted playing opportunities (Billboard applications) for a team or event that do not have a contract yet, with the fee already recorded on acceptance so it is not paid twice. Team money managers or event organisers only.',
  input: z.object({ team_id: id.optional(), event_id: id.optional(), ...page }),
  async handler({ user }, i) {
    if (!!i.team_id === !!i.event_id) throw badRequest('Give either team_id or event_id');
    const payer = await loadPayer({ team_id: i.team_id ?? null, event_id: i.event_id ?? null });
    if (!payer.row) throw notFound(i.team_id ? 'Team' : 'Event');
    const { staffRoleFor } = await import('../player-contracts.js');
    if (!(await staffRoleFor(user, payer)).manage) throw forbidden('Only the team\'s money managers or the event organisers can see this');
    const rows = await many(
      `SELECT r.id AS response_id, r.responder_id AS payee_id, u.display_name, u.handle, p.id AS post_id, p.title AS post_title, p.target_role, p.currency, p.budget_cents, p.compensation, r.payout_id AS legacy_payout_id,
              tp.amount_cents AS legacy_amount_cents, tp.status AS legacy_status, tp.due_on::text AS legacy_due_on, r.created_at
         FROM billboard_responses r JOIN billboard_posts p ON p.id=r.post_id JOIN users u ON u.id=r.responder_id LEFT JOIN team_payouts tp ON tp.id=r.payout_id
        WHERE r.status='accepted' AND ${i.team_id ? 'p.team_id=$1' : "p.target_type='event' AND p.target_id=$1"}
          AND NOT EXISTS (SELECT 1 FROM player_contracts k WHERE k.response_id=r.id AND k.status<>'void')
        ORDER BY r.created_at DESC, r.id LIMIT $2 OFFSET $3`, [i.team_id ?? i.event_id, i.limit, i.offset]);
    const hidden = await hiddenYouth(user, rows.map((r) => r.payee_id));
    return rows.map((r) => (hidden.has(r.payee_id) ? { ...r, display_name: null, handle: null, hidden: true, budget_cents: null, legacy_amount_cents: null } : r));
  },
});

// ------------------------------------------------------------------ create / draft / send
const draftInput = {
  title: z.string().min(1).max(160),
  role: z.enum(ROLES).default('player'),
  terms: termsInput,
};

cap({
  name: 'create_player_contract', method: 'POST', path: '/player-contracts', tag: TAG, status: 201,
  summary: 'Create a contract for a person from an accepted playing opportunity (response_id) or for someone on the team/event. Terms: pay components (appearance, start, goal and win bonuses, monthly pay, fixed, signing and retention payments), term, currency, tax withheld (a rate the club enters) and an expense cap. send=true offers it straight away. A young person needs current guardian consent and a guardian signature. Safe to retry with the same client_key.',
  input: z.object({ team_id: id.optional(), event_id: id.optional(), payee_id: id.optional(), response_id: id.optional(), ...draftInput, send: z.boolean().default(false), client_key: z.string().min(1).max(64).optional() }),
  async handler({ user }, i) {
    if (!!i.team_id === !!i.event_id) throw badRequest('Give either team_id (a team contract) or event_id (an event contract)');
    return tx(async (c) => {
      if (i.client_key) {
        const dup = (await c.query('SELECT id FROM player_contracts WHERE created_by=$1 AND client_key=$2', [user.id, i.client_key])).rows[0];
        if (dup) return getView(c, user, dup.id);
      }
      const payer = await loadPayer({ team_id: i.team_id ?? null, event_id: i.event_id ?? null }, c);
      if (!payer.row) throw notFound(i.team_id ? 'Team' : 'Event');
      const { staffRoleFor } = await import('../player-contracts.js');
      const staff = await staffRoleFor(user, payer, c);
      if (!staff.manage) throw forbidden('Only the team\'s money managers or the event organisers can create contracts');
      let payee = i.payee_id, resp = null;
      if (i.response_id) {
        resp = (await c.query(`SELECT r.*, p.team_id AS post_team, p.target_type, p.target_id, p.title AS post_title FROM billboard_responses r JOIN billboard_posts p ON p.id=r.post_id WHERE r.id=$1 FOR UPDATE OF r`, [i.response_id])).rows[0];
        if (!resp || resp.status !== 'accepted') throw badRequest('That application has not been accepted');
        const ok = i.team_id ? resp.post_team === i.team_id : resp.target_type === 'event' && resp.target_id === i.event_id;
        if (!ok) throw badRequest('That application belongs to a different team or event');
        if (payee && payee !== resp.responder_id) throw badRequest('payee_id does not match the application');
        payee = resp.responder_id;
        if ((await c.query("SELECT 1 FROM player_contracts WHERE response_id=$1 AND status<>'void'", [resp.id])).rowCount) throw conflict('That application already has a contract', { code: 'duplicate' });
      } else {
        if (!payee) throw badRequest('Give payee_id or response_id');
        const known = i.team_id
          ? (await c.query('SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2', [i.team_id, payee])).rowCount
          : (await c.query("SELECT 1 FROM associations WHERE target_type='event' AND target_id=$1 AND user_id=$2 AND status IN ('invited','requested','active')", [i.event_id, payee])).rowCount;
        if (!known) throw badRequest(i.team_id ? 'That person has never been on this team' : 'That person has no role at this event');
      }
      if (payee === user.id) throw forbidden('You cannot create a contract for yourself');
      if (await isYouth(payee, c)) await requireConsent(payee, 'participation', 'a paid agreement', c);
      const cur = (payer.row.currency ?? 'INR').toUpperCase();
      const t = normaliseTerms(i.terms, { hasTeam: !!i.team_id });
      if (t.currency !== cur) throw badRequest(`This ${payer.type} pays in ${cur}; the contract must use the same currency`);
      const no = (await c.query("SELECT 'PC-' || to_char(now(),'YYYY') || '-' || lpad(nextval('player_contract_no_seq')::text, 4, '0') AS n")).rows[0].n;
      const k = (await c.query(
        `INSERT INTO player_contracts(contract_no, team_id, event_id, payee_id, response_id, legacy_payout_id, title, role, currency, client_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [no, i.team_id ?? null, i.event_id ?? null, payee, resp?.id ?? null, resp?.payout_id ?? null, i.title, i.role, t.currency, i.client_key ?? null, user.id])).rows[0];
      await c.query(
        `INSERT INTO player_contract_versions(contract_id, version, kind, status, starts_on, ends_on, effective_from, currency, components, expected_games, withholding_bp, expense_cap_cents, pay_terms_days, value_cents, changes, proposed_by)
         VALUES ($1,1,'initial','draft',$2,$3,$2,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [k.id, t.starts_on, t.ends_on, t.currency, JSON.stringify(t.components), t.expected_games, t.withholding_bp, t.expense_cap_cents, t.pay_terms_days, t.value_cents, JSON.stringify(diffTerms(null, t)), user.id]);
      await audit(c, user.id, 'create_player_contract', 'player_contracts', k.id);
      if (i.send) await sendDraft(c, user, k);
      return getView(c, user, k.id);
    });
  },
});

async function sendDraft(c, user, contract) {
  const access = await accessFor(user, contract, c);
  if (!access?.staff.manage) throw forbidden('Only the team\'s money managers or the event organisers can send a contract');
  if (contract.status !== 'draft') throw conflict(`This contract is already ${contract.status}`);
  const v = (await c.query("SELECT * FROM player_contract_versions WHERE contract_id=$1 AND version=1 FOR UPDATE", [contract.id])).rows[0];
  if (v.ends_on < todayIso()) throw badRequest('The contract term has already ended');
  const r = await propose(c, user, contract, v, access, { initial: true });
  await c.query("UPDATE player_contracts SET status='offered', row_version=row_version+1, updated_at=now() WHERE id=$1", [contract.id]);
  if (await settle(c, contract, { ...v, required_parties: r.required })) await activate(c, { ...contract, status: 'offered' }, v, user.id);
  else await notifyParties(c, contract, access, user.id, { kind: 'player_contract_offered', title: `${access.payer.row.name} sent you a contract`, body: `${contract.title} · ${contract.contract_no}. Review and sign it under Contracts.` });
}

cap({
  name: 'update_contract_draft', method: 'PATCH', path: '/player-contracts/:id', tag: TAG,
  summary: 'Edit the terms or title of a contract that has not been sent yet. Once it is sent the version is frozen; propose an amendment instead. Send row_version from the last read; an older one is refused with stale_version.',
  input: z.object({ id, row_version: z.coerce.number().int().min(1), title: z.string().min(1).max(160).optional(), role: z.enum(ROLES).optional(), terms: termsInput.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { contract, access } = await loadContract(user, i.id, c, { lock: true });
      if (!access.staff.manage) throw forbidden('Only the team\'s money managers or the event organisers can edit a draft');
      if (contract.status !== 'draft') throw conflict(`A ${contract.status} contract cannot be edited. Propose an amendment.`, { code: 'not_draft' });
      if (contract.row_version !== i.row_version) throw conflictStale();
      if (i.terms) {
        const t = normaliseTerms(i.terms, { hasTeam: !!contract.team_id });
        if (t.currency !== contract.currency) throw badRequest('The currency of a contract cannot change');
        await c.query(
          `UPDATE player_contract_versions SET starts_on=$2, ends_on=$3, effective_from=$2, components=$4, expected_games=$5, withholding_bp=$6, expense_cap_cents=$7, pay_terms_days=$8, value_cents=$9, changes=$10, row_version=row_version+1
            WHERE contract_id=$1 AND version=1`,
          [contract.id, t.starts_on, t.ends_on, JSON.stringify(t.components), t.expected_games, t.withholding_bp, t.expense_cap_cents, t.pay_terms_days, t.value_cents, JSON.stringify(diffTerms(null, t))]);
      }
      await c.query('UPDATE player_contracts SET title=coalesce($2,title), role=coalesce($3,role), row_version=row_version+1, updated_at=now() WHERE id=$1', [contract.id, i.title ?? null, i.role ?? null]);
      return getView(c, user, contract.id);
    });
  },
});

cap({
  name: 'send_player_contract', method: 'POST', path: '/player-contracts/:id/send', tag: TAG,
  summary: 'Offer a drafted contract. The terms are frozen; the person (and a guardian, for a young person) and any required finance approver are asked to sign. Your own signature for the club is recorded.',
  input: z.object({ id, row_version: z.coerce.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { contract } = await loadContract(user, i.id, c, { lock: true });
      if (contract.row_version !== i.row_version) throw conflictStale();
      if (await isYouth(contract.payee_id, c)) await requireConsent(contract.payee_id, 'participation', 'a paid agreement', c);
      await sendDraft(c, user, contract);
      return getView(c, user, contract.id);
    });
  },
});

// ------------------------------------------------------------------ list / get
cap({
  name: 'list_player_contracts', method: 'GET', path: '/player-contracts', tag: TAG,
  summary: 'Contracts. Without team_id/event_id: yours (as the person paid, or as guardian of a young person). With team_id or event_id: all contracts of that payer for its money managers; contracts of a young person without current guardian consent appear as hidden placeholders. needs_my_action marks a version waiting for your signature.',
  input: z.object({ team_id: id.optional(), event_id: id.optional(), status: z.enum(['draft', 'offered', 'active', 'completed', 'terminated', 'void']).optional(), ...page }),
  async handler({ user }, i) {
    if (i.team_id && i.event_id) throw badRequest('Give team_id or event_id, not both');
    let rows, staffView = false;
    if (i.team_id || i.event_id) {
      const payer = await loadPayer({ team_id: i.team_id ?? null, event_id: i.event_id ?? null });
      if (!payer.row) throw notFound(i.team_id ? 'Team' : 'Event');
      const { staffRoleFor } = await import('../player-contracts.js');
      if (!(await staffRoleFor(user, payer)).manage) throw forbidden('Only the team\'s money managers or the event organisers can list its contracts');
      staffView = true;
    }
    rows = await many(
      `SELECT ${SUMMARY}, u.display_name AS payee_name, u.handle AS payee_handle, (SELECT coalesce(sum(amount_cents),0) FROM player_contract_entries e WHERE e.contract_id=k.id)::bigint AS owed_cents,
              (SELECT coalesce(sum(amount_cents) FILTER (WHERE kind='fee'),0) FROM player_contract_entries e WHERE e.contract_id=k.id)::bigint AS earned_cents,
              (SELECT coalesce(-sum(amount_cents) FILTER (WHERE kind='payment'),0) FROM player_contract_entries e WHERE e.contract_id=k.id)::bigint AS paid_cents,
              (SELECT value_cents FROM player_contract_versions v WHERE v.contract_id=k.id AND v.version=k.current_version) AS value_cents,
              (SELECT v.version FROM player_contract_versions v WHERE v.contract_id=k.id AND v.status='proposed') AS pending_version
         FROM player_contracts k JOIN users u ON u.id=k.payee_id
        WHERE ${staffView ? '(k.team_id=$1 OR k.event_id=$1)' : '($1::uuid IS NULL AND (k.payee_id=$2 OR EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=$2 AND l.child_id=k.payee_id AND l.status=\'active\' AND l.revoked_at IS NULL)))'}
          AND ($3::text IS NULL OR k.status=$3)${staffView ? ' AND $2::uuid IS NOT NULL' : " AND k.status<>'draft'"}
        ORDER BY k.created_at DESC, k.id LIMIT $4 OFFSET $5`, [i.team_id ?? i.event_id ?? null, user.id, i.status ?? null, i.limit, i.offset]);
    const out = [];
    const hidden = staffView ? await hiddenYouth(user, rows.map((r) => r.payee_id)) : new Set();
    for (const r of rows) {
      if (hidden.has(r.payee_id)) { out.push({ id: r.id, hidden: true, status: r.status }); continue; }
      let needs = false;
      if (r.pending_version) {
        const access = await accessFor(user, r);
        const v = (await one('SELECT * FROM player_contract_versions WHERE contract_id=$1 AND version=$2', [r.id, r.pending_version]));
        if (access && v) {
          const mine = await partiesFor(user, r, v, access);
          const done = new Set((await many("SELECT party FROM player_contract_signatures WHERE version_id=$1", [v.id])).map((x) => x.party));
          needs = mine.some((p) => !done.has(p));
        }
      }
      out.push({ ...r, needs_my_action: needs });
    }
    return out;
  },
});

async function getView(c, user, contractId) {
  const { contract: first, access } = await loadContract(user, contractId, c);
  // earnings are derived from the record (appearances, results, dates), so reading brings them up to date; posting is idempotent
  if (['active', 'completed', 'terminated'].includes(first.status)) await accrueContract(c, first.id, null);
  const contract = (await c.query('SELECT * FROM player_contracts WHERE id=$1', [first.id])).rows[0];
  if (access.role !== 'payee') await audit(c, user.id, 'read_pii', 'player_contracts', contract.id);
  const versions = await viewVersions(c, await versionsOf(c, contract.id));
  const inForce = versions.find((v) => v.status === 'in_force') ?? null;
  const pending = pendingOf(versions);
  // one connection, so these run one after the other
  const ladder = await ladderFor(c, contract.id);
  const readiness = await readinessFor(c, contract);
  const payee = (await c.query(`SELECT ${PUBLIC_USER} FROM users u WHERE u.id=$1`, [contract.payee_id])).rows[0];
  const counts = (await c.query(`SELECT (SELECT count(*) FROM player_contract_expenses WHERE contract_id=$1 AND status='submitted')::int AS expenses_waiting,
                    (SELECT count(*) FROM player_contract_invoices WHERE contract_id=$1)::int AS invoices`, [contract.id])).rows[0];
  const legacy = contract.legacy_payout_id ? (await c.query('SELECT id, amount_cents, currency, status FROM team_payouts WHERE id=$1', [contract.legacy_payout_id])).rows[0] ?? null : null;
  const mineParties = pending ? await partiesFor(user, contract, pending, access, c) : [];
  const signedParties = new Set((pending?.signatures ?? []).filter((s) => s.decision === 'signed').map((s) => s.party));
  const canSign = mineParties.filter((p) => !signedParties.has(p));
  const upcoming = inForce ? await upcomingPayments(c, contract, versions) : [];
  const staff = access.staff;
  const block = blockFor(readiness);
  return {
    ...contract, ended_on: dayOf(contract.ended_on),
    payee, payer: await payerName(contract, c), viewer_role: access.role, youth: access.youth,
    versions, in_force: inForce, pending, ladder: { committed_cents: inForce ? Number(inForce.value_cents) : null, ...ladder },
    readiness, payout_blocker: block, upcoming, legacy_payout: legacy, ...counts,
    permissions: {
      edit_draft: staff.manage && contract.status === 'draft',
      send: staff.manage && contract.status === 'draft',
      propose: ['active'].includes(contract.status) && (staff.manage || access.role === 'payee' || access.role === 'guardian'),
      sign: canSign, withdraw: !!pending && (pending.proposed_by === user.id || staff.manage),
      end: staff.manage && contract.status === 'active', manage_money: staff.manage, finance: staff.finance,
      submit_expense: access.role === 'payee' && contract.status === 'active',
    },
  };
}

/** The next dated payments that have not been earned yet, from the version in force. Informational: nothing here is owed until its trigger happens. */
async function upcomingPayments(c, contract, versions) {
  const live = versions.filter((v) => v.status === 'in_force' || v.status === 'superseded');
  const today = todayIso();
  const v = live.find((x) => x.status === 'in_force');
  if (!v || contract.status !== 'active') return [];
  const out = [];
  const { monthlyPeriods } = await import('../player-contracts.js');
  for (const comp of v.components) {
    if (comp.due_on && comp.due_on > today) out.push({ label: comp.label, due_on: comp.due_on, amount_cents: comp.amount_cents, basis: 'one_off' });
    if (comp.kind === 'monthly') {
      const p = monthlyPeriods(live[0].starts_on, v.ends_on).find((x) => x.to >= today);
      if (p) out.push({ label: `${comp.label} ${p.from} to ${p.to}`, due_on: p.to, amount_cents: comp.amount_cents, basis: 'monthly' });
    }
  }
  return out.sort((a, b) => a.due_on.localeCompare(b.due_on)).slice(0, 8);
}

cap({
  name: 'get_player_contract', method: 'GET', path: '/player-contracts/:id', tag: TAG,
  summary: 'One contract in full: parties, every version with signatures and the changes it made, the pending amendment and who it is waiting for, the money ladder (committed value is separate from earned, withheld, expenses, paid, refunded and owed), readiness checks for payment, and what you can do. Only the person paid, their guardian or the club\'s money managers; anyone else gets 404. Reads by anyone but the person paid are audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) { return tx((c) => getView(c, user, i.id)); },
});

cap({
  name: 'compare_contract_versions', method: 'GET', path: '/player-contracts/:id/compare', tag: TAG,
  summary: 'Compare two versions of a contract field by field (version numbers from get_player_contract).',
  input: z.object({ id, from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1) }),
  async handler({ user }, i) {
    const { contract } = await loadContract(user, i.id);
    const vs = await versionsOf(null, contract.id);
    const a = vs.find((v) => v.version === i.from), b = vs.find((v) => v.version === i.to);
    if (!a || !b) throw notFound('Version');
    return { from: i.from, to: i.to, changes: diffTerms(versionTerms(a), versionTerms(b)) };
  },
});

// ------------------------------------------------------------------ amendments
const amendInput = {
  id,
  base_version: z.coerce.number().int().min(1).describe('the version in force you started from; a different one is refused with stale_version'),
  terms: termsInput,
  effective_from: z.string().date(),
  amendment_types: z.array(z.enum(AMENDMENT_TYPES)).min(1).max(AMENDMENT_TYPES.length),
  reason: z.string().min(1).max(500),
};

async function buildAmendment(c, user, i) {
  const { contract, access } = await loadContract(user, i.id, c, { lock: true });
  if (contract.status !== 'active') throw conflict(`Only an active contract can be amended; this one is ${contract.status}`, { code: 'not_active' });
  if (contract.current_version !== i.base_version) throw conflictStale('contract');
  if (!(access.staff.manage || access.role === 'payee' || access.role === 'guardian')) throw forbidden();
  const versions = await versionsOf(c, contract.id);
  const base = versions.find((v) => v.version === contract.current_version);
  const first = versions.find((v) => v.version === 1);
  const t = normaliseTerms(i.terms, { hasTeam: !!contract.team_id });
  if (t.currency !== contract.currency) throw badRequest('The currency of a contract cannot change');
  if (t.starts_on !== first.starts_on) throw badRequest('An amendment cannot move the original start date');
  if (i.effective_from < first.starts_on || i.effective_from > t.ends_on) throw badRequest('The effective date must fall inside the contract term');
  if (i.effective_from < base.effective_from) throw badRequest('An amendment cannot take effect before the version it changes');
  const changes = diffTerms(versionTerms(base), t);
  if (!changes.length) throw badRequest('Nothing changes. Edit at least one term.');
  return { contract, access, versions, base, t, changes, retroactive: i.effective_from < todayIso() };
}

/** Re-price already-earned items under a hypothetical version, to show what a retroactive date would adjust before anyone signs. */
async function retroImpact(c, contract, versions, base, t, effective_from) {
  const hypothetical = { ...base, version: Math.max(...versions.map((v) => v.version)) + 1, status: 'in_force', effective_from, starts_on: t.starts_on, ends_on: t.ends_on, components: t.components, withholding_bp: t.withholding_bp };
  const live = versions.map((v) => (v.status === 'in_force' ? { ...v, status: 'superseded' } : v));
  const was = await expectedEarnings(c, contract, versions);
  const now = await expectedEarnings(c, contract, [...live, hypothetical]);
  let lines = 0, cents = 0;
  for (const k of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(k)?.gross ?? 0, b = now.get(k)?.gross ?? 0;
    if (a !== b) { lines++; cents += b - a; }
  }
  return { earned_lines_repriced: lines, adjustment_cents: cents };
}

async function impactOf(c, built, i) {
  const { contract, access, versions, base, t } = built;
  const ladder = await ladderFor(c, contract.id);
  const eff = i.effective_from > todayIso() ? i.effective_from : todayIso();
  const upcoming = contract.team_id
    ? Number((await c.query("SELECT count(*)::int AS n FROM fixtures f WHERE (f.home_team_id=$1 OR f.away_team_id=$1) AND f.status IN ('scheduled','live') AND f.scheduled_at::date BETWEEN $2 AND $3", [contract.team_id, eff, t.ends_on])).rows[0].n)
    : 0;
  const retro = built.retroactive ? await retroImpact(c, contract, versions, base, t, i.effective_from) : { earned_lines_repriced: 0, adjustment_cents: 0 };
  const increase = t.value_cents - Number(base.value_cents);
  return {
    value_before_cents: Number(base.value_cents), value_after_cents: t.value_cents, value_change_cents: increase,
    upcoming_games_affected: upcoming, ...retro, retroactive: built.retroactive,
    paid_entries_touched: 0, owed_now_cents: Number(ladder.owed_cents),
    finance_approval_needed: await financeNeeded(access.payer, t.value_cents, increase, built.retroactive),
    notes: ['Paid and earned lines are never edited. A change from a past date posts separate adjustment lines with the reason.'],
  };
}

cap({
  name: 'preview_contract_amendment', method: 'POST', path: '/player-contracts/:id/amendments/preview', tag: TAG,
  summary: 'Show what an amendment would change before anyone signs: the field-by-field difference, the change in committed value, upcoming games priced differently, and (for a past effective date) how many already-earned lines would be adjusted. Nothing is saved.',
  input: z.object(amendInput),
  async handler({ user }, i) {
    return tx(async (c) => {
      const built = await buildAmendment(c, user, i);
      return { changes: built.changes, impact: await impactOf(c, built, i) };
    });
  },
});

cap({
  name: 'propose_contract_amendment', method: 'POST', path: '/player-contracts/:id/amendments', tag: TAG, status: 201,
  summary: 'Propose a change as a new version (the person paid, their guardian or the club\'s managers). Only one amendment can be pending: another party\'s proposal while one is pending needs replace_pending=true and counters it. Needs a reason. A past effective date or a large rise in value also needs a finance approver. Version in force and earlier lines are never edited.',
  input: z.object({ ...amendInput, replace_pending: z.boolean().default(false), note: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const built = await buildAmendment(c, user, i);
      const { contract, access, versions, t } = built;
      const pending = pendingOf(versions);
      if (pending) {
        if (!i.replace_pending) throw conflict('Another amendment is already waiting for signatures. Withdraw it, or send replace_pending=true to counter it.', { code: 'amendment_pending', version: pending.version });
        const counter = pending.proposed_by !== user.id;
        await c.query("UPDATE player_contract_versions SET status=$2, decided_at=now(), row_version=row_version+1 WHERE id=$1", [pending.id, counter ? 'countered' : 'withdrawn']);
      }
      const next = Math.max(...versions.map((v) => v.version)) + 1;
      const v = (await c.query(
        `INSERT INTO player_contract_versions(contract_id, version, kind, amendment_types, status, based_on, starts_on, ends_on, effective_from, currency, components, expected_games, withholding_bp, expense_cap_cents, pay_terms_days, value_cents, retroactive, changes, reason, note_enc, proposed_by)
         VALUES ($1,$2,'amendment',$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [contract.id, next, i.amendment_types, contract.current_version, t.starts_on, t.ends_on, i.effective_from, t.currency, JSON.stringify(t.components), t.expected_games, t.withholding_bp, t.expense_cap_cents, t.pay_terms_days, t.value_cents,
          built.retroactive, JSON.stringify(built.changes), i.reason, i.note ? encrypt(i.note, 'player_contract_versions.note') : null, user.id])).rows[0];
      await propose(c, user, contract, v, access, { initial: false });
      if (await settle(c, contract, v)) await activate(c, contract, v, user.id);
      else await notifyParties(c, contract, access, user.id, { kind: 'player_contract_amendment', title: `Amendment proposed: ${contract.title}`, body: `Version ${next} of ${contract.contract_no} changes ${built.changes.slice(0, 3).map((x) => x.label).join(', ')}. Review it under Contracts.`, data: { version: next } });
      await audit(c, user.id, 'propose_contract_amendment', 'player_contracts', contract.id);
      return getView(c, user, contract.id);
    });
  },
});

cap({
  name: 'decide_contract_version', method: 'POST', path: '/contract-versions/:id/decision', tag: TAG,
  summary: 'Sign or decline a version that is waiting for you. You sign for every party you represent on it (the person paid, a guardian, the club, finance); the proposer cannot also give the second-person finance approval unless nobody else has that authority. When the last required party signs the version comes into force and earnings are brought up to date. Repeating a signature changes nothing.',
  input: z.object({ id, decision: z.enum(['sign', 'decline']), comment: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const v = (await c.query('SELECT * FROM player_contract_versions WHERE id=$1', [i.id])).rows[0];
      if (!v) throw notFound('Version');
      const { contract, access } = await loadContract(user, v.contract_id, c, { lock: true });
      const cur = (await c.query('SELECT * FROM player_contract_versions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (cur.status !== 'proposed') {
        // a repeated tap on a version that is already decided is not an error
        if (cur.status === 'in_force' && i.decision === 'sign' && (await c.query('SELECT 1 FROM player_contract_signatures WHERE version_id=$1 AND signer_id=$2', [cur.id, user.id])).rowCount) return getView(c, user, contract.id);
        throw conflict(`That version is ${cur.status}, so it can no longer be signed or declined`, { code: 'not_pending' });
      }
      const parties = (await partiesFor(user, contract, cur, access, c));
      const done = new Set((await c.query('SELECT party FROM player_contract_signatures WHERE version_id=$1', [cur.id])).rows.map((r) => r.party));
      const todo = parties.filter((p) => !done.has(p));
      if (!todo.length) {
        if (parties.length) return getView(c, user, contract.id); // already signed for everything you represent
        throw forbidden('You are not a party who needs to sign this version');
      }
      if (i.decision === 'decline') {
        await c.query("INSERT INTO player_contract_signatures(version_id, party, signer_id, decision, comment) VALUES ($1,$2,$3,'declined',$4) ON CONFLICT (version_id, party) DO NOTHING", [cur.id, todo[0], user.id, i.comment ?? null]);
        await c.query("UPDATE player_contract_versions SET status='declined', decided_at=now(), row_version=row_version+1 WHERE id=$1", [cur.id]);
        if (cur.version === 1) await c.query("UPDATE player_contracts SET status='void', row_version=row_version+1, updated_at=now() WHERE id=$1", [contract.id]);
        await notifyParties(c, contract, access, user.id, { kind: 'player_contract_declined', title: `Declined: ${contract.title}`, body: `Version ${cur.version} of ${contract.contract_no} was declined${i.comment ? `: ${i.comment}` : '.'}` });
      } else {
        for (const p of todo) await c.query("INSERT INTO player_contract_signatures(version_id, party, signer_id, decision, comment) VALUES ($1,$2,$3,'signed',$4) ON CONFLICT (version_id, party) DO NOTHING", [cur.id, p, user.id, i.comment ?? null]);
        if (await settle(c, contract, cur)) {
          await activate(c, contract, cur, user.id);
          await notifyParties(c, contract, access, user.id, { kind: 'player_contract_signed', title: `Signed: ${contract.title}`, body: `Version ${cur.version} of ${contract.contract_no} is now in force.` });
        }
      }
      await audit(c, user.id, `contract_version_${i.decision}`, 'player_contract_versions', cur.id);
      return getView(c, user, contract.id);
    });
  },
});

cap({
  name: 'withdraw_contract_version', method: 'POST', path: '/contract-versions/:id/withdraw', tag: TAG,
  summary: 'Withdraw a version that is still waiting for signatures (its proposer, or the club\'s managers). Withdrawing the first offer voids the contract; a withdrawn amendment leaves the version in force untouched. Kept on record with the reason.',
  input: z.object({ id, reason: z.string().min(1).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const v = (await c.query('SELECT * FROM player_contract_versions WHERE id=$1', [i.id])).rows[0];
      if (!v) throw notFound('Version');
      const { contract, access } = await loadContract(user, v.contract_id, c, { lock: true });
      const cur = (await c.query('SELECT * FROM player_contract_versions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (cur.status !== 'proposed') throw conflict(`That version is ${cur.status}`, { code: 'not_pending' });
      if (cur.proposed_by !== user.id && !access.staff.manage) throw forbidden('Only the proposer or the club\'s managers can withdraw this');
      await c.query("UPDATE player_contract_versions SET status='withdrawn', decided_at=now(), reason=coalesce(reason,'') || CASE WHEN reason IS NULL THEN '' ELSE ' · ' END || 'Withdrawn: ' || left($2, 200), row_version=row_version+1 WHERE id=$1", [cur.id, i.reason]);
      if (cur.version === 1) await c.query("UPDATE player_contracts SET status='void', row_version=row_version+1, updated_at=now() WHERE id=$1", [contract.id]);
      await notifyParties(c, contract, access, user.id, { kind: 'player_contract_withdrawn', title: `Withdrawn: ${contract.title}`, body: `Version ${cur.version} of ${contract.contract_no} was withdrawn: ${i.reason}` });
      await audit(c, user.id, 'withdraw_contract_version', 'player_contract_versions', cur.id);
      return getView(c, user, contract.id);
    });
  },
});

cap({
  name: 'end_player_contract', method: 'POST', path: '/player-contracts/:id/end', tag: TAG,
  summary: 'End an active contract on a date (today or earlier): terminated early, or completed. Pay for the time worked is earned up to that date (a part month is pro-rata) and stays payable; later retention or fixed payments are no longer owed. A pending amendment is withdrawn. The club\'s managers only; the reason is kept.',
  input: z.object({ id, row_version: z.coerce.number().int().min(1), ended_on: z.string().date().optional(), outcome: z.enum(['terminated', 'completed']).default('terminated'), reason: z.string().min(1).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { contract, access } = await loadContract(user, i.id, c, { lock: true });
      if (!access.staff.manage) throw forbidden('Only the team\'s managers can end a contract');
      if (contract.status !== 'active') throw conflict(`This contract is ${contract.status}`);
      if (contract.row_version !== i.row_version) throw conflictStale();
      const on = i.ended_on ?? todayIso();
      const versions = await versionsOf(c, contract.id);
      if (on > todayIso()) throw badRequest('Choose today or an earlier date');
      if (on < versions[0].starts_on) throw badRequest('The end date cannot be before the contract started');
      const pending = pendingOf(versions);
      if (pending) await c.query("UPDATE player_contract_versions SET status='withdrawn', decided_at=now(), row_version=row_version+1 WHERE id=$1", [pending.id]);
      await c.query('UPDATE player_contracts SET status=$2, ended_on=$3, end_reason=$4, row_version=row_version+1, updated_at=now() WHERE id=$1', [contract.id, i.outcome, on, i.reason]);
      await accrueContract(c, contract.id, user.id);
      await notifyParties(c, contract, access, user.id, { kind: 'player_contract_ended', title: `Contract ${i.outcome}: ${contract.title}`, body: `${contract.contract_no} ended on ${on}. Anything already earned stays payable.` });
      await audit(c, user.id, 'end_player_contract', 'player_contracts', contract.id);
      return getView(c, user, contract.id);
    });
  },
});

export { getView, partiesFor, notifyParties, versionAt, committedValue, financeAuthorities, financeNeeded };
