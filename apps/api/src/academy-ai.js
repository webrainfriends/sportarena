// Academy OS 3/3: the executive copilot. The deterministic answer is always built first from source-linked facts the caller is allowed to see;
// the shared LLM (ai.js) may only re-word it, and any statement it adds without a valid source reference is demoted to a suggestion.
// Athletes are never named in a prompt, no clinical or coach-private data is retrieved, and the copilot cannot act: proposals name the canonical
// capability a person would use.
import { z } from 'zod';
import { askJson, aiConfigured, AI_RULES, quoteData } from './ai.js';
import { pnl, ageing } from './academy-finance.js';
import { signals } from './academy-signals.js';
import { many } from './db.js';
import { reviewQueue } from './academy-outcomes.js';

export const KINDS = {
  margin_variance: { money: true, title: 'Why did margin move?' },
  capacity: { money: false, title: 'Which groups have room or demand?' },
  receivables: { money: true, title: 'Receivables to act on' },
  retention_plan: { money: false, title: 'Retention plan from the indicators' },
  progression_summary: { money: false, title: 'Progression summary' },
  management_narrative: { money: false, title: 'Management review narrative' },
};

const fmt = (m, cur) => (m == null ? 'missing' : `${cur} ${(m / 100).toFixed(2)}`);
const shift = (from, to) => { const ms = new Date(to) - new Date(from) + 864e5; const f = (d, k) => new Date(new Date(d).getTime() - k).toISOString().slice(0, 10); return { from: f(from, ms), to: f(to, ms) }; };

export async function facts(orgId, kind, { from, to, includeMoney }) {
  const out = { kind, period: { from, to }, sources: {}, statements: [] };
  const add = (text, source, type = 'fact') => out.statements.push({ text, type, source });
  if (['margin_variance', 'management_narrative', 'receivables'].includes(kind) && includeMoney) {
    const cur = await pnl(orgId, { from, to }), prev = await pnl(orgId, shift(from, to));
    out.sources.pnl = cur; out.sources.pnl_previous = prev;
    for (const c of cur.currencies) {
      const p = prev.currencies.find((x) => x.currency === c.currency)?.totals;
      const t = c.totals;
      add(`${c.currency}: management revenue ${fmt(t.management_revenue_minor, c.currency)}, operating result ${fmt(t.operating_result_minor, c.currency)}${t.margin_pct == null ? ', margin not shown because a cost category is missing' : `, margin ${t.margin_pct}%`} (invoice basis, ${from} to ${to}).`, 'pnl');
      if (kind !== 'receivables' && p) {
        const d = (k) => (t[k] ?? 0) - (p[k] ?? 0);
        add(`${c.currency} versus the previous equal period: revenue ${d('management_revenue_minor') >= 0 ? '+' : ''}${fmt(d('management_revenue_minor'), c.currency)}, staff cost ${fmt(d('staff_cost_minor'), c.currency)}, venue cost ${fmt(d('venue_cost_minor'), c.currency)}, refunds ${fmt(d('refunds_minor'), c.currency)}, discounts ${fmt(d('discounts_minor'), c.currency)}.`, 'pnl_previous');
      }
      const worst = [...c.programmes].filter((r) => r.margin_pct != null).sort((x, y) => x.margin_pct - y.margin_pct)[0];
      if (worst && kind !== 'receivables') add(`Lowest margin programme in ${c.currency}: ${worst.title} at ${worst.margin_pct}%.`, 'pnl');
      for (const r of c.programmes.filter((x) => x.missing_costs.includes('staff'))) add(`${r.title} has no staff cost entered, so its contribution is incomplete.`, 'pnl', 'fact');
    }
    if (['receivables', 'management_narrative'].includes(kind)) {
      const ag = await ageing(orgId, to);
      out.sources.ageing = ag;
      for (const c of ag.currencies) add(`${c.currency} receivables ${fmt(c.total_minor, c.currency)}: ${fmt(c.buckets.d1_30.amount_minor, c.currency)} 1-30 days, ${fmt(c.buckets.d31_60.amount_minor, c.currency)} 31-60, ${fmt(c.buckets.d61_90.amount_minor + c.buckets.d90_plus.amount_minor, c.currency)} over 60 days past due.`, 'ageing');
    }
  }
  if (['capacity', 'management_narrative'].includes(kind)) {
    const rows = await many(
      `SELECT p.id, p.title, p.capacity, (SELECT count(*)::int FROM org_enrolments e WHERE e.programme_id=p.id AND e.status IN ('enrolled','paused')) AS enrolled,
              (SELECT count(*)::int FROM academy_applications a WHERE a.programme_id=p.id AND a.stage='waitlisted') AS waitlisted
         FROM academy_programmes p WHERE p.organisation_id=$1 AND p.status='published' ORDER BY p.title, p.id`, [orgId]);
    out.sources.capacity = rows;
    for (const r of rows) {
      if (r.capacity == null) { add(`${r.title}: no capacity set, so utilisation is unknown.`, 'capacity'); continue; }
      const pct = Math.round((r.enrolled / r.capacity) * 100);
      if (r.waitlisted > 0 && r.enrolled < r.capacity) add(`${r.title}: ${r.waitlisted} waiting while ${r.capacity - r.enrolled} seats are free. Promote the waitlist.`, 'capacity');
      else if (pct < 60) add(`${r.title} is ${pct}% full (${r.enrolled}/${r.capacity}).`, 'capacity');
      else if (r.waitlisted > 0) add(`${r.title} is full with ${r.waitlisted} waiting: demand for another group.`, 'capacity');
    }
    const idle = rows.filter((r) => r.waitlisted > 0 && r.enrolled < (r.capacity ?? Infinity)).length;
    if (!out.statements.length) add('No capacity or waitlist exceptions.', 'capacity');
    out.sources.idle_with_waitlist = idle;
  }
  if (['retention_plan', 'management_narrative'].includes(kind)) {
    const sg = await signals(orgId, { includeMoney });
    const by = {};
    for (const s of sg) by[s.signal] = (by[s.signal] ?? 0) + 1;
    out.sources.signals = by;
    for (const [k, n] of Object.entries(by)) add(`${n} athlete${n === 1 ? '' : 's'} flagged by the "${k.replace(/_/g, ' ')}" rule.`, 'signals');
    if (!sg.length) add('No retention indicators are firing.', 'signals');
    if (kind === 'retention_plan') add('Suggested plan: contact each flagged family, offer an eligible alternative session or the next programme, and book a coach review. Nobody is excluded or re-priced automatically.', 'signals', 'suggestion');
  }
  if (['progression_summary', 'management_narrative'].includes(kind)) {
    const q = await reviewQueue(orgId);
    const by = {};
    for (const r of q) by[r.reason] = (by[r.reason] ?? 0) + 1;
    out.sources.review_queue = by;
    for (const [k, n] of Object.entries(by)) add(`${n} athlete${n === 1 ? '' : 's'}: ${k.replace(/_/g, ' ')}.`, 'review_queue');
    const dist = await many("SELECT p.title, coalesce(d.to_level, d.from_level) AS level, count(*)::int AS n FROM (SELECT DISTINCT ON (pathway_id, athlete_id) * FROM academy_progression_decisions WHERE organisation_id=$1 ORDER BY pathway_id, athlete_id, created_at DESC, id DESC) d JOIN academy_pathways p ON p.id=d.pathway_id WHERE d.decision <> 'graduate' GROUP BY 1, 2 ORDER BY 1, 2", [orgId]);
    out.sources.levels = dist;
    for (const r of dist) add(`${r.title}: ${r.n} at ${r.level}.`, 'levels');
    if (!q.length && !dist.length) add('No pathway activity yet.', 'review_queue');
  }
  return out;
}

