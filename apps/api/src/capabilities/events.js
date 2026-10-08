import { badgesFor, withBadges } from '../verification.js';
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { hasRole, isAdmin, mustFind, mustOwn, sportBySlugOrId, standings } from '../helpers.js';
import { canManageTeam } from './teams.js';
import { hasOrgGrant } from '../org-access.js';
import { reserve } from './venues.js';
import { notify } from '../notify.js';

const dt = z.string().datetime({ offset: true });
const date = z.string().date();

async function eventForOrganizer(user, eventId, c) {
  const ev = await mustFind('events', eventId, '*', c);
  if (!(await hasOrgGrant(user, ev.organisation_id, ['owner', 'admin'], c))) mustOwn(user, ev.organizer_id, 'event');
  return ev;
}

cap({
  name: 'create_event', method: 'POST', path: '/events', tag: 'Events', auth: ['organizer'], status: 201,
  summary: 'Create a tournament, league, friendly, camp or trial. Points rules drive the standings.',
  input: z.object({
    name: z.string().min(2).max(100), sport: z.string(), kind: z.enum(['tournament', 'league', 'friendly', 'camp', 'trial']).default('tournament'),
    description: z.string().max(2000).optional(), venue_id: id.optional(), starts_on: date.optional(), ends_on: date.optional(),
    points_win: z.number().int().default(3), points_draw: z.number().int().default(1), points_loss: z.number().int().default(0),
    entry_fee_cents: money.default(0), banner_emoji: z.string().max(8).optional(),
    city: z.string().max(80).optional(), capacity: z.number().int().min(1).max(100000).optional(), registration_deadline: dt.optional(),
    currency: z.string().length(3).default('INR'), seeking_sponsors: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    if (i.starts_on && i.ends_on && i.ends_on < i.starts_on) throw badRequest('ends_on is before starts_on');
    return one(
      `INSERT INTO events(name, sport_id, organizer_id, kind, description, venue_id, starts_on, ends_on, points_win, points_draw, points_loss, entry_fee_cents, banner_emoji, status, city, capacity, registration_deadline, currency, seeking_sponsors)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,coalesce($13,'🏆'),'open',$14,$15,$16,upper($17),$18) RETURNING *`,
      [i.name, sport.id, user.id, i.kind, i.description, i.venue_id, i.starts_on, i.ends_on, i.points_win, i.points_draw, i.points_loss, i.entry_fee_cents, i.banner_emoji, i.city, i.capacity, i.registration_deadline, i.currency, i.seeking_sponsors]);
  },
});

const flag = z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')]); // query strings: "false" must mean false
const SEARCH_INPUT = {
  q: z.string().max(100).optional(), sport: z.string().optional(), kind: z.enum(['tournament', 'league', 'friendly', 'camp', 'trial']).optional(),
  status: z.enum(['draft', 'open', 'ongoing', 'completed', 'cancelled']).optional(), organizer_id: id.optional(), city: z.string().max(80).optional(),
  date_from: date.optional(), date_to: date.optional(), open_for_entry: flag.optional(), free: flag.optional(),
  max_fee_cents: money.optional(), seeking_sponsors: flag.optional(), verified: flag.optional(),
  sort: z.enum(['soonest', 'newest', 'fee_low']).default('soonest'), ...page,
};
const REG_OPEN = `(e.status='open' AND (e.registration_deadline IS NULL OR e.registration_deadline > now())
  AND (e.capacity IS NULL OR (SELECT count(*) FROM event_entries n WHERE n.event_id=e.id AND n.status IN ('accepted','pending')) < e.capacity))`;

/** Server-side event search shared by `list_events` and `search_events`. Public-safe card rows + total. */
async function searchEvents(i) {
  const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
  if (i.sport && !sport) return { items: [], total: 0, limit: i.limit, offset: i.offset };
  const args = [];
  const p = (v) => { args.push(v); return `$${args.length}`; };
  const w = ["e.status <> 'draft'"];
  if (sport) w.push(`e.sport_id=${p(sport.id)}`);
  if (i.status) w.push(`e.status=${p(i.status)}`);
  else w.push("e.status IN ('open','ongoing')");
  if (i.kind) w.push(`e.kind=${p(i.kind)}`);
  if (i.organizer_id) w.push(`e.organizer_id=${p(i.organizer_id)}`);
  if (i.q) w.push(`(e.name ILIKE ${p(`%${i.q}%`)} OR e.description ILIKE $${args.length} OR e.city ILIKE $${args.length})`);
  if (i.city) w.push(`lower(coalesce(e.city, (SELECT v.city FROM venues v WHERE v.id=e.venue_id))) = lower(${p(i.city)})`);
  if (i.date_from) w.push(`coalesce(e.ends_on, e.starts_on) >= ${p(i.date_from)}`);
  if (i.date_to) w.push(`e.starts_on <= ${p(i.date_to)}`);
  if (i.open_for_entry) w.push(REG_OPEN);
  if (i.free) w.push('e.entry_fee_cents = 0');
  if (i.max_fee_cents !== undefined) w.push(`e.entry_fee_cents <= ${p(i.max_fee_cents)}`);
  if (i.seeking_sponsors) w.push('e.seeking_sponsors');
  if (i.verified) w.push("EXISTS (SELECT 1 FROM verification_cases vc WHERE vc.subject_type='event' AND vc.subject_id=e.id AND vc.status='approved' AND vc.expires_at > now())");
  const where = w.join(' AND ');
  const order = { soonest: 'e.starts_on NULLS LAST, e.created_at DESC', newest: 'e.created_at DESC', fee_low: 'e.entry_fee_cents, e.starts_on NULLS LAST' }[i.sort];
  const [rows, tot] = await Promise.all([
    many(
      `SELECT e.id, e.name, e.kind, e.status, e.description, e.starts_on, e.ends_on, e.city, e.venue_id, e.organizer_id, e.entry_fee_cents, e.currency, e.capacity,
              e.registration_deadline, e.seeking_sponsors, e.banner_emoji, e.sport_id, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji,
              (SELECT count(*)::int FROM event_entries n WHERE n.event_id=e.id AND n.status='accepted') AS entrants,
              CASE WHEN e.capacity IS NULL THEN NULL ELSE greatest(e.capacity - (SELECT count(*)::int FROM event_entries n WHERE n.event_id=e.id AND n.status IN ('accepted','pending')), 0) END AS spots_left,
              ${REG_OPEN} AS registration_open
         FROM events e JOIN sports s ON s.id=e.sport_id WHERE ${where} ORDER BY ${order} LIMIT ${p(i.limit)} OFFSET ${p(i.offset)}`, args),
    one(`SELECT count(*)::int AS n FROM events e WHERE ${where}`, args.slice(0, args.length - 2)),
  ]);
  const items = (await withBadges('event', rows)).map((r) => ({ ...r, link: `/events/${r.id}` }));
  return { items, total: tot.n, limit: i.limit, offset: i.offset };
}

cap({
  name: 'search_events', method: 'GET', path: '/events/search', tag: 'Events', auth: 'public',
  summary: 'Search events (server-side filters, sort and paging): text, sport, kind, city, date range, open-for-entry, fee, sponsors wanted, verified. Returns cards + total.',
  input: z.object(SEARCH_INPUT),
  handler: (_, i) => searchEvents(i),
});

cap({
  name: 'list_events', method: 'GET', path: '/events', tag: 'Events', auth: 'public', summary: 'Discover events (same filters as search_events; plain array).',
  input: z.object(SEARCH_INPUT),
  async handler(_, i) { return (await searchEvents(i)).items; },
});

cap({
  name: 'get_event', method: 'GET', path: '/events/:id', tag: 'Events', auth: 'public',
  summary: 'Event page: details, entrants, standings, sponsors, rating.', input: z.object({ id }),
  async handler(_, i) {
    const ev = await one('SELECT e.*, s.name AS sport, s.emoji AS sport_emoji FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id=$1', [i.id]);
    if (!ev) throw notFound('Event');
    const [entrants, table, sponsors, rating, venue] = await Promise.all([
      many(`SELECT e.id AS entry_id, t.id AS team_id, t.name, t.emoji, t.color, u.id AS user_id, u.handle, u.display_name FROM event_entries e LEFT JOIN teams t ON t.id=e.team_id LEFT JOIN users u ON u.id=e.user_id WHERE e.event_id=$1 AND e.status='accepted'`, [i.id]),
      standings(i.id),
      many("SELECT sp.id, sp.name, sp.emoji, ss.in_kind FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ss.target_type='event' AND ss.target_id=$1 AND ss.status='active'", [i.id]),
      one("SELECT round(avg(rating),2) AS avg, count(*)::int AS n FROM testimonials WHERE subject_type='event' AND subject_id=$1", [i.id]),
      ev.venue_id ? one('SELECT id, name, city, emoji FROM venues WHERE id=$1', [ev.venue_id]) : null,
    ]);
    return { ...ev, verified: (await badgesFor('event', [ev.id])).get(ev.id) ?? [], venue, entrants, standings: table, sponsors, rating };
  },
});

const NEXT_STATUS = { draft: ['open', 'cancelled'], open: ['ongoing', 'cancelled'], ongoing: ['cancelled'], completed: [], cancelled: [] };

cap({
  name: 'update_event', method: 'PATCH', path: '/events/:id', tag: 'Events', summary: 'Edit an event you organise. Status moves open → ongoing/cancelled only; cancelling notifies entrants.',
  input: z.object({
    id, name: z.string().min(2).max(100).optional(), description: z.string().max(2000).optional(), status: z.enum(['open', 'ongoing', 'cancelled']).optional(),
    starts_on: date.optional(), ends_on: date.optional(), venue_id: id.optional(), city: z.string().max(80).optional(),
    capacity: z.number().int().min(1).max(100000).optional(), registration_deadline: dt.optional(), seeking_sponsors: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = (await c.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!ev) throw notFound('Event');
      mustOwn(user, ev.organizer_id, 'event');
      if (i.status && i.status !== ev.status && !NEXT_STATUS[ev.status].includes(i.status)) throw conflict(`An event that is ${ev.status} cannot become ${i.status}`);
      if ((i.starts_on || i.ends_on) && (await c.query('SELECT coalesce($2::date, ends_on) < coalesce($1::date, starts_on) AS bad FROM events WHERE id=$3', [i.starts_on ?? null, i.ends_on ?? null, i.id])).rows[0].bad) throw badRequest('ends_on is before starts_on');
      if (i.capacity) {
        const used = (await c.query("SELECT count(*)::int AS n FROM event_entries WHERE event_id=$1 AND status='accepted'", [i.id])).rows[0].n;
        if (i.capacity < used) throw conflict(`${used} entries are already accepted; capacity cannot go below that`);
      }
      const out = (await c.query(
        `UPDATE events SET name=coalesce($2,name), description=coalesce($3,description), status=coalesce($4,status), starts_on=coalesce($5,starts_on), ends_on=coalesce($6,ends_on),
           venue_id=coalesce($7,venue_id), city=coalesce($8,city), capacity=coalesce($9,capacity), registration_deadline=coalesce($10,registration_deadline), seeking_sponsors=coalesce($11,seeking_sponsors)
         WHERE id=$1 RETURNING *`,
        [i.id, i.name, i.description, i.status, i.starts_on, i.ends_on, i.venue_id, i.city, i.capacity, i.registration_deadline, i.seeking_sponsors])).rows[0];
      if (i.status === 'cancelled' && ev.status !== 'cancelled') {
        const who = (await c.query("SELECT DISTINCT coalesce(t.owner_id, e.user_id) AS uid FROM event_entries e LEFT JOIN teams t ON t.id=e.team_id WHERE e.event_id=$1 AND e.status IN ('pending','accepted','waitlisted')", [i.id])).rows;
        for (const r of who) if (r.uid) await notify(c, r.uid, { kind: 'event_cancelled', title: 'Event cancelled', body: `${ev.name} was cancelled by the organiser.`, data: { event_id: ev.id } });
      }
      return out;
    });
  },
});

