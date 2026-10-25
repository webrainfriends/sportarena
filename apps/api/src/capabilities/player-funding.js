// Player funding workspace (#334): one place where a player (or a young player's guardian, or a coach they chose) sees sponsorship applications,
// awarded support, funding needs, dues, goods, and what to do next. It is a read model over the canonical sponsorship tables (reused through the
// beneficiary-portfolio SQL, so totals reconcile with #292 and with every agreement); the only data it owns are the needs, their links and the shares.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { toCsv } from '../csv.js';
import { requireConsent } from '../youth.js';
import { RELATIONSHIP_SQL } from '../coaching.js';
import { accessBlock, reasonText } from '../wellness-sharing.js';
import { chain, shapeMoney } from '../beneficiary-portfolio.js';
import { CATEGORIES, PURPOSES, SECTIONS, SECURED_DEAL, coverage, linksFor, requireOwner, resolveAccess, shareBlock, shareEvent, shareState } from '../player-funding.js';
import { obligationRows } from './sponsorship-agreements.js';

const TAG = 'Player funding';
const day = z.string().date();
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const currency = z.string().length(3).transform((s) => s.toUpperCase()).refine((s) => /^[A-Z]{3}$/.test(s), 'Use a three-letter currency code');
const amount = z.coerce.number().int().min(1).max(100_000_000_000).describe('amount in minor units (cents/paise) of the stated currency');
const sections = z.array(z.enum(SECTIONS)).min(1).max(SECTIONS.length).describe('what the coach may see: needs, applications, support (agreements and their terms), dues (what is due, paid and confirmed)');
const NOTE = 'athlete_funding_needs.note';
/** Minor units in their own currency, e.g. 50000 SGD -> "SGD 500.00" (labels only: every API amount stays an integer in minor units). */
const fmt = (cents, cur) => { try { const f = new Intl.NumberFormat('en', { style: 'currency', currency: cur, currencyDisplay: 'code' }); return f.format(Number(cents) / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur}`; } };
const ymd = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);

// ------------------------------------------------------------------ needs

const NEED_COLS = 'n.id, n.athlete_id, n.category, n.title, n.amount_cents, n.currency, n.needed_by::text AS needed_by, n.note_enc, n.status, n.rev, n.created_at, n.updated_at, n.withdrawn_at';

/** A need with its live links and what they cover. The note is personal free text: decrypted only for the owner side. */
async function needViews(c, rows, { note }) {
  const links = await linksFor(c, rows.map((r) => r.id));
  return rows.map((r) => {
    const own = links.filter((l) => l.need_id === r.id);
    const cov = r.status === 'open' ? coverage(r, own) : { secured_cents: 0, pending_cents: 0, gap_cents: 0, met: false };
    const { note_enc, ...rest } = r;
    return {
      ...rest, amount_cents: Number(r.amount_cents), ...cov,
      ...(note ? { note: note_enc ? decrypt(note_enc, NOTE) : null } : {}),
      links: own.map((l) => ({ id: l.id, kind: l.application_id ? 'application' : 'agreement', application_id: l.application_id, sponsorship_id: l.sponsorship_id, label: l.label, state: l.state, allocated_cents: Number(l.allocated_cents), counted_cents: Number(l.counted_cents) })),
      source: { type: 'athlete_funding_need', id: r.id },
    };
  });
}
const needView = async (c, needId, opts = { note: true }) => (await needViews(c, (await c.query(`SELECT ${NEED_COLS} FROM athlete_funding_needs n WHERE n.id=$1`, [needId])).rows, opts))[0];

const lockNeed = async (c, user, needId) => {
  const n = (await c.query('SELECT * FROM athlete_funding_needs WHERE id=$1 FOR UPDATE', [needId])).rows[0];
  if (!n) throw notFound('Funding need');
  const role = await requireOwner(c, user, n.athlete_id);
  return { n, role };
};
const stale = (n, rev) => { if (n.rev !== rev) throw conflict('This need changed since you opened it. Reload and try again.', { code: 'stale_version', rev: n.rev }); };

cap({
  name: 'create_funding_need', method: 'POST', path: '/funding-needs', tag: TAG, status: 201,
  summary: 'Record what you need funded: a category, a title, an amount in its own currency and an optional date it is needed by. The athlete or a verified guardian of a young athlete. Send a client_key so a retry returns the same need instead of a second one. A need is private to you (and your guardian) until you share the workspace with a coach.',
  input: z.object({ athlete_id: id.optional().describe('a guardian names the young athlete; omitted = yourself'), category: z.enum(CATEGORIES), title: z.string().trim().min(1).max(120), amount_cents: amount, currency, needed_by: day.optional(), note: z.string().trim().max(500).optional(), client_key: z.string().min(8).max(64) }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    return tx(async (c) => {
      await requireOwner(c, user, athleteId);
      if (i.needed_by && i.needed_by < today()) throw badRequest('The date it is needed by is in the past');
      await c.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [athleteId]); // serialises this athlete's creates (the cap below and the key)
      const prior = (await c.query(`SELECT ${NEED_COLS} FROM athlete_funding_needs n WHERE n.athlete_id=$1 AND n.client_key=$2`, [athleteId, i.client_key])).rows[0];
      if (prior) {
        const same = prior.category === i.category && prior.title === i.title && Number(prior.amount_cents) === i.amount_cents && prior.currency === i.currency && (prior.needed_by ?? null) === (i.needed_by ?? null);
        if (!same) throw conflict('This client_key was already used for a different need', { code: 'client_key_reused', id: prior.id });
        return needView(c, prior.id);
      }
      if ((await c.query("SELECT count(*)::int AS n FROM athlete_funding_needs WHERE athlete_id=$1 AND status='open'", [athleteId])).rows[0].n >= 100) throw conflict('You have 100 open needs; withdraw some before adding more');
      const row = (await c.query(
        `INSERT INTO athlete_funding_needs(athlete_id, category, title, amount_cents, currency, needed_by, note_enc, client_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [athleteId, i.category, i.title, i.amount_cents, i.currency, i.needed_by ?? null, i.note ? encrypt(i.note, NOTE) : null, i.client_key, user.id])).rows[0];
      await audit(c, user.id, 'create_funding_need', 'athlete_funding_needs', row.id);
      return needView(c, row.id);
    });
  },
});

