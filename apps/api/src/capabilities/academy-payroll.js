// Academy OS 2/3: staff time and compensation. Timesheets are linked to canonical academy work and keep an immutable history; rules are
// effective-dated and never rewritten; a payroll run is an APPROVED STATEMENT of compensation obligations per period and currency. It moves
// no money and is not statutory payroll (no tax, pension, social-security or filing); pay-out happens outside, or through existing provider
// settlement where that applies. Currencies are never added together.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { isSupportedCurrency, toMajor } from '../currency.js';
import { toCsv } from '../csv.js';
import { notify } from '../notify.js';
import { opsAccess, ruleFor, priceTimesheet } from '../academy-ops.js';

const TAG = 'Academy payroll';
const day = z.string().date();
const dt = z.string().datetime({ offset: true });
const LATE_MIN = 10, EXTRA_MIN = 15;

const event = (c, tsId, action, actor, reason, before, after) => c.query('INSERT INTO academy_timesheet_events(timesheet_id, action, actor_id, reason, before, after) VALUES ($1,$2,$3,$4,$5,$6)', [tsId, action, actor, reason ?? null, before ?? null, after ?? null]);
const snap = (t) => ({ clock_in: t.clock_in, clock_out: t.clock_out, break_min: t.break_min, minutes: t.minutes, status: t.status });
const minutesOf = (inn, out, brk) => Math.max(0, Math.round((new Date(out) - new Date(inn)) / 60000) - (brk ?? 0));

async function tsFor(user, tsId, { write = false, c } = {}) {
  const q = c ?? pool;
  const t = (await q.query(`SELECT * FROM academy_timesheets WHERE id=$1${c ? ' FOR UPDATE' : ''}`, [tsId])).rows[0];
  if (!t) throw notFound('Timesheet');
  const a = await opsAccess(user, t.organisation_id, { write, c });
  const own = t.user_id === user.id;
  if (!own && !a.has('timesheets')) throw notFound('Timesheet');
  return { t, a, own };
}

const exceptions = (t) => {
  const out = [];
  if (t.clock_in && !t.clock_out && t.status === 'open' && new Date(t.clock_in) < new Date(Date.now() - 12 * 3600000)) out.push('missing clock-out');
  if (t.scheduled_start && t.clock_in && new Date(t.clock_in) > new Date(+new Date(t.scheduled_start) + LATE_MIN * 60000)) out.push('late start');
  if (t.scheduled_start && t.scheduled_end && t.minutes != null) {
    const sched = Math.round((new Date(t.scheduled_end) - new Date(t.scheduled_start)) / 60000);
    if (t.minutes > sched + EXTRA_MIN) out.push('extra time'); else if (t.minutes < sched - EXTRA_MIN) out.push('short of schedule');
  }
  return out;
};

// ------------------------------------------------------------------ clock and manual time
cap({
  name: 'clock_in_academy_session', method: 'POST', path: '/academy/sessions/:id/clock-in', tag: TAG, status: 201,
  summary: 'Clock in to a session you are assigned to (from 30 minutes before the start). Creates the timesheet for that session once; repeating the call returns it. No location is collected, and clocking in never marks any athlete present.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = (await c.query('SELECT * FROM academy_sessions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!s) throw notFound('Session');
    await opsAccess(user, s.organisation_id, { write: true, c });
    const st = (await c.query("SELECT role FROM academy_session_staff WHERE session_id=$1 AND user_id=$2 AND status IN ('assigned','confirmed')", [s.id, user.id])).rows[0];
    if (!st) throw forbidden('You are not assigned to this session');
    if (s.status !== 'published') throw conflict('Only published sessions can be clocked into');
    if (Date.now() < +new Date(s.starts_at) - 30 * 60000) throw conflict('You can clock in from 30 minutes before the session');
    if (Date.now() > +new Date(s.ends_at) + 4 * 3600000) throw conflict('This session ended too long ago to clock in. Add a manual entry instead.');
    let t = (await c.query('SELECT * FROM academy_timesheets WHERE session_id=$1 AND user_id=$2 FOR UPDATE', [s.id, user.id])).rows[0];
    if (t?.clock_in) return t;
    const date = s.starts_at.toISOString().slice(0, 10);
    if (!t) {
      t = (await c.query(
        `INSERT INTO academy_timesheets(organisation_id, user_id, session_id, kind, label, work_date, scheduled_start, scheduled_end, role, programme_id, clock_in)
         VALUES ($1,$2,$3,'session',$4,$5,$6,$7,$8,$9,now()) RETURNING *`, [s.organisation_id, user.id, s.id, s.title.slice(0, 80), date, s.starts_at, s.ends_at, st.role, s.programme_id])).rows[0];
      await event(c, t.id, 'created', user.id, null, null, snap(t));
    } else t = (await c.query('UPDATE academy_timesheets SET clock_in=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [t.id])).rows[0];
    await event(c, t.id, 'clock_in', user.id, null, null, { clock_in: t.clock_in });
    return t;
  }),
});

