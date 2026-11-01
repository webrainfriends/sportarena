// Family dashboard and combined family calendar (issue #572). A read projection over records that already exist: guardian links and
// consents (youth.js), the athlete schedule and team attendance, team charges, academy charges, competition registrations and trips.
// Nothing is copied or stored here; acting for a child (RSVP, registration, payment, consent) uses the existing capabilities, which
// check the verified guardian link themselves. A dependent only appears while the link is verified, unexpired and the child is youth.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many } from '../db.js';
import { notFound } from '../errors.js';
import { PURPOSES, SCOPES, YOUTH_SQL, guardiansOf, hasConsent } from '../youth.js';
import { buildSchedule } from './athlete-schedule.js';

const TAG = 'Family';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** What a guardian sees of a child's calendar: sport, never health, recovery, duty or imported busy time (those need their own consent). */
const KID_KINDS = 'match,team,event,training,venue';
const NEEDS_PRESENCE = new Set(['match', 'team', 'training']);
const LINK_WARN_DAYS = 30;

const ymd = (d) => d.toISOString().slice(0, 10);
const plus = (d, n) => ymd(new Date(Date.parse(d) + n * 864e5));

/** Verified dependents of `user`, optionally one of them. Anyone who is not a verified guardian of `childId` gets "not found". */
export async function dependentsOf(user, childId) {
  const rows = await many(
    `SELECT u.id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color, u.avatar_url, u.youth_until::text AS independent_on, l.id AS link_id, l.scopes, l.relationship, l.expires_at,
            (SELECT count(*)::int FROM guardian_links o WHERE o.child_id=l.child_id AND o.status='active' AND o.revoked_at IS NULL AND (o.expires_at IS NULL OR o.expires_at > now())) AS guardians
       FROM guardian_links l JOIN users u ON u.id=l.child_id
      WHERE l.guardian_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND ${YOUTH_SQL}
        AND ($2::uuid IS NULL OR l.child_id=$2) ORDER BY u.display_name, u.id`, [user.id, childId ?? null]);
  if (childId && !rows.length) throw notFound('Dependent');
  return rows;
}

const person = (p, isMe = false) => ({ id: p.id, handle: p.handle, display_name: p.display_name, avatar_emoji: p.avatar_emoji ?? null, avatar_color: p.avatar_color ?? null, avatar_url: p.avatar_url ?? null, is_me: isMe });
const overlaps = (a, b) => new Date(a.starts_at) < new Date(b.ends_at) && new Date(b.starts_at) < new Date(a.ends_at);

/** Merge several people's schedules into one, flagging two different people who have to be somewhere at the same time. */
function merge(parts) {
  const items = parts.flatMap(({ who, sched }) => sched.items.map((x) => ({ ...x, person: who, family_clash: false })));
  items.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at) || a.person.display_name.localeCompare(b.person.display_name) || String(a.source_id).localeCompare(String(b.source_id)));
  const timed = items.filter((x) => !x.all_day && x.ends_at && NEEDS_PRESENCE.has(x.kind));
  const clashes = [];
  for (let i = 0; i < timed.length; i++) for (let j = i + 1; j < timed.length; j++) {
    const a = timed[i], b = timed[j];
    if (a.person.id !== b.person.id && overlaps(a, b)) {
      a.family_clash = b.family_clash = true;
      clashes.push([a, b].map((x) => ({ person_id: x.person.id, person_name: x.person.display_name, title: x.title, starts_at: x.starts_at, ends_at: x.ends_at })));
    }
  }
  return { items, clashes };
}

cap({
  name: 'get_family_schedule', method: 'GET', path: '/me/family/schedule', tag: TAG,
  summary: 'One calendar for the household: your own schedule and that of every young person you are a verified guardian of (matches, team sessions, events, training, venue bookings), each item tagged with whose it is and carrying the RSVP state, with a warning when two people have to be in different places at the same time. Health, recovery and imported calendars are never included for a child.',
  input: z.object({ from: day.optional(), to: day.optional(), child_id: id.optional().describe('Show only this dependent'), include_me: z.coerce.boolean().default(true), include_entries: z.coerce.boolean().default(false).describe('Also list events a team is merely entered in and nobody has asked the person to answer') }),
  async handler({ user }, i) {
    const kids = await dependentsOf(user, i.child_id);
    const range = { from: i.from, to: i.to };
    const parts = [];
    if (i.include_me && !i.child_id) parts.push({ who: person(user, true), sched: await buildSchedule(user, { ...range, kinds: KID_KINDS }) });
    for (const k of kids.filter((x) => (x.scopes ?? SCOPES).includes('calendar'))) parts.push({ who: person(k), sched: await buildSchedule({ id: k.id }, { ...range, kinds: KID_KINDS }) });
    if (!i.include_entries) {
      const rows = await asks(parts.map((p) => p.who.id));
      for (const p of parts) p.sched = { ...p.sched, items: quiet(p.sched.items, rows, p.who.id) };
    }
    const { items, clashes } = merge(parts);
    const first = parts[0]?.sched;
    return { from: first?.from ?? i.from ?? null, to: first?.to ?? i.to ?? null, people: parts.map((p) => p.who), items, family_clashes: clashes, action_required: items.filter((x) => x.action_required).length };
  },
});