cap({
  name: 'update_funding_need', method: 'PATCH', path: '/funding-needs/:id', tag: TAG,
  summary: 'Edit a funding need, or withdraw it (status=withdrawn; it is kept, never deleted, and can be reopened). Send the `rev` you last saw: if the need changed elsewhere you get a 409 and must reload. The currency cannot change while applications or agreements are linked; release them first.',
  input: z.object({ id, rev: z.number().int().min(1), category: z.enum(CATEGORIES).optional(), title: z.string().trim().min(1).max(120).optional(), amount_cents: amount.optional(), currency: currency.optional(), needed_by: day.nullable().optional(), note: z.string().trim().max(500).nullable().optional(), status: z.enum(['open', 'withdrawn']).optional() }),
  async handler({ user }, i) {
    const { id: needId, rev, ...patch } = i;
    if (!Object.keys(patch).length) throw badRequest('Nothing to change');
    return tx(async (c) => {
      const { n } = await lockNeed(c, user, needId);
      stale(n, rev);
      if (patch.needed_by && patch.needed_by < today() && patch.needed_by !== ymd(n.needed_by)) throw badRequest('The date it is needed by is in the past');
      if (patch.currency && patch.currency !== n.currency && (await c.query('SELECT 1 FROM athlete_funding_links WHERE need_id=$1 AND released_at IS NULL', [n.id])).rowCount) throw conflict('Release the linked applications and agreements before changing the currency', { code: 'currency_locked' });
      if (n.status === 'withdrawn' && patch.status !== 'open' && Object.keys(patch).some((k) => k !== 'status')) throw conflict('This need is withdrawn; reopen it to edit it', { code: 'need_withdrawn' });
      const reopen = patch.status === 'open' && n.status === 'withdrawn';
      if (reopen && (await c.query("SELECT count(*)::int AS n FROM athlete_funding_needs WHERE athlete_id=$1 AND status='open'", [n.athlete_id])).rows[0].n >= 100) throw conflict('You have 100 open needs; withdraw some first');
      await c.query(
        `UPDATE athlete_funding_needs SET category=coalesce($2,category), title=coalesce($3,title), amount_cents=coalesce($4,amount_cents), currency=coalesce($5,currency),
           needed_by=CASE WHEN $6::boolean THEN $7::date ELSE needed_by END, note_enc=CASE WHEN $8::boolean THEN $9 ELSE note_enc END,
           status=coalesce($10,status), withdrawn_at=CASE WHEN $10='withdrawn' THEN coalesce(withdrawn_at, now()) WHEN $10='open' THEN NULL ELSE withdrawn_at END, rev=rev+1, updated_at=now() WHERE id=$1`,
        [n.id, patch.category ?? null, patch.title ?? null, patch.amount_cents ?? null, patch.currency ?? null, 'needed_by' in patch, patch.needed_by ?? null, 'note' in patch, patch.note ? encrypt(patch.note, NOTE) : null, patch.status ?? null]);
      await audit(c, user.id, patch.status === 'withdrawn' ? 'withdraw_funding_need' : 'update_funding_need', 'athlete_funding_needs', n.id);
      return needView(c, n.id);
    });
  },
});

/** The cash a deal commits in `currency`, from its lines at the version in force. */
const dealCash = async (c, dealId, cur) => Number((await c.query(
  `SELECT coalesce(sum(coalesce(l.total_cents, l.amount_cents * l.instalments)),0)::bigint AS total FROM sponsorships s JOIN sponsorship_lines l ON l.sponsorship_id=s.id AND l.version=coalesce(s.accepted_version, s.terms_version)
    WHERE s.id=$1 AND l.kind='money' AND l.currency=$2`, [dealId, cur])).rows[0].total);
const liveAllocated = async (c, col, targetId) => Number((await c.query(`SELECT coalesce(sum(k.allocated_cents),0)::bigint AS n FROM athlete_funding_links k JOIN athlete_funding_needs n ON n.id=k.need_id WHERE k.${col}=$1 AND k.released_at IS NULL AND n.status='open'`, [targetId])).rows[0].n);

