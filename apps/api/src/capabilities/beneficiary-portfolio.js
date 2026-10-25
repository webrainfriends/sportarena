// Beneficiary portfolio (#292): who a sponsor (or a recipient) supports across programs, applications, awards and agreements,
// with support history, funding gaps, milestones, documents, risk flags, reviews and next actions. Read-only over the canonical tables;
// the agreement screens stay the only place to act, so there is no second workflow here.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, pool } from '../db.js';
import { forbidden } from '../errors.js';
import { audit } from '../helpers.js';
import { toCsv } from '../csv.js';
import { sponsorAccess, sponsorStaffSql, actionsFor } from '../sponsor-access.js';
import { chain, recipientSql, shapeMoney, RISKS, SORTS } from '../beneficiary-portfolio.js';

const TAG = 'Sponsors';
const TARGETS = z.enum(['event', 'team', 'athlete']);
const VIEWS = z.enum(['sponsor', 'recipient']);
const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);
const FILTERS = {
  view: VIEWS.optional().describe('sponsor = beneficiaries of the brands you run; recipient = sponsors of the events, teams and athlete profile you own. Omitted: sponsor when you run a brand, otherwise recipient'),
  sponsor_id: id.optional(), program_id: id.optional(), target_type: TARGETS.optional(),
  q: z.string().trim().max(80).optional().describe('beneficiary name'),
  stage: z.enum(['active', 'pending', 'closed']).optional().describe('active = an agreement is running; pending = an offer or application is open; closed = history only'),
  has_gap: bool.optional().describe('only beneficiaries whose requested funding is not fully awarded or offered'),
  risk: z.enum(Object.keys(RISKS)).optional(), currency: z.string().length(3).transform((s) => s.toUpperCase()).optional(),
};

/** Which sides the caller may open, so a client offers only views that can return something. */
async function availableViews(user) {
  const brands = (await pool.query(`SELECT EXISTS (SELECT 1 FROM sponsors sp WHERE ${sponsorStaffSql(1).replace(/ss\.department_id/g, 'r.department_id')}) AS ok`, [user.id])).rows[0].ok;
  const own = (await pool.query(`SELECT EXISTS (SELECT 1 FROM events WHERE organizer_id=$1) OR EXISTS (SELECT 1 FROM teams WHERE owner_id=$1) OR EXISTS (SELECT 1 FROM users WHERE id=$1 AND 'athlete' = ANY(roles)) AS ok`, [user.id])).rows[0].ok;
  return { sponsor: brands, recipient: own };
}
const pickView = async (user, want) => { const av = await availableViews(user); return { view: want ?? (av.sponsor ? 'sponsor' : 'recipient'), available_views: av }; };
const like = (q) => (q ? q.replace(/[%_\\]/g, '\\$&') : null);
const args = (user, i, extra = []) => [user.id, i.sponsor_id ?? null, i.program_id ?? null, i.target_type ?? null, like(i.q), i.stage ?? null, !!i.has_gap, i.risk ?? null, i.currency ?? null, i.target_id ?? null, ...extra];
const run = (view, action, tail, params) => many(`WITH ${chain(view, action)} ${tail}`, params);

