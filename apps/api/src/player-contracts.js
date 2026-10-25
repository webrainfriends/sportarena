// Player contracts (issue #333): terms, versions, access and the earnings engine. Shared by the contract and money capabilities.
//
// Money model. A contract version states what *could* be paid (committed value, never income). Only a verified trigger creates a ledger
// entry: a played game with verified minutes (appearances #322), a goal on the official record, a result, or a due date. A payment entry
// exists only when the club records a transfer. Everything lives in one append-only ledger signed in the payee's favour.
import { z } from 'zod';
import { pool, tx } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { isAdmin } from './helpers.js';
import { hasOrgGrant } from './org-access.js';
import { canManageMoney } from './capabilities/team-management.js';
import { guardianLink, hasConsent, isYouth } from './youth.js';

export const FINANCE_THRESHOLD_CENTS = () => Number(process.env.PLAYER_CONTRACT_FINANCE_THRESHOLD_CENTS ?? 2_500_000);
export const ROLES = ['player', 'coach', 'official', 'scorer', 'volunteer', 'staff', 'other'];
export const KINDS = {
  appearance_fee: { basis: 'per_game', label: 'Appearance fee' },
  start_bonus: { basis: 'per_game', label: 'Start bonus' },
  goal_bonus: { basis: 'per_goal', label: 'Goal bonus' },
  win_bonus: { basis: 'per_win', label: 'Win bonus' },
  monthly: { basis: 'monthly', label: 'Monthly pay' },
  fixed: { basis: 'one_off', dated: true, label: 'Fixed fee' },
  signing_fee: { basis: 'one_off', dated: true, label: 'Signing fee' },
  retention: { basis: 'one_off', dated: true, label: 'Retention bonus' },
  custom: { basis: 'one_off', dated: true, label: 'Other payment' },
};
const PER_GAME = new Set(Object.entries(KINDS).filter(([, k]) => k.basis.startsWith('per_')).map(([n]) => n));

// ------------------------------------------------------------------ dates (ISO yyyy-mm-dd strings, UTC arithmetic)
const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(`${s}T00:00:00Z`);
export const todayIso = () => iso(new Date());
/** A date column read from Postgres (a local-midnight Date) or an ISO string, as yyyy-mm-dd. */
export const dayOf = (v) => (v == null ? null : v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10));
const addDays = (s, n) => iso(new Date(parse(s).getTime() + n * 864e5));
const diffDays = (a, b) => Math.round((parse(b).getTime() - parse(a).getTime()) / 864e5);
export function addMonths(s, n) {
  const d = parse(s);
  const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return iso(t);
}
/** Monthly pay periods inside [startsOn, endsOn], each starting on the same day of the month as the term. The last may be partial. */
export function monthlyPeriods(startsOn, endsOn) {
  const out = [];
  for (let k = 0; k < 600; k++) {
    const from = addMonths(startsOn, k);
    if (from > endsOn) break;
    const nominalTo = addDays(addMonths(startsOn, k + 1), -1);
    out.push({ key: from, from, nominalTo, to: nominalTo < endsOn ? nominalTo : endsOn, fullDays: diffDays(from, nominalTo) + 1 });
  }
  return out;
}

// ------------------------------------------------------------------ terms
const day = z.string().date();
export const componentSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
  kind: z.enum(Object.keys(KINDS)),
  label: z.string().min(1).max(80).optional(),
  amount_cents: z.coerce.number().int().min(1).max(10_000_000_000_000),
  due_on: day.optional(),
});
export const termsSchema = z.object({
  starts_on: day,
  ends_on: day,
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase()),
  components: z.array(componentSchema).min(1).max(30),
  expected_games: z.coerce.number().int().min(0).max(500).default(0),
  withholding_bp: z.coerce.number().int().min(0).max(5000).default(0),
  expense_cap_cents: z.coerce.number().int().min(0).nullable().optional(),
  pay_terms_days: z.coerce.number().int().min(0).max(120).default(7),
});