cap({
  name: 'link_funding_need', method: 'POST', path: '/funding-needs/:id/links', tag: TAG, status: 201,
  summary: 'Say which application or agreement covers (part of) a need, and how much of it. Exactly one of application_id / sponsorship_id, both for this athlete, in the need\'s currency. The amount cannot exceed what the item can give (the request, the award, or the agreement\'s committed cash) once other needs\' links are counted, so the same money is never claimed twice. Coverage is read live: a declined application or ended-early agreement stops covering by itself. Send the need\'s `rev`.',
  input: z.object({ id, rev: z.number().int().min(1), application_id: id.optional(), sponsorship_id: id.optional(), allocated_cents: amount }),
  async handler({ user }, i) {
    if (!!i.application_id === !!i.sponsorship_id) throw badRequest('Give either application_id or sponsorship_id');
    return tx(async (c) => {
      const { n } = await lockNeed(c, user, i.id);
      stale(n, i.rev);
      if (n.status !== 'open') throw conflict('This need is withdrawn; reopen it first', { code: 'need_withdrawn' });
      let limit, col, target;
      if (i.application_id) {
        col = 'application_id'; target = i.application_id;
        const a = (await c.query('SELECT * FROM sponsorship_applications WHERE id=$1 FOR UPDATE', [i.application_id])).rows[0];
        if (!a || a.target_type !== 'athlete' || a.target_id !== n.athlete_id) throw notFound('Application');
        if (!['submitted', 'awarded'].includes(a.status)) throw conflict(`This application is ${a.status} and cannot cover a need`, { code: 'target_not_live' });
        if (a.currency !== n.currency) throw badRequest(`This application is in ${a.currency}; the need is in ${n.currency}. Currencies are never converted.`);
        const aw = (await c.query("SELECT status, amount_cents, sponsorship_id FROM sponsorship_awards WHERE application_id=$1 AND status IN ('issued','accepted') ORDER BY created_at DESC, id LIMIT 1", [a.id])).rows[0];
        if (aw?.status === 'accepted' && aw.sponsorship_id) throw conflict('This award became an agreement; link the agreement instead so the money is not counted twice', { code: 'use_agreement', sponsorship_id: aw.sponsorship_id });
        limit = Number(a.status === 'awarded' ? (aw?.amount_cents ?? a.awarded_cents ?? 0) : a.requested_cents);
      } else {
        col = 'sponsorship_id'; target = i.sponsorship_id;
        const s = (await c.query('SELECT * FROM sponsorships WHERE id=$1 FOR UPDATE', [i.sponsorship_id])).rows[0];
        if (!s || s.target_type !== 'athlete' || s.target_id !== n.athlete_id) throw notFound('Agreement');
        if (!['proposed', ...SECURED_DEAL].includes(s.status)) throw conflict(`This agreement is ${s.status} and cannot cover a need`, { code: 'target_not_live' });
        limit = await dealCash(c, s.id, n.currency);
        if (!limit) throw badRequest(`This agreement commits no cash in ${n.currency}`);
        const origin = (await c.query('SELECT application_id FROM sponsorship_awards WHERE sponsorship_id=$1', [s.id])).rows.map((r) => r.application_id);
        if (origin.length && (await c.query('SELECT 1 FROM athlete_funding_links WHERE need_id=$1 AND released_at IS NULL AND application_id = ANY($2::uuid[])', [n.id, origin])).rowCount) throw conflict('The application this agreement came from is already linked to this need; release that link first', { code: 'double_count' });
      }
      const dup = (await c.query(`SELECT * FROM athlete_funding_links WHERE need_id=$1 AND ${col}=$2 AND released_at IS NULL`, [n.id, target])).rows[0];
      if (dup) {
        if (Number(dup.allocated_cents) === i.allocated_cents) return needView(c, n.id); // a retry
        throw conflict('This item is already linked to this need; release the link to change the amount', { code: 'link_exists', link_id: dup.id });
      }
      const remaining = limit - (await liveAllocated(c, col, target));
      if (i.allocated_cents > remaining) throw conflict(`Only ${Math.max(0, remaining)} of this ${col === 'application_id' ? 'application' : 'agreement'} is not already claimed by your needs`, { code: 'over_allocated', remaining_cents: Math.max(0, remaining), limit_cents: limit });
      await c.query(`INSERT INTO athlete_funding_links(need_id, ${col}, allocated_cents, created_by) VALUES ($1,$2,$3,$4)`, [n.id, target, i.allocated_cents, user.id]);
      await c.query('UPDATE athlete_funding_needs SET rev=rev+1, updated_at=now() WHERE id=$1', [n.id]);
      await audit(c, user.id, 'link_funding_need', 'athlete_funding_needs', n.id);
      return needView(c, n.id);
    });
  },
});