cap({
  name: 'enter_event', method: 'POST', path: '/events/:id/entries', tag: 'Events', status: 201,
  summary: 'Register a team you manage (team_id) or yourself (omit team_id). Respects the deadline; when the event is full you join the waitlist.',
  input: z.object({ id, team_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = (await c.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!ev) throw notFound('Event');
      if (ev.status !== 'open') throw conflict('Event is not open for registration');
      if (ev.registration_deadline && ev.registration_deadline < new Date()) throw conflict('Registration closed on ' + ev.registration_deadline.toISOString());
      if (i.team_id) {
        const t = await mustFind('teams', i.team_id, '*', c);
        if (t.sport_id !== ev.sport_id) throw badRequest('Team plays a different sport');
        if (!(await canManageTeam(user, t))) throw forbidden('You do not manage that team');
      }
      const teamId = i.team_id ?? null, userId = i.team_id ? null : user.id;
      const prior = (await c.query('SELECT * FROM event_entries WHERE event_id=$1 AND team_id IS NOT DISTINCT FROM $2 AND user_id IS NOT DISTINCT FROM $3', [i.id, teamId, userId])).rows[0];
      if (prior && prior.status !== 'withdrawn') throw conflict('Already registered');
      const taken = (await c.query("SELECT count(*)::int AS n FROM event_entries WHERE event_id=$1 AND status IN ('accepted','pending')", [i.id])).rows[0].n;
      const status = ev.capacity && taken >= ev.capacity ? 'waitlisted' : 'pending';
      if (prior) return (await c.query('UPDATE event_entries SET status=$2, withdrawn_at=NULL, updated_at=now(), created_at=now() WHERE id=$1 RETURNING *', [prior.id, status])).rows[0];
      return (await c.query('INSERT INTO event_entries(event_id, team_id, user_id, status) VALUES ($1,$2,$3,$4) RETURNING *', [i.id, teamId, userId, status])).rows[0];
    });
  },
});

