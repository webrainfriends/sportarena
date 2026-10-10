// Event planning: contact and contract everyone an event needs (teams, coaches, referees, medical staff, suppliers,
// venues, insurers, sponsors) through requests that end in a finalized booking, keep the budget, and run the task list.
import { z } from 'zod';
import { cap, id, page, money, capabilities } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, mustFind } from '../helpers.js';
import { notify } from '../notify.js';
import { NOT_YOUTH_SQL } from '../youth.js';
import { eventForOrganizer } from './events.js';
import { REQUEST_KINDS, BUDGET_CATEGORIES, canAnswer, createRequest, announce, finalizeRequest, priceOf } from '../event-planning.js';

const TAG = 'Event planning';
const date = z.string().date();
const kind = z.enum(REQUEST_KINDS);

const organizer = (user, eventId, c = pool) => eventForOrganizer(user, eventId, c);
const sportIds = async (c, slugs) => {
  if (!slugs?.length) return [];
  const rows = (await c.query('SELECT id, slug FROM sports WHERE slug = ANY($1::text[]) OR id::text = ANY($1::text[])', [slugs])).rows;
  if (rows.length !== new Set(slugs).size) throw notFound('Sport');
  return rows.map((r) => r.id);
};

// ---------------------------------------------------------------- find who to contact

cap({
  name: 'find_event_partners', method: 'GET', path: '/events/:id/partners', tag: TAG,
  summary: 'Find who to contact for this event: teams in the sport, coaches, referees by sport, physios/doctors, suppliers, insurers taking requests, sponsors and venues that have courts/grounds for the event\'s sports. Each result says which id to pass to create_event_request and whether you already asked them.',
  input: z.object({ id, kind, q: z.string().max(80).optional(), city: z.string().max(80).optional(), sport: z.string().optional().describe('sport slug; defaults to the event\'s sports'), ...page }),
  async handler({ user }, i) {
    const ev = await organizer(user, i.id);
    let slugs = i.sport ? [i.sport] : (await many("SELECT s.slug FROM event_disciplines d JOIN sports s ON s.id=d.sport_id WHERE d.event_id=$1 AND d.status <> 'cancelled'", [ev.id])).map((r) => r.slug);
    if (!slugs.length) slugs = [(await one('SELECT slug FROM sports WHERE id=$1', [ev.sport_id])).slug];
    const sp = await many('SELECT id FROM sports WHERE slug = ANY($1::text[])', [slugs]);
    const sportIdsArr = sp.map((s) => s.id);
    const args = [ev.id, i.q ? `%${i.q}%` : null, i.city ?? null, sportIdsArr, i.limit, i.offset];
    const asked = (col) => `EXISTS (SELECT 1 FROM event_requests r WHERE r.event_id=$1 AND r.kind=$7 AND r.${col} AND r.status IN ('draft','sent','quoted','accepted','finalized'))`;
    if (i.kind === 'team') {
      return many(`SELECT t.id, 'team_id' AS key, t.name, t.emoji, t.city, (SELECT count(*)::int FROM team_members m WHERE m.team_id=t.id AND m.status='active') AS detail_count,
                          EXISTS (SELECT 1 FROM event_entries e WHERE e.event_id=$1 AND e.team_id=t.id AND e.status IN ('pending','accepted')) AS entered,
                          ${asked('team_id=t.id')} AS already_asked
                     FROM teams t WHERE t.sport_id = ANY($4::uuid[]) AND ($2::text IS NULL OR t.name ILIKE $2) AND ($3::text IS NULL OR lower(t.city)=lower($3)) AND t.parent_team_id IS NULL
                    ORDER BY t.name LIMIT $5 OFFSET $6`, [...args, 'team']);
    }
    if (i.kind === 'venue') {
      return many(`SELECT v.id, 'venue_id' AS key, v.name, v.emoji, v.city, count(r.id)::int AS detail_count, min(NULLIF(r.hourly_rate_cents,0)) AS from_rate_cents,
                          ${asked('venue_id=v.id')} AS already_asked
                     FROM venues v JOIN resources r ON r.venue_id=v.id AND r.active AND r.sport_id = ANY($4::uuid[])
                    WHERE ($2::text IS NULL OR v.name ILIKE $2) AND ($3::text IS NULL OR lower(v.city)=lower($3)) GROUP BY v.id ORDER BY v.name LIMIT $5 OFFSET $6`, [...args, 'venue']);
    }
    if (i.kind === 'sponsor') {
      return many(`SELECT s.id, 'sponsor_id' AS key, s.name, s.emoji, s.industry AS city, ${asked('sponsor_id=s.id')} AS already_asked FROM sponsors s
                    WHERE ($2::text IS NULL OR s.name ILIKE $2) AND ($3::text IS NULL OR true) AND cardinality($4::uuid[]) >= 0 ORDER BY s.name LIMIT $5 OFFSET $6`, [...args, 'sponsor']);
    }
    if (i.kind === 'insurer') {
      return many(`SELECT n.id, 'insurer_id' AS key, n.name, '🛡️' AS emoji, NULL AS city, ${asked('insurer_id=n.id')} AS already_asked FROM insurers n
                    WHERE n.status='active' AND n.accepting_requests AND ($2::text IS NULL OR n.name ILIKE $2) AND ($3::text IS NULL OR true) AND cardinality($4::uuid[]) >= 0 ORDER BY n.name LIMIT $5 OFFSET $6`, [...args, 'insurer']);
    }
    const role = { coach: 'coach', referee: 'referee', umpire: 'referee', judge: 'referee', scorer: null, timekeeper: 'referee', physio: 'physio', doctor: 'doctor', first_aider: null, volunteer: null, supplier: 'supplier' }[i.kind];
    const join = role === 'referee' ? "JOIN sport_profiles sp ON sp.user_id=u.id AND sp.role='referee' AND sp.sport_id = ANY($4::uuid[])"
      : role === 'coach' ? "JOIN sport_profiles sp ON sp.user_id=u.id AND sp.role='coach' AND sp.sport_id = ANY($4::uuid[])" : '';
    const rate = role === 'referee' || role === 'coach' ? 'max(sp.hourly_rate_cents)' : role === 'physio' || role === 'doctor' ? 'max(pp.consult_fee_cents)' : 'NULL';
    const prov = role === 'physio' || role === 'doctor' ? `JOIN provider_profiles pp ON pp.user_id=u.id AND pp.provider_type='${role}' AND pp.listed AND ($3::text IS NULL OR lower(pp.city)=lower($3))` : '';
    const roleWhere = !join && !prov && role ? `AND '${role}' = ANY(u.roles)` : '';
    return many(`SELECT u.id, 'user_id' AS key, u.display_name AS name, u.avatar_emoji AS emoji, NULL AS city, ${rate} AS from_rate_cents, ${asked('recipient_id=u.id')} AS already_asked
                   FROM users u ${join} ${prov} WHERE ${NOT_YOUTH_SQL} AND u.id <> $8 AND ($3::text IS NULL OR true) AND cardinality($4::uuid[]) >= 0 ${roleWhere} AND ($2::text IS NULL OR u.display_name ILIKE $2 OR u.handle ILIKE $2)
                  GROUP BY u.id ORDER BY u.display_name LIMIT $5 OFFSET $6`, [...args, i.kind, user.id]);
  },
});