cap({
  name: 'release_funding_need_link', method: 'POST', path: '/funding-need-links/:id/release', tag: TAG,
  summary: 'Stop counting an application or agreement towards a need. The link is kept as history, never deleted; the agreement itself is untouched. Releasing twice is harmless. Send the need\'s `rev`.',
  input: z.object({ id, rev: z.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k0 = (await c.query('SELECT need_id FROM athlete_funding_links WHERE id=$1', [i.id])).rows[0];
      if (!k0) throw notFound('Link');
      const { n } = await lockNeed(c, user, k0.need_id);
      const k = (await c.query('SELECT * FROM athlete_funding_links WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (k.released_at) return needView(c, n.id);
      stale(n, i.rev);
      await c.query('UPDATE athlete_funding_links SET released_at=now(), released_by=$2 WHERE id=$1', [k.id, user.id]);
      await c.query('UPDATE athlete_funding_needs SET rev=rev+1, updated_at=now() WHERE id=$1', [n.id]);
      await audit(c, user.id, 'release_funding_need_link', 'athlete_funding_needs', n.id);
      return needView(c, n.id);
    });
  },
});

// ------------------------------------------------------------------ the workspace

const DUE_STATES = ['upcoming', 'overdue', 'open', 'fulfilled'];
const STATE_SQL = `($11::text IS NULL OR ($11='overdue' AND o.status='scheduled' AND o.due_on < current_date AND o.held_by_pause_id IS NULL) OR ($11='upcoming' AND o.status='scheduled' AND o.due_on >= current_date)
  OR ($11='open' AND o.status='scheduled') OR ($11='fulfilled' AND o.status='fulfilled'))`;
const AWARD_VISIBLE = ['waitlisted', 'issued', 'accepted', 'declined', 'expired'];
const PRIORITY = { answer_award: 1, answer_offer: 1, confirm_payment: 1, confirm_receipt: 1, submit_endorsement: 1, meet_condition: 1, review_endorsement: 2, overdue_from_sponsor: 2, agreement_ending: 2, fund_need: 2 };

/** Money cells a coach may see depend on the sections they were given: requests and awards need `applications`, committed and paid need `dues`. */
const moneyFor = (m, S) => {
  const x = shapeMoney(m);
  const out = { currency: x.currency };
  if (S.has('applications')) Object.assign(out, { requested_cents: x.requested_cents, awarded_cents: x.awarded_cents, offered_cents: x.offered_cents, gap_cents: x.gap_cents });
  if (S.has('dues')) Object.assign(out, { committed_cents: x.committed_cents, confirmed_cents: x.confirmed_cents, reported_unconfirmed_cents: x.reported_unconfirmed_cents, overdue_cents: x.overdue_cents, outstanding_cents: x.outstanding_cents });
  return out;
};

function dueShape(o, deal, line) {
  const state = o.status === 'fulfilled' ? 'fulfilled' : o.status === 'cancelled' ? 'cancelled' : o.held ? 'on_hold' : o.overdue ? 'overdue' : 'scheduled';
  const base = { id: o.id, sponsorship_id: o.sponsorship_id, agreement_ref: deal?.agreement_ref ?? null, sponsor: deal?.sponsor_name ?? null, label: o.label, kind: o.kind, due_on: o.due_on, original_due_on: o.original_due_on, state, currency: o.currency, source: { type: 'sponsorship_obligation', id: o.id } };
  if (o.kind === 'money') {
    const amountC = Number(o.amount_cents), confirmed = Number(o.confirmed_cents), conceded = Number(o.conceded_cents ?? 0);
    return { ...base, money: { amount_cents: amountC, confirmed_cents: confirmed, reported_unconfirmed_cents: Number(o.reported_unverified_cents), checkout_in_progress_cents: Number(o.checkout_in_progress_cents), refunded_cents: Number(o.refunded_cents), conceded_cents: conceded, outstanding_cents: Math.max(0, amountC - confirmed - conceded) } };
  }
  if (o.kind === 'goods') {
    const net = o.received_quantity - o.returned_quantity;
    return { ...base, goods: { committed: o.quantity, received: o.received_quantity, in_transit: o.in_transit_quantity, returned: o.returned_quantity, credited: o.credited_quantity, return_pending: o.return_pending_quantity, remaining: Math.max(0, o.quantity - (net + o.in_transit_quantity + o.credited_quantity)) } };
  }
  if (o.kind === 'endorsement') return { ...base, endorsement: { promoter: line?.promoter ?? null, submission_status: o.submission_status } };
  return { ...base, service: { vouchers_open: o.vouchers_open, vouchers_redeemed: o.vouchers_redeemed } };
}

async function buildWorkspace(c, athleteId, access, { state = null, limit = 50, offset = 0, forExport = false }) {
  const S = new Set(access.sections);
  const owner = access.role !== 'staff';
  const p = [athleteId, null, null, 'athlete', null, null, false, null, null, athleteId];
  const run = (tail, extra = []) => many(`WITH ${chain('athlete')} ${tail}`, [...p, ...extra]);
  const athlete = await one('SELECT id, display_name, handle, (youth_until IS NOT NULL AND youth_until > current_date) AS youth FROM users WHERE id=$1', [athleteId]);
  const out = {
    athlete: { id: athlete.id, display_name: athlete.display_name, handle: athlete.handle, youth: athlete.youth },
    access: { role: access.role, sections: access.sections, can_export: access.can_export, ...(access.role === 'staff' ? { shares: access.shares.map((s) => ({ id: s.id, purpose: s.purpose, expires_at: s.expires_at })) } : {}) },
    as_of: new Date().toISOString(),
    basis: 'Amounts are minor units of their own currency and are never added across currencies. A reported payment is not counted as received until the recipient confirms it. Goods and endorsement values are estimates, never cash.',
  };

  const needsOn = S.has('needs'), appsOn = S.has('applications'), supportOn = S.has('support'), duesOn = S.has('dues');
  const money = appsOn || duesOn ? await run('SELECT * FROM money ORDER BY currency') : [];
  out.totals = appsOn || duesOn ? money.map((m) => moneyFor(m, S)) : null;

  if (needsOn) {
    const rows = (await c.query(`SELECT ${NEED_COLS} FROM athlete_funding_needs n WHERE n.athlete_id=$1 ORDER BY (n.status='open') DESC, n.needed_by NULLS LAST, n.created_at, n.id LIMIT 200`, [athleteId])).rows;
    out.needs = await needViews(c, rows, { note: owner });
    const open = out.needs.filter((x) => x.status === 'open');
    const byCur = new Map();
    for (const x of open) {
      const t = byCur.get(x.currency) ?? { currency: x.currency, needed_cents: 0, secured_cents: 0, pending_cents: 0, gap_cents: 0 };
      t.needed_cents += x.amount_cents; t.secured_cents += x.secured_cents; t.pending_cents += x.pending_cents; t.gap_cents += x.gap_cents; byCur.set(x.currency, t);
    }
    out.needs_totals = [...byCur.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1));
  } else out.needs = null;

  const apps = appsOn || owner ? await run(
    `SELECT a.id, a.status, a.requested_cents, a.awarded_cents, a.offered_cents, a.currency, a.program_id, p.name AS program_name, p.sponsor_id, sp.name AS sponsor_name, r.name AS round_name, r.seq AS round_seq, ap.created_at, ap.decided_at, ap.receipt_no,
            (SELECT json_build_object('id', w.id, 'status', w.status, 'expires_at', w.expires_at, 'sponsorship_id', w.sponsorship_id, 'offer_version', w.offer_version, 'amount_cents', w.amount_cents) FROM sponsorship_awards w
              WHERE w.application_id=a.id AND w.status = ANY($11) ORDER BY w.created_at DESC, w.id LIMIT 1) AS award
       FROM apps a JOIN sponsorship_applications ap ON ap.id=a.id JOIN sponsorship_programs p ON p.id=a.program_id JOIN sponsors sp ON sp.id=p.sponsor_id JOIN sponsorship_rounds r ON r.id=ap.round_id
      ORDER BY ap.created_at DESC, a.id LIMIT 100`, [AWARD_VISIBLE]) : [];
  const appItems = apps.map((a) => {
    const expired = a.award?.status === 'issued' && new Date(a.award.expires_at) <= new Date();
    return {
      id: a.id, status: a.status, program: { id: a.program_id, name: a.program_name, round: a.round_name }, sponsor: { id: a.sponsor_id, name: a.sponsor_name }, currency: a.currency, receipt_no: a.receipt_no,
      requested_cents: Number(a.requested_cents), awarded_cents: a.status === 'awarded' ? Number(a.awarded_cents) : null, offered_cents: a.offered_cents == null ? null : Number(a.offered_cents),
      award: a.award ? { ...a.award, status: expired ? 'expired' : a.award.status, amount_cents: Number(a.award.amount_cents) } : null,
      submitted_at: a.created_at, decided_at: a.decided_at, source: { type: 'sponsorship_application', id: a.id },
    };
  });
  out.applications = appsOn ? appItems : null;

  const deals = supportOn || duesOn || owner ? await run(
    `SELECT ss.id, ss.agreement_ref, ss.status, ss.sponsor_id, sp.name AS sponsor_name, ss.starts_on::text, ss.ends_on::text, ss.terms_version, ss.accepted_version, ss.program_id, pr.name AS program_name,
            ss.amount_cents AS legacy_amount_cents, ss.in_kind AS legacy_in_kind, EXISTS (SELECT 1 FROM sponsorship_lines l WHERE l.sponsorship_id=ss.id) AS has_lines
       FROM deals d JOIN sponsorships ss ON ss.id=d.id JOIN sponsors sp ON sp.id=ss.sponsor_id LEFT JOIN sponsorship_programs pr ON pr.id=ss.program_id ORDER BY ss.created_at DESC, ss.id LIMIT 100`) : [];
  const dealIds = deals.map((d) => d.id);
  const lines = supportOn || duesOn || owner ? await run(
    `SELECT l.id, l.sponsorship_id, l.kind, l.label, l.currency, l.total_cents, l.amount_cents, l.instalments, l.cadence, l.estimate_cents, l.quantity, l.unit, l.promoter, l.service_type
       FROM deals d JOIN sponsorships ss ON ss.id=d.id JOIN sponsorship_lines l ON l.sponsorship_id=ss.id AND l.version=coalesce(ss.accepted_version, ss.terms_version) ORDER BY l.sponsorship_id, l.position`) : [];
  const conds = duesOn || owner ? await run(
    `SELECT c.id, w.sponsorship_id, c.text, c.due_on::text AS due_on, c.blocks_payment, c.met_at FROM sponsorship_awards w JOIN sponsorship_award_conditions c ON c.award_id=w.id JOIN deals d ON d.id=w.sponsorship_id
      WHERE w.status='accepted' AND c.removed_at IS NULL ORDER BY c.due_on NULLS LAST, c.id`) : [];
  out.support = supportOn ? deals.map((d) => ({
    id: d.id, agreement_ref: d.agreement_ref, status: d.status, sponsor: { id: d.sponsor_id, name: d.sponsor_name }, program: d.program_id ? { id: d.program_id, name: d.program_name } : null,
    starts_on: d.starts_on, ends_on: d.ends_on, terms_version: d.accepted_version ?? d.terms_version,
    lines: lines.filter((l) => l.sponsorship_id === d.id).map(({ sponsorship_id, ...l }) => ({ ...l, total_cents: l.total_cents == null ? null : Number(l.total_cents), amount_cents: l.amount_cents == null ? null : Number(l.amount_cents), estimate_cents: l.estimate_cents == null ? null : Number(l.estimate_cents), estimate_is_cash: false })),
    legacy: d.has_lines ? undefined : { amount_cents: d.legacy_amount_cents, in_kind: d.legacy_in_kind, note: 'Predates structured terms: the currency was never recorded, so it is not counted in any total' },
    source: { type: 'sponsorship', id: d.id },
  })) : null;

  const dealBy = new Map(deals.map((d) => [d.id, d]));
  let dues = null;
  if (duesOn) {
    const ids = (await run(`SELECT o.id FROM sponsorship_obligations o JOIN deals d ON d.id=o.sponsorship_id WHERE o.status <> 'cancelled' AND ${STATE_SQL} ORDER BY o.due_on, o.id LIMIT $12 OFFSET $13`, [state, limit, offset])).map((r) => r.id);
    const total = (await run(`SELECT count(*)::int AS n FROM sponsorship_obligations o JOIN deals d ON d.id=o.sponsorship_id WHERE o.status <> 'cancelled' AND ${STATE_SQL}`, [state]))[0].n;
    const rows = ids.length ? await obligationRows('o.id = ANY($1::uuid[])', [ids]) : [];
    const items = rows.map((o) => dueShape(o, dealBy.get(o.sponsorship_id) ?? null, lines.find((l) => l.id === o.line_id)));
    const open = (await run("SELECT o.currency, o.kind, count(*)::int AS n FROM sponsorship_obligations o JOIN deals d ON d.id=o.sponsorship_id WHERE o.status='scheduled' GROUP BY o.currency, o.kind ORDER BY o.currency NULLS LAST, o.kind"));
    dues = { total, limit, offset, items, open_by_kind: open, conditions: conds.filter((x) => !x.met_at).map((x) => ({ id: x.id, sponsorship_id: x.sponsorship_id, text: x.text, due_on: x.due_on, blocks_payment: x.blocks_payment })) };
  }
  out.dues = dues;

  if (owner && !forExport) {
    out.next_actions = await nextActions({ run, apps: appItems, deals, lines, conds, needs: out.needs ?? [] });
    out.withheld = [];
  } else if (!owner) out.withheld = SECTIONS.filter((s) => !S.has(s));
  out.snapshot = createHash('sha1').update(JSON.stringify([out.totals, out.needs, out.applications, out.support, dues && { total: dues.total, items: dues.items }])).digest('hex').slice(0, 16);
  return out;
}

