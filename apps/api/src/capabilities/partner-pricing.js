// Platform pricing: the platform team owns the price list shown for every venue. Venue price changes (peak / off-peak /
// custom rules, base rates, categories) arrive as price requests that the platform approves, counters or rejects; only then
// are they written back against the venue. The platform can also set the price list directly and gets an explainable
// suggestion built from location (peer prices), demand, rating, facilities and discounts.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { mustFind } from '../helpers.js';
import { canManage } from '../booking/engine.js';
import { hhmm } from '../booking/time.js';
import { notify, notifyVenueTeam } from '../notify.js';
import { isPlatform } from '../platform.js';
import { appendThread, applyPriceChange, recordPriceList } from '../pricing.js';

const TAG = 'Platform pricing';
const platformOnly = (user) => { if (!isPlatform(user)) throw forbidden('Only the platform team can do that'); };
const clock = z.string().regex(/^\d{1,2}:\d{2}$/, 'use HH:MM').refine((s) => !Number.isNaN(hhmm(s)), 'not a valid time');
const ruleShape = z.object({
  name: z.string().min(1).max(60), resource_id: id.optional(), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  start: clock.default('00:00'), end: clock.default('24:00'), hourly_rate_cents: money, valid_from: z.string().date().optional(), valid_to: z.string().date().optional(), priority: z.number().int().min(-100).max(100).default(0),
});

// ------------------------------------------------------------------ price requests and negotiation
cap({
  name: 'list_price_requests', method: 'GET', path: '/price-requests', tag: TAG,
  summary: 'Price change requests with their negotiation thread. The platform team sees the whole queue (default: open ones); a venue team passes `venue_id` to see its own.',
  input: z.object({ venue_id: id.optional(), status: z.enum(['open', 'pending', 'countered', 'approved', 'rejected', 'withdrawn']).default('open'), ...page }),
  async handler({ user }, i) {
    if (!isPlatform(user)) {
      if (!i.venue_id) throw badRequest('Pass venue_id');
      if (!(await canManage(user, i.venue_id))) throw forbidden('Only the venue team can see this');
    }
    return many(
      `SELECT q.*, v.name AS venue_name, v.city, v.currency, u.handle AS requested_by_handle FROM price_requests q JOIN venues v ON v.id=q.venue_id JOIN users u ON u.id=q.requested_by
        WHERE ($1::uuid IS NULL OR q.venue_id=$1) AND (CASE WHEN $2='open' THEN q.status IN ('pending','countered') ELSE q.status=$2 END)
        ORDER BY q.created_at DESC LIMIT $3 OFFSET $4`, [i.venue_id ?? null, i.status, i.limit, i.offset]);
  },
});

