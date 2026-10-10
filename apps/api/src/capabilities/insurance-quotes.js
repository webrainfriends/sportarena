// Quotes and renewals: a person (or a team's / event's organiser) asks for a quote, insurers answer with priced offers, the buyer
// tracks them, accepts one (which creates the policy, pending payment) and renews the policy when it nears its end.
// Every step is written to the append-only insurance_quote_events, which is what the tracker shows.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notify.js';
import { audit, isAdmin, mustFind } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { checkCover, checkSubject, checkTerm, COVER_FOR, insertPolicy, loadPlan, managedSubjects, myInsurer, standing, subjectName, termsOf } from './insurance.js';

const today = () => new Date().toISOString().slice(0, 10);
const MAX_OPEN_REQUESTS = 20;
const MAX_FANOUT = 500;
const logEvent = (c, e) => c.query('INSERT INTO insurance_quote_events(request_id, quote_id, insurer_id, actor_id, action, detail) VALUES ($1,$2,$3,$4,$5,$6)', [e.request_id ?? null, e.quote_id ?? null, e.insurer_id ?? null, e.actor_id ?? null, e.action, e.detail ?? null]);
const ownerOf = async (c, insurerId) => (await c.query('SELECT owner_id FROM insurers WHERE id=$1', [insurerId])).rows[0]?.owner_id;
/** An open request is visible to every insurer taking requests; an addressed one only to that insurer. */
const visibleTo = (r, ins) => !!ins && ins.status === 'active' && (r.insurer_id === ins.id || (r.insurer_id === null && ins.accepting_requests));
/** The person who asked, or (for a team / event / venue) anyone who manages it: they follow the request, compare the quotes and decide. Admins only look. */
const decides = async (user, row, ownerId) => ownerId === user.id || (row.cover_for !== 'individual' && !isAdmin(user) && (await standing(user, row.cover_for, row.subject_id)) === 'manage');
/** Where the cover is: the team's or venue's city, or the venue an event is held at. */
const cityOf = async (coverFor, subject) => coverFor === 'team' ? (await one('SELECT city FROM teams WHERE id=$1', [subject]))?.city
  : coverFor === 'venue' ? (await one('SELECT city FROM venues WHERE id=$1', [subject]))?.city
  : coverFor === 'event' ? (await one('SELECT v.city FROM events e JOIN venues v ON v.id=e.venue_id WHERE e.id=$1', [subject]))?.city : null;
const effStatus = `CASE WHEN q.status='offered' AND q.valid_until < current_date THEN 'expired' ELSE q.status END`;

const QUOTE_COLS = `q.id, q.request_id, q.insurer_id, i.name AS insurer, (i.verified_at IS NOT NULL) AS insurer_verified, q.plan_id, pl.name AS plan_name, pl.emoji, q.buyer_id, ub.display_name AS buyer,
  q.cover_for, q.subject_id, ${subjectName('q.cover_for', 'q.subject_id')} AS subject_name, q.months, q.premium_cents, q.premium_cents * q.months AS total_cents, q.coverage_cents, q.deductible_cents, q.waiting_period_days,
  q.currency, q.note, q.details, q.valid_until, ${effStatus} AS status, q.policy_id, q.created_at, q.decided_at`;
const QUOTE_FROM = 'FROM insurance_quotes q JOIN insurers i ON i.id=q.insurer_id JOIN insurance_plans pl ON pl.id=q.plan_id JOIN users ub ON ub.id=q.buyer_id';
const num = (r) => ({ ...r, premium_cents: Number(r.premium_cents), total_cents: Number(r.total_cents), coverage_cents: Number(r.coverage_cents), deductible_cents: Number(r.deductible_cents) });

// ---------------------------------------------------------------- requests