/** What the player (or guardian) can do next, most urgent first. Each action points at the canonical record where it is done: nothing is decided here. */
async function nextActions({ run, apps, deals, conds, needs }) {
  const a = [];
  const act = (code, label, entity, extra = {}) => a.push({ code, priority: PRIORITY[code] ?? 3, label, entity, ...extra });
  const t = today();
  for (const x of apps) if (x.award?.status === 'issued') act('answer_award', `Answer the funding offer from ${x.sponsor.name} (${x.program.name})`, { type: 'award', id: x.award.id }, { due_on: ymd(x.award.expires_at) });
  for (const d of deals) {
    if (d.status === 'proposed') act('answer_offer', `Answer the offer from ${d.sponsor_name}`, { type: 'sponsorship', id: d.id });
    if (d.status === 'active' && d.ends_on && d.ends_on >= t && d.ends_on <= plusDays(t, 30)) act('agreement_ending', `The agreement with ${d.sponsor_name} is ending soon: renew it or let it end`, { type: 'sponsorship', id: d.id }, { due_on: d.ends_on });
  }
  for (const p of await run("SELECT p.id, p.amount_cents, p.currency, p.paid_on::text AS paid_on, ob.sponsorship_id FROM sponsorship_payments p JOIN sponsorship_obligations ob ON ob.id=p.obligation_id JOIN deals d ON d.id=ob.sponsorship_id WHERE p.status='reported' ORDER BY p.created_at, p.id LIMIT 30"))
    act('confirm_payment', `Confirm or reject the ${fmt(p.amount_cents, p.currency)} payment the sponsor says they made`, { type: 'sponsorship', id: p.sponsorship_id }, { amount_cents: Number(p.amount_cents), currency: p.currency });
  for (const x of await run("SELECT x.id, x.quantity, ob.sponsorship_id, l.label FROM sponsorship_deliveries x JOIN sponsorship_obligations ob ON ob.id=x.obligation_id JOIN sponsorship_lines l ON l.id=ob.line_id JOIN deals d ON d.id=ob.sponsorship_id WHERE x.status='dispatched' ORDER BY x.created_at, x.id LIMIT 30"))
    act('confirm_receipt', `Confirm that ${x.quantity} × ${x.label} arrived (or report a problem)`, { type: 'sponsorship', id: x.sponsorship_id });
  for (const e of await run(`SELECT o.id, o.due_on::text AS due_on, o.sponsorship_id, l.label, l.promoter, (SELECT s.status FROM sponsorship_submissions s WHERE s.obligation_id=o.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS sub
      FROM sponsorship_obligations o JOIN sponsorship_lines l ON l.id=o.line_id JOIN deals d ON d.id=o.sponsorship_id WHERE o.kind='endorsement' AND o.status='scheduled' AND o.held_by_pause_id IS NULL ORDER BY o.due_on, o.id LIMIT 30`)) {
    if (e.promoter === 'recipient' && (e.sub == null || e.sub === 'revision_requested')) act('submit_endorsement', `Send the evidence for “${e.label}”${e.due_on < t ? ' (overdue)' : ''}`, { type: 'sponsorship', id: e.sponsorship_id }, { due_on: e.due_on });
    if (e.promoter === 'sponsor' && e.sub === 'submitted') act('review_endorsement', `Review the sponsor's evidence for “${e.label}”`, { type: 'sponsorship', id: e.sponsorship_id });
  }
  for (const o of await run("SELECT o.id, o.due_on::text AS due_on, o.sponsorship_id, o.kind, l.label FROM sponsorship_obligations o JOIN sponsorship_lines l ON l.id=o.line_id JOIN deals d ON d.id=o.sponsorship_id WHERE o.status='scheduled' AND o.kind <> 'endorsement' AND o.due_on < current_date AND o.held_by_pause_id IS NULL ORDER BY o.due_on, o.id LIMIT 20"))
    act('overdue_from_sponsor', `“${o.label}” is overdue and has not been fulfilled`, { type: 'sponsorship', id: o.sponsorship_id }, { due_on: o.due_on });
  for (const cd of conds.filter((x) => !x.met_at)) act('meet_condition', `${cd.blocks_payment ? 'Payment waits on: ' : 'Condition: '}${cd.text}`, { type: 'sponsorship', id: cd.sponsorship_id }, cd.due_on ? { due_on: cd.due_on } : {});
  for (const n of needs.filter((x) => x.status === 'open' && x.gap_cents > 0)) act('fund_need', `${n.title}: ${fmt(n.gap_cents, n.currency)} is not yet covered`, { type: 'need', id: n.id }, { ...(n.needed_by ? { due_on: n.needed_by } : {}), gap_cents: n.gap_cents, currency: n.currency });
  return a.sort((x, y) => x.priority - y.priority || ((x.due_on ?? '9999') < (y.due_on ?? '9999') ? -1 : (x.due_on ?? '9999') > (y.due_on ?? '9999') ? 1 : 0) || (x.code < y.code ? -1 : x.code > y.code ? 1 : 0) || (x.entity.id < y.entity.id ? -1 : 1)).slice(0, 40);
}

