// Academy OS 3/3: Academy Executive Home (one page with drill-downs), retention indicators and the advisory copilot.
// The home only composes read models from the canonical domains; every card names the screen/capability that owns the data.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many } from '../db.js';
import { forbidden } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { STAFF, STAFF_MONEY } from '../academy.js';
import { pnl, ageing } from '../academy-finance.js';
import { signals, SIGNAL_RULES } from '../academy-signals.js';
import { reviewQueue } from '../academy-outcomes.js';
import { answer, KINDS } from '../academy-ai.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

cap({
  name: 'list_academy_signals', method: 'GET', path: '/organisations/:id/academy/signals', tag: 'Academy',
  summary: 'Retention and engagement indicators (owner/admin; finance sees only the overdue-balance indicator; a coach sees attendance indicators for their own groups). Each is a stated rule with the evidence it fired on and the actions a person could take. There is no risk score and nothing is done automatically.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { role } = await orgFor(user, i.id, ['owner', 'admin', 'coach', 'finance']);
    const list = await signals(i.id, { coachId: role === 'coach' ? user.id : null, includeMoney: STAFF_MONEY.includes(role) && role !== 'coach', financeOnly: role === 'finance' });
    await audit(null, user.id, 'read_academy_signals', 'organisations', i.id);
    return { rules: SIGNAL_RULES, signals: list };
  },
});