/** Move the oldest waitlisted entry into the pending queue once a spot opens (call inside a transaction holding the event row lock). */
async function promoteWaitlist(c, ev) {
  if (!ev.capacity) return null;
  const taken = (await c.query("SELECT count(*)::int AS n FROM event_entries WHERE event_id=$1 AND status IN ('accepted','pending')", [ev.id])).rows[0].n;
  if (taken >= ev.capacity) return null;
  const next = (await c.query("SELECT e.*, coalesce(t.owner_id, e.user_id) AS uid FROM event_entries e LEFT JOIN teams t ON t.id=e.team_id WHERE e.event_id=$1 AND e.status='waitlisted' ORDER BY e.created_at LIMIT 1 FOR UPDATE OF e", [ev.id])).rows[0];
  if (!next) return null;
  await c.query("UPDATE event_entries SET status='pending', updated_at=now() WHERE id=$1", [next.id]);
  await notify(c, next.uid, { kind: 'event_waitlist', title: 'A spot opened up', body: `You moved off the waitlist for ${ev.name}; the organiser will confirm your entry.`, data: { event_id: ev.id, entry_id: next.id } });
  return next;
}

cap({
  name: 'withdraw_entry', method: 'POST', path: '/entries/:id/withdraw', tag: 'Events',
  summary: 'Withdraw your registration (or your team’s). The next waitlisted entry is promoted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await mustFind('event_entries', i.id, '*', c);
      const ev = (await c.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [e.event_id])).rows[0];
      if (e.team_id) { if (!(await canManageTeam(user, await mustFind('teams', e.team_id, '*', c)))) throw forbidden('You do not manage that team'); }
      else if (e.user_id !== user.id && !isAdmin(user)) throw forbidden('This is not your registration');
      if (['withdrawn', 'rejected'].includes(e.status)) throw conflict(`Entry is already ${e.status}`);
      if (['completed', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
      if (e.status === 'accepted' && (await c.query("SELECT 1 FROM fixtures WHERE event_id=$1 AND (home_team_id=$2 OR away_team_id=$2) AND status IN ('live','completed') LIMIT 1", [ev.id, e.team_id])).rowCount) throw conflict('Matches have already been played; ask the organiser to remove you');
      const out = (await c.query("UPDATE event_entries SET status='withdrawn', withdrawn_at=now(), updated_at=now() WHERE id=$1 RETURNING *", [i.id])).rows[0];
      await promoteWaitlist(c, ev);
      await notify(c, ev.organizer_id, { kind: 'event_entry', title: 'Entry withdrawn', body: `An entry was withdrawn from ${ev.name}.`, data: { event_id: ev.id, entry_id: e.id } });
      return out;
    });
  },
});