/** Record that someone other than the athlete looked: an audit line, and for a coach the share's own history the athlete can read. */
async function recordView(c, user, athleteId, access, action) {
  await audit(c, user.id, action, 'funding_workspace', athleteId);
  if (access.role === 'staff') for (const s of access.shares) await shareEvent(c, s, user.id, action === 'export_player_funding' ? 'exported' : 'viewed');
}

cap({
  name: 'get_player_funding_workspace', method: 'GET', path: '/player-funding', tag: TAG,
  summary: 'The player\'s funding workspace in one read: totals per currency (requested, awarded, offered, gap, committed, confirmed, reported-but-unconfirmed, outstanding), funding needs with what covers them, sponsorship applications and their offers, agreements and their terms, every due with what was paid and confirmed (money), received and in transit (goods), evidence state (endorsements), and the next actions. Read live from the canonical sponsorship tables, so it reconciles with each agreement and with the beneficiary portfolio. Order is total and paging is stable. The athlete, a verified guardian, or a coach the athlete shared it with (only the shared sections, only while the share, the coaching relationship and any guardian consent all hold); anyone else gets 404.',
  input: z.object({ athlete_id: id.optional().describe('omitted = yourself; a guardian or coach names the athlete'), state: z.enum(DUE_STATES).optional().describe('filter the dues'), limit: z.coerce.number().int().min(1).max(100).default(50), offset: page.offset }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    const access = await resolveAccess(pool, user, athleteId);
    const ws = await buildWorkspace(pool, athleteId, access, i);
    if (access.role !== 'self') await recordView(pool, user, athleteId, access, 'read_funding_workspace');
    return ws;
  },
});

