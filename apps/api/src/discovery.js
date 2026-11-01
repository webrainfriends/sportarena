// One discovery read for the map and the list (#696). It composes the three existing searches (venues, open games, coach classes) so
// there is no fourth copy of the distance or availability logic: the pins on the map are exactly the rows in the list, from one call.
import { capabilities } from './registry.js';
import { isYouth } from './youth.js';
import { one } from './db.js';
import { roundCoord } from './geo.js';

const run = (name, user, input) => {
  const c = capabilities.find((x) => x.name === name);
  return c.handler({ user }, c.input.parse(input));
};

const toMinutes = (iso, tz) => {
  const p = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).formatToParts(new Date(iso));
  return Number(p.find((x) => x.type === 'hour').value) * 60 + Number(p.find((x) => x.type === 'minute').value);
};
export const hhmm = (s) => (s == null ? null : Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)));

const pin = (lat, lng) => ({ latitude: roundCoord(lat), longitude: roundCoord(lng) });

/** Normalised rows: the same fields whatever the kind, so one card and one pin component serve all three. */
const fromVenue = (v) => ({
  kind: 'venue', id: v.id, title: v.name, sport_slugs: v.sports ?? [], starts_at: null, ends_at: null,
  place: { venue_id: v.id, name: v.name, city: v.city, ...pin(v.latitude, v.longitude) }, distance_km: v.distance_km == null ? null : Number(v.distance_km),
  price_cents: v.min_hourly_rate_cents == null ? null : Number(v.min_hourly_rate_cents), price_unit: 'hour', currency: v.currency ?? null,
  seats_left: null, is_full: false, level: null, rating: v.rating == null ? null : Number(v.rating), reviews: v.reviews ?? 0, cover_url: v.cover_url ?? null, is_favourite: !!v.is_favourite,
  audience: 'all_ages',
});
const fromGame = (g) => ({
  kind: 'game', id: g.id, title: g.title, sport_slugs: [g.sport_slug], sport: g.sport, emoji: g.sport_emoji, starts_at: g.starts_at, ends_at: g.ends_at,
  place: { venue_id: g.place?.venue_id ?? null, name: g.place?.name ?? null, city: g.place?.city ?? null, ...pin(g.place?.latitude, g.place?.longitude) }, distance_km: g.distance_km ?? null,
  price_cents: g.cost?.per_player_cents == null ? null : Number(g.cost.per_player_cents), price_unit: 'player', currency: g.cost?.currency ?? null,
  seats_left: g.slots_left ?? null, is_full: !!g.is_full, level: g.skill?.label ?? null, level_min: g.skill?.min ?? null, level_max: g.skill?.max ?? null, audience: g.audience, host: g.host ? { handle: g.host.handle, display_name: g.host.display_name } : null,
});
const fromClass = (k) => ({
  kind: 'class', id: k.id, title: k.title, sport_slugs: [k.sport_slug], sport: k.sport, emoji: k.sport_emoji, starts_at: k.starts_at, ends_at: new Date(+new Date(k.starts_at) + k.duration_min * 60000).toISOString(),
  place: k.place ? { venue_id: k.place.venue_id, name: k.place.name, city: k.place.city, ...pin(k.place.latitude, k.place.longitude) } : null, distance_km: k.distance_km ?? null,
  price_cents: k.price_cents, price_unit: 'seat', currency: k.currency, seats_left: k.seats_left, is_full: k.is_full, level: k.skill?.label ?? null, level_min: k.skill?.min ?? null, level_max: k.skill?.max ?? null,
  audience: k.audience, is_online: !!k.is_online, coach: k.coach ? { handle: k.coach.handle, display_name: k.coach.display_name } : null,
});

/**
 * `f` is the validated discover_nearby input. Returns { items, pins, counts, total, as_of }.
 * Pins are derived from the items, never fetched separately, so the map and the list always agree.
 */