const CHARGE = `SELECT ch.id AS charge_id, ch.member_id AS child_id, t.name AS team_name, b.title, b.currency, ch.due_on::text AS due_on, (ch.amount_minor - ch.adjusted_minor - ch.settled_minor)::bigint AS balance_minor,
                       (ch.due_on IS NOT NULL AND ch.due_on < current_date) AS overdue
                  FROM team_charges ch JOIN team_charge_batches b ON b.id=ch.batch_id JOIN teams t ON t.id=ch.team_id
                 WHERE ch.payer_id=$1 AND ch.member_id = ANY($2::uuid[]) AND ch.status='awaiting_payment' ORDER BY ch.due_on NULLS LAST, ch.created_at LIMIT 200`;
const ACADEMY = `SELECT ch.id AS charge_id, coalesce(e.user_id, a.athlete_id) AS child_id, o.name AS organisation_name, ch.kind AS title, ch.currency, ch.due_on::text AS due_on, (ch.amount_minor - ch.settled_minor - ch.adjusted_minor)::bigint AS balance_minor,
                        (ch.due_on IS NOT NULL AND ch.due_on < current_date) AS overdue,
                        NOT EXISTS (SELECT 1 FROM pos_sale_lines l JOIN pos_sales s ON s.id=l.sale_id WHERE l.charge_id=ch.id AND s.status='awaiting_payment') AS payable_online
                   FROM academy_charges ch LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id JOIN organisations o ON o.id=ch.organisation_id
                  WHERE ch.payer_id=$1 AND ch.status='awaiting_payment' AND coalesce(e.user_id, a.athlete_id) = ANY($2::uuid[]) ORDER BY ch.due_on NULLS LAST, ch.id LIMIT 200`;
const REGS = `SELECT r.id, r.user_id AS child_id, r.event_id, e.name AS event_name, t.name AS team_name, r.status, r.registration_no FROM reg_registrations r JOIN events e ON e.id=r.event_id JOIN teams t ON t.id=r.team_id
               WHERE r.user_id = ANY($1::uuid[]) AND r.status IN ('submitted','under_review','registered','suspended') AND e.status NOT IN ('completed','cancelled') ORDER BY r.created_at DESC LIMIT 200`;
/** Competitions a child's team is entered in whose registration is offered (a published policy, and no windows or one open now) but where the child has no live registration yet. */
const OPEN_REGS = `SELECT m.user_id AS child_id, m.team_id, t.name AS team_name, e.id AS event_id, e.name AS event_name
                     FROM team_members m JOIN teams t ON t.id=m.team_id JOIN event_entries x ON x.team_id=m.team_id AND x.status='accepted' JOIN events e ON e.id=x.event_id
                    WHERE m.user_id = ANY($1::uuid[]) AND m.status='active' AND e.status NOT IN ('completed','cancelled')
                      AND EXISTS (SELECT 1 FROM reg_policies p WHERE p.event_id=e.id)
                      AND (NOT EXISTS (SELECT 1 FROM reg_windows w WHERE w.event_id=e.id AND w.retired_at IS NULL)
                           OR EXISTS (SELECT 1 FROM reg_windows w WHERE w.event_id=e.id AND w.retired_at IS NULL AND w.opens_at <= now() AND w.closes_at > now()))
                      AND NOT EXISTS (SELECT 1 FROM reg_registrations r WHERE r.event_id=e.id AND r.user_id=m.user_id AND r.status IN ('submitted','under_review','registered','suspended'))
                    ORDER BY e.name LIMIT 200`;
const TRIPS = `SELECT p.id AS participant_id, p.user_id AS child_id, p.status, t.id AS trip_id, t.name, t.origin, t.destination, t.depart_at, t.return_at, t.timezone, tm.name AS team_name,
                      EXISTS (SELECT 1 FROM trip_consents c WHERE c.participant_id=p.id AND c.revoked_at IS NULL AND c.expires_at > now()
                                AND EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=c.guardian_id AND l.child_id=c.child_id AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()))) AS consent_current,
                      (SELECT count(*)::int FROM trip_segments s WHERE s.trip_id=t.id) AS legs
                 FROM trip_participants p JOIN trips t ON t.id=p.trip_id LEFT JOIN teams tm ON tm.id=t.team_id
                WHERE p.user_id = ANY($1::uuid[]) AND p.status IN ('invited','confirmed') AND t.status NOT IN ('completed','cancelled') AND t.return_at > now() ORDER BY t.depart_at LIMIT 100`;