cap({
  name: 'clock_out_academy_session', method: 'POST', path: '/academy/timesheets/:id/clock-out', tag: TAG,
  summary: 'Clock out of your open timesheet (optionally with unpaid break minutes). The worked time is computed and the timesheet is submitted for approval. Repeating it changes nothing.',
  input: z.object({ id, break_min: z.number().int().min(0).max(240).default(0) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { t, own } = await tsFor(user, i.id, { write: true, c });
    if (!own) throw forbidden('You can only clock out of your own timesheet');
    if (t.clock_out) return t;
    if (!t.clock_in) throw conflict('You have not clocked in');
    const out = new Date();
    const row = (await c.query("UPDATE academy_timesheets SET clock_out=$2, break_min=$3, minutes=$4, status='submitted', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [t.id, out, i.break_min, minutesOf(t.clock_in, out, i.break_min)])).rows[0];
    await event(c, t.id, 'clock_out', user.id, null, snap(t), snap(row));
    return row;
  }),
});

cap({
  name: 'submit_academy_timesheet', method: 'POST', path: '/organisations/:id/academy/timesheets', tag: TAG, status: 201,
  summary: 'Enter time by hand: for a session you worked (session_id), a non-session shift (registration desk, safeguarding duty, event support) or other work. Idempotent per idempotency_key. It is submitted for approval; owners/admins (timesheets access) can enter on behalf of someone with user_id.',
  input: z.object({ id, idempotency_key: z.string().min(8).max(80), user_id: id.optional(), session_id: id.optional(), shift_id: id.optional(), kind: z.enum(['shift', 'manual']).default('shift'), label: z.string().trim().min(2).max(80).optional(), clock_in: dt, clock_out: dt, break_min: z.number().int().min(0).max(240).default(0), role: z.enum(['lead', 'assistant', 'duty', 'other']).default('assistant'), programme_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await opsAccess(user, i.id, { write: true, c });
    const who = i.user_id ?? user.id;
    if (who !== user.id) a.need('timesheets');
    const prior = (await c.query('SELECT * FROM academy_timesheets WHERE user_id=$1 AND idempotency_key=$2', [who, i.idempotency_key])).rows[0];
    if (prior) return prior;
    if (new Date(i.clock_out) <= new Date(i.clock_in)) throw badRequest('The end is before the start');
    if (+new Date(i.clock_out) - +new Date(i.clock_in) > 16 * 3600000) throw badRequest('A single entry cannot be longer than 16 hours');
    if (new Date(i.clock_out) > new Date(Date.now() + 5 * 60000)) throw badRequest('You cannot enter time that has not happened yet');
    if (!(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, who])).rowCount) throw badRequest('Not an active member');
    let s = null, role = i.role, programme = i.programme_id ?? null, kind = i.kind;
    if (i.session_id) {
      s = (await c.query('SELECT * FROM academy_sessions WHERE id=$1 AND organisation_id=$2', [i.session_id, i.id])).rows[0];
      if (!s) throw notFound('Session');
      const st = (await c.query("SELECT role FROM academy_session_staff WHERE session_id=$1 AND user_id=$2 AND status IN ('assigned','confirmed')", [s.id, who])).rows[0];
      if (!st) throw badRequest('That person is not assigned to the session');
      if ((await c.query('SELECT 1 FROM academy_timesheets WHERE session_id=$1 AND user_id=$2', [s.id, who])).rowCount) throw conflict('A timesheet already exists for this session. Adjust it instead.');
      role = st.role; programme = s.programme_id; kind = 'session';
    }
    let sh = null;
    if (i.shift_id) {
      sh = (await c.query("SELECT * FROM academy_shifts WHERE id=$1 AND organisation_id=$2 AND user_id=$3 AND status IN ('assigned','confirmed')", [i.shift_id, i.id, who])).rows[0];
      if (!sh) throw notFound('Shift');
      if ((await c.query('SELECT 1 FROM academy_timesheets WHERE shift_id=$1 AND user_id=$2', [sh.id, who])).rowCount) throw conflict('A timesheet already exists for this shift. Adjust it instead.');
      role = 'duty'; programme = sh.programme_id; kind = 'shift';
    }
    const minutes = minutesOf(i.clock_in, i.clock_out, i.break_min);
    const t = (await c.query(
      `INSERT INTO academy_timesheets(organisation_id, user_id, session_id, shift_id, kind, label, work_date, scheduled_start, scheduled_end, clock_in, clock_out, break_min, minutes, role, programme_id, status, idempotency_key)
       VALUES ($1,$2,$3,$16,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'submitted',$15) RETURNING *`,
      [i.id, who, s?.id ?? null, kind, i.label ?? s?.title?.slice(0, 80) ?? sh?.title ?? null, i.clock_in.slice(0, 10), s?.starts_at ?? sh?.starts_at ?? null, s?.ends_at ?? sh?.ends_at ?? null, i.clock_in, i.clock_out, i.break_min, minutes, role === 'other' ? 'assistant' : role, programme, i.idempotency_key, sh?.id ?? null])).rows[0];
    await event(c, t.id, 'created', user.id, who === user.id ? null : 'entered on behalf', null, snap(t));
    await event(c, t.id, 'submitted', user.id, null, null, snap(t));
    return t;
  }),
});