cap({
  name: 'list_beneficiary_portfolio', method: 'GET', path: '/beneficiary-portfolio', tag: TAG,
  summary: 'The beneficiary portfolio: every athlete, team and event your brands support (or, as a recipient, the sponsors behind what you own), across programs, applications, awards and agreements. Per beneficiary and per currency: requested vs awarded vs offered funding, the remaining gap, committed, confirmed received, reported-but-unconfirmed and outstanding amounts, plus agreement counts, risk flags and the next milestone. Read live from the agreements, so totals reconcile with them. Currencies are never added together; a reported payment is never counted as settled. Another sponsor\'s terms are never included. `totals` covers every match, not just the page. Order is total (sort key, name, type, id), so paging is stable.',
  input: z.object({ ...FILTERS, sort: z.enum(Object.keys(SORTS)).default('name'), ...page }),
  async handler({ user }, i) {
    const { view, available_views } = await pickView(user, i.view);
    if (!available_views[view]) throw forbidden(view === 'sponsor' ? 'You do not run a sponsor brand' : 'You own no events, teams or athlete profile');
    const params = args(user, i);
    const rows = await run(view, 'read', `SELECT *, count(*) OVER()::int AS total FROM matched ORDER BY ${SORTS[i.sort]} lower(name), target_type, target_id LIMIT $11 OFFSET $12`, [...params, i.limit, i.offset]);
    const keys = rows.map((r) => [r.target_type, r.target_id]);
    const money = rows.length ? await run(view, 'read', 'SELECT m.* FROM money m WHERE (m.target_type, m.target_id) IN (SELECT * FROM unnest($11::text[], $12::uuid[])) ORDER BY m.currency', [...params, keys.map((k) => k[0]), keys.map((k) => k[1])]) : [];
    const totals = (await run(view, 'read',
      `SELECT m.currency, sum(m.requested) AS requested, sum(m.awarded) AS awarded, sum(m.offered) AS offered, sum(m.gap) AS gap, sum(m.committed) AS committed, sum(m.confirmed) AS confirmed, sum(m.reported) AS reported, sum(m.overdue) AS overdue
         FROM money m JOIN matched x ON x.target_type=m.target_type AND x.target_id=m.target_id WHERE ($9::text IS NULL OR m.currency=$9) GROUP BY m.currency ORDER BY m.currency`, params)).map(shapeMoney);
    const total = rows[0]?.total ?? (i.offset ? (await run(view, 'read', 'SELECT count(*)::int AS n FROM matched', params))[0].n : 0);
    return {
      view, available_views, total, limit: i.limit, offset: i.offset, totals,
      items: rows.map((r) => ({
        target_type: r.target_type, target_id: r.target_id, name: r.name, stage: r.stage,
        agreements: { active: r.active_agreements, proposed: r.proposed_agreements, closed: r.closed_agreements }, applications: { total: r.applications, open: r.open_applications },
        money: money.filter((m) => m.target_type === r.target_type && m.target_id === r.target_id).map(shapeMoney),
        risks: r.risks, next_milestone_on: r.next_due_on,
      })),
      risk_labels: RISKS,
    };
  },
});

cap({
  name: 'export_beneficiary_portfolio', method: 'GET', path: '/beneficiary-portfolio-export', tag: TAG,
  summary: 'CSV of the portfolio (one row per beneficiary and currency) for the current filters. Sponsor side: only brand managers, finance and auditors, and only their own brands; the recipient exports their own. No contact or personal data beyond the beneficiary name (a youth athlete stays masked). Every export is audit-logged.',
  input: z.object({ ...FILTERS }),
  async handler({ user }, i) {
    const { view, available_views } = await pickView(user, i.view);
    if (!available_views[view]) throw forbidden('Nothing to export');
    const action = 'export';
    const params = args(user, i);
    const rows = await run(view, action, 'SELECT * FROM matched ORDER BY lower(name), target_type, target_id', params);
    // a role that can read the portfolio but export none of it (evaluator, legal, viewer) is told so rather than handed an empty file
    if (view === 'sponsor' && !rows.length && (await run(view, 'read', 'SELECT 1 FROM matched LIMIT 1', params)).length) throw forbidden('Your role cannot export this portfolio');
    const money = rows.length ? await run(view, action, 'SELECT m.* FROM money m JOIN matched x ON x.target_type=m.target_type AND x.target_id=m.target_id ORDER BY m.currency', params) : [];
    const out = [];
    for (const r of rows) {
      const own = money.filter((m) => m.target_type === r.target_type && m.target_id === r.target_id);
      for (const m of own.length ? own : [null]) {
        const s = m && shapeMoney(m);
        out.push({ beneficiary: r.name, target_type: r.target_type, stage: r.stage, active_agreements: r.active_agreements, currency: s?.currency ?? '', requested_cents: s?.requested_cents ?? '', awarded_cents: s?.awarded_cents ?? '', offered_cents: s?.offered_cents ?? '', gap_cents: s?.gap_cents ?? '',
          committed_cents: s?.committed_cents ?? '', confirmed_cents: s?.confirmed_cents ?? '', reported_unconfirmed_cents: s?.reported_unconfirmed_cents ?? '', outstanding_cents: s?.outstanding_cents ?? '', risks: r.risks.join(' ') });
      }
    }
    await audit(null, user.id, 'export', 'beneficiary_portfolio', null);
    return { filename: 'beneficiary-portfolio.csv', rows: out.length, csv: toCsv(['beneficiary', 'target_type', 'stage', 'active_agreements', 'currency', 'requested_cents', 'awarded_cents', 'offered_cents', 'gap_cents', 'committed_cents', 'confirmed_cents', 'reported_unconfirmed_cents', 'outstanding_cents', 'risks'], out) };
  },
});