const TEAMS = `SELECT m.user_id AS child_id, t.id, t.name, t.emoji, m.role FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id = ANY($1::uuid[]) AND m.status='active' ORDER BY t.name LIMIT 200`;

/** Consent state per purpose, the same rule as list_youth_consents: only a current grant by a still-verified guardian counts. */
async function consentStates(childIds) {
  const rows = await many('SELECT child_id, purpose, expires_at, revoked_at FROM youth_consents WHERE child_id = ANY($1::uuid[])', [childIds]);
  const out = new Map();
  for (const cid of childIds) {
    const states = [];
    for (const purpose of PURPOSES) {
      const r = rows.find((x) => x.child_id === cid && x.purpose === purpose);
      const state = !r ? 'not_given' : r.revoked_at ? 'revoked' : new Date(r.expires_at) <= new Date() ? 'expired' : (await hasConsent(cid, purpose)) ? 'active' : 'lapsed';
      states.push({ purpose, state, expires_at: r?.expires_at ?? null });
    }
    out.set(cid, states);
  }
  return out;
}

/** Event-level "entered" items are never answered (nobody asked), so they only add noise: keep an event only when its team actually asked this person. */
const asks = (ids) => (ids.length ? many("SELECT user_id, team_id, event_id, fixture_id FROM team_attendance WHERE user_id = ANY($1::uuid[]) AND rsvp='pending'", [ids]) : []);
const asked = (rows, personId, rsvp) => rows.some((a) => a.user_id === personId && a.team_id === rsvp.team_id && (rsvp.fixture_id ? a.fixture_id === rsvp.fixture_id : !a.fixture_id && a.event_id === rsvp.event_id));
const quiet = (items, rows, personId) => items.filter((x) => !(x.source_type === 'event' && x.rsvp?.value === 'pending' && !asked(rows, personId, x.rsvp)));

/** The primary guardian (verified first) may narrow the other guardians, so they see who those are and what each may do. Everyone else sees nothing of them. */
async function coGuardians(userId, childIds) {
  const out = new Map();
  for (const cid of childIds) {
    if ((await guardiansOf(cid))[0] !== userId) continue;
    out.set(cid, await many(`SELECT l.id AS link_id, l.guardian_id, u.display_name, l.scopes FROM guardian_links l JOIN users u ON u.id=l.guardian_id
                              WHERE l.child_id=$1 AND l.guardian_id<>$2 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) ORDER BY l.created_at, l.id`, [cid, userId]));
  }
  return out;
}

const sum = (rows) => Object.entries(rows.reduce((m, r) => ({ ...m, [r.currency]: (m[r.currency] ?? 0) + Number(r.balance_minor) }), {})).map(([currency, due_minor]) => ({ currency, due_minor })).sort((a, b) => a.currency.localeCompare(b.currency));