cap({
  name: 'request_quote', method: 'POST', path: '/insurance/quote-requests', tag: 'Insurance', status: 201,
  summary: 'Ask for an insurance quote for yourself, a team you play or work in, an event/tournament you organise or sponsor, or a venue you run. Send it to one insurer (insurer_id, or implied by plan_id) or leave it open so it appears in the insurers\' marketplace (Billboard) and every insurer taking requests can answer. You can send several requests to different insurers and collect several quotes. The people who manage the team, event or venue can compare and accept the quotes. Say what you want covered (participants, sport, months); the note is encrypted and only the insurers it goes to can read it. Then follow it with get_quote_request, and accept a quote with accept_quote.',
  input: z.object({
    cover_for: z.enum(COVER_FOR).optional().describe('inferred from plan_id when you give one'), subject_id: id.optional().describe('team, event or venue id; omit for yourself'),
    plan_id: id.optional(), insurer_id: id.optional(), months: z.number().int().min(1).max(36).default(12), participants: z.number().int().min(1).max(100000).optional(),
    sport: z.string().max(60).optional(), city: z.string().max(80).optional().describe('where the cover is needed; defaults to the team\'s or venue\'s city'), message: z.string().max(2000).optional(),
  }),
  async handler({ user }, i) {
    let coverFor = i.cover_for, insurerId = i.insurer_id ?? null, plan = null;
    if (i.plan_id) {
      plan = await loadPlan(i.plan_id);
      if (plan.status !== 'active') throw conflict('This plan is no longer on sale');
      if (coverFor && coverFor !== plan.cover_for) throw badRequest(`That plan covers ${plan.cover_for}, not ${coverFor}`);
      if (insurerId && insurerId !== plan.insurer_id) throw badRequest('That plan belongs to another insurer');
      coverFor = plan.cover_for; insurerId = plan.insurer_id;
      checkTerm(plan, i.months);
    }
    if (!coverFor) throw badRequest('Say what you want covered (cover_for) or pick a plan');
    const subject = await checkSubject(user, coverFor, i.subject_id, 'request');
    const city = i.city ?? (await cityOf(coverFor, subject)) ?? null;
    let ins = null;
    if (insurerId) {
      ins = await one('SELECT * FROM insurers WHERE id=$1', [insurerId]);
      if (!ins || ins.status !== 'active') throw notFound('Insurer');
      if (!ins.accepting_requests) throw conflict('That insurer is not taking quote requests right now');
      if (ins.owner_id === user.id) throw badRequest('You cannot request a quote from your own insurer');
    }
    return tx(async (c) => {
      const open = Number((await c.query("SELECT count(*) AS n FROM insurance_quote_requests WHERE requester_id=$1 AND status IN ('open','quoted')", [user.id])).rows[0].n);
      if (open >= MAX_OPEN_REQUESTS) throw conflict(`You have ${open} open requests: cancel or finish some first`);
      const dup = (await c.query("SELECT 1 FROM insurance_quote_requests WHERE requester_id=$1 AND subject_id=$2 AND cover_for=$3 AND insurer_id IS NOT DISTINCT FROM $4 AND status IN ('open','quoted')", [user.id, subject, coverFor, insurerId])).rows[0];
      if (dup) throw conflict('You already have an open request for that');
      const r = (await c.query(
        `INSERT INTO insurance_quote_requests(requester_id, insurer_id, plan_id, cover_for, subject_id, months, participants, sport, message_enc, city) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, insurer_id, plan_id, cover_for, subject_id, months, participants, sport, city, status, created_at`,
        [user.id, insurerId, plan?.id ?? null, coverFor, subject, i.months, i.participants ?? null, i.sport ?? null, encrypt(i.message, 'insurance_quote_requests.message'), city])).rows[0];
      await logEvent(c, { request_id: r.id, insurer_id: insurerId, actor_id: user.id, action: 'requested', detail: insurerId ? `Sent to ${ins.name}` : 'Open to all insurers' });
      if (ins?.owner_id) await notify(c, ins.owner_id, { kind: 'quote_request', title: 'New quote request', body: 'Someone asked you for an insurance quote.', data: { request_id: r.id } });
      if (!insurerId) {   // open to all: tell every insurer that takes requests (generic text, no details), the Billboard has the rest
        const owners = (await c.query("SELECT owner_id FROM insurers WHERE status='active' AND accepting_requests AND owner_id IS NOT NULL AND owner_id<>$1 ORDER BY created_at LIMIT $2", [user.id, MAX_FANOUT])).rows;
        for (const o of owners) await notify(c, o.owner_id, { kind: 'quote_request', title: 'New insurance request on the Billboard', body: 'Someone is looking for insurance quotes. Open the Billboard to answer.', data: { request_id: r.id } });
      }
      return r;
    });
  },
});

const REQ_COLS = `r.id, r.requester_id, ur.display_name AS requester, r.insurer_id, i.name AS insurer, r.plan_id, pl.name AS plan_name, r.cover_for, r.subject_id,
  CASE r.cover_for WHEN 'individual' THEN ur.display_name ELSE ${subjectName('r.cover_for', 'r.subject_id')} END AS subject_name, r.months, r.participants, r.sport, r.city, r.status, r.created_at, r.updated_at`;
const REQ_FROM = 'FROM insurance_quote_requests r JOIN users ur ON ur.id=r.requester_id LEFT JOIN insurers i ON i.id=r.insurer_id LEFT JOIN insurance_plans pl ON pl.id=r.plan_id';