cap({
  name: 'find_venues_for_sports', method: 'GET', path: '/venue-finder', tag: TAG, auth: 'public',
  summary: 'For each chosen sport, the venues that actually have courts/grounds for it (optionally in a city), with how many bookable spots and the lowest hourly rate — so an organiser can pick one venue per sport.',
  input: z.object({ sports: z.string().min(1).describe('comma separated sport slugs'), city: z.string().max(80).optional() }),
  async handler(_, i) {
    const slugs = [...new Set(i.sports.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 30);
    const out = [];
    for (const slug of slugs) {
      const s = await one('SELECT id, slug, name, emoji FROM sports WHERE slug=$1', [slug]);
      if (!s) continue;
      out.push({ sport: s.slug, name: s.name, emoji: s.emoji, venues: await many(
        `SELECT v.id, v.name, v.emoji, v.city, count(r.id)::int AS spots, min(NULLIF(r.hourly_rate_cents,0)) AS from_rate_cents
           FROM venues v JOIN resources r ON r.venue_id=v.id AND r.active AND r.sport_id=$1 WHERE ($2::text IS NULL OR lower(v.city)=lower($2)) GROUP BY v.id ORDER BY count(r.id) DESC, v.name LIMIT 20`, [s.id, i.city ?? null]) });
    }
    return out;
  },
});

// ---------------------------------------------------------------- requests

cap({
  name: 'create_event_request', method: 'POST', path: '/events/:id/requests', tag: TAG, status: 201,
  summary: 'Contact someone for the event: invite a team, ask a coach/referee/physio/doctor/volunteer to work it, ask a supplier or venue for a quote or booking, ask an insurer for cover, or ask a sponsor. Say what you offer (offer_cents) or leave it for them to quote. The recipient accepts, quotes or declines; you finalize. Insurance goes through the insurance module (quotes come back there). send=false keeps it as a draft.',
  input: z.object({
    id, kind, user_id: id.optional(), team_id: id.optional(), venue_id: id.optional(), sponsor_id: id.optional(), insurer_id: id.optional(),
    title: z.string().min(2).max(120).optional(), message: z.string().max(2000).optional(), sports: z.array(z.string()).max(30).optional(),
    starts_on: date.optional(), ends_on: date.optional(), quantity: z.number().int().min(1).max(1000000).optional(), offer_cents: money.optional(), currency: z.string().length(3).optional(), send: z.boolean().default(true),
  }),
  async handler({ user }, i) {
    const target = { team: i.team_id, venue: i.venue_id, sponsor: i.sponsor_id, insurer: i.insurer_id }[i.kind] ?? i.user_id;
    if (!target) throw badRequest(`Choose who to contact (${{ team: 'team_id', venue: 'venue_id', sponsor: 'sponsor_id', insurer: 'insurer_id' }[i.kind] ?? 'user_id'})`);
    const insurance = capabilities.find((c) => c.name === 'request_quote').handler;
    return tx(async (c) => {
      const ev = await organizer(user, i.id, c);
      return createRequest(c, user, ev, { ...i, sport_ids: await sportIds(c, i.sports) }, { insuranceRequest: insurance });
    });
  },
});

cap({
  name: 'send_event_request', method: 'POST', path: '/event-requests/:id/send', tag: TAG,
  summary: 'Send a draft request.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const insurance = capabilities.find((c) => c.name === 'request_quote').handler;
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM event_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Request');
      const ev = await organizer(user, r.event_id, c);
      if (r.status !== 'draft') throw conflict(`Request is ${r.status}`);
      if (r.kind === 'insurer') {
        const sent = (await c.query("UPDATE event_requests SET status='sent' WHERE id=$1 RETURNING *", [r.id])).rows[0];
        const qr = await insurance({ user }, { cover_for: 'event', subject_id: ev.id, insurer_id: r.insurer_id, months: 1, participants: r.quantity ?? undefined, message: r.message ?? undefined });
        return (await c.query('UPDATE event_requests SET ref_type=$2, ref_id=$3 WHERE id=$1 RETURNING *', [r.id, 'insurance_quote_request', qr.id])).rows[0] ?? sent;
      }
      const row = (await c.query("UPDATE event_requests SET status='sent', updated_at=now() WHERE id=$1 RETURNING *", [r.id])).rows[0];
      await announce(c, ev, row, user);
      return row;
    });
  },
});