/** Validate and normalise terms: stable component keys, dated one-offs inside the term, per-game pay only where games exist. */
export function normaliseTerms(t, { hasTeam }) {
  if (t.ends_on < t.starts_on) throw badRequest('The contract cannot end before it starts');
  const seen = new Map();
  const components = t.components.map((c) => {
    const meta = KINDS[c.kind];
    if (PER_GAME.has(c.kind) && !hasTeam) throw badRequest(`${meta.label} is paid per game, so it needs a team contract`);
    const n = (seen.get(c.kind) ?? 0) + 1; seen.set(c.kind, n);
    const key = c.key ?? (n === 1 ? c.kind : `${c.kind}_${n}`);
    let due_on = c.due_on;
    if (meta.dated) {
      due_on ??= c.kind === 'signing_fee' ? t.starts_on : undefined;
      if (!due_on) throw badRequest(`${meta.label} needs a due date`);
      if (due_on < t.starts_on || due_on > t.ends_on) throw badRequest(`${meta.label} must fall inside the contract term`);
    } else if (due_on) throw badRequest(`${meta.label} has no due date`);
    return { key, kind: c.kind, label: c.label ?? meta.label, amount_cents: c.amount_cents, ...(due_on ? { due_on } : {}) };
  });
  const keys = components.map((c) => c.key);
  if (new Set(keys).size !== keys.length) throw badRequest('Two payments share a key; give each a different key');
  const out = { starts_on: t.starts_on, ends_on: t.ends_on, currency: t.currency, components, expected_games: t.expected_games ?? 0, withholding_bp: t.withholding_bp ?? 0, expense_cap_cents: t.expense_cap_cents ?? null, pay_terms_days: t.pay_terms_days ?? 7 };
  out.value_cents = committedValue(out);
  return out;
}

/** What the terms could pay: monthly pay for the term, every one-off, and per-game pay only for the games the club expects. Never income. */
export function committedValue(t) {
  let v = 0;
  for (const c of t.components) {
    if (c.kind === 'monthly') for (const p of monthlyPeriods(t.starts_on, t.ends_on)) v += Math.round(c.amount_cents * (diffDays(p.from, p.to) + 1) / p.fullDays);
    else if (KINDS[c.kind].dated) v += c.amount_cents;
    else if (c.kind === 'appearance_fee' || c.kind === 'start_bonus') v += c.amount_cents * (t.expected_games ?? 0);
  }
  return v;
}

const FIELD_LABELS = { starts_on: 'Start date', ends_on: 'End date', currency: 'Currency', expected_games: 'Expected games', withholding_bp: 'Tax withheld (basis points)', expense_cap_cents: 'Expense cap per claim', pay_terms_days: 'Days to pay' };
/** Field-by-field difference between two sets of terms. `from` may be null for a first version. */
export function diffTerms(from, to) {
  const out = [];
  for (const f of Object.keys(FIELD_LABELS)) if (!from || String(from[f] ?? '') !== String(to[f] ?? '')) out.push({ field: f, label: FIELD_LABELS[f], from: from ? from[f] ?? null : null, to: to[f] ?? null });
  const a = new Map((from?.components ?? []).map((c) => [c.key, c])), b = new Map(to.components.map((c) => [c.key, c]));
  for (const [k, c] of b) {
    const p = a.get(k);
    if (!p) out.push({ field: `component:${k}`, label: c.label, from: null, to: c.amount_cents, change: 'added' });
    else if (p.amount_cents !== c.amount_cents || (p.due_on ?? '') !== (c.due_on ?? '') || p.kind !== c.kind) out.push({ field: `component:${k}`, label: c.label, from: p.amount_cents, to: c.amount_cents, change: 'changed', due_from: p.due_on ?? null, due_to: c.due_on ?? null });
  }
  for (const [k, c] of a) if (!b.has(k)) out.push({ field: `component:${k}`, label: c.label, from: c.amount_cents, to: null, change: 'removed' });
  return out;
}

export const versionTerms = (v) => ({ starts_on: v.starts_on, ends_on: v.ends_on, currency: v.currency, components: v.components, expected_games: v.expected_games, withholding_bp: v.withholding_bp, expense_cap_cents: v.expense_cap_cents == null ? null : Number(v.expense_cap_cents), pay_terms_days: v.pay_terms_days });
export const VERSION_COLS = `id, contract_id, version, kind, amendment_types, status, based_on, starts_on::text AS starts_on, ends_on::text AS ends_on, effective_from::text AS effective_from, currency, components, expected_games, withholding_bp, expense_cap_cents, pay_terms_days, value_cents, required_parties, retroactive, changes, reason, proposed_by, proposed_at, decided_at, row_version, created_at`;