cap({
  name: 'list_quote_requests', method: 'GET', path: '/insurance/quote-requests', tag: 'Insurance',
  summary: 'Your quote requests, and those for the teams, events and venues you manage, with how many quotes each has received (view=mine, default). As an insurer, view=inbox lists the requests you can answer (addressed to you or open to all), minus the ones you declined, with your own quote on each so you can see what still needs one.',
  input: z.object({ view: z.enum(['mine', 'inbox']).default('mine'), status: z.enum(['open', 'quoted', 'accepted', 'cancelled', 'declined']).optional(), unanswered: z.coerce.boolean().optional().describe('inbox only: requests you have not quoted yet'), ...page }),
  async handler({ user }, i) {
    if (i.view === 'inbox') {
      const ins = await myInsurer(user);
      return many(
        `SELECT ${REQ_COLS}, (SELECT q.id FROM insurance_quotes q WHERE q.request_id=r.id AND q.insurer_id=$1 ORDER BY q.created_at DESC LIMIT 1) AS my_quote_id,
            (SELECT ${effStatus} FROM insurance_quotes q WHERE q.request_id=r.id AND q.insurer_id=$1 ORDER BY q.created_at DESC LIMIT 1) AS my_quote_status
           ${REQ_FROM} WHERE (r.insurer_id=$1 OR (r.insurer_id IS NULL AND $2)) AND r.status IN ('open','quoted') AND r.requester_id<>$3
            AND NOT EXISTS (SELECT 1 FROM insurance_request_declines d WHERE d.request_id=r.id AND d.insurer_id=$1)
            AND ($4::text IS NULL OR r.status=$4) AND (NOT $5 OR NOT EXISTS (SELECT 1 FROM insurance_quotes q WHERE q.request_id=r.id AND q.insurer_id=$1))
          ORDER BY r.created_at DESC LIMIT $6 OFFSET $7`,
        [ins.id, ins.accepting_requests && ins.status === 'active', user.id, i.status ?? null, !!i.unanswered, i.limit, i.offset]);
    }
    return many(
      `SELECT ${REQ_COLS}, (SELECT count(*)::int FROM insurance_quotes q WHERE q.request_id=r.id AND (q.status='offered' AND q.valid_until >= current_date)) AS open_quotes,
          (SELECT count(*)::int FROM insurance_quotes q WHERE q.request_id=r.id) AS quotes
         ${REQ_FROM} WHERE (r.requester_id=$1 OR (r.cover_for<>'individual' AND r.subject_id = ANY($5::uuid[]))) AND ($2::text IS NULL OR r.status=$2) ORDER BY r.created_at DESC LIMIT $3 OFFSET $4`,
      [user.id, i.status ?? null, i.limit, i.offset, await managedSubjects(user)]);
  },
});

/** Load a request and decide who is looking: the requester, an insurer that may answer it, or the platform team. */
async function viewRequest(user, rid) {
  const r = await mustFind('insurance_quote_requests', rid);
  const ins = await myInsurer(user, { required: false });
  const asRequester = await decides(user, r, r.requester_id);
  const asInsurer = visibleTo(r, ins) && !asRequester ? ins : null;
  if (!asRequester && !asInsurer && !isAdmin(user)) throw notFound('Quote request');
  return { r, ins: asInsurer, asRequester };
}

cap({
  name: 'get_quote_request', method: 'GET', path: '/insurance/quote-requests/:id', tag: 'Insurance',
  summary: 'One quote request with its tracker (every step so far), the quotes it received and the message threads. The requester sees all quotes and threads; an insurer sees only its own. The note is decrypted for them (audit-logged).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { r, ins, asRequester } = await viewRequest(user, i.id);
    const head = await one(`SELECT ${REQ_COLS} ${REQ_FROM} WHERE r.id=$1`, [r.id]);
    if (r.message_enc) await audit(null, user.id, 'read_pii', 'insurance_quote_requests', r.id);
    const only = asRequester || isAdmin(user) ? null : ins.id;
    const quotes = (await many(`SELECT ${QUOTE_COLS} ${QUOTE_FROM} WHERE q.request_id=$1 AND ($2::uuid IS NULL OR q.insurer_id=$2) ORDER BY q.created_at DESC`, [r.id, only])).map(num);
    const events = await many(
      `SELECT e.id, e.action, e.detail, e.insurer_id, e.quote_id, e.created_at, u.display_name AS actor FROM insurance_quote_events e LEFT JOIN users u ON u.id=e.actor_id
        WHERE (e.request_id=$1 OR e.quote_id = ANY($3::uuid[])) AND ($2::uuid IS NULL OR e.insurer_id IS NULL OR e.insurer_id=$2) ORDER BY e.created_at, e.id`, [r.id, only, quotes.map((q) => q.id)]);
    const msgs = await many(
      `SELECT m.id, m.insurer_id, i.name AS insurer, m.sender_id, u.display_name AS sender, m.body_enc, m.created_at FROM insurance_request_messages m JOIN insurers i ON i.id=m.insurer_id JOIN users u ON u.id=m.sender_id
        WHERE m.request_id=$1 AND ($2::uuid IS NULL OR m.insurer_id=$2) ORDER BY m.created_at, m.id`, [r.id, only]);
    if (msgs.length) await audit(null, user.id, 'read_pii', 'insurance_request_messages', r.id);
    return { ...head, message: decrypt(r.message_enc, 'insurance_quote_requests.message'), quotes, events, messages: msgs.map(({ body_enc, ...m }) => ({ ...m, body: decrypt(body_enc, 'insurance_request_messages.body') })) };
  },
});