cap({
  name: 'list_entries', method: 'GET', path: '/events/:id/entries', tag: 'Events', summary: 'Registrations for an event you organise.', input: z.object({ id, status: z.enum(['pending', 'accepted', 'rejected', 'withdrawn', 'waitlisted']).optional() }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.id);
    return many(`SELECT e.*, t.name AS team_name, u.display_name FROM event_entries e LEFT JOIN teams t ON t.id=e.team_id LEFT JOIN users u ON u.id=e.user_id WHERE e.event_id=$1 AND ($2::text IS NULL OR e.status=$2) ORDER BY e.created_at`, [i.id, i.status ?? null]);
  },
});

cap({
  name: 'decide_entry', method: 'PATCH', path: '/entries/:id', tag: 'Events', summary: 'Accept or reject a registration (event organiser). Accepting is blocked when the event is full; the entrant is notified.',
  input: z.object({ id, status: z.enum(['accepted', 'rejected']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await mustFind('event_entries', i.id, '*', c);
      const ev = (await c.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [e.event_id])).rows[0];
      mustOwn(user, ev.organizer_id, 'event');
      if (!['pending', 'waitlisted', 'accepted'].includes(e.status)) throw conflict(`Entry is ${e.status}`);
      if (i.status === 'accepted' && e.status !== 'accepted' && ev.capacity) {
        const used = (await c.query("SELECT count(*)::int AS n FROM event_entries WHERE event_id=$1 AND status='accepted'", [ev.id])).rows[0].n;
        if (used >= ev.capacity) throw conflict('Event is full; capacity reached');
      }
      const out = (await c.query('UPDATE event_entries SET status=$2, updated_at=now() WHERE id=$1 RETURNING *', [i.id, i.status])).rows[0];
      const uid = e.user_id ?? (await c.query('SELECT owner_id FROM teams WHERE id=$1', [e.team_id])).rows[0]?.owner_id;
      if (uid) await notify(c, uid, { kind: 'event_entry', title: `Entry ${i.status}`, body: `Your registration for ${ev.name} was ${i.status}.`, data: { event_id: ev.id, entry_id: e.id } });
      if (i.status === 'rejected') await promoteWaitlist(c, ev);
      return out;
    });
  },
});