cap({
  name: 'get_family_dashboard', method: 'GET', path: '/me/family', tag: TAG,
  summary: 'The family dashboard for a guardian: for each verified dependent, their teams (for team chat), what is coming up in the next two weeks, matches awaiting an RSVP, fees and academy charges due, competition registrations (live and open to complete), trips needing a guardian consent, and permissions that have lapsed, plus one combined to-do list and the total due per currency. Each to-do carries the ids to act on with the existing capabilities (set_event_rsvp, submit_registration, create_payment, decide_trip_consent, grant_youth_consent). Pass child_id to switch to one dependent. Only people you are currently a verified guardian of appear.',
  input: z.object({ child_id: id.optional().describe('Switch to one dependent'), days: z.coerce.number().int().min(1).max(31).default(14) }),
  async handler({ user }, i) {
    const kids = await dependentsOf(user, i.child_id);
    const ids = kids.map((k) => k.id);
    const from = ymd(new Date()), to = plus(from, i.days);
    const [charges, academy, regs, openRegs, trips, teams, consents, unread, askedRows, scheds, co] = await Promise.all([
      ids.length ? many(CHARGE, [user.id, ids]) : [], ids.length ? many(ACADEMY, [user.id, ids]) : [], ids.length ? many(REGS, [ids]) : [], ids.length ? many(OPEN_REGS, [ids]) : [],
      ids.length ? many(TRIPS, [ids]) : [], ids.length ? many(TEAMS, [ids]) : [], consentStates(ids), many('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [user.id]),
      asks(ids),
      Promise.all(kids.map((k) => buildSchedule({ id: k.id }, { from, to, kinds: KID_KINDS }))),
      coGuardians(user.id, ids),
    ]);
    const todo = [];
    const push = (k, scope, t) => todo.push(k.scopes.includes(scope) ? t : { ...t, blocked: 'scope', scope });
    const dependents = kids.map((k, n) => {
      const who = person(k);
      const sched = scheds[n];
      const mine = (rows) => rows.filter((r) => r.child_id === k.id);
      // only a question the team actually asked: the schedule shows 'pending' for every entered event, a pending attendance row means someone asked
      const wanted = (x) => asked(askedRows, k.id, x.rsvp);
      const rsvp = sched.items.filter((x) => x.rsvp && x.rsvp.value === 'pending' && wanted(x)).map((x) => ({ title: x.title, context: x.context ?? null, starts_at: x.starts_at, team_id: x.rsvp.team_id, event_id: x.rsvp.event_id, fixture_id: x.rsvp.fixture_id }));
      const fees = [...mine(charges).map((r) => ({ ...r, source: 'team', purpose: { purpose_type: 'team_charge', purpose_id: r.charge_id } })), ...mine(academy).map((r) => ({ ...r, source: 'academy', purpose: r.payable_online ? { purpose_type: 'academy_charge', purpose_id: r.charge_id } : null }))];
      const lapsed = (consents.get(k.id) ?? []).filter((c) => ['expired', 'lapsed'].includes(c.state) || (c.purpose === 'participation' && c.state !== 'active'));
      const awaitingTrips = mine(trips).filter((t) => !t.consent_current);
      const renewal = k.expires_at && new Date(k.expires_at) < new Date(Date.now() + LINK_WARN_DAYS * 864e5);
      for (const r of rsvp) push(k, 'rsvp', { kind: 'rsvp', person: who, title: `Are ${k.display_name} coming? ${r.title}`, due_at: r.starts_at, action: { type: 'rsvp', child_id: k.id, team_id: r.team_id, event_id: r.event_id, fixture_id: r.fixture_id } });
      for (const f of fees) push(k, 'pay', { kind: 'payment', person: who, title: `${f.title}${f.team_name ? ` · ${f.team_name}` : f.organisation_name ? ` · ${f.organisation_name}` : ''}`, due_at: f.due_on, overdue: f.overdue, amount: { currency: f.currency, minor: Number(f.balance_minor) }, action: { type: 'pay', child_id: k.id, source: f.source, charge_id: f.charge_id, purpose: f.purpose } });
      for (const o of mine(openRegs)) push(k, 'register', { kind: 'registration', person: who, title: `Register ${k.display_name} for ${o.event_name}`, due_at: null, action: { type: 'register', child_id: k.id, event_id: o.event_id, team_id: o.team_id } });
      for (const t of awaitingTrips) push(k, 'travel_consent', { kind: 'trip_consent', person: who, title: `Trip consent for ${k.display_name}: ${t.name}`, due_at: t.depart_at, action: { type: 'trip_consent', child_id: k.id, trip_id: t.trip_id, participant_id: t.participant_id } });
      for (const c of lapsed) push(k, 'consent', { kind: 'consent', person: who, title: `${c.purpose} permission for ${k.display_name} is ${c.state === 'not_given' ? 'not given' : 'not current'}`, due_at: null, action: { type: 'consent', child_id: k.id, purpose: c.purpose } });
      if (renewal) todo.push({ kind: 'renew_link', person: who, title: `Renew your guardian verification for ${k.display_name}`, due_at: k.expires_at, action: { type: 'renew_link', child_id: k.id, link_id: k.link_id } });
      return {
        person: who, relationship: k.relationship, independent_on: k.independent_on, link_expires_at: k.expires_at, guardians: k.guardians, link_id: k.link_id, scopes: k.scopes, primary: co.has(k.id), co_guardians: co.get(k.id) ?? [],
        teams: mine(teams).map(({ child_id, ...t }) => t), upcoming: k.scopes.includes('calendar') ? quiet(sched.items, askedRows, k.id).slice(0, 8) : [], rsvp_pending: rsvp, fees, registrations: mine(regs), registrations_open: mine(openRegs), trips: mine(trips).map(({ child_id, ...t }) => t), consents: consents.get(k.id) ?? [], needs_attention: lapsed.length + awaitingTrips.length + (renewal ? 1 : 0),
      };
    });
    todo.sort((a, b) => (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0) || (a.due_at ? Date.parse(a.due_at) : Infinity) - (b.due_at ? Date.parse(b.due_at) : Infinity) || a.title.localeCompare(b.title));
    const money = [...charges, ...academy];
    return { from, to, dependents, todo, due: sum(money), overdue: money.filter((r) => r.overdue).length, unread_notifications: unread[0].n };
  },
});
