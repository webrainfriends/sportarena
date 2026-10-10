// Platform-controlled pricing. A venue never edits its live prices: its changes become price requests which the platform team
// approves, counters or rejects. Only on approval is the price written back against the venue (as platform pricing, which
// always wins over any older venue-set rule). Platform staff edit prices directly.
import { approvalsOn, isPlatform } from './platform.js';
import { badRequest, notFound } from './errors.js';
import { hhmm } from './booking/time.js';

/** Do this user's price edits on this venue have to be approved? (Platform staff never; a venue still being reviewed is approved as a whole.) */
export async function needsPriceApproval(c, user, venueId) {
  if (!approvalsOn() || isPlatform(user)) return false;
  const v = (await c.query('SELECT approval_status FROM venues WHERE id=$1', [venueId])).rows[0];
  if (!v) throw notFound('Venue');
  return v.approval_status === 'approved';
}

const entry = (user, action, note) => ({ at: new Date().toISOString(), by: user.id, role: isPlatform(user) ? 'platform' : 'venue', action, note: note ?? null });

export async function fileRequest(c, user, venueId, kind, targetId, payload, current) {
  const row = (await c.query(
    `INSERT INTO price_requests(venue_id, requested_by, kind, target_id, payload, current, thread) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [venueId, user.id, kind, targetId ?? null, JSON.stringify(payload), current ? JSON.stringify(current) : null, JSON.stringify([entry(user, 'requested')])])).rows[0];
  return { pending_platform_approval: true, message: 'Sent to the platform team. The price changes only once they approve it.', request: row };
}
export const appendThread = (user, thread, action, note) => JSON.stringify([...thread, entry(user, action, note)]);

const ruleCols = { name: 'name', resource_id: 'resource_id', weekdays: 'weekdays', hourly_rate_cents: 'hourly_rate_cents', valid_from: 'valid_from', valid_to: 'valid_to', priority: 'priority' };

/** Write an approved (or platform-made) price change against the venue. `c` is a transaction client. */
export async function applyPriceChange(c, { venueId, kind, targetId, payload, actorId }) {
  const p = payload;
  switch (kind) {
    case 'rule_create': {
      if (hhmm(p.end ?? '24:00') <= hhmm(p.start ?? '00:00')) throw badRequest('end must be after start');
      return (await c.query(
        `INSERT INTO price_rules(venue_id, resource_id, name, weekdays, start_min, end_min, hourly_rate_cents, valid_from, valid_to, priority, source, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'platform',$11) RETURNING *`,
        [venueId, p.resource_id ?? null, p.name, p.weekdays ?? null, hhmm(p.start ?? '00:00'), hhmm(p.end ?? '24:00'), p.hourly_rate_cents, p.valid_from ?? null, p.valid_to ?? null, p.priority ?? 0, actorId])).rows[0];
    }
    case 'rule_update': {
      const r = (await c.query('SELECT * FROM price_rules WHERE id=$1 AND venue_id=$2', [targetId, venueId])).rows[0];
      if (!r) throw notFound('Price rule');
      const set = [], vals = [targetId];
      for (const [k, col] of Object.entries(ruleCols)) if (p[k] !== undefined) { vals.push(p[k]); set.push(`${col}=$${vals.length}`); }
      if (p.start !== undefined) { vals.push(hhmm(p.start)); set.push(`start_min=$${vals.length}`); }
      if (p.end !== undefined) { vals.push(hhmm(p.end)); set.push(`end_min=$${vals.length}`); }
      if (p.active !== undefined) { vals.push(p.active); set.push(`active=$${vals.length}`); }
      vals.push(actorId); set.push(`source='platform'`, `approved_by=$${vals.length}`);
      return (await c.query(`UPDATE price_rules SET ${set.join(', ')} WHERE id=$1 RETURNING *`, vals)).rows[0];
    }
    case 'rule_delete':
      await c.query('UPDATE price_rules SET active=false WHERE id=$1 AND venue_id=$2', [targetId, venueId]);
      return { ok: true };
    case 'base_rate':
      return (await c.query(
        `UPDATE resources SET hourly_rate_cents=$3, rate_source='platform', active = CASE WHEN $4 THEN true ELSE active END WHERE id=$1 AND venue_id=$2 RETURNING *`,
        [targetId, venueId, p.hourly_rate_cents, !!p.activate])).rows[0];
    case 'category_create':
      return (await c.query('INSERT INTO price_categories(venue_id, name, color, hourly_rate_cents) VALUES ($1,$2,$3,$4) RETURNING *', [venueId, p.name, p.color ?? '#7c5cff', p.hourly_rate_cents])).rows[0];
    case 'category_update':
      return (await c.query('UPDATE price_categories SET name=coalesce($2,name), color=coalesce($3,color), hourly_rate_cents=coalesce($4,hourly_rate_cents), active=coalesce($5,active) WHERE id=$1 AND venue_id=$6 RETURNING *',
        [targetId, p.name ?? null, p.color ?? null, p.hourly_rate_cents ?? null, p.active ?? null, venueId])).rows[0];
    case 'category_rate':
      await c.query('INSERT INTO category_rates(category_id, resource_id, hourly_rate_cents) VALUES ($1,$2,$3) ON CONFLICT (category_id, resource_id) DO UPDATE SET hourly_rate_cents=EXCLUDED.hourly_rate_cents', [targetId, p.resource_id, p.hourly_rate_cents]);
      return { ok: true };
    default: throw badRequest(`Unknown price change ${kind}`);
  }
}

/** Snapshot the venue's live prices as a new numbered price-list version (audit of every platform price decision). */
export async function recordPriceList(c, venueId, userId, { factors = {}, note } = {}) {
  const base = await c.query('SELECT id AS resource_id, name, hourly_rate_cents, rate_source FROM resources WHERE venue_id=$1 AND active ORDER BY name', [venueId]);
  const rules = await c.query('SELECT id, name, resource_id, weekdays, start_min, end_min, hourly_rate_cents, valid_from, valid_to, priority, source FROM price_rules WHERE venue_id=$1 AND active ORDER BY created_at', [venueId]);
  const cats = await c.query('SELECT id, name, hourly_rate_cents FROM price_categories WHERE venue_id=$1 AND active ORDER BY name', [venueId]);
  const version = ((await c.query('SELECT coalesce(max(version),0)::int AS v FROM price_list_versions WHERE venue_id=$1', [venueId])).rows[0].v) + 1;
  return (await c.query('INSERT INTO price_list_versions(venue_id, version, snapshot, factors, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [venueId, version, JSON.stringify({ base_rates: base.rows, rules: rules.rows, categories: cats.rows }), JSON.stringify(factors), note ?? null, userId])).rows[0];
}