cap({
  name: 'create_fixture', method: 'POST', path: '/events/:id/fixtures', tag: 'Schedule', status: 201,
  summary: 'Schedule a game. If resource_id is given the court/ground is booked atomically; referee clashes are rejected.',
  input: z.object({ id, home_team_id: id, away_team_id: id, scheduled_at: dt, duration_min: z.number().int().min(10).max(600).default(90), round: z.string().max(40).optional(), resource_id: id.optional(), referee_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await eventForOrganizer(user, i.id, c);
      if (i.home_team_id === i.away_team_id) throw badRequest('A team cannot play itself');
      const ok = await c.query("SELECT count(*)::int AS n FROM event_entries WHERE event_id=$1 AND status='accepted' AND team_id = ANY($2)", [i.id, [i.home_team_id, i.away_team_id]]);
      if (ok.rows[0].n !== 2) throw badRequest('Both teams must be accepted entrants of this event');
      const end = new Date(new Date(i.scheduled_at).getTime() + i.duration_min * 60000).toISOString();
      for (const team of [i.home_team_id, i.away_team_id]) {
        const clash = await c.query("SELECT 1 FROM fixtures WHERE status IN ('scheduled','live') AND (home_team_id=$1 OR away_team_id=$1) AND scheduled_at < $3 AND scheduled_at + interval '90 minutes' > $2", [team, i.scheduled_at, end]);
        if (clash.rowCount) throw conflict('A team already has a game in that window');
      }
      if (i.referee_id) {
        const ref = await c.query("SELECT 1 FROM sport_profiles WHERE user_id=$1 AND role='referee' AND sport_id=$2", [i.referee_id, ev.sport_id]);
        if (!ref.rowCount) throw badRequest('That person is not a referee for this sport');
        const clash = await c.query("SELECT 1 FROM fixtures WHERE referee_id=$1 AND status IN ('scheduled','live') AND scheduled_at < $3 AND scheduled_at + interval '90 minutes' > $2", [i.referee_id, i.scheduled_at, end]);
        if (clash.rowCount) throw conflict('Referee already has a game in that window');
      }
      if (i.resource_id) await reserve(c, { resource_id: i.resource_id, user_id: user.id, event_id: i.id, starts_at: i.scheduled_at, ends_at: end, note: `Fixture ${i.round ?? ''}`.trim() });
      return (await c.query(
        'INSERT INTO fixtures(event_id, round, home_team_id, away_team_id, resource_id, referee_id, scheduled_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [i.id, i.round ?? null, i.home_team_id, i.away_team_id, i.resource_id ?? null, i.referee_id ?? null, i.scheduled_at])).rows[0];
    });
  },
});

cap({
  name: 'generate_round_robin', method: 'POST', path: '/events/:id/schedule/round-robin', tag: 'Schedule', status: 201,
  summary: 'Auto-generate a single round-robin schedule for all accepted teams (circle method), one round per interval.',
  input: z.object({ id, first_round_at: dt, interval_days: z.number().int().min(1).max(30).default(7) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await eventForOrganizer(user, i.id, c);
      if ((await c.query('SELECT 1 FROM fixtures WHERE event_id=$1 LIMIT 1', [i.id])).rowCount) throw conflict('Event already has fixtures');
      const teams = (await c.query("SELECT team_id FROM event_entries WHERE event_id=$1 AND status='accepted' AND team_id IS NOT NULL ORDER BY created_at", [i.id])).rows.map((r) => r.team_id);
      if (teams.length < 2) throw badRequest('Need at least 2 accepted teams');
      const slots = teams.length % 2 ? [...teams, null] : [...teams];
      const n = slots.length, out = [];
      for (let r = 0; r < n - 1; r++) {
        const when = new Date(new Date(i.first_round_at).getTime() + r * i.interval_days * 864e5).toISOString();
        for (let k = 0; k < n / 2; k++) {
          const a = slots[k], b = slots[n - 1 - k];
          if (a && b) out.push((await c.query('INSERT INTO fixtures(event_id, round, home_team_id, away_team_id, scheduled_at) VALUES ($1,$2,$3,$4,$5) RETURNING *', [i.id, `Round ${r + 1}`, r % 2 ? b : a, r % 2 ? a : b, when])).rows[0]);
        }
        slots.splice(1, 0, slots.pop()); // rotate all but the first slot
      }
      return { created: out.length, fixtures: out };
    });
  },
});