cap({
  name: 'export_player_funding', method: 'GET', path: '/player-funding/export', tag: TAG,
  summary: 'CSV of the workspace (one row per need, application and due) for the sections the caller may see. The athlete and a verified guardian can always export; a coach only when the share allows exports and only while it is live. Every export is audit-logged and, for a coach, appears in the athlete\'s share history. Nothing beyond amounts, labels and sponsor names is included.',
  input: z.object({ athlete_id: id.optional() }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    const access = await resolveAccess(pool, user, athleteId);
    if (!access.can_export) throw forbidden('This share does not allow exports');
    const ws = await buildWorkspace(pool, athleteId, access, { limit: 100, offset: 0, forExport: true });
    const rows = [];
    for (const n of ws.needs ?? []) rows.push({ record: 'need', reference: n.id, label: n.title, kind: n.category, status: n.status, due_on: n.needed_by ?? '', currency: n.currency, amount_cents: n.amount_cents, settled_cents: n.secured_cents, pending_cents: n.pending_cents, open_cents: n.gap_cents });
    for (const a of ws.applications ?? []) rows.push({ record: 'application', reference: a.receipt_no ?? a.id, label: `${a.program.name} · ${a.sponsor.name}`, kind: 'application', status: a.status, due_on: '', currency: a.currency, amount_cents: a.requested_cents, settled_cents: a.awarded_cents ?? '', pending_cents: a.offered_cents ?? '', open_cents: '' });
    if (ws.dues) {
      // export every due, not just the first page
      const all = [];
      for (let off = 0; ; off += 100) {
        const pg = await buildWorkspace(pool, athleteId, { ...access, sections: ['dues'] }, { limit: 100, offset: off, forExport: true });
        all.push(...pg.dues.items);
        if (all.length >= pg.dues.total || !pg.dues.items.length || off >= 4900) break;
      }
      for (const d of all) {
        const m = d.money, g = d.goods;
        rows.push({ record: 'due', reference: d.agreement_ref ?? d.sponsorship_id, label: `${d.label} · ${d.sponsor ?? ''}`.trim(), kind: d.kind, status: d.state, due_on: d.due_on, currency: d.currency ?? '',
          amount_cents: m ? m.amount_cents : g ? g.committed : '', settled_cents: m ? m.confirmed_cents : g ? g.received - g.returned : '', pending_cents: m ? m.reported_unconfirmed_cents : g ? g.in_transit : '', open_cents: m ? m.outstanding_cents : g ? g.remaining : '' });
      }
    }
    await recordView(pool, user, athleteId, access, 'export_player_funding');
    return { filename: `funding-${ws.athlete.handle}-${today()}.csv`, content_type: 'text/csv', rows: rows.length, basis: ws.basis,
      csv: toCsv(['record', 'reference', 'label', 'kind', 'status', 'due_on', 'currency', 'amount_cents', 'settled_cents', 'pending_cents', 'open_cents'], rows) };
  },
});

// ------------------------------------------------------------------ sharing with a coach

const SHARE_COLS = 's.id, s.athlete_id, s.recipient_id, s.purpose, s.sections, s.can_export, s.expires_at, s.version, s.revoked_at, s.created_at, s.updated_at';
const expiresAt = (d) => {
  if (d < today()) throw badRequest('The end date is in the past');
  if (d > plusDays(today(), 365)) throw badRequest('Sharing can run for at most one year; renew it later');
  return `${plusDays(d, 1)}T00:00:00Z`;
};
const order = (s) => [...new Set(s)].sort((a, b) => SECTIONS.indexOf(a) - SECTIONS.indexOf(b));