cap({
  name: 'get_academy_executive_home', method: 'GET', path: '/organisations/:id/academy/executive', tag: 'Academy',
  summary: 'Academy Executive Home (owner/admin; finance sees the finance section only): people & demand, delivery, outcomes, finance and partners/risk in one read, for a date range. Every card carries the tab that owns its data. Items the system cannot know yet (cancelled sessions, staffing exceptions, until Academy OS 2/3) are reported as missing, not zero.',
  input: z.object({ id, from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    const { role } = await orgFor(user, i.id, STAFF_MONEY);
    const from = i.from ?? daysAgo(90), to = i.to ?? today();
    const out = { period: { from, to }, my_role: role };
    if (STAFF.includes(role)) {
      const stages = await many("SELECT stage, count(*)::int AS n FROM academy_applications WHERE organisation_id=$1 AND created_at::date BETWEEN $2 AND $3 GROUP BY 1", [i.id, from, to]);
      const s = Object.fromEntries(stages.map((r) => [r.stage, r.n]));
      const seats = await one(
        `SELECT coalesce(sum(p.capacity),0)::int AS capacity, count(*) FILTER (WHERE p.capacity IS NULL)::int AS uncapped,
                (SELECT count(*)::int FROM org_enrolments e JOIN academy_programmes pp ON pp.id=e.programme_id WHERE pp.organisation_id=$1 AND pp.status='published' AND pp.capacity IS NOT NULL AND e.status IN ('enrolled','paused')) AS enrolled_in_capped
           FROM academy_programmes p WHERE p.organisation_id=$1 AND p.status='published'`, [i.id]);
      const active = (await one("SELECT count(DISTINCT e.user_id)::int AS n FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.status IN ('enrolled','paused') AND e.programme_id IS NOT NULL", [i.id])).n;
      const newer = (await one("SELECT count(DISTINCT e.user_id)::int AS n FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.programme_id IS NOT NULL AND e.enrolled_at::date BETWEEN $2 AND $3 AND NOT EXISTS (SELECT 1 FROM org_enrolments e0 JOIN org_cohorts k0 ON k0.id=e0.cohort_id WHERE k0.organisation_id=$1 AND e0.user_id=e.user_id AND e0.enrolled_at::date < $2)", [i.id, from, to])).n;
      const returning = (await one("SELECT count(DISTINCT e.user_id)::int AS n FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.programme_id IS NOT NULL AND e.enrolled_at::date BETWEEN $2 AND $3 AND EXISTS (SELECT 1 FROM org_enrolments e0 JOIN org_cohorts k0 ON k0.id=e0.cohort_id WHERE k0.organisation_id=$1 AND e0.user_id=e.user_id AND e0.enrolled_at::date < $2)", [i.id, from, to])).n;
      out.people = { link: { tab: 'admissions' }, enrolled_athletes: active, funnel: s, new_athletes: newer, returning_athletes: returning, capacity: seats.capacity, enrolled_in_capped: seats.enrolled_in_capped,
        utilisation_pct: seats.capacity ? Math.round((seats.enrolled_in_capped / seats.capacity) * 1000) / 10 : null, uncapped_programmes: seats.uncapped, waitlisted: s.waitlisted ?? 0, formulas: { utilisation: 'enrolled in programmes with a capacity / sum of those capacities', retention: 'see per-programme unit economics in the P&L' } };
      const att = await one(
        `SELECT count(DISTINCT (a.cohort_id, a.session_date))::int AS sessions, count(*) FILTER (WHERE a.status='present')::int AS present, count(*) FILTER (WHERE a.status='absent')::int AS absent
           FROM org_attendance a JOIN org_cohorts k ON k.id=a.cohort_id WHERE k.organisation_id=$1 AND a.session_date BETWEEN $2 AND $3`, [i.id, from, to]);
      out.delivery = { link: { tab: 'programmes' }, sessions_recorded: att.sessions, attendance_pct: att.present + att.absent ? Math.round((att.present / (att.present + att.absent)) * 1000) / 10 : null,
        sessions_cancelled: null, staffing_exceptions: null, missing_note: 'Cancelled sessions and staffing / ratio exceptions need Academy OS 2/3 (sessions and staff assignment).' };
      const lv = await many("SELECT p.title, coalesce(d.to_level, d.from_level) AS level, d.decision, count(*)::int AS n FROM (SELECT DISTINCT ON (pathway_id, athlete_id) * FROM academy_progression_decisions WHERE organisation_id=$1 ORDER BY pathway_id, athlete_id, created_at DESC, id DESC) d JOIN academy_pathways p ON p.id=d.pathway_id GROUP BY 1, 2, 3 ORDER BY 1, 2", [i.id]);
      const assessed = await one("SELECT count(*) FILTER (WHERE status='approved')::int AS approved, count(*) FILTER (WHERE status IN ('submitted','appealed'))::int AS awaiting_review FROM academy_assessments WHERE organisation_id=$1 AND created_at::date BETWEEN $2 AND $3", [i.id, from, to]);
      const moves = await many("SELECT decision, count(*)::int AS n FROM academy_progression_decisions WHERE organisation_id=$1 AND created_at::date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1", [i.id, from, to]);
      const q = await reviewQueue(i.id);
      out.outcomes = { link: { tab: 'progress' }, level_distribution: lv, assessments_approved: assessed.approved, assessments_awaiting_review: assessed.awaiting_review, decisions: moves, review_queue: q.length, official_note: 'Official competition results stay in the event / passport views; they are not mixed into pathway levels.' };
      const sg = await signals(i.id, { includeMoney: true });
      const bySig = {};
      for (const x of sg) bySig[x.signal] = (bySig[x.signal] ?? 0) + 1;
      out.retention = { link: { tab: 'signals' }, indicators: bySig, athletes_flagged: new Set(sg.map((x) => x.athlete_id)).size };
      const sp = await one("SELECT count(*)::int AS n FROM sponsorships ss WHERE ss.status='active' AND (ss.target_type='organisation' AND ss.target_id=$1 OR ss.target_type='group' AND ss.target_id IN (SELECT id FROM org_cohorts WHERE organisation_id=$1))", [i.id]);
      const overdueOb = await one("SELECT count(*)::int AS n FROM sponsorship_obligations o JOIN sponsorships ss ON ss.id=o.sponsorship_id WHERE o.status='scheduled' AND o.due_on < current_date AND (ss.target_type='organisation' AND ss.target_id=$1 OR ss.target_type='group' AND ss.target_id IN (SELECT id FROM org_cohorts WHERE organisation_id=$1))", [i.id]);
      const prov = await one("SELECT count(*)::int AS n FROM org_provider_associations WHERE organisation_id=$1 AND status='active'", [i.id]);
      const lg = await one("SELECT count(*) FILTER (WHERE m.status IN ('active','on_hold'))::int AS open_matters, count(*) FILTER (WHERE m.id IS NULL)::int AS intakes_open FROM legal_intakes i LEFT JOIN legal_matters m ON m.intake_id=i.id WHERE i.acting_as='organisation' AND i.acting_for_id=$1", [i.id]);
      out.partners = { link: { tab: 'partners' }, active_sponsorships: sp.n, overdue_sponsor_obligations: overdueOb.n, providers: prov.n, legal_open_matters: lg.open_matters, legal_intakes_in_progress: lg.intakes_open };
    }
    const p = await pnl(i.id, { from, to });
    const ag = await ageing(i.id, to);
    out.finance = { link: { tab: 'finance' }, basis: p.basis, currencies: p.currencies.map((c) => ({ currency: c.currency, management_revenue_minor: c.totals.management_revenue_minor, cash_collected_minor: c.totals.cash_collected_minor, outstanding_minor: c.totals.outstanding_minor,
      staff_cost_minor: c.totals.staff_cost_minor, venue_cost_minor: c.totals.venue_cost_minor, contribution_minor: c.totals.contribution_minor, operating_result_minor: c.totals.operating_result_minor, margin_pct: c.totals.margin_pct, cost_picture_complete: c.totals.cost_picture_complete,
      programmes: c.programmes.map((r) => ({ programme_id: r.programme_id, title: r.title, management_revenue_minor: r.management_revenue_minor, operating_result_minor: r.operating_result_minor, margin_pct: r.margin_pct, contribution_complete: r.contribution_complete })) })),
      ageing: ag.currencies.map((c) => ({ currency: c.currency, total_minor: c.total_minor, buckets: c.buckets })) };
    await audit(null, user.id, 'read_academy_executive', 'organisations', i.id);
    return out;
  },
});

cap({
  name: 'ask_academy_copilot', method: 'POST', path: '/organisations/:id/academy/copilot', tag: 'Academy',
  summary: 'Advisory copilot for the academy executive (owner/admin; finance for the money questions): explains margin movement, capacity, receivables, retention indicators and progression, or drafts a management narrative. It reads only the source-linked figures the caller may see (no clinical data, no coach-private notes, no athlete names), marks facts versus suggestions with their source, and works without an AI model. It cannot change anything.',
  input: z.object({ id, kind: z.enum(['margin_variance', 'capacity', 'receivables', 'retention_plan', 'progression_summary', 'management_narrative']), question: z.string().max(300).optional(), from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    const { role } = await orgFor(user, i.id, STAFF_MONEY);
    if (role === 'finance' && !KINDS[i.kind].money) throw forbidden('Finance can ask the money questions only');
    await audit(null, user.id, `academy_copilot_${i.kind}`, 'organisations', i.id);
    return answer(i.id, i.kind, { from: i.from ?? daysAgo(90), to: i.to ?? today(), includeMoney: STAFF_MONEY.includes(role), question: i.question });
  },
});