cap({
  name: 'list_fixtures', method: 'GET', path: '/fixtures', tag: 'Schedule', auth: 'public', summary: 'Game schedule and results, filterable by event, team, referee or date.',
  input: z.object({ event_id: id.optional(), team_id: id.optional(), referee_id: id.optional(), from: dt.optional(), to: dt.optional(), status: z.enum(['scheduled', 'live', 'completed', 'cancelled']).optional(), ...page }),
  handler: (_, i) => many(
    `SELECT f.*, h.name AS home_name, h.emoji AS home_emoji, h.color AS home_color, a.name AS away_name, a.emoji AS away_emoji, a.color AS away_color, e.name AS event_name, r.name AS resource_name
       FROM fixtures f JOIN events e ON e.id=f.event_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id LEFT JOIN resources r ON r.id=f.resource_id
      WHERE ($1::uuid IS NULL OR f.event_id=$1) AND ($2::uuid IS NULL OR f.home_team_id=$2 OR f.away_team_id=$2) AND ($3::uuid IS NULL OR f.referee_id=$3)
        AND ($4::timestamptz IS NULL OR f.scheduled_at >= $4) AND ($5::timestamptz IS NULL OR f.scheduled_at < $5) AND ($6::text IS NULL OR f.status=$6)
      ORDER BY f.scheduled_at LIMIT $7 OFFSET $8`,
    [i.event_id ?? null, i.team_id ?? null, i.referee_id ?? null, i.from ?? null, i.to ?? null, i.status ?? null, i.limit, i.offset]),
});