cap({
  name: 'list_funding_share_recipients', method: 'GET', path: '/funding-shares/recipients', tag: TAG,
  summary: 'Who the athlete can share their funding workspace with: coaches who currently coach them (and, for a young athlete, only while a guardian\'s coaching consent is current). Being on the same team or having a sponsor does not make someone appear here.',
  input: z.object({ athlete_id: id.optional(), q: z.string().trim().max(60).optional() }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    await requireOwner(pool, user, athleteId);
    const like = i.q ? `%${i.q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const rows = await many(`SELECT DISTINCT u.id, u.display_name, u.handle FROM (${RELATIONSHIP_SQL}) r JOIN users u ON u.id=r.coach_id WHERE r.athlete_id=$1 AND u.id <> $1 AND ($2::text IS NULL OR u.display_name ILIKE $2 OR u.handle ILIKE $2) ORDER BY u.display_name, u.id LIMIT 50`, [athleteId, like]);
    const out = [];
    for (const r of rows) if (!(await accessBlock(pool, athleteId, r.id, 'coach'))) out.push({ ...r, kind: 'coach', detail: 'Coaches you' });
    return out;
  },
});

cap({
  name: 'create_funding_share', method: 'POST', path: '/funding-shares', tag: TAG, status: 201,
  summary: 'Let a coach who currently coaches the athlete see chosen parts of the funding workspace for a purpose, until a date (at most a year), with or without CSV export. The athlete or a verified guardian. Repeating the same request returns the share you already have; a different one for the same person and purpose must be edited. For a young athlete a guardian\'s current coaching consent is required, and it is re-checked on every read.',
  input: z.object({ athlete_id: id.optional(), recipient_id: id, purpose: z.enum(PURPOSES), sections, can_export: z.boolean().default(false), expires_on: day }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    if (i.recipient_id === athleteId) throw badRequest('You cannot share with yourself');
    const rec = await one('SELECT id, display_name FROM users WHERE id=$1', [i.recipient_id]);
    if (!rec) throw notFound('Recipient');
    const secs = order(i.sections);
    const expires = expiresAt(i.expires_on);
    return tx(async (c) => {
      await requireOwner(c, user, athleteId);
      await c.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [athleteId]); // serialises this athlete's shares
      const block = await accessBlock(c, athleteId, rec.id, 'coach');
      if (block === 'guardian_consent') await requireConsent(athleteId, 'coaching', 'sharing funding', c);
      if (block) throw forbidden('You can share with a coach who currently coaches you');
      for (const e of (await c.query("UPDATE funding_shares SET revoked_at=now() WHERE athlete_id=$1 AND recipient_id=$2 AND purpose=$3 AND revoked_at IS NULL AND expires_at <= now() RETURNING id, athlete_id, recipient_id", [athleteId, rec.id, i.purpose])).rows) await shareEvent(c, e, null, 'expired');
      const live = (await c.query(`SELECT ${SHARE_COLS} FROM funding_shares s WHERE s.athlete_id=$1 AND s.recipient_id=$2 AND s.purpose=$3 AND s.revoked_at IS NULL FOR UPDATE`, [athleteId, rec.id, i.purpose])).rows[0];
      if (live) {
        if (live.sections.join() === secs.join() && live.can_export === i.can_export && new Date(live.expires_at).getTime() === Date.parse(expires)) return live; // duplicate / retry
        throw conflict('You are already sharing for this purpose with this person. Edit that share instead.', { code: 'share_exists', share_id: live.id, version: live.version });
      }
      const s = (await c.query(`INSERT INTO funding_shares(athlete_id, recipient_id, purpose, sections, can_export, expires_at, granted_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING ${SHARE_COLS.replace(/s\./g, '')}`, [athleteId, rec.id, i.purpose, secs, i.can_export, expires, user.id])).rows[0];
      await shareEvent(c, s, user.id, 'granted', { sections: secs, purpose: i.purpose, can_export: i.can_export, expires_at: expires });
      await audit(c, user.id, 'grant_funding_share', 'funding_shares', s.id);
      await notify(c, rec.id, { kind: 'funding_shared', title: 'An athlete shared their funding with you', body: 'Open Shared funding to see what they chose to share.', data: { screen: 'PlayerFunding', share_id: s.id, athlete_id: athleteId }, dedupe_key: `funding_shared:${s.id}` });
      return s;
    });
  },
});

cap({
  name: 'update_funding_share', method: 'PATCH', path: '/funding-shares/:id', tag: TAG,
  summary: 'Change what a live share covers (sections, export, end date). Send the `version` you last saw: if it changed elsewhere you get a 409 and must reload. Narrowing takes effect on the coach\'s very next read.',
  input: z.object({ id, version: z.number().int().min(1), sections: sections.optional(), can_export: z.boolean().optional(), expires_on: day.optional() }),
  async handler({ user }, i) {
    if (i.sections === undefined && i.can_export === undefined && i.expires_on === undefined) throw badRequest('Nothing to change');
    const expires = i.expires_on ? expiresAt(i.expires_on) : null;
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM funding_shares WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!s) throw notFound('Share');
      await requireOwner(c, user, s.athlete_id);
      if (s.revoked_at || new Date(s.expires_at) <= new Date()) throw conflict('This share has ended. Create a new one.', { code: 'share_ended' });
      if (s.version !== i.version) throw conflict('This share changed since you opened it. Reload and try again.', { code: 'stale_version', version: s.version });
      const u = (await c.query(`UPDATE funding_shares SET sections=coalesce($2::text[], sections), can_export=coalesce($3::boolean, can_export), expires_at=coalesce($4::timestamptz, expires_at), version=version+1, updated_at=now() WHERE id=$1
        RETURNING ${SHARE_COLS.replace(/s\./g, '')}`, [s.id, i.sections ? order(i.sections) : null, i.can_export ?? null, expires])).rows[0];
      await shareEvent(c, s, user.id, 'updated', { sections: u.sections, can_export: u.can_export, expires_at: u.expires_at });
      await audit(c, user.id, 'update_funding_share', 'funding_shares', s.id);
      return u;
    });
  },
});

cap({
  name: 'revoke_funding_share', method: 'POST', path: '/funding-shares/:id/revoke', tag: TAG,
  summary: 'Stop sharing now. The coach\'s next read, export or open page is refused; the share and its history are kept. Revoking twice is harmless.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM funding_shares WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!s) throw notFound('Share');
      await requireOwner(c, user, s.athlete_id);
      if (s.revoked_at) return { id: s.id, state: 'revoked', revoked_at: s.revoked_at };
      const r = (await c.query('UPDATE funding_shares SET revoked_at=now(), revoked_by=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING revoked_at', [s.id, user.id])).rows[0];
      await shareEvent(c, s, user.id, 'revoked');
      await audit(c, user.id, 'revoke_funding_share', 'funding_shares', s.id);
      return { id: s.id, state: 'revoked', revoked_at: r.revoked_at };
    });
  },
});

cap({
  name: 'list_funding_shares', method: 'GET', path: '/funding-shares', tag: TAG,
  summary: 'The athlete\'s (or guardian\'s) view of who can see the funding workspace: every share with its state (active, expired, revoked) and whether it works right now, plus the history of who was given what, who looked and who exported, newest first.',
  input: z.object({ athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    await requireOwner(pool, user, athleteId);
    const rows = await many(`SELECT ${SHARE_COLS}, u.display_name AS recipient_name, u.handle AS recipient_handle FROM funding_shares s JOIN users u ON u.id=s.recipient_id WHERE s.athlete_id=$1 ORDER BY (s.revoked_at IS NULL AND s.expires_at > now()) DESC, s.created_at DESC, s.id LIMIT $2 OFFSET $3`, [athleteId, i.limit, i.offset]);
    const shares = [];
    for (const s of rows) shares.push({ ...s, state: shareState(s), blocked: shareState(s) === 'active' ? await shareBlock(pool, s) : null });
    const events = await many(`SELECT e.id, e.share_id, e.action, e.detail, e.created_at, e.actor_id, u.display_name AS recipient_name FROM funding_share_events e JOIN users u ON u.id=e.recipient_id WHERE e.athlete_id=$1 ORDER BY e.created_at DESC, e.id LIMIT 50`, [athleteId]);
    return { shares: shares.map((s) => ({ ...s, blocked_reason: s.blocked ? reasonText(s.blocked) : null })), events };
  },
});

cap({
  name: 'list_funding_shared_with_me', method: 'GET', path: '/funding-shared', tag: TAG,
  summary: 'Coach: the athletes who shared their funding workspace with you, what each share covers and until when, and whether it works right now (a stopped share, a lapsed coaching relationship or withdrawn guardian consent is shown as blocked and the athlete is not named).',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(`SELECT ${SHARE_COLS}, u.display_name, u.handle FROM funding_shares s JOIN users u ON u.id=s.athlete_id WHERE s.recipient_id=$1 AND s.revoked_at IS NULL AND s.expires_at > now() ORDER BY s.created_at DESC, s.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    const out = [];
    for (const s of rows) {
      const block = await shareBlock(pool, s);
      out.push({ id: s.id, athlete: block ? { id: s.athlete_id, display_name: null, handle: null } : { id: s.athlete_id, display_name: s.display_name, handle: s.handle }, purpose: s.purpose, sections: s.sections, can_export: s.can_export, expires_at: s.expires_at, state: shareState(s), blocked: block, blocked_reason: block ? reasonText(block) : null });
    }
    return out;
  },
});