cap({
  name: 'adjust_academy_timesheet', method: 'POST', path: '/academy/timesheets/:id/adjust', tag: TAG,
  summary: 'Correct times or break minutes, always with a reason. The person themselves can correct before approval; managers (timesheets access) can correct any unapproved timesheet. The before/after is kept in the immutable history and the timesheet goes back to submitted. An approved timesheet must be reopened first (and cannot be once it is in an approved payroll run).',
  input: z.object({ id, row_version: z.number().int(), reason: z.string().trim().min(3).max(300), clock_in: dt.optional(), clock_out: dt.optional(), break_min: z.number().int().min(0).max(240).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { t } = await tsFor(user, i.id, { write: true, c });
    if (t.row_version !== i.row_version) throw conflict('This timesheet was changed by someone else. Reload and try again.', { row_version: t.row_version });
    if (t.status === 'approved') throw conflict('This timesheet is approved. Reopen it first.');
    const inn = i.clock_in ?? t.clock_in, out = i.clock_out ?? t.clock_out, brk = i.break_min ?? t.break_min;
    if (!inn || !out) throw badRequest('Both start and end are needed');
    if (new Date(out) <= new Date(inn)) throw badRequest('The end is before the start');
    const row = (await c.query("UPDATE academy_timesheets SET clock_in=$2, clock_out=$3, break_min=$4, minutes=$5, status='submitted', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [t.id, inn, out, brk, minutesOf(inn, out, brk)])).rows[0];
    await event(c, t.id, 'adjusted', user.id, i.reason, snap(t), snap(row));
    await audit(c, user.id, 'adjust_academy_timesheet', 'academy_timesheets', t.id);
    return row;
  }),
});

cap({
  name: 'decide_academy_timesheet', method: 'POST', path: '/academy/timesheets/:id/decision', tag: TAG,
  summary: 'Approve, reject, or reopen an approved timesheet (timesheets access; never your own). Every decision is appended to the immutable history; an approved timesheet in an approved payroll run is frozen by the database and cannot be reopened.',
  input: z.object({ id, action: z.enum(['approve', 'reject', 'reopen']), reason: z.string().trim().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { t, a } = await tsFor(user, i.id, { write: true, c });
    a.need('timesheets');
    if (t.user_id === user.id) throw forbidden('You cannot approve your own timesheet');
    if ((i.action === 'reject' || i.action === 'reopen') && !i.reason) throw badRequest('Say why');
    const next = { approve: 'approved', reject: 'rejected', reopen: 'submitted' }[i.action];
    const from = { approve: ['submitted'], reject: ['submitted'], reopen: ['approved'] }[i.action];
    if (t.status === next && i.action !== 'reopen') return t;
    if (!from.includes(t.status)) throw conflict(`A ${t.status} timesheet cannot be ${next}`);
    if (i.action === 'approve' && (t.minutes == null || !t.clock_out)) throw conflict('This timesheet has no finished time to approve');
    if (t.payroll_run_id) throw conflict('This timesheet is part of a payroll run');
    const row = (await c.query('UPDATE academy_timesheets SET status=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [t.id, next])).rows[0];
    await event(c, t.id, i.action === 'approve' ? 'approved' : i.action === 'reject' ? 'rejected' : 'reopened', user.id, i.reason, snap(t), snap(row));
    await audit(c, user.id, `${i.action}_academy_timesheet`, 'academy_timesheets', t.id);
    await notify(c, t.user_id, { kind: 'academy_timesheet_decision', title: i.action === 'approve' ? 'Timesheet approved' : i.action === 'reject' ? 'Timesheet needs changes' : 'Timesheet reopened', body: 'Open Gotmygame for details.', data: { timesheet_id: t.id }, dedupe_key: `academy-ts:${t.id}:${row.row_version}` });
    return row;
  }),
});

cap({
  name: 'list_academy_timesheets', method: 'GET', path: '/organisations/:id/academy/timesheets', tag: TAG,
  summary: 'Timesheets for review (timesheets access: everyone\'s; otherwise only your own) with exceptions (late start, extra time, short, missing clock-out). Filter by status, person or date range.',
  input: z.object({ id, status: z.enum(['open', 'submitted', 'approved', 'rejected']).optional(), user_id: id.optional(), from: day.optional(), to: day.optional(), ...page, limit: z.coerce.number().int().min(1).max(200).default(100) }),
  async handler({ user }, i) {
    const a = await opsAccess(user, i.id);
    const all = a.has('timesheets');
    const rows = await many(
      `SELECT t.*, u.display_name FROM academy_timesheets t JOIN users u ON u.id=t.user_id
        WHERE t.organisation_id=$1 AND ($2 OR t.user_id=$3) AND ($4::text IS NULL OR t.status=$4) AND ($5::uuid IS NULL OR t.user_id=$5) AND ($6::date IS NULL OR t.work_date >= $6) AND ($7::date IS NULL OR t.work_date <= $7)
        ORDER BY t.work_date DESC, t.created_at DESC, t.id LIMIT $8 OFFSET $9`, [i.id, all, user.id, i.status ?? null, i.user_id ?? null, i.from ?? null, i.to ?? null, i.limit, i.offset]);
    return rows.map((t) => ({ ...t, exceptions: exceptions(t) }));
  },
});

cap({
  name: 'get_academy_timesheet', method: 'GET', path: '/academy/timesheets/:id', tag: TAG,
  summary: 'One timesheet with its full append-only history (who changed what, when and why).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { t } = await tsFor(user, i.id);
    const events = await many('SELECT e.action, e.reason, e.before, e.after, e.created_at, u.display_name AS by FROM academy_timesheet_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.timesheet_id=$1 ORDER BY e.created_at, e.id', [t.id]);
    return { ...t, exceptions: exceptions(t), events };
  },
});

// ------------------------------------------------------------------ compensation rules
cap({
  name: 'set_academy_comp_rule', method: 'POST', path: '/organisations/:id/academy/comp-rules', tag: TAG, status: 201,
  summary: 'Add a compensation term for a person: hourly, per session, day rate, fixed per programme, or volunteer (unpaid), optionally per role / programme, with an overtime multiplier for hourly work beyond the scheduled time. Terms are versioned by effective date: a change adds a new version and can never reach back into a period that has an approved payroll run.',
  input: z.object({ id, user_id: id, role: z.enum(['any', 'lead', 'assistant', 'duty']).default('any'), programme_id: id.optional(), model: z.enum(['hourly', 'per_session', 'day_rate', 'programme_fixed', 'volunteer']), rate_minor: z.number().int().min(0).max(100000000).default(0), currency: z.string().length(3), overtime_multiplier: z.number().min(1).max(4).default(1), effective_from: day, note: z.string().max(200).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await opsAccess(user, i.id, { write: true, c });
    a.need('payroll');
    if (!isSupportedCurrency(i.currency)) throw badRequest('Unsupported currency');
    if (i.model !== 'volunteer' && i.rate_minor <= 0) throw badRequest('Give the rate');
    if (!(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, i.user_id])).rowCount) throw badRequest('Not an active member');
    const frozen = (await c.query("SELECT max(period_end) AS d FROM academy_payroll_runs WHERE organisation_id=$1 AND status='approved'", [i.id])).rows[0].d;
    if (frozen && i.effective_from <= (frozen.toISOString?.().slice(0, 10) ?? String(frozen).slice(0, 10))) throw conflict('Terms cannot start inside a period that already has an approved payroll run', { latest_approved_period_end: frozen });
    try {
      const r = (await c.query(
        `INSERT INTO academy_comp_rules(organisation_id, user_id, role, programme_id, model, rate_minor, currency, overtime_bp, effective_from, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [i.id, i.user_id, i.role, i.programme_id ?? null, i.model, i.model === 'volunteer' ? 0 : i.rate_minor, i.currency.toUpperCase(), Math.round(i.overtime_multiplier * 10000), i.effective_from, i.note ?? null, user.id])).rows[0];
      await audit(c, user.id, 'set_academy_comp_rule', 'academy_comp_rules', r.id);
      return r;
    } catch (e) { if (e.code === '23505') throw conflict('There is already a term for that person, role and programme from that date. Choose a later date.'); throw e; }
  }),
});

cap({
  name: 'list_academy_comp_rules', method: 'GET', path: '/organisations/:id/academy/comp-rules', tag: TAG,
  summary: 'Compensation terms (payroll access: everyone\'s; anyone else sees only their own), newest version first.',
  input: z.object({ id, user_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const a = await opsAccess(user, i.id);
    const all = a.has('payroll');
    return many(
      `SELECT r.*, u.display_name, p.title AS programme FROM academy_comp_rules r JOIN users u ON u.id=r.user_id LEFT JOIN academy_programmes p ON p.id=r.programme_id
        WHERE r.organisation_id=$1 AND ($2 OR r.user_id=$3) AND ($4::uuid IS NULL OR r.user_id=$4) ORDER BY r.effective_from DESC, r.created_at DESC, r.id LIMIT $5 OFFSET $6`, [i.id, all, user.id, i.user_id ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'add_academy_pay_adjustment', method: 'POST', path: '/organisations/:id/academy/pay-adjustments', tag: TAG, status: 201,
  summary: 'Record a bonus, allowance or deduction with a reason (payroll access). It is included in the next payroll run for that currency and period; once a run is approved it is frozen.',
  input: z.object({ id, user_id: id, amount_minor: z.number().int().refine((n) => n !== 0, 'Amount cannot be zero'), currency: z.string().length(3), reason: z.string().trim().min(3).max(200), on_date: day }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await opsAccess(user, i.id, { write: true, c });
    a.need('payroll');
    if (!isSupportedCurrency(i.currency)) throw badRequest('Unsupported currency');
    if (!(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, i.user_id])).rowCount) throw badRequest('Not an active member');
    const r = (await c.query('INSERT INTO academy_pay_adjustments(organisation_id, user_id, amount_minor, currency, reason, on_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [i.id, i.user_id, i.amount_minor, i.currency.toUpperCase(), i.reason, i.on_date, user.id])).rows[0];
    await audit(c, user.id, 'add_academy_pay_adjustment', 'academy_pay_adjustments', r.id);
    return r;
  }),
});

// ------------------------------------------------------------------ payroll runs
async function compute(c, orgId, currency, from, to) {
  const sheets = (await c.query(
    `SELECT t.*, u.display_name FROM academy_timesheets t JOIN users u ON u.id=t.user_id
      WHERE t.organisation_id=$1 AND t.status='approved' AND t.payroll_run_id IS NULL AND t.work_date BETWEEN $2 AND $3 ORDER BY t.user_id, t.work_date, t.id`, [orgId, from, to])).rows;
  const lines = new Map(), unpriced = [], seenDay = new Set(), seenFixed = new Set();
  const line = (uid, name) => { if (!lines.has(uid)) lines.set(uid, { user_id: uid, display_name: name, minutes: 0, scheduled_minutes: 0, sessions: 0, base_minor: 0, adjustments_minor: 0, detail: [] }); return lines.get(uid); };
  for (const t of sheets) {
    const wd = t.work_date.toISOString?.().slice(0, 10) ?? String(t.work_date).slice(0, 10);
    const rule = await ruleFor(c, orgId, t.user_id, t.role, t.programme_id, wd);
    if (!rule) { unpriced.push({ timesheet_id: t.id, user_id: t.user_id, display_name: t.display_name, work_date: wd, reason: 'no compensation term in force on that date' }); continue; }
    if (rule.currency !== currency) { unpriced.push({ timesheet_id: t.id, user_id: t.user_id, display_name: t.display_name, work_date: wd, reason: `paid in ${rule.currency}; run it in a ${rule.currency} payroll run`, currency: rule.currency }); continue; }
    const p = priceTimesheet(rule, t);
    let amount = p.amount, basis = p.basis;
    if (p.day) { const k = `${t.user_id}|${wd}|${rule.id}`; amount = seenDay.has(k) ? 0 : Number(rule.rate_minor); seenDay.add(k); basis = amount ? 'day rate' : 'day rate (already counted)'; }
    if (p.fixed != null) { const k = `${t.user_id}|${t.programme_id}|${rule.id}`; amount = seenFixed.has(k) ? 0 : p.fixed; seenFixed.add(k); basis = amount ? 'fixed programme amount' : 'fixed programme amount (already counted)'; }
    const l = line(t.user_id, t.display_name);
    l.minutes += t.minutes ?? 0;
    l.scheduled_minutes += t.scheduled_start && t.scheduled_end ? Math.round((new Date(t.scheduled_end) - new Date(t.scheduled_start)) / 60000) : 0;
    l.sessions += t.session_id ? 1 : 0;
    l.base_minor += amount;
    l.detail.push({ timesheet_id: t.id, work_date: wd, minutes: t.minutes, rule_id: rule.id, rule_effective_from: rule.effective_from, model: rule.model, rate_minor: Number(rule.rate_minor), amount_minor: amount, basis });
  }
  const adj = (await c.query(
    `SELECT a.*, u.display_name FROM academy_pay_adjustments a JOIN users u ON u.id=a.user_id WHERE a.organisation_id=$1 AND a.currency=$2 AND a.payroll_run_id IS NULL AND a.on_date BETWEEN $3 AND $4 ORDER BY a.user_id, a.on_date, a.id`, [orgId, currency, from, to])).rows;
  for (const a of adj) { const l = line(a.user_id, a.display_name); l.adjustments_minor += Number(a.amount_minor); l.detail.push({ adjustment_id: a.id, on_date: a.on_date, amount_minor: Number(a.amount_minor), basis: a.reason }); }
  const out = [...lines.values()].map((l) => ({ ...l, gross_minor: l.base_minor + l.adjustments_minor, paid_minor: 0, outstanding_minor: l.base_minor + l.adjustments_minor })).sort((x, y) => x.display_name.localeCompare(y.display_name) || x.user_id.localeCompare(y.user_id));
  return { lines: out, unpriced, total_minor: out.reduce((n, l) => n + l.gross_minor, 0), timesheet_ids: sheets.filter((t) => !unpriced.some((u) => u.timesheet_id === t.id)).map((t) => t.id), adjustment_ids: adj.map((a) => a.id) };
}

const runView = async (c, run) => {
  const lines = (await c.query('SELECT l.*, u.display_name, e.staff_ref, e.engagement_type FROM academy_payroll_lines l JOIN users u ON u.id=l.user_id LEFT JOIN org_staff_engagements e ON e.organisation_id=$2 AND e.user_id=l.user_id WHERE l.run_id=$1 ORDER BY u.display_name, l.user_id', [run.id, run.organisation_id])).rows;
  return { ...run, lines: lines.map((l) => ({ ...l, outstanding_minor: Number(l.gross_minor) - Number(l.paid_minor) })), limitations: 'A statement of compensation obligations only. It does not calculate tax, pension, social security or statutory deductions and moves no money.' };
};

cap({
  name: 'create_academy_payroll_run', method: 'POST', path: '/organisations/:id/academy/payroll', tag: TAG, status: 201,
  summary: 'Compute compensation for one period and ONE currency from approved timesheets and effective-dated terms (scheduled vs worked minutes, base, approved adjustments, gross, paid, outstanding). commit:false previews; commit:true creates a draft run and reserves its timesheets. Idempotent per idempotency_key. Approved timesheets with no term, or paid in another currency, are listed as unpriced, never converted or added.',
  input: z.object({ id, currency: z.string().length(3), period_start: day, period_end: day, idempotency_key: z.string().min(8).max(80), commit: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await opsAccess(user, i.id, { write: true, c });
    a.need('payroll');
    const cur = i.currency.toUpperCase();
    if (!isSupportedCurrency(cur)) throw badRequest('Unsupported currency');
    if (i.period_end < i.period_start) throw badRequest('The period ends before it starts');
    await c.query('SELECT id FROM organisations WHERE id=$1 FOR UPDATE', [i.id]);
    const prior = (await c.query('SELECT * FROM academy_payroll_runs WHERE organisation_id=$1 AND idempotency_key=$2', [i.id, i.idempotency_key])).rows[0];
    if (prior) return { ...(await runView(c, prior)), replayed: true };
    const r = await compute(c, i.id, cur, i.period_start, i.period_end);
    if (!i.commit) return { preview: true, currency: cur, period_start: i.period_start, period_end: i.period_end, total_minor: r.total_minor, lines: r.lines, unpriced: r.unpriced };
    if (!r.lines.length) throw conflict('Nothing to pay in that period and currency', { unpriced: r.unpriced });
    const run = (await c.query('INSERT INTO academy_payroll_runs(organisation_id, currency, period_start, period_end, idempotency_key, total_minor, unpriced, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [i.id, cur, i.period_start, i.period_end, i.idempotency_key, r.total_minor, JSON.stringify(r.unpriced), user.id])).rows[0];
    for (const l of r.lines) await c.query('INSERT INTO academy_payroll_lines(run_id, user_id, minutes, scheduled_minutes, sessions, base_minor, adjustments_minor, gross_minor, paid_minor, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9)', [run.id, l.user_id, l.minutes, l.scheduled_minutes, l.sessions, l.base_minor, l.adjustments_minor, l.gross_minor, JSON.stringify(l.detail)]);
    await c.query('UPDATE academy_timesheets SET payroll_run_id=$1 WHERE id = ANY($2)', [run.id, r.timesheet_ids]);
    await c.query('UPDATE academy_pay_adjustments SET payroll_run_id=$1 WHERE id = ANY($2)', [run.id, r.adjustment_ids]);
    await audit(c, user.id, 'create_academy_payroll_run', 'academy_payroll_runs', run.id);
    return { ...(await runView(c, run)), replayed: false };
  }),
});

cap({
  name: 'approve_academy_payroll_run', method: 'POST', path: '/academy/payroll/:id/approve', tag: TAG,
  summary: 'Approve a draft payroll run (payroll access, current row_version). Approved runs and their timesheets are frozen by the database; repeating the approval returns the approved run.',
  input: z.object({ id, row_version: z.number().int() }),
  handler: ({ user }, i) => tx(async (c) => {
    const run = (await c.query('SELECT * FROM academy_payroll_runs WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!run) throw notFound('Payroll run');
    const a = await opsAccess(user, run.organisation_id, { write: true, c });
    a.need('payroll');
    if (run.status === 'approved') return runView(c, run);
    if (run.status !== 'draft') throw conflict(`A ${run.status} run cannot be approved`);
    if (run.row_version !== i.row_version) throw conflict('This run was changed. Reload and try again.', { row_version: run.row_version });
    const next = (await c.query("UPDATE academy_payroll_runs SET status='approved', approved_by=$2, approved_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *", [run.id, user.id])).rows[0];
    await audit(c, user.id, 'approve_academy_payroll_run', 'academy_payroll_runs', run.id);
    return runView(c, next);
  }),
});

cap({
  name: 'void_academy_payroll_run', method: 'POST', path: '/academy/payroll/:id/void', tag: TAG,
  summary: 'Discard a DRAFT run (payroll access). Its timesheets and adjustments are released for a new run; the run itself stays in the history as void. An approved run cannot be voided.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const run = (await c.query('SELECT * FROM academy_payroll_runs WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!run) throw notFound('Payroll run');
    (await opsAccess(user, run.organisation_id, { write: true, c })).need('payroll');
    if (run.status !== 'draft') throw conflict(`A ${run.status} run cannot be voided`);
    await c.query('UPDATE academy_timesheets SET payroll_run_id=NULL WHERE payroll_run_id=$1', [run.id]);
    await c.query('UPDATE academy_pay_adjustments SET payroll_run_id=NULL WHERE payroll_run_id=$1', [run.id]);
    await c.query("UPDATE academy_payroll_runs SET status='void', row_version=row_version+1 WHERE id=$1", [run.id]);
    await audit(c, user.id, 'void_academy_payroll_run', 'academy_payroll_runs', run.id);
    return { ok: true };
  }),
});

cap({
  name: 'list_academy_payroll_runs', method: 'GET', path: '/organisations/:id/academy/payroll', tag: TAG,
  summary: 'Payroll runs for the organisation (payroll access), newest first. Totals are per run, each in its own currency.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    (await opsAccess(user, i.id)).need('payroll');
    return many('SELECT r.*, (SELECT count(*)::int FROM academy_payroll_lines l WHERE l.run_id=r.id) AS people FROM academy_payroll_runs r WHERE r.organisation_id=$1 ORDER BY r.period_end DESC, r.created_at DESC, r.id LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset]);
  },
});

cap({
  name: 'get_academy_payroll_run', method: 'GET', path: '/academy/payroll/:id', tag: TAG,
  summary: 'A payroll run with every person\'s minutes, base, adjustments, gross, paid and outstanding, the rule version used for each timesheet, and what could not be priced.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const run = await one('SELECT * FROM academy_payroll_runs WHERE id=$1', [i.id]);
    if (!run) throw notFound('Payroll run');
    (await opsAccess(user, run.organisation_id)).need('payroll');
    return runView(pool, run);
  },
});

cap({
  name: 'export_academy_payroll_run', method: 'GET', path: '/academy/payroll/:id/export', tag: TAG,
  summary: 'CSV of an APPROVED run for finance review or external payroll/bank processing (name, staff reference, engagement type, scheduled and worked hours, sessions, base, adjustments, gross, paid, outstanding, currency, period). Only people with payroll access; every export is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const run = await one('SELECT * FROM academy_payroll_runs WHERE id=$1', [i.id]);
    if (!run) throw notFound('Payroll run');
    (await opsAccess(user, run.organisation_id)).need('payroll');
    if (run.status !== 'approved') throw conflict('Only an approved run can be exported');
    const v = await runView(pool, run);
    const major = (m) => toMajor(Number(m), run.currency);
    const rows = v.lines.map((l) => ({ name: l.display_name, staff_ref: l.staff_ref ?? '', engagement: l.engagement_type ?? '', scheduled_hours: (l.scheduled_minutes / 60).toFixed(2), worked_hours: (l.minutes / 60).toFixed(2), sessions: l.sessions, base: major(l.base_minor), adjustments: major(l.adjustments_minor), gross: major(l.gross_minor), paid: major(l.paid_minor), outstanding: major(l.outstanding_minor), currency: run.currency, period_start: run.period_start.toISOString?.().slice(0, 10) ?? run.period_start, period_end: run.period_end.toISOString?.().slice(0, 10) ?? run.period_end }));
    await pool.query('UPDATE academy_payroll_runs SET exported_at=now() WHERE id=$1', [run.id]);
    await audit(null, user.id, 'export_academy_payroll', 'academy_payroll_runs', run.id);
    return { filename: `academy-payroll-${rows[0]?.period_start ?? ''}-${run.currency}.csv`, rows: rows.length, csv: toCsv(['name', 'staff_ref', 'engagement', 'scheduled_hours', 'worked_hours', 'sessions', 'base', 'adjustments', 'gross', 'paid', 'outstanding', 'currency', 'period_start', 'period_end'], rows) };
  },
});

cap({
  name: 'list_my_academy_statements', method: 'GET', path: '/me/academy/statements', tag: TAG,
  summary: 'Your own approved pay statements (minutes, base, adjustments, gross, outstanding per run). Nobody else\'s figures and nothing from a draft run are returned.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT r.id AS run_id, r.organisation_id, o.name AS organisation, r.currency, r.period_start, r.period_end, l.minutes, l.scheduled_minutes, l.sessions, l.base_minor, l.adjustments_minor, l.gross_minor, l.paid_minor, (l.gross_minor - l.paid_minor) AS outstanding_minor, l.detail
       FROM academy_payroll_lines l JOIN academy_payroll_runs r ON r.id=l.run_id AND r.status='approved' JOIN organisations o ON o.id=r.organisation_id
      WHERE l.user_id=$1 ORDER BY r.period_end DESC, r.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});