cap({
  name: 'cancel_quote_request', method: 'POST', path: '/insurance/quote-requests/:id/cancel', tag: 'Insurance',
  summary: 'Cancel your own quote request (or one for a team, event or venue you manage). Quotes still on offer for it are closed. Nothing is deleted: the request and its history stay in your tracker.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM insurance_quote_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r || !(await decides(user, r, r.requester_id))) throw notFound('Quote request');
      if (!['open', 'quoted'].includes(r.status)) throw conflict(`A ${r.status} request cannot be cancelled`);
      const out = (await c.query("UPDATE insurance_quotes SET status='declined', decided_at=now(), updated_at=now() WHERE request_id=$1 AND status='offered' RETURNING id, insurer_id", [r.id])).rows;
      for (const q of out) { await logEvent(c, { request_id: r.id, quote_id: q.id, insurer_id: q.insurer_id, actor_id: user.id, action: 'quote_declined', detail: 'The request was cancelled' }); const o = await ownerOf(c, q.insurer_id); if (o) await notify(c, o, { kind: 'quote_update', title: 'A quote request was cancelled', body: 'A request you quoted was cancelled by the requester.', data: { request_id: r.id } }); }
      await logEvent(c, { request_id: r.id, actor_id: user.id, action: 'cancelled' });
      return (await c.query("UPDATE insurance_quote_requests SET status='cancelled', updated_at=now() WHERE id=$1 RETURNING id, status", [r.id])).rows[0];
    });
  },
});

cap({
  name: 'decline_quote_request', method: 'POST', path: '/insurance/quote-requests/:id/decline', tag: 'Insurance', auth: ['insurer'],
  summary: 'Pass on a quote request (it leaves your inbox). A request addressed only to you is closed as declined and the requester is told; an open request stays open for other insurers.',
  input: z.object({ id, reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    const ins = await myInsurer(user);
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM insurance_quote_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r || !visibleTo(r, ins)) throw notFound('Quote request');
      if (!['open', 'quoted'].includes(r.status)) throw conflict(`A ${r.status} request cannot be declined`);
      await c.query('INSERT INTO insurance_request_declines(request_id, insurer_id, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [r.id, ins.id, i.reason ?? null]);
      await logEvent(c, { request_id: r.id, insurer_id: ins.id, actor_id: user.id, action: 'insurer_declined', detail: i.reason ?? null });
      if (r.insurer_id === ins.id) {
        await c.query("UPDATE insurance_quote_requests SET status='declined', updated_at=now() WHERE id=$1", [r.id]);
        await notify(c, r.requester_id, { kind: 'quote_update', title: 'Your quote request was declined', body: `${ins.name} cannot quote this one. Open it to try another insurer.`, data: { request_id: r.id } });
      }
      return { id: r.id, declined: true };
    });
  },
});

// ---------------------------------------------------------------- quotes