// ------------------------------------------------------------------ who is who
export const db = (c) => c ?? pool;
export async function loadPayer(contract, c) {
  if (contract.team_id) return { type: 'team', row: (await db(c).query('SELECT * FROM teams WHERE id=$1', [contract.team_id])).rows[0] };
  return { type: 'event', row: (await db(c).query('SELECT * FROM events WHERE id=$1', [contract.event_id])).rows[0] };
}
/** Finance-capable people for a payer: the owner and active owner/admin/finance members of the organisation. */
export async function financeAuthorities(payer, c) {
  const orgId = payer.row.organisation_id;
  const ids = new Set([payer.type === 'team' ? payer.row.owner_id : payer.row.organizer_id]);
  if (orgId) for (const r of (await db(c).query("SELECT m.user_id FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.organisation_id=$1 AND m.status='active' AND o.status='active' AND m.role IN ('owner','admin','finance')", [orgId])).rows) ids.add(r.user_id);
  return ids;
}
export async function staffRoleFor(user, payer, c) {
  if (!user) return { manage: false, finance: false };
  if (isAdmin(user)) return { manage: true, finance: true };
  if (payer.type === 'team') {
    const manage = await canManageMoney(user, payer.row);
    const finance = manage && (payer.row.owner_id === user.id || await hasOrgGrant(user, payer.row.organisation_id, ['owner', 'admin', 'finance'], db(c)));
    return { manage, finance };
  }
  const finance = payer.row.organizer_id === user.id || await hasOrgGrant(user, payer.row.organisation_id, ['owner', 'admin', 'finance'], db(c));
  return { manage: finance, finance };
}
/** May this person with finance authority also act on something they prepared? Only when nobody else has that authority. */
export async function isSoleAuthority(user, payer, c) {
  const ids = await financeAuthorities(payer, c);
  return ids.has(user.id) && ids.size === 1;
}

/**
 * How the caller relates to a contract: payee, guardian (of a young payee), staff (manage/finance) or nothing.
 * `null` means "not found" - existence is never revealed to outsiders, and a young person's contract is hidden from staff
 * and from the young person when guardian consent is not current (live revocation).
 */