cap({
  name: 'decide_price_request', method: 'POST', path: '/admin/price-requests/:id/decision', tag: TAG,
  summary: 'Platform team: `approve` a venue price request (optionally `adjust` the figures — the platform price wins), `counter` with different figures for the venue to accept or decline, or `reject`. On approval the price is written back against the venue and recorded as a new price-list version.',
  input: z.object({ id, action: z.enum(['approve', 'counter', 'reject']), adjust: z.record(z.string(), z.any()).optional().describe('fields to replace in the request, e.g. {"hourly_rate_cents": 90000}'), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    platformOnly(user);
    if (i.action !== 'approve' && !i.note) throw badRequest('Give the venue a note');
    if (i.action === 'counter' && !i.adjust) throw badRequest('A counter-offer needs `adjust`');
    return tx(async (c) => {
      const q = (await c.query('SELECT * FROM price_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!q) throw notFound('Price request');
      if (!['pending', 'countered'].includes(q.status)) throw conflict(`That request is already ${q.status}`);
      const final = { ...q.payload, ...(i.adjust ?? {}) };
      let result = null, status;
      if (i.action === 'approve') {
        result = await applyPriceChange(c, { venueId: q.venue_id, kind: q.kind, targetId: q.target_id, payload: final, actorId: user.id });
        await recordPriceList(c, q.venue_id, user.id, { note: `Request approved${i.adjust ? ' with platform adjustments' : ''}` });
        status = 'approved';
      } else status = i.action === 'counter' ? 'countered' : 'rejected';
      await c.query('UPDATE price_requests SET status=$2, counter=$3, thread=$4, decided_by=$5, decided_at=CASE WHEN $2 IN (\'approved\',\'rejected\') THEN now() ELSE decided_at END WHERE id=$1',
        [q.id, status, i.action === 'counter' ? JSON.stringify(final) : q.counter, appendThread(user, q.thread, i.action, i.note), user.id]);
      const venue = (await c.query('SELECT * FROM venues WHERE id=$1', [q.venue_id])).rows[0];
      await notifyVenueTeam(c, venue, user.id, { kind: 'price_request', title: `${venue.name}: price request ${status}`, body: i.note ?? (status === 'approved' ? 'The new price is live.' : ''), data: { venue_id: venue.id, request_id: q.id } });
      return { id: q.id, status, applied: status === 'approved' ? result : undefined };
    });
  },
});

cap({
  name: 'respond_price_request', method: 'POST', path: '/price-requests/:id/response', tag: TAG,
  summary: 'Venue team: answer the platform\'s counter-offer (`accept` applies it as the live price, `decline` closes the request) or `withdraw` your own open request.',
  input: z.object({ id, action: z.enum(['accept', 'decline', 'withdraw']), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const q = (await c.query('SELECT * FROM price_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!q) throw notFound('Price request');
      if (!(await canManage(user, q.venue_id, c))) throw forbidden('Only the venue team can do that');
      if (!['pending', 'countered'].includes(q.status)) throw conflict(`That request is already ${q.status}`);
      if (i.action === 'accept' && q.status !== 'countered') throw conflict('There is no counter-offer to accept');
      let status = i.action === 'accept' ? 'approved' : i.action === 'decline' ? 'rejected' : 'withdrawn';
      if (i.action === 'accept') {
        await applyPriceChange(c, { venueId: q.venue_id, kind: q.kind, targetId: q.target_id, payload: q.counter, actorId: q.decided_by });
        await recordPriceList(c, q.venue_id, q.decided_by, { note: 'Counter-offer accepted by the venue' });
      }
      await c.query('UPDATE price_requests SET status=$2, thread=$3, decided_at=now() WHERE id=$1', [q.id, status, appendThread(user, q.thread, i.action, i.note)]);
      return { id: q.id, status };
    });
  },
});

// ------------------------------------------------------------------ price list set by the platform
cap({
  name: 'apply_pricing_plan', method: 'POST', path: '/admin/venues/:id/pricing', tag: TAG,
  summary: 'Platform team: set the venue\'s price list directly — base rates per area and platform rules (peak / off-peak / seasonal) — overriding anything the venue set. Retire rules with `retire_rule_ids`. Records a numbered price-list version with the factors behind the decision (use suggest_venue_pricing for them).',
  input: z.object({
    id, base_rates: z.array(z.object({ resource_id: id, hourly_rate_cents: money })).max(200).default([]), rules: z.array(ruleShape).max(100).default([]), retire_rule_ids: z.array(id).max(200).default([]),
    factors: z.record(z.string(), z.any()).optional(), note: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    platformOnly(user);
    await mustFind('venues', i.id);
    if (!i.base_rates.length && !i.rules.length && !i.retire_rule_ids.length) throw badRequest('Nothing to change');
    return tx(async (c) => {
      for (const b of i.base_rates) {
        const ok = (await c.query("UPDATE resources SET hourly_rate_cents=$3, rate_source='platform' WHERE id=$1 AND venue_id=$2 RETURNING id", [b.resource_id, i.id, b.hourly_rate_cents])).rowCount;
        if (!ok) throw badRequest('An area in base_rates does not belong to this venue');
      }
      for (const rid of i.retire_rule_ids) await c.query('UPDATE price_rules SET active=false WHERE id=$1 AND venue_id=$2', [rid, i.id]);
      for (const r of i.rules) await applyPriceChange(c, { venueId: i.id, kind: 'rule_create', payload: r, actorId: user.id });
      const version = await recordPriceList(c, i.id, user.id, { factors: i.factors, note: i.note });
      const venue = (await c.query('SELECT * FROM venues WHERE id=$1', [i.id])).rows[0];
      await notifyVenueTeam(c, venue, user.id, { kind: 'price_list', title: `${venue.name}: new platform price list (v${version.version})`, body: i.note ?? 'The platform team updated your venue pricing.', data: { venue_id: venue.id } });
      return version;
    });
  },
});

cap({
  name: 'price_list_history', method: 'GET', path: '/venues/:id/price-list-history', tag: TAG,
  summary: 'Every platform price decision for a venue as numbered versions (what the rates were, the factors, who decided). Visible to the platform team and the venue team.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    if (!isPlatform(user) && !(await canManage(user, i.id))) throw forbidden('Only the venue team can see this');
    return many('SELECT l.id, l.version, l.snapshot, l.factors, l.note, l.created_at, u.handle AS decided_by FROM price_list_versions l LEFT JOIN users u ON u.id=l.created_by WHERE l.venue_id=$1 ORDER BY l.version DESC LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ pricing assistant
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const roundTo = (n, step) => Math.max(0, Math.round(n / step) * step);

cap({
  name: 'suggest_venue_pricing', method: 'GET', path: '/admin/venues/:id/pricing-suggestion', tag: TAG,
  summary: 'Pricing assistant for the platform team: a recommended price list for a venue built from location (what comparable venues in the city charge for the same kind of area and sport), demand (30-day utilisation), rating, facilities and the discounts the venue gives. Every adjustment is listed with its reason; feed the result to apply_pricing_plan.',
  input: z.object({ id }),
  async handler({ user }, i) {
    platformOnly(user);
    const v = await mustFind('venues', i.id);
    const [areas, stats, peers, disc] = await Promise.all([
      many('SELECT id, name, kind, sport_id, hourly_rate_cents, indoor FROM resources WHERE venue_id=$1 AND active AND kind <> \'equipment\' ORDER BY name', [i.id]),
      one(`SELECT (SELECT round(avg(rating),2)::float8 FROM testimonials WHERE subject_type='venue' AND subject_id=$1) AS rating,
                  (SELECT count(*)::int FROM testimonials WHERE subject_type='venue' AND subject_id=$1) AS reviews,
                  (SELECT coalesce(sum(extract(epoch FROM b.ends_at - b.starts_at) / 3600 * b.quantity),0)::float8 FROM bookings b JOIN resources r ON r.id=b.resource_id
                    WHERE r.venue_id=$1 AND b.status IN ('confirmed','no_show') AND b.starts_at > now() - interval '30 days' AND b.starts_at < now()) AS unit_hours`, [i.id]),
      many(`SELECT r.kind, r.sport_id, r.hourly_rate_cents FROM resources r JOIN venues pv ON pv.id=r.venue_id
             WHERE pv.id <> $1 AND pv.active AND pv.approval_status='approved' AND r.active AND r.hourly_rate_cents > 0 AND ($2::text IS NULL OR pv.city ILIKE $2)`, [i.id, v.city ?? null]),
      one("SELECT coalesce(avg(CASE WHEN kind='percent' THEN value ELSE NULL END),0)::float8 AS avg_pct, count(*)::int AS n FROM discounts WHERE venue_id=$1 AND active AND code IS NULL AND (valid_to IS NULL OR valid_to >= current_date)", [i.id]),
    ]);
    const factors = [];
    const adj = (key, label, pct, detail) => factors.push({ key, label, adjust_pct: pct, detail });
    // demand
    const capacityHours = Math.max(1, areas.length) * 30 * 10;
    const util = stats.unit_hours / capacityHours;
    const dPct = stats.unit_hours === 0 ? 0 : util > 0.6 ? 10 : util > 0.4 ? 5 : util < 0.05 ? -12 : util < 0.15 ? -8 : 0;
    adj('demand', 'Demand', dPct, stats.unit_hours === 0 ? 'No bookings in the last 30 days (new or not yet live): no demand signal' : `${Math.round(util * 100)}% utilisation over 30 days`);
    // rating
    const rPct = stats.reviews >= 5 && stats.rating >= 4.5 ? 5 : stats.reviews >= 3 && stats.rating >= 4 ? 2 : stats.reviews >= 3 && stats.rating < 3.5 ? -5 : 0;
    adj('rating', 'Rating', rPct, stats.reviews ? `${stats.rating} from ${stats.reviews} review(s)` : 'No reviews yet');
    // facilities
    const am = (v.amenities ?? []).length, inPct = areas.length && areas.filter((a) => a.indoor).length / areas.length > 0.5 ? 3 : 0;
    const fPct = (am >= 8 ? 5 : am >= 4 ? 2 : 0) + inPct;
    adj('facilities', 'Facilities', fPct, `${am} amenities${inPct ? ', mostly indoor areas' : ''}`);
    // discounts
    const dcPct = disc.avg_pct > 15 ? Math.min(5, Math.round(disc.avg_pct / 4)) : 0;
    adj('discounts', 'Discounts', dcPct, disc.n ? `${disc.n} standing offer(s), average ${Math.round(disc.avg_pct)}% off${dcPct ? ' — list price lifted so the net price stays competitive' : ''}` : 'No standing offers');
    const total = Math.max(-30, Math.min(40, factors.reduce((s, f) => s + f.adjust_pct, 0)));
    const multiplier = 1 + total / 100;
    // location: comparable venues in the same city
    const step = 100;
    const resources = areas.map((a) => {
      const same = peers.filter((p) => p.kind === a.kind && (a.sport_id ? p.sport_id === a.sport_id : true)).map((p) => p.hourly_rate_cents);
      const cityMedian = median(same), source = same.length >= 2 ? 'city peers' : 'current rate';
      const baseline = same.length >= 2 ? cityMedian : a.hourly_rate_cents;
      return { resource_id: a.id, name: a.name, kind: a.kind, current_cents: a.hourly_rate_cents, baseline_cents: baseline, baseline_source: source, peers: same.length, suggested_cents: baseline ? roundTo(baseline * multiplier, step) : null };
    });
    adj('location', 'Location', 0, `Baseline is the median of comparable ${v.city ?? ''} venues where at least 2 exist, otherwise the venue's current rate`);
    const rules = [
      { name: 'Weekday evenings (peak)', weekdays: [1, 2, 3, 4, 5], start: '17:00', end: '22:00', pct: 20 },
      { name: 'Weekends', weekdays: [0, 6], start: '07:00', end: '22:00', pct: 15 },
      { name: 'Weekday daytime (off-peak)', weekdays: [1, 2, 3, 4, 5], start: '06:00', end: '15:00', pct: -15 },
    ];
    const suggestedRules = rules.flatMap((r) => resources.filter((x) => x.suggested_cents).map((x) => ({ name: r.name, resource_id: x.resource_id, weekdays: r.weekdays, start: r.start, end: r.end, hourly_rate_cents: roundTo(x.suggested_cents * (1 + r.pct / 100), step), priority: 0, area: x.name })));
    return { venue_id: i.id, currency: v.currency, factors, total_adjust_pct: total, multiplier: Math.round(multiplier * 1000) / 1000, resources, suggested_rules: suggestedRules,
      note: 'Advisory. Review the figures, then apply them with apply_pricing_plan (base_rates + rules). Platform rules always override anything the venue has set.' };
  },
});