export async function discover(user, f) {
  const kinds = f.kinds?.length ? f.kinds : ['venue', 'game', 'class'];
  const sports = f.sport?.length ? f.sport : [undefined];
  const geo = { lat: f.lat, lng: f.lng, radius_km: f.radius_km, bbox: f.bbox };
  const win = { from: f.from, to: f.to };
  const viewerYouth = !!user && (await isYouth(user.id));
  const guardian = !!user && !!(await one("SELECT 1 AS ok FROM guardian_links WHERE guardian_id=$1 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [user.id]));
  const showYouth = viewerYouth || guardian; // minors' listings are never shown to the public
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
  const jobs = [];
  for (const sport of sports) {
    if (kinds.includes('venue')) {
      jobs.push(run('list_venues', user, clean({
        ...geo, sport, city: f.city, q: f.q, max_hourly_rate_cents: f.max_price_cents, limit: 100, sort: f.lat != null ? 'distance' : 'name',
        ...(f.from && f.to && new Date(f.to) - new Date(f.from) <= 12 * 36e5 ? { available_from: f.from, available_to: f.to } : {}), // a free-court window only makes sense for a few hours
      })).then((r) => r.map(fromVenue)));
    }
    if (kinds.includes('game')) {
      jobs.push(run('find_open_games', user, clean({
        ...geo, ...win, sport, level: f.level, max_cost_cents: f.max_price_cents, has_slots: f.has_seats, q: f.q || f.city, limit: 100, sort: 'soonest', tz: f.tz,
      })).then((r) => r.map(fromGame)));
    }
    if (kinds.includes('class')) {
      jobs.push(run('list_coach_classes', user, clean({
        ...geo, ...win, sport, level: f.level, max_price_cents: f.max_price_cents, has_seats: f.has_seats, city: f.city, limit: 100, sort: 'soonest',
      })).then((r) => r.map(fromClass)));
    }
  }
  let items = (await Promise.all(jobs)).flat();
  const seen = new Set();
  items = items.filter((x) => (seen.has(`${x.kind}:${x.id}`) ? false : (seen.add(`${x.kind}:${x.id}`), true)));
  if (f.q) { const q = f.q.toLowerCase(); items = items.filter((x) => x.kind === 'venue' || [x.title, x.place?.name, x.place?.city, x.sport].some((t) => t && t.toLowerCase().includes(q))); }
  if (!showYouth) items = items.filter((x) => x.audience !== 'youth');
  if (f.seats_left != null) items = items.filter((x) => x.seats_left == null || x.seats_left >= f.seats_left);
  const tf = hhmm(f.time_from), tt = hhmm(f.time_to);
  if (tf != null || tt != null) {
    items = items.filter((x) => {
      if (!x.starts_at) return true; // a venue has no start time: its free window is the date range
      const m = toMinutes(x.starts_at, f.tz);
      return (tf == null || m >= tf) && (tt == null || m <= tt);
    });
  }
  const order = {
    soonest: (a, b) => (a.starts_at ?? '9999') < (b.starts_at ?? '9999') ? -1 : (a.starts_at ?? '9999') > (b.starts_at ?? '9999') ? 1 : 0,
    distance: (a, b) => (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9),
    price: (a, b) => (a.price_cents ?? 1e12) - (b.price_cents ?? 1e12),
  }[f.sort];
  items.sort((a, b) => order(a, b) || String(a.title).localeCompare(String(b.title)));
  const counts = { venue: 0, game: 0, class: 0 };
  for (const x of items) counts[x.kind]++;
  const total = items.length;
  items = items.slice(f.offset, f.offset + f.limit);
  const pins = items.filter((x) => x.place?.latitude != null).map((x) => ({ key: `${x.kind}:${x.id}`, kind: x.kind, id: x.id, latitude: x.place.latitude, longitude: x.place.longitude }));
  return { items, pins, counts, total, as_of: new Date().toISOString() };
}