const REQ_COLS = `r.id, r.event_id, r.kind, r.target_name, r.title, r.message, r.sport_ids, r.starts_on, r.ends_on, r.quantity, r.offer_cents, r.quote_cents, r.currency, r.quote_note, r.quote_valid_until,
  r.status, r.ref_type, r.ref_id, r.budget_line_id, r.team_id, r.venue_id, r.sponsor_id, r.insurer_id, r.recipient_id, r.responded_at, r.finalized_at, r.created_at,
  (SELECT count(*)::int FROM event_request_messages m WHERE m.request_id=r.id) AS messages`;

/** Insurance requests live in the insurance module: show their live progress and what was accepted. */
async function withInsurance(rows) {
  const refs = rows.filter((r) => r.ref_type === 'insurance_quote_request').map((r) => r.ref_id);
  if (!refs.length) return rows;
  const info = await many(
    `SELECT qr.id, qr.status, (SELECT count(*)::int FROM insurance_quotes z WHERE z.request_id=qr.id AND z.status='offered' AND z.valid_until >= current_date) AS offers,
            (SELECT z.premium_cents * z.months FROM insurance_quotes z WHERE z.request_id=qr.id AND z.status='accepted' LIMIT 1) AS accepted_total_cents
       FROM insurance_quote_requests qr WHERE qr.id = ANY($1::uuid[])`, [refs]);
  return rows.map((r) => {
    const x = info.find((n) => n.id === r.ref_id);
    if (!x) return r;
    const live = r.status === 'finalized' || r.status === 'cancelled' ? r.status : x.accepted_total_cents != null ? 'accepted' : x.offers ? 'quoted' : x.status === 'declined' ? 'declined' : r.status;
    return { ...r, status: live, quote_cents: r.quote_cents ?? x.accepted_total_cents ?? null, insurance: { request_status: x.status, offers: x.offers, accepted_total_cents: x.accepted_total_cents != null ? Number(x.accepted_total_cents) : null } };
  });
}

cap({
  name: 'list_event_requests', method: 'GET', path: '/events/:id/requests', tag: TAG,
  summary: 'Everything the event has asked of others and where each stands: sent, quoted, accepted (awaiting your finalize), declined, finalized.',
  input: z.object({ id, kind: kind.optional(), status: z.enum(['draft', 'sent', 'quoted', 'accepted', 'declined', 'finalized', 'cancelled']).optional(), ...page }),
  async handler({ user }, i) {
    await organizer(user, i.id);
    const rows = await withInsurance(await many(`SELECT ${REQ_COLS} FROM event_requests r WHERE r.event_id=$1 AND ($2::text IS NULL OR r.kind=$2) ORDER BY r.created_at DESC LIMIT 300`, [i.id, i.kind ?? null]));
    const out = i.status ? rows.filter((r) => r.status === i.status) : rows;
    return out.slice(i.offset, i.offset + i.limit);
  },
});

cap({
  name: 'get_event_request', method: 'GET', path: '/event-requests/:id', tag: TAG,
  summary: 'One request with its negotiation thread. Visible to the organiser and to the recipient.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = (await many(`SELECT ${REQ_COLS} FROM event_requests r WHERE r.id=$1`, [i.id]))[0];
    if (!r) throw notFound('Request');
    const ev = await mustFind('events', r.event_id);
    const org = isAdmin(user) || ev.organizer_id === user.id;
    if (!org && !(await canAnswer(pool, user, { ...r, kind: r.kind }))) throw forbidden();
    const thread = await many('SELECT m.id, m.sender_id, u.display_name AS sender, m.body, m.created_at FROM event_request_messages m JOIN users u ON u.id=m.sender_id WHERE m.request_id=$1 ORDER BY m.created_at', [i.id]);
    return { ...(await withInsurance([r]))[0], event: ev.name, as: org ? 'organiser' : 'recipient', thread };
  },
});