cap({
  name: 'create_quote', method: 'POST', path: '/insurance/quotes', tag: 'Insurance', auth: ['insurer'], status: 201,
  summary: 'Send a priced quote on one of your active plans: either answering a quote request (request_id) or offered directly to a person (buyer_id, plus subject_id for a team or event). Premium is per month, like plans; you can change the cover, excess and waiting period from the plan\'s. It is valid for valid_days (default 14) and the buyer accepts or declines it. The plan\'s exclusions and conditions always apply. You can answer one request with several of your plans (one live quote per plan); withdraw a quote to send a revised one. `details` carries your own terms in plain words.',
  input: z.object({
    request_id: id.optional(), buyer_id: id.optional(), subject_id: id.optional(), plan_id: id, months: z.number().int().min(1).max(36).optional(), premium_cents: money,
    coverage_cents: money.refine((n) => n > 0).optional(), deductible_cents: money.optional(), waiting_period_days: z.number().int().min(0).max(730).optional(),
    valid_days: z.number().int().min(1).max(90).default(14), note: z.string().max(1000).optional(),
    details: z.string().max(2000).optional().describe('your own terms in plain words: what is included, special conditions, discounts'),
  }).refine((q) => !!q.request_id !== !!q.buyer_id, 'Give request_id (answering a request) or buyer_id (a direct offer), not both'),
  async handler({ user }, i) {
    const ins = await myInsurer(user);
    if (ins.status !== 'active') throw conflict('Your insurer profile is suspended');
    const plan = await loadPlan(i.plan_id);
    if (plan.insurer_id !== ins.id) throw forbidden('That plan belongs to another insurer');
    if (plan.status !== 'active') throw conflict('That plan is retired: quote on an active plan');
    return tx(async (c) => {
      let buyerId, subject, months = i.months, req = null;
      if (i.request_id) {
        req = (await c.query('SELECT * FROM insurance_quote_requests WHERE id=$1 FOR UPDATE', [i.request_id])).rows[0];
        if (!req || !visibleTo(req, ins)) throw notFound('Quote request');
        if (!['open', 'quoted'].includes(req.status)) throw conflict(`That request is ${req.status}`);
        if (req.requester_id === user.id) throw badRequest('You cannot quote your own request');
        if (req.cover_for !== plan.cover_for) throw badRequest(`That request is for ${req.cover_for} cover but the plan covers ${plan.cover_for}`);
        if ((await c.query("SELECT 1 FROM insurance_quotes q WHERE q.request_id=$1 AND q.insurer_id=$2 AND q.plan_id=$3 AND q.status='offered' AND q.valid_until >= current_date", [req.id, ins.id, plan.id])).rowCount) throw conflict('You already have a live quote on this request for that plan: withdraw it to send a revised one');
        buyerId = req.requester_id; subject = req.subject_id; months ??= req.months;
      } else {
        if (i.buyer_id === user.id) throw badRequest('You cannot quote yourself');
        const buyer = (await c.query('SELECT id FROM users WHERE id=$1', [i.buyer_id])).rows[0];
        if (!buyer) throw notFound('Buyer');
        buyerId = buyer.id; months ??= 12;
        if (plan.cover_for === 'individual') subject = buyer.id;
        else {
          if (!i.subject_id) throw badRequest('subject_id (the team or event) is required for team/event cover');
          if (!(await c.query(`SELECT 1 FROM ${{ team: 'teams', event: 'events', venue: 'venues' }[plan.cover_for]} WHERE id=$1`, [i.subject_id])).rowCount) throw notFound(plan.cover_for);
          subject = i.subject_id;
        }
        if (Number((await c.query("SELECT count(*) AS n FROM insurance_quotes WHERE insurer_id=$1 AND buyer_id=$2 AND request_id IS NULL AND status='offered' AND valid_until >= current_date", [ins.id, buyerId])).rows[0].n) >= 3) throw conflict('That person already has 3 live offers from you');
      }
      checkTerm(plan, months);
      const q = (await c.query(
        `INSERT INTO insurance_quotes(request_id, insurer_id, plan_id, buyer_id, cover_for, subject_id, months, premium_cents, coverage_cents, deductible_cents, waiting_period_days, currency, note, valid_until, created_by, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, current_date + $14::int, $15, $16) RETURNING id`,
        [req?.id ?? null, ins.id, plan.id, buyerId, plan.cover_for, subject, months, i.premium_cents, i.coverage_cents ?? plan.coverage_cents, i.deductible_cents ?? plan.deductible_cents, i.waiting_period_days ?? plan.waiting_period_days, plan.currency, i.note ?? null, i.valid_days, user.id, i.details ?? null])).rows[0];
      await logEvent(c, { request_id: req?.id, quote_id: q.id, insurer_id: ins.id, actor_id: user.id, action: 'quote_sent', detail: `${ins.name} sent a quote` });
      if (req) await c.query("UPDATE insurance_quote_requests SET status='quoted', updated_at=now() WHERE id=$1", [req.id]);
      await notify(c, buyerId, { kind: 'quote_update', title: 'You have a new insurance quote', body: `${ins.name} sent you a quote. Open it to compare and accept.`, data: { quote_id: q.id, request_id: req?.id ?? null } });
      return num((await c.query(`SELECT ${QUOTE_COLS} ${QUOTE_FROM} WHERE q.id=$1`, [q.id])).rows[0]);
    });
  },
});