cap({
  name: 'reschedule_fixture', method: 'PATCH', path: '/fixtures/:id', tag: 'Schedule', summary: 'Move, assign a referee to, or cancel a fixture.',
  input: z.object({ id, scheduled_at: dt.optional(), referee_id: id.optional(), status: z.enum(['scheduled', 'live', 'cancelled']).optional() }),
  async handler({ user }, i) {
    const f = await mustFind('fixtures', i.id);
    await eventForOrganizer(user, f.event_id);
    if (f.status === 'completed') throw conflict('Completed fixtures are locked');
    return one('UPDATE fixtures SET scheduled_at=coalesce($2,scheduled_at), referee_id=coalesce($3,referee_id), status=coalesce($4,status) WHERE id=$1 RETURNING *', [i.id, i.scheduled_at, i.referee_id, i.status]);
  },
});

cap({
  name: 'record_result', method: 'POST', path: '/fixtures/:id/result', tag: 'Schedule',
  summary: 'Record the final score (event organiser or the assigned referee). Updates standings.',
  input: z.object({ id, home_score: z.number().int().min(0), away_score: z.number().int().min(0) }),
  async handler({ user }, i) {
    const f = await mustFind('fixtures', i.id);
    const ev = await mustFind('events', f.event_id);
    if (!isAdmin(user) && ![ev.organizer_id, f.referee_id].includes(user.id)) throw forbidden('Only the organiser or the assigned referee can record results');
    return one("UPDATE fixtures SET home_score=$2, away_score=$3, status='completed' WHERE id=$1 RETURNING *", [i.id, i.home_score, i.away_score]);
  },
});

cap({
  name: 'get_standings', method: 'GET', path: '/events/:id/standings', tag: 'Schedule', auth: 'public', summary: 'League table computed from completed fixtures.', input: z.object({ id }),
  handler: (_, i) => standings(i.id),
});

cap({
  name: 'complete_event', method: 'POST', path: '/events/:id/complete', tag: 'Events',
  summary: 'Close an event and auto-award the cup (1st), silver and bronze medals (2nd/3rd) from the final standings.', input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await eventForOrganizer(user, i.id, c);
      if (ev.status === 'completed') throw conflict('Already completed');
      const table = await standings(i.id, c);
      const podium = [['cup', `${ev.name} — Champions`], ['medal_silver', `${ev.name} — Runners-up`], ['medal_bronze', `${ev.name} — Third place`]];
      const awards = [];
      for (const [n, [kind, name]] of podium.entries()) {
        if (!table[n] || table[n].played === 0) continue;
        awards.push((await c.query('INSERT INTO awards(name, kind, event_id, team_id, awarded_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, kind, i.id, table[n].team_id, user.id])).rows[0]);
      }
      await c.query("UPDATE events SET status='completed' WHERE id=$1", [i.id]);
      return { status: 'completed', standings: table, awards };
    });
  },
});