export async function accessFor(user, contract, c) {
  const youth = await isYouth(contract.payee_id, c);
  const consent = !youth || await hasConsent(contract.payee_id, 'participation', c);
  const payer = await loadPayer(contract, c);
  const guardian = youth && !!(await guardianLink(user.id, contract.payee_id, c));
  const isPayee = user.id === contract.payee_id;
  // conflict of interest: nobody acts as the club on their own pay, or on a young person they are guardian of
  const staff = isPayee || guardian ? { manage: false, finance: false } : await staffRoleFor(user, payer, c);
  if (guardian) return { role: 'guardian', payer, staff, youth, consent, isPayee: false, guardian };
  if (isPayee && consent) return { role: 'payee', payer, staff, youth, consent, isPayee };
  if (staff.manage && consent) return { role: 'staff', payer, staff, youth, consent, isPayee: false };
  return null;
}
export async function loadContract(user, id, c, { lock = false } = {}) {
  const row = (await db(c).query(`SELECT * FROM player_contracts WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!row) throw notFound('Contract');
  const access = await accessFor(user, row, c);
  if (!access || (row.status === 'draft' && access.role !== 'staff')) throw notFound('Contract'); // a draft is the club's until it is sent
  return { contract: row, access };
}
export function mustManage(access, what = 'do that', { finance = false } = {}) {
  const ok = finance ? access.staff.finance : access.staff.manage;
  if (!ok) throw forbidden(finance ? `Only the owner or finance team can ${what}` : `Only the team's managers can ${what}`);
}

// ------------------------------------------------------------------ versions
export async function versionsOf(c, contractId, { all = true } = {}) {
  return (await db(c).query(`SELECT ${VERSION_COLS} FROM player_contract_versions WHERE contract_id=$1 ${all ? '' : "AND status IN ('in_force','superseded')"} ORDER BY version`, [contractId])).rows;
}
/** The version that governs a date: the highest version number whose effective date has arrived. Later agreements override earlier ones from their effective date. */
export function versionAt(versions, d) {
  let best = null;
  for (const v of versions) if ((v.status === 'in_force' || v.status === 'superseded') && v.effective_from <= d && (!best || v.version > best.version)) best = v;
  return best;
}
export const requiredParties = ({ youth, financeNeeded }) => ['team', ...(youth ? ['guardian', 'player'] : ['player']), ...(financeNeeded ? ['finance'] : [])];

// ------------------------------------------------------------------ earnings engine
const entryKey = (o) => `${o.component_key}|${o.source_key}`;

/** What the in-force terms say should have been earned by `today`, keyed by component and source. */
export async function expectedEarnings(c, contract, versions, today = todayIso()) {
  const live = versions.filter((v) => v.status === 'in_force' || v.status === 'superseded');
  const exp = new Map();
  if (!live.length || ['draft', 'offered', 'void'].includes(contract.status)) return exp;
  const first = live[0].starts_on;
  const ended = dayOf(contract.ended_on);
  const put = (v, comp, source_key, gross, occurred_on, label, source_type = null, source_id = null) => {
    exp.set(`${comp.key}|${source_key}`, { component_key: comp.key, source_key, version_no: v.version, gross, bp: v.withholding_bp, occurred_on, label, source_type, source_id });
  };
  const within = (v, d) => d >= first && d <= v.ends_on && (!ended || d <= ended);

  if (contract.team_id) {
    const apps = (await db(c).query(
      `SELECT a.fixture_id, a.status, f.scheduled_at::date::text AS day, f.home_team_id, f.away_team_id, f.home_score, f.away_score, ht.name AS home_name, at.name AS away_name
         FROM match_appearances a JOIN fixtures f ON f.id=a.fixture_id LEFT JOIN teams ht ON ht.id=f.home_team_id LEFT JOIN teams at ON at.id=f.away_team_id
        WHERE a.user_id=$1 AND a.team_id=$2 AND a.archived_at IS NULL AND a.verified_at IS NOT NULL AND a.status IN ('started','substitute_on') AND a.minutes_played > 0 AND f.status='completed'
        ORDER BY f.scheduled_at, f.id`, [contract.payee_id, contract.team_id])).rows;
    const goals = new Map((await db(c).query("SELECT fixture_id, count(*)::int AS n FROM match_events WHERE player_id=$1 AND team_id=$2 AND kind='goal' AND voided_at IS NULL GROUP BY fixture_id", [contract.payee_id, contract.team_id])).rows.map((r) => [r.fixture_id, r.n]));
    for (const a of apps) {
      const v = versionAt(live, a.day);
      if (!v || !within(v, a.day)) continue;
      const mine = a.home_team_id === contract.team_id ? 'home' : 'away';
      const vs = mine === 'home' ? a.away_name : a.home_name;
      const tag = `${vs ? `vs ${vs}` : 'game'}, ${a.day}`;
      const won = a.home_score != null && a.away_score != null && (mine === 'home' ? a.home_score > a.away_score : a.away_score > a.home_score);
      for (const comp of v.components) {
        if (comp.kind === 'appearance_fee') put(v, comp, `fx:${a.fixture_id}`, comp.amount_cents, a.day, `${comp.label} ${tag}`, 'fixture', a.fixture_id);
        else if (comp.kind === 'start_bonus' && a.status === 'started') put(v, comp, `fx:${a.fixture_id}`, comp.amount_cents, a.day, `${comp.label} ${tag}`, 'fixture', a.fixture_id);
        else if (comp.kind === 'win_bonus' && won) put(v, comp, `fx:${a.fixture_id}`, comp.amount_cents, a.day, `${comp.label} ${tag}`, 'fixture', a.fixture_id);
        else if (comp.kind === 'goal_bonus' && goals.get(a.fixture_id)) put(v, comp, `fx:${a.fixture_id}`, comp.amount_cents * goals.get(a.fixture_id), a.day, `${comp.label} x${goals.get(a.fixture_id)} ${tag}`, 'fixture', a.fixture_id);
      }
    }
  }
  // periodic and dated pay, priced by the version in force on the first day of the period / the due date
  const last = live[live.length - 1];
  const horizon = live.reduce((m, v) => (v.ends_on > m ? v.ends_on : m), last.ends_on);
  const keys = new Set(live.flatMap((v) => v.components.filter((c2) => c2.kind === 'monthly' || KINDS[c2.kind].dated).map((c2) => c2.key)));
  for (const key of keys) {
    const sample = live.flatMap((v) => v.components).find((c2) => c2.key === key);
    if (sample.kind === 'monthly') {
      for (const p of monthlyPeriods(first, horizon)) {
        const v = versionAt(live, p.from);
        const comp = v?.components.find((x) => x.key === key);
        if (!v || !comp || p.from > v.ends_on) continue;
        let to = p.to < v.ends_on ? p.to : v.ends_on;
        if (ended && ended < to) to = ended;
        if (ended && p.from > ended) continue;
        if (to > today || to < p.from) continue;
        const days = diffDays(p.from, to) + 1;
        put(v, comp, `mo:${p.key}`, days === p.fullDays ? comp.amount_cents : Math.round(comp.amount_cents * days / p.fullDays), to, `${comp.label} ${p.from} to ${to}`, 'period', null);
      }
    } else {
      // a dated one-off: the version at its due date decides whether it is owed
      const dues = new Set(live.flatMap((v) => v.components.filter((x) => x.key === key).map((x) => x.due_on)));
      for (const due of dues) {
        const v = versionAt(live, due);
        const comp = v?.components.find((x) => x.key === key);
        if (!v || !comp || comp.due_on !== due || due > today || due > v.ends_on || (ended && due > ended)) continue;
        put(v, comp, `due:${due}`, comp.amount_cents, due, `${comp.label}, due ${due}`, 'due_date', null);
      }
    }
  }
  return exp;
}

/**
 * Bring the ledger in line with the terms: post only the difference between what should be earned and what is already posted
 * (fee and withholding each), so it is safe to repeat and a correction (a voided goal, a retro-dated amendment) becomes a
 * compensating entry, never an edit. The contract row is locked for the duration.
 */
export async function accrueContract(c, contractId, actor = null, today = todayIso()) {
  const contract = (await c.query('SELECT * FROM player_contracts WHERE id=$1 FOR UPDATE', [contractId])).rows[0];
  if (!contract) throw notFound('Contract');
  const versions = await versionsOf(c, contractId);
  const expected = await expectedEarnings(c, contract, versions, today);
  const posted = (await c.query(
    `SELECT component_key, source_key, kind, sum(amount_cents)::bigint AS total, count(*)::int AS n, (array_agg(label ORDER BY seq DESC))[1] AS label, (array_agg(source_type ORDER BY seq DESC))[1] AS source_type,
            (array_agg(source_id ORDER BY seq DESC))[1] AS source_id, max(occurred_on)::text AS occurred_on
       FROM player_contract_entries WHERE contract_id=$1 AND kind IN ('fee','withholding') AND source_key IS NOT NULL GROUP BY component_key, source_key, kind`, [contractId])).rows;
  const have = new Map(posted.map((r) => [`${r.component_key}|${r.source_key}|${r.kind}`, r]));
  const keys = new Set([...expected.keys(), ...posted.map((r) => entryKey(r))]);
  let count = 0, net = 0;
  const post = async (e, kind, amount, label, reason, occurred, version_no) => {
    const prior = have.get(`${e.component_key}|${e.source_key}|${kind}`);
    const idem = `${kind === 'fee' ? 'acc' : 'wh'}:${e.component_key}:${e.source_key}:${(prior?.n ?? 0) + 1}`;
    const r = await c.query(
      `INSERT INTO player_contract_entries(contract_id, payee_id, currency, kind, amount_cents, component_key, source_key, source_type, source_id, version_no, occurred_on, label, reason, idem_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (contract_id, idem_key) DO NOTHING RETURNING id`,
      [contractId, contract.payee_id, contract.currency, kind, amount, e.component_key, e.source_key, e.source_type, e.source_id, version_no, occurred, label, reason, idem, actor]);
    if (r.rowCount) { count++; net += amount; }
  };
  for (const k of [...keys].sort()) {
    const e = expected.get(k);
    const f = have.get(`${k}|fee`), w = have.get(`${k}|withholding`);
    const base = e ?? { component_key: (f ?? w).component_key, source_key: (f ?? w).source_key, source_type: (f ?? w).source_type, source_id: (f ?? w).source_id };
    const wantFee = e ? e.gross : 0;
    const haveFee = f ? Number(f.total) : 0;
    const today_ = e?.occurred_on ?? (f ?? w).occurred_on;
    if (wantFee !== haveFee) await post(base, 'fee', wantFee - haveFee, e ? e.label : `Reversed: ${(f ?? w).label}`, e && f ? 'Recalculated from the current terms or record' : e ? null : 'No longer earned under the current terms or record', today_, e?.version_no ?? null);
    const wantWh = e ? -Math.round(e.gross * e.bp / 10000) : 0;
    const haveWh = w ? Number(w.total) : 0;
    if (wantWh !== haveWh) await post(base, 'withholding', wantWh - haveWh, `Tax withheld: ${e ? e.label : (f ?? w).label}`, e && w ? 'Recalculated' : null, today_, e?.version_no ?? null);
  }
  return { posted: count, net_cents: net };
}

/** Sums the ledger into the money ladder. Each figure is one thing; committed value and offers are never included. */
export const LADDER_SQL = `SELECT coalesce(sum(amount_cents) FILTER (WHERE kind='fee'),0)::bigint AS earned_cents,
    coalesce(-sum(amount_cents) FILTER (WHERE kind='withholding'),0)::bigint AS withheld_cents,
    coalesce(sum(amount_cents) FILTER (WHERE kind='expense'),0)::bigint AS expenses_cents,
    coalesce(sum(amount_cents) FILTER (WHERE kind='adjustment'),0)::bigint AS adjustments_cents,
    coalesce(-sum(amount_cents) FILTER (WHERE kind='payment'),0)::bigint AS paid_cents,
    coalesce(sum(amount_cents) FILTER (WHERE kind='refund'),0)::bigint AS refunded_cents,
    coalesce(sum(amount_cents),0)::bigint AS owed_cents
  FROM player_contract_entries`;
export async function ladderFor(c, contractId) {
  return (await db(c).query(`${LADDER_SQL} WHERE contract_id=$1`, [contractId])).rows[0];
}

/** Line-level readiness for paying a contract right now. Each failed check is a code the screens can show; nothing is hidden or dropped. */
export async function readinessFor(c, contract, { access } = {}) {
  const out = [];
  const active = ['active', 'completed', 'terminated'].includes(contract.status) && contract.current_version != null;
  out.push({ code: 'signed', ok: active, message: active ? 'Terms are signed by every party' : 'Waiting for signatures' });
  const youth = await isYouth(contract.payee_id, c);
  const consent = !youth || await hasConsent(contract.payee_id, 'participation', c);
  out.push({ code: 'consent', ok: consent, message: youth ? (consent ? 'Guardian consent is current' : 'Guardian consent is not current') : 'Not needed' });
  const acct = (await db(c).query("SELECT status FROM payout_accounts WHERE owner_id=$1 AND currency=$2 AND status IN ('pending','verified') ORDER BY created_at DESC LIMIT 1", [contract.payee_id, contract.currency])).rows[0];
  out.push({ code: 'bank_account', ok: acct?.status === 'verified', message: !acct ? `No ${contract.currency} bank account added yet` : acct.status === 'verified' ? 'Bank account verified' : 'Bank account is waiting for verification' });
  return out;
}
export const blockFor = (r) => {
  const by = Object.fromEntries(r.map((x) => [x.code, x]));
  if (!by.signed.ok) return { code: 'not_signed', message: by.signed.message };
  if (!by.consent.ok) return { code: 'consent', message: by.consent.message };
  if (by.bank_account.message.startsWith('No ')) return { code: 'no_bank_account', message: by.bank_account.message };
  if (!by.bank_account.ok) return { code: 'account_unverified', message: by.bank_account.message };
  return null;
};

export const conflictStale = (what = 'contract') => conflict(`This ${what} was changed by someone else. Reload to see the latest version, then try again.`, { code: 'stale_version' });

/**
 * Worker step: bring every active contract's earnings up to date from the record, so the club desk and each person's balance are right
 * without anyone opening the contract. Each contract is its own transaction; a failure on one never blocks the others. Returns how many
 * ledger lines were posted.
 */
export async function accrueActiveContracts({ limit = 2000 } = {}) {
  const ids = (await pool.query("SELECT id FROM player_contracts WHERE status='active' ORDER BY id LIMIT $1", [limit])).rows.map((r) => r.id);
  let posted = 0;
  for (const id of ids) {
    try { posted += (await tx((c) => accrueContract(c, id, null))).posted; }
    catch (e) { console.error('[player-contracts] accrual failed for', id, e.message); }
  }
  return posted;
}