cap({
  name: 'withdraw_quote', method: 'POST', path: '/insurance/quotes/:id/withdraw', tag: 'Insurance', auth: ['insurer'],
  summary: 'Withdraw a quote that is still on offer (e.g. to send a revised one). The buyer is told.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ins = await myInsurer(user);
    return tx(async (c) => {
      const q = (await c.query('SELECT * FROM insurance_quotes WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!q || q.insurer_id !== ins.id) throw notFound('Quote');
      if (q.status !== 'offered') throw conflict(`A ${q.status} quote cannot be withdrawn`);
      await c.query("UPDATE insurance_quotes SET status='withdrawn', decided_at=now(), updated_at=now() WHERE id=$1", [q.id]);
      await logEvent(c, { request_id: q.request_id, quote_id: q.id, insurer_id: ins.id, actor_id: user.id, action: 'quote_withdrawn' });
      if (q.request_id) await c.query("UPDATE insurance_quote_requests SET status='open', updated_at=now() WHERE id=$1 AND status='quoted' AND NOT EXISTS (SELECT 1 FROM insurance_quotes WHERE request_id=$1 AND status='offered' AND valid_until >= current_date)", [q.request_id]);
      await notify(c, q.buyer_id, { kind: 'quote_update', title: 'A quote was withdrawn', body: `${ins.name} withdrew a quote.`, data: { quote_id: q.id } });
      return { id: q.id, status: 'withdrawn' };
    });
  },
});

cap({
  name: 'list_quotes', method: 'GET', path: '/insurance/quotes', tag: 'Insurance',
  summary: 'Quotes you received, or received for the teams, events and venues you manage (view=received, default) or, as an insurer, quotes you sent (view=sent). Expired offers show as expired. Includes the total cost, cover, excess, waiting period and the date the quote is valid until.',
  input: z.object({ view: z.enum(['received', 'sent']).default('received'), status: z.enum(['offered', 'accepted', 'declined', 'withdrawn', 'expired']).optional(), ...page }),
  async handler({ user }, i) {
    const ins = i.view === 'sent' ? await myInsurer(user) : null;
    const rows = await many(
      `SELECT * FROM (SELECT ${QUOTE_COLS} ${QUOTE_FROM} WHERE ${ins ? 'q.insurer_id=$1' : "(q.buyer_id=$1 OR (q.cover_for<>'individual' AND q.subject_id = ANY($5::uuid[])))"}) x WHERE ($2::text IS NULL OR x.status=$2) ORDER BY x.created_at DESC LIMIT $3 OFFSET $4`,
      [ins ? ins.id : user.id, i.status ?? null, i.limit, i.offset, ...(ins ? [] : [await managedSubjects(user)])]);
    return rows.map(num);
  },
});

cap({
  name: 'get_quote', method: 'GET', path: '/insurance/quotes/:id', tag: 'Insurance',
  summary: 'One quote with the plan\'s exclusions and conditions (always shown), the tracker of what happened to it, and the policy it became once accepted. Buyer, the quoting insurer or admin.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const q = await one(`SELECT ${QUOTE_COLS}, pl.exclusions, pl.conditions, pl.currency AS plan_currency ${QUOTE_FROM} WHERE q.id=$1`, [i.id]);
    if (!q) throw notFound('Quote');
    const ins = await myInsurer(user, { required: false });
    if (!(await decides(user, q, q.buyer_id)) && !isAdmin(user) && !(ins && ins.id === q.insurer_id)) throw notFound('Quote');
    const events = await many('SELECT e.id, e.action, e.detail, e.created_at, u.display_name AS actor FROM insurance_quote_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.quote_id=$1 ORDER BY e.created_at, e.id', [q.id]);
    return { ...num(q), events };
  },
});