const ymd = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);
/** Minor units in their own currency, e.g. 600000 USD -> "$6,000.00". */
const fmt = (cents, cur) => { try { const f = new Intl.NumberFormat('en', { style: 'currency', currency: cur }); return f.format(Number(cents) / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur}`; } };
const label = (s) => String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

cap({
  name: 'get_beneficiary_portfolio_entry', method: 'GET', path: '/beneficiary-portfolio/:target_type/:target_id', tag: TAG,
  summary: 'One beneficiary in your portfolio: the agreements and applications you are party to (never another sponsor\'s terms), per-currency totals, support history, upcoming milestones, documents, shared reviews, risk flags and next actions for your role. `snapshot` changes whenever any of it changes, so a client can tell its copy is stale. 403 when you have no relationship with the beneficiary (it does not reveal whether it exists).',
  input: z.object({ target_type: TARGETS, target_id: id, view: VIEWS.optional(), sponsor_id: id.optional(), program_id: id.optional() }),
  async handler({ user }, i) {
    const { view, available_views } = await pickView(user, i.view);
    const f = { ...i, q: undefined, stage: undefined, has_gap: false, risk: undefined, currency: undefined };
    const params = args(user, f);
    const head = available_views[view] ? (await run(view, 'read', 'SELECT * FROM matched', params))[0] : null;
    if (!head) throw forbidden('You have no support relationship with this beneficiary');
    const sponsor = view === 'sponsor';
    const [money, agreements, agMoney, lines, apps, upcoming, conds, reviews, pending, subs, letters, evidence, hist, others] = await Promise.all([
      run(view, 'read', 'SELECT * FROM money ORDER BY currency', params),
      run(view, 'read', `SELECT ss.id, ss.agreement_ref, ss.status, ss.sponsor_id, sp.name AS sponsor_name, ss.starts_on::text, ss.ends_on::text, ss.visibility, ss.terms_version, ss.accepted_version, ss.program_id, pr.name AS program_name,
          ss.amount_cents AS legacy_amount_cents, ss.in_kind AS legacy_in_kind, EXISTS (SELECT 1 FROM sponsorship_lines l WHERE l.sponsorship_id=ss.id) AS has_lines
        FROM deals d JOIN sponsorships ss ON ss.id=d.id JOIN sponsors sp ON sp.id=ss.sponsor_id LEFT JOIN sponsorship_programs pr ON pr.id=ss.program_id ORDER BY ss.created_at DESC, ss.id`, params),
      run(view, 'read', `SELECT sponsorship_id, currency, sum(amount_cents)::bigint AS committed, sum(confirmed)::bigint AS confirmed, sum(reported)::bigint AS reported,
          coalesce(sum(amount_cents) FILTER (WHERE status='scheduled' AND due_on < current_date),0)::bigint AS overdue FROM ob WHERE kind='money' GROUP BY sponsorship_id, currency ORDER BY sponsorship_id, currency`, params),
      run(view, 'read', `SELECT l.sponsorship_id, l.kind, l.label, l.currency, l.total_cents, l.amount_cents, l.instalments, l.cadence, l.estimate_cents, l.quantity, l.unit
        FROM deals d JOIN sponsorships ss ON ss.id=d.id JOIN sponsorship_lines l ON l.sponsorship_id=ss.id AND l.version=coalesce(ss.accepted_version, ss.terms_version) ORDER BY l.sponsorship_id, l.position`, params),
      run(view, 'read', `SELECT a.id, a.status, a.requested_cents, a.awarded_cents, a.offered_cents, a.currency, a.program_id, p.name AS program_name, p.sponsor_id, sp.name AS sponsor_name, r.name AS round_name, r.seq AS round_seq, ap.created_at, ap.decided_at
        FROM apps a JOIN sponsorship_applications ap ON ap.id=a.id JOIN sponsorship_programs p ON p.id=a.program_id JOIN sponsors sp ON sp.id=p.sponsor_id JOIN sponsorship_rounds r ON r.id=ap.round_id ORDER BY ap.created_at DESC, a.id`, params),
      run(view, 'read', `SELECT ob.id, ob.sponsorship_id, ob.kind, ob.due_on::text AS due_on, ob.amount_cents, ob.currency, ob.quantity, l.label, (ob.due_on < current_date) AS overdue
        FROM ob JOIN sponsorship_lines l ON l.id=ob.line_id WHERE ob.status='scheduled' ORDER BY ob.due_on, ob.id LIMIT 30`, params),
      run(view, 'read', `SELECT c.id, w.sponsorship_id, c.text, c.due_on::text AS due_on, c.blocks_payment, c.met_at FROM sponsorship_awards w JOIN sponsorship_award_conditions c ON c.award_id=w.id JOIN deals d ON d.id=w.sponsorship_id
        WHERE w.status='accepted' AND c.removed_at IS NULL ORDER BY c.due_on NULLS LAST, c.id`, params),
      // youth: a sponsor never reads notes about a minor from here; the recipient and guardians keep them in the agreement
      head.youth ? [] : run(view, 'read', `SELECT r.id, r.sponsorship_id, r.body, r.visibility, r.next_review_on::text, r.response, r.created_at, (r.author_id=$1) AS mine, u.display_name AS author
        FROM sponsorship_reviews r JOIN deals d ON d.id=r.sponsorship_id JOIN users u ON u.id=r.author_id WHERE d.may_review AND (r.visibility='shared' OR r.author_id=$1) ORDER BY r.created_at DESC, r.id LIMIT 50`, params),
      run(view, 'read', `SELECT p.id, p.status, p.amount_cents, p.currency, p.created_at, p.paid_on::text AS paid_on, ob.sponsorship_id, ob.stale_report FROM sponsorship_payments p JOIN ob ON ob.id=p.obligation_id WHERE p.status='reported' ORDER BY p.created_at, p.id`, params),
      run(view, 'read', `SELECT s.id, s.status, s.created_at, s.evidence_url, ob.sponsorship_id, l.promoter, l.label FROM sponsorship_submissions s JOIN ob ON ob.id=s.obligation_id JOIN sponsorship_lines l ON l.id=ob.line_id ORDER BY s.created_at DESC, s.id LIMIT 50`, params),
      run(view, 'read', `SELECT w.id, w.sponsorship_id, w.letter_version, w.issued_at, w.status FROM sponsorship_awards w JOIN sponsorship_applications ap ON ap.id=w.application_id JOIN apps a ON a.id=ap.id WHERE w.letter IS NOT NULL ORDER BY w.issued_at DESC, w.id`, params),
      run(view, 'read', `SELECT p.id, p.evidence_url, p.created_at, p.amount_cents, p.currency, ob.sponsorship_id FROM sponsorship_payments p JOIN ob ON ob.id=p.obligation_id WHERE p.evidence_url IS NOT NULL ORDER BY p.created_at DESC, p.id LIMIT 50`, params),
      run(view, 'read', `SELECT * FROM (
          SELECT ap.created_at AS at, 'application_submitted' AS kind, NULL::uuid AS sponsorship_id, a.id AS ref, NULL::text AS detail FROM apps a JOIN sponsorship_applications ap ON ap.id=a.id
          UNION ALL SELECT ap.decided_at, 'application_' || a.status, NULL, a.id, NULL FROM apps a JOIN sponsorship_applications ap ON ap.id=a.id WHERE ap.decided_at IS NOT NULL AND a.status IN ('awarded','declined')
          UNION ALL SELECT w.issued_at, 'award_issued', w.sponsorship_id, w.id, NULL FROM sponsorship_awards w JOIN apps a ON a.id=w.application_id WHERE w.issued_at IS NOT NULL
          UNION ALL SELECT w.responded_at, 'award_' || w.status, w.sponsorship_id, w.id, NULL FROM sponsorship_awards w JOIN apps a ON a.id=w.application_id WHERE w.responded_at IS NOT NULL AND w.status IN ('accepted','declined')
          UNION ALL SELECT h.created_at, 'agreement_' || h.action, h.sponsorship_id, NULL::uuid, NULL FROM sponsorship_history h JOIN deals d ON d.id=h.sponsorship_id WHERE h.action <> 'payment_confirmed'
          UNION ALL SELECT p.decided_at, 'payment_confirmed', ob.sponsorship_id, p.id, p.currency || ' ' || p.amount_cents FROM sponsorship_payments p JOIN ob ON ob.id=p.obligation_id WHERE p.status='confirmed' AND p.decided_at IS NOT NULL
        ) h ORDER BY at DESC, kind, ref NULLS LAST, sponsorship_id NULLS LAST LIMIT 60`, params),
      // only a count, only of other sponsors' public active deals: their terms and identity stay theirs
      sponsor ? pool.query("SELECT count(DISTINCT ss.sponsor_id)::int AS n FROM sponsorships ss WHERE ss.target_type=$1 AND ss.target_id=$2 AND ss.status='active' AND ss.visibility='public' AND ss.sponsor_id <> ALL($3::uuid[])",
        [i.target_type, i.target_id, [...new Set((await run(view, 'read', 'SELECT DISTINCT sponsor_id FROM deals', params)).map((r) => r.sponsor_id))]]).then((r) => r.rows[0].n) : Promise.resolve(null),
    ]);
    // what this person may do per brand (read live); a recipient acts as themselves
    const roles = new Map();
    if (sponsor) for (const sid of new Set(agreements.map((a) => a.sponsor_id).concat(apps.map((a) => a.sponsor_id)))) {
      const sp = (await pool.query('SELECT id, owner_id, organisation_id, entity_id FROM sponsors WHERE id=$1', [sid])).rows[0];
      roles.set(sid, await sponsorAccess(user, sp));
    }
    const may = (sid, action) => !sponsor || (!!roles.get(sid) && actionsFor(roles.get(sid).role).includes(action));
    const ref = new Map(agreements.map((a) => [a.id, a]));
    const sponsorOf = (sid) => ref.get(sid)?.sponsor_id;
    const today = new Date().toISOString().slice(0, 10);

    const risks = head.risks.map((code) => ({ code, label: RISKS[code] }));
    const actions = [];
    const act = (code, text, extra = {}) => actions.push({ code, label: text, ...extra });
    for (const o of upcoming.filter((x) => x.overdue)) {
      if (sponsor && o.kind === 'money' && may(sponsorOf(o.sponsorship_id), 'pay')) act('report_payment', `Report the overdue payment “${o.label}” (due ${o.due_on})`, { sponsorship_id: o.sponsorship_id, due_on: o.due_on });
      else if (sponsor && o.kind === 'goods' && may(sponsorOf(o.sponsorship_id), 'pay')) act('dispatch_goods', `Dispatch the overdue goods “${o.label}” (due ${o.due_on})`, { sponsorship_id: o.sponsorship_id, due_on: o.due_on });
      else if (!sponsor) act('overdue_from_sponsor', `“${o.label}” was due ${o.due_on} and has not been fulfilled`, { sponsorship_id: o.sponsorship_id, due_on: o.due_on });
    }
    for (const p of pending) {
      if (sponsor && p.stale_report && may(sponsorOf(p.sponsorship_id), 'pay')) act('chase_confirmation', 'A reported payment is still unconfirmed by the recipient', { sponsorship_id: p.sponsorship_id });
      if (!sponsor) act('confirm_payment', `Confirm or reject the reported payment of ${fmt(p.amount_cents, p.currency)}`, { sponsorship_id: p.sponsorship_id });
    }
    for (const s of subs.filter((x) => x.status === 'submitted')) {
      if (sponsor ? s.promoter === 'recipient' && may(sponsorOf(s.sponsorship_id), 'evaluate') : s.promoter === 'sponsor') act('review_endorsement', `Review the endorsement evidence for “${s.label}”`, { sponsorship_id: s.sponsorship_id });
    }
    for (const a of agreements) {
      if (a.status === 'proposed') act(sponsor ? 'await_response' : 'answer_offer', sponsor ? `Waiting for the recipient to answer ${a.sponsor_name}'s offer` : `Answer the offer from ${a.sponsor_name}`, { sponsorship_id: a.id });
      if (a.status === 'active' && a.ends_on && a.ends_on >= today && a.ends_on <= new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) && may(a.sponsor_id, 'revise')) act('renew_or_end', `The agreement with ${a.sponsor_name} ends ${a.ends_on}: renew it or let it end`, { sponsorship_id: a.id, due_on: a.ends_on });
    }
    for (const r of reviews.filter((x) => !x.mine && x.visibility === 'shared' && !x.response && !sponsor)) act('respond_review', 'Answer a review note', { sponsorship_id: r.sponsorship_id });
    for (const a of agreements.filter((x) => x.status === 'active')) {
      const last = reviews.find((r) => r.sponsorship_id === a.id && r.visibility === 'shared');
      if (sponsor && last?.next_review_on && last.next_review_on < today && may(a.sponsor_id, 'evaluate')) act('write_review', `The review with ${a.sponsor_name} was due ${last.next_review_on}`, { sponsorship_id: a.id, due_on: last.next_review_on });
    }
    for (const a of apps.filter((x) => x.status === 'submitted' || x.status === 'awarded')) {
      const gap = Number(a.requested_cents) - (a.status === 'awarded' ? Number(a.awarded_cents) : Number(a.offered_cents ?? 0));
      if (sponsor && gap > 0 && may(a.sponsor_id, 'program')) act('review_funding_gap', `${a.program_name}: ${fmt(gap, a.currency)} of the request is not yet awarded or offered`, { program_id: a.program_id });
    }
    for (const w of letters.filter((x) => x.status === 'issued')) if (!sponsor) act('respond_to_award', 'An award offer is waiting for your answer', { sponsorship_id: w.sponsorship_id, award_id: w.id });

    const milestones = [
      ...upcoming.map((o) => ({ type: 'due', due_on: o.due_on, label: o.label, kind: o.kind, amount_cents: o.kind === 'money' ? Number(o.amount_cents) : null, currency: o.currency, quantity: o.quantity, overdue: o.overdue, sponsorship_id: o.sponsorship_id })),
      ...conds.filter((c) => c.due_on && !c.met_at).map((c) => ({ type: 'condition', due_on: c.due_on, label: c.text, blocks_payment: c.blocks_payment, overdue: c.due_on < today, sponsorship_id: c.sponsorship_id })),
      ...agreements.filter((a) => a.status === 'active' && a.ends_on).map((a) => ({ type: 'agreement_end', due_on: a.ends_on, label: `${a.sponsor_name} agreement ends`, overdue: false, sponsorship_id: a.id })),
      ...reviews.filter((r) => r.visibility === 'shared' && r.next_review_on && r.next_review_on >= today).map((r) => ({ type: 'review', due_on: r.next_review_on, label: 'Scheduled review', overdue: false, sponsorship_id: r.sponsorship_id })),
    ].sort((a, b) => (a.due_on < b.due_on ? -1 : a.due_on > b.due_on ? 1 : a.type < b.type ? -1 : 1));

    const documents = [
      ...letters.filter((w) => w.status !== 'withdrawn').map((w) => ({ kind: 'award_letter', label: `Award letter v${w.letter_version ?? 1}`, at: w.issued_at, sponsorship_id: w.sponsorship_id, award_id: w.id })),
      ...evidence.map((p) => ({ kind: 'payment_evidence', label: `Payment evidence (${fmt(p.amount_cents, p.currency)})`, at: p.created_at, sponsorship_id: p.sponsorship_id, url: p.evidence_url })),
      ...subs.map((s) => ({ kind: 'endorsement_evidence', label: `Endorsement evidence: ${s.label} (${s.status.replace('_', ' ')})`, at: s.created_at, sponsorship_id: s.sponsorship_id, url: s.evidence_url })),
    ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

    const out = {
      view, available_views,
      beneficiary: { target_type: head.target_type, target_id: head.target_id, name: head.name, stage: head.stage, youth_limited: !!head.youth },
      totals: money.map(shapeMoney),
      agreements: agreements.map((a) => ({
        id: a.id, agreement_ref: a.agreement_ref, status: a.status, sponsor: { id: a.sponsor_id, name: a.sponsor_name }, program: a.program_id ? { id: a.program_id, name: a.program_name } : null,
        starts_on: a.starts_on, ends_on: a.ends_on, terms_version: a.accepted_version ?? a.terms_version, visibility: a.visibility,
        lines: lines.filter((l) => l.sponsorship_id === a.id).map(({ sponsorship_id, ...l }) => l),
        money: agMoney.filter((m) => m.sponsorship_id === a.id).map(shapeMoney),
        legacy: a.has_lines ? undefined : { amount_cents: a.legacy_amount_cents, in_kind: a.legacy_in_kind, note: 'Predates structured terms: the currency was never recorded, so it is not counted in any total' },
      })),
      applications: apps.map((a) => ({ id: a.id, status: a.status, program: { id: a.program_id, name: a.program_name, round: a.round_name }, sponsor: { id: a.sponsor_id, name: a.sponsor_name }, currency: a.currency,
        requested_cents: Number(a.requested_cents), awarded_cents: a.status === 'awarded' ? Number(a.awarded_cents) : null, offered_cents: a.offered_cents == null ? null : Number(a.offered_cents), submitted_at: a.created_at, decided_at: a.decided_at })),
      history: hist.map((h) => ({ at: h.at, kind: h.kind, label: label(h.kind.replace(/^agreement_/, '')), sponsorship_id: h.sponsorship_id, detail: h.kind === 'payment_confirmed' && h.detail ? fmt(h.detail.split(' ')[1], h.detail.split(' ')[0]) : h.detail })),
      milestones, documents, reviews, risks, next_actions: actions,
      other_public_sponsors: others,
    };
    out.snapshot = createHash('sha1').update(JSON.stringify([out.totals, out.agreements, out.applications, out.history.slice(0, 5), out.milestones, out.documents.length, out.reviews.length, out.risks, out.next_actions.length])).digest('hex').slice(0, 16);
    return out;
  },
});