const shape = z.object({ summary: z.string().max(1500), statements: z.array(z.object({ text: z.string().max(400), type: z.enum(['fact', 'suggestion']), source: z.string().max(40) })).max(20) });

export async function answer(orgId, kind, { from, to, includeMoney, question }) {
  const f = await facts(orgId, kind, { from, to, includeMoney });
  const base = { kind, title: KINDS[kind].title, period: f.period, ai: false, statements: f.statements, summary: f.statements.filter((s) => s.type === 'fact').map((s) => s.text).slice(0, 3).join(' ') || 'Nothing to report for this period.', note: 'Built from your records without an AI model. Advisory only: nothing here has been changed.' };
  if (!aiConfigured()) return base;
  const allowed = new Set(f.statements.map((s) => s.source));
  const r = await askJson({
    system: `You help an academy director read their own management figures. ${AI_RULES} Use only the numbers in the data. Say which statements are facts and which are suggestions. Never propose automatic admission, promotion, scholarship, pricing, refund, payment or schedule changes; a person does those. Each statement needs a "source" taken from the data.`,
    user: `<data>${JSON.stringify({ period: f.period, statements: f.statements })}</data>\nQuestion: <data>${quoteData(question ?? KINDS[kind].title, 300)}</data>`,
    schema: shape, shape: '{"summary": string, "statements": [{"text": string, "type": "fact"|"suggestion", "source": string}]}', maxTokens: 900,
  });
  if (!r) return base;
  const statements = r.statements.map((s) => (allowed.has(s.source) ? s : { ...s, type: 'suggestion', source: 'unverified' }));
  return { ...base, ai: true, summary: r.summary, statements, note: 'Drafted with an AI model from the figures above. Statements without a valid source are shown as suggestions. Advisory only.' };
}