cap({
  name: 'accept_quote', method: 'POST', path: '/insurance/quotes/:id/accept', tag: 'Insurance', status: 201,
  summary: 'Accept a quote that is still on offer: this creates the policy on the quoted price and terms (cover assigned). The policy is pending_payment until paid (create_payment with purpose insurance_policy) when a payment provider is enabled. Your eligibility (team/event management, age and sport limits) is checked again now. Other quotes on the same request are closed.',
  input: z.object({ id, beneficiary: z.string().max(200).optional() }),
  async handler({ user }, i) {
    const probe = await one('SELECT * FROM insurance_quotes WHERE id=$1', [i.id]);
    if (!probe || !(await decides(user, probe, probe.buyer_id))) throw notFound('Quote');
    const plan = await loadPlan(probe.plan_id);
    const subject = await checkCover(user, plan, probe.cover_for === 'individual' ? undefined : probe.subject_id);
    return tx(async (c) => {
      const q = (await c.query('SELECT * FROM insurance_quotes WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (q.status !== 'offered') throw conflict(`This quote is ${q.status}`);
      if (String(q.valid_until instanceof Date ? q.valid_until.toISOString().slice(0, 10) : q.valid_until) < today()) throw conflict('This quote has expired: ask the insurer for a new one');
      const ins = (await c.query('SELECT * FROM insurers WHERE id=$1', [q.insurer_id])).rows[0];
      if (ins.status !== 'active') throw conflict('That insurer is suspended');
      const terms = termsOf({ ...plan, currency: q.currency }, { premium_cents: q.premium_cents, coverage_cents: q.coverage_cents, deductible_cents: q.deductible_cents, waiting_period_days: q.waiting_period_days, extra: { quote_id: q.id } });
      const pol = await insertPolicy(c, { plan, holderId: user.id, subject, months: q.months, beneficiary: i.beneficiary, terms, quoteId: q.id });
      await c.query("UPDATE insurance_quotes SET status='accepted', policy_id=$2, decided_at=now(), updated_at=now() WHERE id=$1", [q.id, pol.id]);
      await logEvent(c, { request_id: q.request_id, quote_id: q.id, insurer_id: q.insurer_id, actor_id: user.id, action: 'quote_accepted', detail: 'Cover assigned' });
      if (q.request_id) {
        const others = (await c.query("UPDATE insurance_quotes SET status='declined', decided_at=now(), updated_at=now() WHERE request_id=$1 AND id<>$2 AND status='offered' RETURNING id, insurer_id", [q.request_id, q.id])).rows;
        for (const o of others) { await logEvent(c, { request_id: q.request_id, quote_id: o.id, insurer_id: o.insurer_id, actor_id: user.id, action: 'quote_declined', detail: 'Another quote was accepted' }); }
        await c.query("UPDATE insurance_quote_requests SET status='accepted', updated_at=now() WHERE id=$1", [q.request_id]);
        await logEvent(c, { request_id: q.request_id, insurer_id: q.insurer_id, actor_id: user.id, action: 'accepted', detail: `${ins.name}'s quote` });
      }
      if (ins.owner_id) await notify(c, ins.owner_id, { kind: 'quote_update', title: 'Your quote was accepted', body: 'A quote you sent was accepted. A policy was created.', data: { quote_id: q.id, policy_id: pol.id } });
      return pol;
    });
  },
});

cap({
  name: 'decline_quote', method: 'POST', path: '/insurance/quotes/:id/decline', tag: 'Insurance',
  summary: 'Decline a quote you do not want. If it was the last live quote on your request, the request goes back to open so insurers can quote again.',
  input: z.object({ id, reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const q = (await c.query('SELECT * FROM insurance_quotes WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!q || !(await decides(user, q, q.buyer_id))) throw notFound('Quote');
      if (q.status !== 'offered') throw conflict(`This quote is ${q.status}`);
      await c.query("UPDATE insurance_quotes SET status='declined', decided_at=now(), updated_at=now() WHERE id=$1", [q.id]);
      await logEvent(c, { request_id: q.request_id, quote_id: q.id, insurer_id: q.insurer_id, actor_id: user.id, action: 'quote_declined', detail: i.reason ?? null });
      if (q.request_id) await c.query("UPDATE insurance_quote_requests SET status='open', updated_at=now() WHERE id=$1 AND status='quoted' AND NOT EXISTS (SELECT 1 FROM insurance_quotes WHERE request_id=$1 AND status='offered' AND valid_until >= current_date)", [q.request_id]);
      const o = await ownerOf(c, q.insurer_id);
      if (o) await notify(c, o, { kind: 'quote_update', title: 'A quote was declined', body: 'A quote you sent was declined.', data: { quote_id: q.id } });
      return { id: q.id, status: 'declined' };
    });
  },
});

cap({
  name: 'send_quote_message', method: 'POST', path: '/insurance/quote-requests/:id/messages', tag: 'Insurance', status: 201,
  summary: 'Message the other side of a quote request: the requester writes to one insurer (insurer_id), an insurer answers the requester. Messages are encrypted and only those two parties can read them. Use it to ask questions before quoting or accepting.',
  input: z.object({ id, insurer_id: id.optional().describe('requester only: which insurer you are writing to'), body: z.string().min(1).max(2000) }),
  async handler({ user }, i) {
    const { r, ins, asRequester } = await viewRequest(user, i.id);
    if (!asRequester && !ins) throw forbidden('Only the requester and the insurers it went to can message');
    if (!['open', 'quoted', 'accepted'].includes(r.status)) throw conflict(`A ${r.status} request is closed for messages`);
    return tx(async (c) => {
      let insurer = ins;
      if (asRequester) {
        if (!i.insurer_id) throw badRequest('insurer_id is required: which insurer are you writing to?');
        insurer = (await c.query('SELECT * FROM insurers WHERE id=$1', [i.insurer_id])).rows[0];
        if (!insurer || !visibleTo(r, insurer)) throw notFound('Insurer');
      }
      const m = (await c.query('INSERT INTO insurance_request_messages(request_id, insurer_id, sender_id, body_enc) VALUES ($1,$2,$3,$4) RETURNING id, request_id, insurer_id, created_at', [r.id, insurer.id, user.id, encrypt(i.body, 'insurance_request_messages.body')])).rows[0];
      const to = asRequester ? insurer.owner_id : r.requester_id;
      if (to) await notify(c, to, { kind: 'quote_message', title: 'New message about an insurance quote', body: 'You have a new message. Open the request to read it.', data: { request_id: r.id } });
      return m;
    });
  },
});

// ---------------------------------------------------------------- renewal

const RENEW_WINDOW_DAYS = 60;   // renewal opens this long before the end (the app flags "due" 30 days before)
const GRACE_DAYS = 30;          // a policy can still be renewed this long after it ended (cover restarts from today)

cap({
  name: 'renew_policy', method: 'POST', path: '/insurance/policies/:id/renew', tag: 'Insurance', status: 201,
  summary: `Renew a policy you hold. Renewal opens ${RENEW_WINDOW_DAYS} days before the end and stays open ${GRACE_DAYS} days after it. A renewal starts the day after the current policy ends (so cover is continuous and no new waiting period applies), or today if it already ended. It is priced on the plan's current premium and terms: pass plan_id to switch to another plan of the same kind, or request a quote for a negotiated price. Eligibility is checked again. Calling it twice returns the renewal that is still waiting for payment.`,
  input: z.object({ id, months: z.number().int().min(1).max(36).optional().describe('defaults to the length of the policy being renewed'), plan_id: id.optional(), beneficiary: z.string().max(200).optional() }),
  async handler({ user }, i) {
    const old = await mustFind('insurance_policies', i.id);
    if (!(await decides(user, { cover_for: old.subject_type, subject_id: old.subject_id }, old.holder_id))) throw forbidden();
    if (old.status !== 'active') throw conflict(`A ${old.status.replace('_', ' ')} policy cannot be renewed`);
    const left = Math.round((new Date(old.ends_on) - new Date(today())) / 864e5);
    if (left > RENEW_WINDOW_DAYS) throw conflict(`Renewal opens ${RENEW_WINDOW_DAYS} days before the policy ends`);
    if (left < -GRACE_DAYS) throw conflict(`This policy ended more than ${GRACE_DAYS} days ago: buy a new one`);
    const child = await one('SELECT * FROM insurance_policies WHERE renewed_from=$1', [old.id]);
    if (child) {
      if (child.status === 'pending_payment') return { id: child.id, status: child.status, starts_on: child.starts_on, ends_on: child.ends_on, renewed_from: old.id, subject_type: child.subject_type, subject_id: child.subject_id, plan_id: child.plan_id, amount_cents: Number(child.amount_cents) };
      throw conflict('This policy has already been renewed');
    }
    const plan = await loadPlan(i.plan_id ?? old.plan_id);
    if (plan.status !== 'active') throw conflict('This plan is no longer on sale: pick another plan or request a quote');
    if (plan.cover_for !== old.subject_type) throw badRequest(`That plan covers ${plan.cover_for}, but this policy covers ${old.subject_type}`);
    if (!(await one("SELECT 1 FROM insurers WHERE id=$1 AND status='active'", [plan.insurer_id]))) throw conflict('That insurer is suspended');
    const oldMonths = Math.max(1, Math.round((new Date(old.ends_on) - new Date(old.starts_on)) / 2629800000));
    const months = i.months ?? Math.min(36, oldMonths);
    checkTerm(plan, months);
    const subject = await checkCover(user, plan, old.subject_type === 'individual' ? undefined : old.subject_id);
    const continuous = left >= 0;
    const startsOn = continuous ? new Date(new Date(old.ends_on).getTime() + 864e5).toISOString().slice(0, 10) : today();
    const terms = termsOf(plan, { waiting_period_days: continuous ? 0 : plan.waiting_period_days, extra: { renewal: true, continuous } });
    return tx(async (c) => {
      const p = await insertPolicy(c, { plan, holderId: user.id, subject, months, beneficiary: i.beneficiary, terms, startsOn, renewedFrom: old.id });
      await audit(c, user.id, 'renew_policy', 'insurance_policies', old.id);
      return p;
    });
  },
});