cap({
  name: 'list_my_event_requests', method: 'GET', path: '/me/event-requests', tag: TAG,
  summary: 'Your inbox: requests events have sent to you or to a team, venue or sponsor you run — to accept, quote or decline.',
  input: z.object({ status: z.enum(['sent', 'quoted', 'accepted', 'declined', 'finalized', 'cancelled']).optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT ${REQ_COLS}, e.name AS event, e.starts_on AS event_starts_on, e.city AS event_city
       FROM event_requests r JOIN events e ON e.id=r.event_id
      WHERE r.status <> 'draft' AND r.kind <> 'insurer' AND ($2::text IS NULL OR r.status=$2)
        AND (r.recipient_id=$1
          OR r.team_id IN (SELECT t.id FROM teams t WHERE t.owner_id=$1 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$1 AND m.status='active' AND m.role IN ('captain','manager')))
          OR r.venue_id IN (SELECT venue_id FROM venue_staff WHERE user_id=$1 AND removed_at IS NULL))
      ORDER BY (r.status IN ('sent')) DESC, r.created_at DESC LIMIT $3 OFFSET $4`, [user.id, i.status ?? null, i.limit, i.offset]),
});

cap({
  name: 'respond_event_request', method: 'POST', path: '/event-requests/:id/respond', tag: TAG,
  summary: 'The recipient answers: accept the organiser\'s terms, send a quote / counter-offer (amount, note, validity), or decline. Team invitations without a fee are completed as soon as they are accepted. Insurers answer through the insurance desk.',
  input: z.object({ id, response: z.enum(['accept', 'quote', 'decline']), quote_cents: money.optional(), quote_note: z.string().max(1000).optional(), quote_valid_until: date.optional(), message: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM event_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Request');
      if (r.kind === 'insurer') throw badRequest('Insurance requests are answered in the insurance desk (create_quote)');
      if (!(await canAnswer(c, user, r))) throw forbidden('This request is not addressed to you');
      if (!['sent', 'quoted'].includes(r.status)) throw conflict(`Request is ${r.status}`);
      if (i.response === 'accept' && r.status === 'quoted') throw conflict('You already sent a quote; the organiser decides next');
      if (i.response === 'quote' && i.quote_cents === undefined) throw badRequest('Give the amount you quote (quote_cents)');
      if (i.quote_valid_until && i.quote_valid_until < new Date().toISOString().slice(0, 10)) throw badRequest('quote_valid_until is in the past');
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [r.event_id])).rows[0];
      const status = { accept: 'accepted', quote: 'quoted', decline: 'declined' }[i.response];
      let row = (await c.query(
        "UPDATE event_requests SET status=$2, responded_at=now(), updated_at=now(), quote_cents=CASE WHEN $2='quoted' THEN $3 ELSE quote_cents END, quote_note=coalesce($4, quote_note), quote_valid_until=coalesce($5, quote_valid_until) WHERE id=$1 RETURNING *",
        [r.id, status, i.quote_cents ?? null, i.quote_note ?? null, i.quote_valid_until ?? null])).rows[0];
      if (i.message) await c.query('INSERT INTO event_request_messages(request_id, sender_id, body) VALUES ($1,$2,$3)', [r.id, user.id, i.message]);
      if (status === 'accepted' && r.kind === 'team' && !(Number(r.offer_cents) > 0)) row = await finalizeRequest(c, ev, row, { id: ev.organizer_id });
      const word = { accepted: 'accepted', quoted: `quoted ${(Number(i.quote_cents ?? 0) / 100).toFixed(2)} ${r.currency}`, declined: 'declined' }[status];
      await notify(c, ev.organizer_id, { kind: 'event_request', title: `${r.target_name} ${row.status === 'finalized' ? 'joined' : word}`, body: `${r.title}${i.message ? `: ${i.message.slice(0, 160)}` : ''}`, data: { event_id: ev.id, request_id: r.id } });
      return row;
    });
  },
});

cap({
  name: 'finalize_event_request', method: 'POST', path: '/event-requests/:id/finalize', tag: TAG,
  summary: 'Confirm the booking once it is accepted or quoted: the agreed amount (the quote, else your offer, or override) is committed to the budget, and the effect is applied — a team enters the event, a referee/physio/doctor joins the crew, a sponsorship becomes active, a venue is set. For insurance, accept a quote in the insurance module first.',
  input: z.object({ id, amount_cents: money.optional().describe('override the agreed amount') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM event_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Request');
      const ev = await organizer(user, r.event_id, c);
      if (r.status === 'finalized') return r;
      let price = i.amount_cents;
      if (r.kind === 'insurer') {
        const acc = (await c.query("SELECT premium_cents * months AS total FROM insurance_quotes WHERE request_id=$1 AND status='accepted' LIMIT 1", [r.ref_id])).rows[0];
        if (!acc) throw conflict('Accept one of the insurers\' quotes first (accept_quote), then finalize');
        price ??= Number(acc.total);
      } else if (!['accepted', 'quoted'].includes(r.status)) throw conflict(`Request is ${r.status}: it must be accepted or quoted first`);
      return finalizeRequest(c, ev, r, user, { price: price ?? priceOf(r) });
    });
  },
});

cap({
  name: 'cancel_event_request', method: 'POST', path: '/event-requests/:id/cancel', tag: TAG,
  summary: 'Withdraw a request that is not finalized yet. The recipient is told.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM event_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Request');
      const ev = await organizer(user, r.event_id, c);
      if (r.status === 'finalized') throw conflict('A finalized booking is changed where it took effect (release the crew member, withdraw the entry…)');
      if (['cancelled', 'declined'].includes(r.status)) return r;
      const row = (await c.query("UPDATE event_requests SET status='cancelled', updated_at=now() WHERE id=$1 RETURNING *", [r.id])).rows[0];
      if (r.status !== 'draft' && r.recipient_id) await notify(c, r.recipient_id, { kind: 'event_request', title: `Request withdrawn: ${ev.name}`, body: r.title, data: { event_id: ev.id, request_id: r.id } });
      return row;
    });
  },
});

cap({
  name: 'send_event_request_message', method: 'POST', path: '/event-requests/:id/messages', tag: TAG, status: 201,
  summary: 'Negotiate: a message from the organiser to the recipient or back. The other side is notified.',
  input: z.object({ id, body: z.string().min(1).max(2000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM event_requests WHERE id=$1', [i.id])).rows[0];
      if (!r) throw notFound('Request');
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [r.event_id])).rows[0];
      const org = isAdmin(user) || ev.organizer_id === user.id;
      if (!org && !(await canAnswer(c, user, r))) throw forbidden();
      if (r.status === 'draft') throw conflict('Send the request first');
      const m = (await c.query('INSERT INTO event_request_messages(request_id, sender_id, body) VALUES ($1,$2,$3) RETURNING *', [r.id, user.id, i.body])).rows[0];
      const to = org ? r.recipient_id : ev.organizer_id;
      if (to && to !== user.id) await notify(c, to, { kind: 'event_request', title: `Message about ${r.title}`, body: i.body.slice(0, 200), data: { event_id: ev.id, request_id: r.id } });
      return m;
    });
  },
});

// ---------------------------------------------------------------- budget

const lineRow = (r) => ({ ...r, planned_cents: Number(r.planned_cents), committed_cents: Number(r.committed_cents), paid_cents: Number(r.paid_cents ?? 0) });

async function budgetOf(eventId) {
  const ev = await mustFind('events', eventId);
  const settings = (await one('SELECT * FROM event_budgets WHERE event_id=$1', [eventId])) ?? { event_id: eventId, currency: ev.currency ?? 'INR', spend_cap_cents: null, contingency_pct: 0, notes: null };
  const lines = (await many(
    `SELECT l.*, coalesce((SELECT sum(p.amount_cents) FROM event_budget_payments p WHERE p.line_id=l.id AND p.voided_at IS NULL),0) AS paid_cents, r.target_name, r.kind AS request_kind
       FROM event_budget_lines l LEFT JOIN event_requests r ON r.id=l.request_id WHERE l.event_id=$1 AND l.status <> 'void' ORDER BY l.direction DESC, l.category, l.created_at`, [eventId])).map(lineRow);
  const forecast = (l) => Math.max(l.committed_cents || l.planned_cents, l.paid_cents);
  const sum = (arr, f) => arr.reduce((a, l) => a + f(l), 0);
  const exp = lines.filter((l) => l.direction === 'expense'), inc = lines.filter((l) => l.direction === 'income');
  const contingency = Math.round(sum(exp, forecast) * (settings.contingency_pct / 100));
  const entries = Number((await one("SELECT count(*) AS n FROM event_entries WHERE event_id=$1 AND status='accepted'", [eventId])).n);
  const byCategory = {};
  for (const l of lines) {
    const k = `${l.direction}:${l.category}`;
    byCategory[k] ??= { direction: l.direction, category: l.category, planned_cents: 0, committed_cents: 0, paid_cents: 0 };
    byCategory[k].planned_cents += l.planned_cents; byCategory[k].committed_cents += l.committed_cents; byCategory[k].paid_cents += l.paid_cents;
  }
  const summary = {
    currency: settings.currency,
    expense: { planned_cents: sum(exp, (l) => l.planned_cents), committed_cents: sum(exp, (l) => l.committed_cents), paid_cents: sum(exp, (l) => l.paid_cents), forecast_cents: sum(exp, forecast), still_to_pay_cents: sum(exp, (l) => Math.max(forecast(l) - l.paid_cents, 0)) },
    income: { planned_cents: sum(inc, (l) => l.planned_cents), committed_cents: sum(inc, (l) => l.committed_cents), received_cents: sum(inc, (l) => l.paid_cents), forecast_cents: sum(inc, forecast), still_to_receive_cents: sum(inc, (l) => Math.max(forecast(l) - l.paid_cents, 0)) },
    contingency_cents: contingency,
    net_forecast_cents: sum(inc, forecast) - sum(exp, forecast) - contingency,
    net_cash_cents: sum(inc, (l) => l.paid_cents) - sum(exp, (l) => l.paid_cents),
    spend_cap_cents: settings.spend_cap_cents == null ? null : Number(settings.spend_cap_cents),
    cap_used_pct: settings.spend_cap_cents ? Math.round(((sum(exp, forecast) + contingency) / Number(settings.spend_cap_cents)) * 100) : null,
    suggested_entry_fee_income_cents: entries * Number(ev.entry_fee_cents ?? 0),
    entries_accepted: entries,
  };
  const alerts = [];
  if (summary.cap_used_pct != null && summary.cap_used_pct > 100) alerts.push({ level: 'red', text: `Forecast spend is ${summary.cap_used_pct}% of the approved cap` });
  else if (summary.cap_used_pct != null && summary.cap_used_pct > 85) alerts.push({ level: 'amber', text: `Forecast spend is ${summary.cap_used_pct}% of the approved cap` });
  for (const l of exp) {
    if (l.paid_cents > Math.max(l.planned_cents, l.committed_cents)) alerts.push({ level: 'red', line_id: l.id, text: `${l.name}: paid more than planned/committed` });
    else if (l.committed_cents > l.planned_cents && l.planned_cents > 0) alerts.push({ level: 'amber', line_id: l.id, text: `${l.name}: committed above the plan` });
  }
  if (summary.net_forecast_cents < 0) alerts.push({ level: 'amber', text: 'Forecast income does not cover forecast spend' });
  if (!lines.length) alerts.push({ level: 'info', text: 'No budget yet — add lines, or they appear as you finalize bookings' });
  return { event_id: eventId, settings, summary, by_category: Object.values(byCategory), lines, alerts };
}

cap({
  name: 'get_event_budget', method: 'GET', path: '/events/:id/budget', tag: TAG,
  summary: 'The event budget: every line with planned, committed (agreed with a counterpart) and paid amounts, totals, forecast, net position, contingency, the approved spend cap and what is over plan.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await organizer(user, i.id);
    const b = await budgetOf(i.id);
    b.payments = await many(
      `SELECT p.id, p.line_id, l.name AS line, l.direction, p.amount_cents, p.paid_on, p.method, p.reference, p.note, p.created_at FROM event_budget_payments p JOIN event_budget_lines l ON l.id=p.line_id
        WHERE p.event_id=$1 AND p.voided_at IS NULL ORDER BY p.paid_on DESC, p.created_at DESC LIMIT 200`, [i.id]);
    return b;
  },
});

cap({
  name: 'set_event_budget', method: 'PATCH', path: '/events/:id/budget', tag: TAG,
  summary: 'Set the budget rules: currency, approved spend cap and a contingency percentage held back on top of forecast spend.',
  input: z.object({ id, currency: z.string().length(3).optional(), spend_cap_cents: money.nullable().optional(), contingency_pct: z.number().int().min(0).max(100).optional(), notes: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    const ev = await organizer(user, i.id);
    return one(
      `INSERT INTO event_budgets(event_id, currency, spend_cap_cents, contingency_pct, notes) VALUES ($1, upper(coalesce($2,$6)), $3, coalesce($4,0), $5)
       ON CONFLICT (event_id) DO UPDATE SET currency=upper(coalesce($2, event_budgets.currency)), spend_cap_cents = CASE WHEN $7::boolean THEN $3 ELSE event_budgets.spend_cap_cents END,
         contingency_pct=coalesce($4, event_budgets.contingency_pct), notes=coalesce($5, event_budgets.notes), updated_at=now() RETURNING *`,
      [i.id, i.currency ?? null, i.spend_cap_cents ?? null, i.contingency_pct ?? null, i.notes ?? null, ev.currency ?? 'INR', i.spend_cap_cents !== undefined]);
  },
});

cap({
  name: 'add_budget_line', method: 'POST', path: '/events/:id/budget/lines', tag: TAG, status: 201,
  summary: 'Plan an expense or an income: category, name and planned amount. Lines for finalized bookings are added automatically.',
  input: z.object({ id, direction: z.enum(['expense', 'income']).default('expense'), category: z.enum(BUDGET_CATEGORIES), name: z.string().min(2).max(120), planned_cents: money, notes: z.string().max(500).optional() }),
  async handler({ user }, i) {
    await organizer(user, i.id);
    return lineRow(await one('INSERT INTO event_budget_lines(event_id, direction, category, name, planned_cents, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [i.id, i.direction, i.category, i.name, i.planned_cents, i.notes ?? null, user.id]));
  },
});

cap({
  name: 'update_budget_line', method: 'PATCH', path: '/budget-lines/:id', tag: TAG,
  summary: 'Change a line\'s name, category, planned amount or notes, close it (no more payments) or void it (kept for the record, ignored in totals; not if payments exist).',
  input: z.object({ id, name: z.string().min(2).max(120).optional(), category: z.enum(BUDGET_CATEGORIES).optional(), planned_cents: money.optional(), notes: z.string().max(500).optional(), status: z.enum(['planned', 'committed', 'closed', 'void']).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const l = (await c.query('SELECT * FROM event_budget_lines WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!l) throw notFound('Budget line');
      await organizer(user, l.event_id, c);
      if (i.status === 'void' && (await c.query('SELECT 1 FROM event_budget_payments WHERE line_id=$1 AND voided_at IS NULL', [l.id])).rowCount) throw conflict('This line has payments — void them first');
      if (i.status === 'void' && l.request_id) throw conflict('This line belongs to a finalized booking');
      return lineRow((await c.query(
        'UPDATE event_budget_lines SET name=coalesce($2,name), category=coalesce($3,category), planned_cents=coalesce($4,planned_cents), notes=coalesce($5,notes), status=coalesce($6,status) WHERE id=$1 RETURNING *',
        [l.id, i.name ?? null, i.category ?? null, i.planned_cents ?? null, i.notes ?? null, i.status ?? null])).rows[0]);
    });
  },
});

cap({
  name: 'record_budget_payment', method: 'POST', path: '/budget-lines/:id/payments', tag: TAG, status: 201,
  summary: 'Record money actually paid out (expense line) or received (income line): amount, date, how and a reference. Corrections void the entry; nothing is deleted.',
  input: z.object({ id, amount_cents: money.refine((n) => n > 0, 'amount must be above 0'), paid_on: date.optional(), method: z.enum(['cash', 'bank', 'card', 'upi', 'cheque', 'other']).optional(), reference: z.string().max(80).optional(), note: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const l = (await c.query('SELECT * FROM event_budget_lines WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!l) throw notFound('Budget line');
      await organizer(user, l.event_id, c);
      if (['closed', 'void'].includes(l.status)) throw conflict(`Line is ${l.status}`);
      return (await c.query('INSERT INTO event_budget_payments(event_id, line_id, amount_cents, paid_on, method, reference, note, recorded_by) VALUES ($1,$2,$3,coalesce($4, current_date),$5,$6,$7,$8) RETURNING *',
        [l.event_id, l.id, i.amount_cents, i.paid_on ?? null, i.method ?? null, i.reference ?? null, i.note ?? null, user.id])).rows[0];
    });
  },
});

cap({
  name: 'void_budget_payment', method: 'POST', path: '/budget-payments/:id/void', tag: TAG,
  summary: 'Cancel a payment entry made in error. It stays on record, marked void, with who and why.',
  input: z.object({ id, reason: z.string().min(2).max(300) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = (await c.query('SELECT * FROM event_budget_payments WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!p) throw notFound('Payment');
      await organizer(user, p.event_id, c);
      if (p.voided_at) throw conflict('Already void');
      return (await c.query('UPDATE event_budget_payments SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1 RETURNING *', [p.id, user.id, i.reason])).rows[0];
    });
  },
});

cap({
  name: 'export_event_budget', method: 'GET', path: '/events/:id/budget/export', tag: TAG,
  summary: 'The budget as CSV (one row per line: planned, committed, paid, remaining).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await organizer(user, i.id);
    const b = await budgetOf(i.id);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['direction', 'category', 'name', 'planned', 'committed', 'paid', 'remaining'].join(',')];
    for (const l of b.lines) rows.push([l.direction, l.category, esc(l.name), (l.planned_cents / 100).toFixed(2), (l.committed_cents / 100).toFixed(2), (l.paid_cents / 100).toFixed(2), (Math.max(l.committed_cents || l.planned_cents, l.paid_cents) - l.paid_cents) / 100].join(','));
    return { filename: `${ev.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-budget.csv`, rows: b.lines.length, csv: rows.join('\n') };
  },
});

// ---------------------------------------------------------------- tasks

const taskCat = z.enum(['general', 'venue', 'people', 'officials', 'medical', 'equipment', 'catering', 'insurance', 'sponsors', 'marketing', 'safety', 'finance', 'legal', 'logistics']);

cap({
  name: 'create_event_task', method: 'POST', path: '/events/:id/tasks', tag: TAG, status: 201,
  summary: 'Add a planning task with a category, owner, due date (calendar) and priority.',
  input: z.object({ id, title: z.string().min(2).max(160), category: taskCat.default('general'), owner_id: id.optional(), due_on: date.optional(), priority: z.enum(['low', 'normal', 'high']).default('normal'), notes: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    await organizer(user, i.id);
    if (i.owner_id) await mustFind('users', i.owner_id, 'id');
    try { return await one('INSERT INTO event_tasks(event_id, title, category, owner_id, due_on, priority, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [i.id, i.title, i.category, i.owner_id ?? null, i.due_on ?? null, i.priority, i.notes ?? null, user.id]); }
    catch (e) { if (e.code === '23505') throw conflict('There is already a task with that title'); throw e; }
  },
});

cap({
  name: 'update_event_task', method: 'PATCH', path: '/event-tasks/:id', tag: TAG,
  summary: 'Move a task along (todo → doing → blocked → done), reassign it, re-date it or drop it. The organiser edits anything; the owner can update status and notes.',
  input: z.object({ id, title: z.string().min(2).max(160).optional(), status: z.enum(['todo', 'doing', 'blocked', 'done', 'dropped']).optional(), owner_id: id.nullable().optional(), due_on: date.nullable().optional(), priority: z.enum(['low', 'normal', 'high']).optional(), notes: z.string().max(1000).optional(), category: taskCat.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const t = (await c.query('SELECT * FROM event_tasks WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!t) throw notFound('Task');
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [t.event_id])).rows[0];
      const org = isAdmin(user) || ev.organizer_id === user.id;
      const own = t.owner_id === user.id;
      if (!org && !(own && Object.keys(i).every((k) => ['id', 'status', 'notes'].includes(k)))) throw forbidden('Only the organiser can change this; the owner can update status and notes');
      if (i.owner_id) await mustFind('users', i.owner_id, 'id', c);
      try {
        const row = (await c.query(
          `UPDATE event_tasks SET title=coalesce($2,title), status=coalesce($3,status), owner_id = CASE WHEN $4::boolean THEN $5::uuid ELSE owner_id END, due_on = CASE WHEN $6::boolean THEN $7::date ELSE due_on END,
             priority=coalesce($8,priority), notes=coalesce($9,notes), category=coalesce($10,category), completed_at = CASE WHEN $3='done' THEN coalesce(completed_at, now()) WHEN $3 IS NOT NULL THEN NULL ELSE completed_at END WHERE id=$1 RETURNING *`,
          [t.id, i.title ?? null, i.status ?? null, i.owner_id !== undefined, i.owner_id ?? null, i.due_on !== undefined, i.due_on ?? null, i.priority ?? null, i.notes ?? null, i.category ?? null])).rows[0];
        if (i.owner_id && i.owner_id !== user.id && i.owner_id !== t.owner_id) await notify(c, i.owner_id, { kind: 'event_task', title: `Task for ${ev.name}`, body: row.title, data: { event_id: ev.id, task_id: t.id } });
        return row;
      } catch (e) { if (e.code === '23505') throw conflict('There is already a task with that title'); throw e; }
    });
  },
});

cap({
  name: 'list_event_tasks', method: 'GET', path: '/events/:id/tasks', tag: TAG,
  summary: 'Planning tasks with owner, due date and status; overdue ones are flagged. The organiser sees all, an owner their own.',
  input: z.object({ id, status: z.enum(['todo', 'doing', 'blocked', 'done', 'dropped']).optional(), category: taskCat.optional(), mine: z.coerce.boolean().optional() }),
  async handler({ user }, i) {
    const ev = await mustFind('events', i.id);
    const org = isAdmin(user) || ev.organizer_id === user.id;
    return many(
      `SELECT t.*, u.display_name AS owner, (t.status NOT IN ('done','dropped') AND t.due_on < current_date) AS overdue FROM event_tasks t LEFT JOIN users u ON u.id=t.owner_id
        WHERE t.event_id=$1 AND ($2::text IS NULL OR t.status=$2) AND ($3::text IS NULL OR t.category=$3) AND (t.status <> 'dropped' OR $2='dropped') AND ($4 OR t.owner_id=$5) AND (NOT $6 OR t.owner_id=$5)
        ORDER BY (t.status IN ('done','dropped')), t.due_on NULLS LAST, t.priority DESC, t.created_at`, [i.id, i.status ?? null, i.category ?? null, org, user.id, !!i.mine]);
  },
});

// a starting checklist an organiser asks for; due dates count back from the start date
const CHECKLIST = [
  ['Confirm the venue(s) and book every ground', 'venue', 60, 'high'], ['Set the budget and spend cap', 'finance', 60, 'high'], ['Draft the programme: sports, categories, rules', 'general', 55, 'high'],
  ['Open registration and publish the event', 'marketing', 50, 'high'], ['Invite teams and schools', 'people', 45, 'normal'], ['Ask sponsors for support', 'sponsors', 45, 'normal'],
  ['Request insurance quotes and choose cover', 'insurance', 40, 'high'], ['Hire referees and officials', 'officials', 35, 'high'], ['Hire doctors and physios; plan first-aid points', 'medical', 35, 'high'],
  ['Get quotes for equipment, trophies and kit', 'equipment', 35, 'normal'], ['Arrange catering and water', 'catering', 30, 'normal'], ['Close registration and confirm entries', 'people', 21, 'high'],
  ['Build teams and finish nominations', 'people', 18, 'high'], ['Publish the schedule and check for clashes', 'logistics', 14, 'high'], ['Guardian consent and medical forms collected', 'safety', 14, 'high'],
  ['Brief officials and medical staff', 'officials', 7, 'normal'], ['Prepare certificates, medals and trophies', 'equipment', 7, 'normal'], ['Safety and risk walk-through of every ground', 'safety', 5, 'high'],
  ['Final announcement to all participants and guardians', 'marketing', 3, 'normal'], ['Pay deposits and confirm every supplier', 'finance', 3, 'normal'], ['Settle crew payments and supplier invoices', 'finance', -7, 'normal'],
  ['Publish results and send certificates', 'general', -3, 'normal'], ['Thank sponsors, volunteers and crew', 'sponsors', -7, 'low'], ['Close the budget and review what to improve', 'finance', -14, 'low'],
];
cap({
  name: 'generate_event_checklist', method: 'POST', path: '/events/:id/tasks/checklist', tag: TAG, status: 201,
  summary: 'Create the standard planning tasks for an event, dated backwards from its start date (and forwards for the wrap-up). Safe to repeat: tasks that already exist are skipped. Edit, assign or drop them afterwards.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await organizer(user, i.id, c);
      let made = 0;
      for (const [title, category, days, priority] of CHECKLIST) {
        const due = ev.starts_on ? new Date(Date.parse(new Date(ev.starts_on).toISOString().slice(0, 10)) - days * 86400000).toISOString().slice(0, 10) : null;
        const r = await c.query('INSERT INTO event_tasks(event_id, title, category, due_on, priority, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [ev.id, title, category, due, priority, user.id]);
        made += r.rowCount;
      }
      return { created: made, skipped: CHECKLIST.length - made, dated_from: ev.starts_on ?? null };
    });
  },
});

// ---------------------------------------------------------------- overview

cap({
  name: 'get_event_plan', method: 'GET', path: '/events/:id/plan', tag: TAG,
  summary: 'The planning control room: requests by kind and status and what waits for your finalize, budget position, task progress and overdue items, key dates, and what is missing (venue, cover, officials, medical).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await organizer(user, i.id);
    const [reqs, tasks, b, staff, prog, venueReq] = await Promise.all([
      many(`SELECT ${REQ_COLS} FROM event_requests r WHERE r.event_id=$1 AND r.status <> 'cancelled'`, [i.id]).then(withInsurance),
      one(`SELECT count(*) FILTER (WHERE status NOT IN ('done','dropped'))::int AS open, count(*) FILTER (WHERE status='done')::int AS done, count(*) FILTER (WHERE status NOT IN ('done','dropped') AND due_on < current_date)::int AS overdue,
                  count(*) FILTER (WHERE status='blocked')::int AS blocked FROM event_tasks WHERE event_id=$1`, [i.id]),
      budgetOf(i.id),
      many("SELECT role, status, count(*)::int AS n FROM event_staff WHERE event_id=$1 GROUP BY role, status", [i.id]),
      one('SELECT 1 AS yes FROM event_programmes WHERE event_id=$1', [i.id]),
      one("SELECT count(*)::int AS n FROM event_requests WHERE event_id=$1 AND kind='venue' AND status='finalized'", [i.id]),
    ]);
    const by = {};
    for (const r of reqs) { by[r.kind] ??= {}; by[r.kind][r.status] = (by[r.kind][r.status] ?? 0) + 1; }
    const waiting = reqs.filter((r) => ['quoted', 'accepted'].includes(r.status)).map((r) => ({ id: r.id, kind: r.kind, title: r.title, target: r.target_name, status: r.status, quote_cents: r.quote_cents == null ? null : Number(r.quote_cents), offer_cents: r.offer_cents == null ? null : Number(r.offer_cents) }));
    const has = (k) => reqs.some((r) => r.kind === k && r.status === 'finalized');
    const crew = (roles) => staff.filter((s) => roles.includes(s.role) && s.status === 'accepted').reduce((a, s) => a + s.n, 0);
    const todo = [];
    if (!ev.venue_id && !venueReq.n) todo.push('No venue confirmed yet');
    if (!has('insurer') && !(await one("SELECT 1 FROM insurance_policies WHERE subject_type='event' AND subject_id=$1 LIMIT 1", [i.id]).catch(() => null))) todo.push('No insurance arranged');
    if (!crew(['referee', 'umpire', 'judge', 'scorer', 'timekeeper'])) todo.push('No referees or officials hired');
    if (!crew(['physio', 'doctor', 'first_aider'])) todo.push('No medical cover hired');
    if (!b.lines.length) todo.push('No budget lines yet');
    if (waiting.length) todo.push(`${waiting.length} request(s) waiting for you to finalize`);
    if (tasks.overdue) todo.push(`${tasks.overdue} overdue task(s)`);
    const days = ev.starts_on ? Math.ceil((Date.parse(new Date(ev.starts_on).toISOString().slice(0, 10)) - Date.now()) / 86400000) : null;
    return {
      event: { id: ev.id, name: ev.name, status: ev.status, starts_on: ev.starts_on, ends_on: ev.ends_on, registration_deadline: ev.registration_deadline, days_to_go: days, multi_sport: !!prog },
      requests: { by_kind: by, total: reqs.length, waiting_for_you: waiting }, tasks, budget: { summary: b.summary, alerts: b.alerts }, crew: staff, todo,
    };
  },
});
