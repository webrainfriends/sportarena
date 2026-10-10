// Event planning rules shared by create_event and the planning capabilities: outbound requests (invitations, hires,
// quotes, bookings), what finalizing one does, and the budget it feeds.
import { badRequest, conflict, notFound } from './errors.js';
import { notify, venueTeam } from './notify.js';

export const REQUEST_KINDS = ['team', 'coach', 'referee', 'umpire', 'judge', 'scorer', 'timekeeper', 'physio', 'doctor', 'first_aider', 'volunteer', 'supplier', 'venue', 'insurer', 'sponsor'];
export const STAFF_KINDS = ['referee', 'umpire', 'judge', 'scorer', 'timekeeper', 'physio', 'doctor', 'first_aider', 'volunteer'];
const NEEDS_ROLE = { coach: 'coach', referee: 'referee', umpire: 'referee', judge: 'referee', timekeeper: 'referee', physio: 'physio', doctor: 'doctor', supplier: 'supplier' };
export const BUDGET_MAP = {
  team: ['income', 'entry_fees'], coach: ['expense', 'staff'], referee: ['expense', 'officials'], umpire: ['expense', 'officials'], judge: ['expense', 'officials'], scorer: ['expense', 'officials'],
  timekeeper: ['expense', 'officials'], physio: ['expense', 'medical'], doctor: ['expense', 'medical'], first_aider: ['expense', 'medical'], volunteer: ['expense', 'staff'],
  supplier: ['expense', 'equipment'], venue: ['expense', 'venue'], insurer: ['expense', 'insurance'], sponsor: ['income', 'sponsorship'],
};
export const BUDGET_CATEGORIES = ['venue', 'officials', 'medical', 'equipment', 'catering', 'insurance', 'marketing', 'prizes', 'staff', 'transport', 'admin', 'contingency', 'sponsorship', 'entry_fees', 'tickets', 'merchandise', 'other'];
const KIND_LABEL = { team: 'Team invitation', coach: 'Coach', referee: 'Referee', umpire: 'Umpire', judge: 'Judge', scorer: 'Scorer', timekeeper: 'Timekeeper', physio: 'Physio', doctor: 'Doctor', first_aider: 'First aider', volunteer: 'Volunteer', supplier: 'Supplier quote', venue: 'Venue booking', insurer: 'Insurance quote', sponsor: 'Sponsorship' };

const q = (c, text, args) => c.query(text, args).then((r) => r.rows);

/** Can this user answer the request (is the recipient, or runs the team / venue it is addressed to)? */
export async function canAnswer(c, user, r) {
  if (r.recipient_id === user.id) return true;
  if (r.kind === 'venue' && r.venue_id) return (await venueTeam(c, r.venue_id)).includes(user.id);
  if (r.kind === 'team' && r.team_id) {
    return (await q(c, "SELECT 1 FROM teams t WHERE t.id=$1 AND (t.owner_id=$2 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$2 AND m.status='active' AND m.role IN ('captain','manager')))", [r.team_id, user.id])).length > 0;
  }
  return false;
}

/** Everyone who should be told about a request addressed to a venue or team (the owner and the people who run it). */
async function audience(c, r) {
  const set = new Set([r.recipient_id].filter(Boolean));
  if (r.kind === 'venue' && r.venue_id) for (const u of await venueTeam(c, r.venue_id)) set.add(u);
  if (r.kind === 'team' && r.team_id) for (const x of await q(c, "SELECT user_id FROM team_members WHERE team_id=$1 AND status='active' AND role IN ('captain','manager')", [r.team_id])) set.add(x.user_id);
  return [...set];
}

/**
 * Create (and by default send) a request from an event. `input` carries kind + one target id (user_id / team_id /
 * venue_id / sponsor_id / insurer_id) plus the terms. Insurance requests are handed to the insurance module.
 */
export async function createRequest(c, user, ev, i, { insuranceRequest } = {}) {
  if (['completed', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
  let recipient = null, target = null, ref = {}, name = null;
  const col = {};
  if (i.kind === 'team') {
    const t = (await q(c, 'SELECT id, name, owner_id FROM teams WHERE id=$1', [i.team_id]))[0];
    if (!t) throw notFound('Team');
    if ((await q(c, "SELECT 1 FROM event_entries WHERE event_id=$1 AND team_id=$2 AND status IN ('pending','accepted')", [ev.id, t.id])).length) throw conflict('That team is already entered');
    recipient = t.owner_id; name = t.name; col.team_id = t.id;
  } else if (i.kind === 'venue') {
    const v = (await q(c, 'SELECT id, name, owner_id FROM venues WHERE id=$1', [i.venue_id]))[0];
    if (!v) throw notFound('Venue');
    recipient = v.owner_id; name = v.name; col.venue_id = v.id;
  } else if (i.kind === 'sponsor') {
    const s = (await q(c, 'SELECT id, name, owner_id FROM sponsors WHERE id=$1', [i.sponsor_id]))[0];
    if (!s) throw notFound('Sponsor');
    recipient = s.owner_id; name = s.name; col.sponsor_id = s.id;
  } else if (i.kind === 'insurer') {
    const s = (await q(c, "SELECT id, name, owner_id, status, accepting_requests FROM insurers WHERE id=$1", [i.insurer_id]))[0];
    if (!s || s.status !== 'active') throw notFound('Insurer');
    if (!s.accepting_requests) throw conflict('That insurer is not taking quote requests right now');
    recipient = s.owner_id; name = s.name; col.insurer_id = s.id;
  } else {
    const u = (await q(c, 'SELECT id, display_name, roles FROM users WHERE id=$1', [i.user_id]))[0];
    if (!u) throw notFound('User');
    const need = NEEDS_ROLE[i.kind];
    if (need && !u.roles.includes(need)) throw badRequest(`That person is not registered as ${need === 'referee' ? 'a referee' : `a ${need}`} on SportArena`);
    recipient = u.id; name = u.display_name;
  }
  if (recipient === user.id) throw badRequest('You cannot send a request to yourself');
  const sports = i.sport_ids ?? [];
  if (i.starts_on && i.ends_on && i.ends_on < i.starts_on) throw badRequest('ends_on is before starts_on');
  const title = i.title ?? `${KIND_LABEL[i.kind]} — ${ev.name}`;
  let r;
  try {
    r = (await q(c,
      `INSERT INTO event_requests(event_id, kind, recipient_id, team_id, venue_id, sponsor_id, insurer_id, target_name, title, message, sport_ids, starts_on, ends_on, quantity, offer_cents, currency, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,upper($16),$17,$18) RETURNING *`,
      [ev.id, i.kind, recipient, col.team_id ?? null, col.venue_id ?? null, col.sponsor_id ?? null, col.insurer_id ?? null, name, title, i.message ?? null, sports, i.starts_on ?? ev.starts_on ?? null, i.ends_on ?? ev.ends_on ?? null,
        i.quantity ?? null, i.offer_cents ?? null, i.currency ?? ev.currency ?? 'INR', i.send === false ? 'draft' : 'sent', user.id]))[0];
  } catch (e) { if (e.code === '23505') throw conflict('You already have an open request like this to the same recipient'); throw e; }
  if (i.kind === 'insurer' && r.status === 'sent') {
    if (!insuranceRequest) throw badRequest('Insurance requests need the insurance module');
    const sportName = sports.length ? (await q(c, 'SELECT name FROM sports WHERE id=$1', [sports[0]]))[0]?.name : null;
    const months = r.starts_on && r.ends_on ? Math.max(1, Math.ceil((Date.parse(r.ends_on) - Date.parse(r.starts_on)) / (30 * 86400000))) : 1;
    const qr = await insuranceRequest({ user }, { cover_for: 'event', subject_id: ev.id, insurer_id: col.insurer_id, months, participants: r.quantity ?? undefined, sport: sportName ?? undefined, message: r.message ?? undefined });
    r = (await q(c, 'UPDATE event_requests SET ref_type=$2, ref_id=$3 WHERE id=$1 RETURNING *', [r.id, 'insurance_quote_request', qr.id]))[0];
  } else if (r.status === 'sent') await announce(c, ev, r, user);
  return r;
}

export async function announce(c, ev, r, from) {
  for (const u of await audience(c, r)) {
    if (u === from.id) continue;
    await notify(c, u, { kind: 'event_request', title: `${KIND_LABEL[r.kind]}: ${ev.name}`, body: r.message ? r.message.slice(0, 200) : `${ev.name} has sent you a request. Open it to accept, quote or decline.`, data: { event_id: ev.id, request_id: r.id } });
  }
}

/** Create or refresh the budget line a finalized request commits. */
export async function upsertBudgetLine(c, ev, r, price, userId) {
  const [direction, category] = BUDGET_MAP[r.kind];
  const existing = (await q(c, "SELECT * FROM event_budget_lines WHERE request_id=$1 AND status <> 'void' FOR UPDATE", [r.id]))[0];
  if (existing) return (await q(c, "UPDATE event_budget_lines SET committed_cents=$2, planned_cents=greatest(planned_cents,$2), status='committed' WHERE id=$1 RETURNING *", [existing.id, price]))[0];
  return (await q(c,
    "INSERT INTO event_budget_lines(event_id, direction, category, name, planned_cents, committed_cents, status, request_id, created_by) VALUES ($1,$2,$3,$4,$5,$5,'committed',$6,$7) RETURNING *",
    [ev.id, direction, category, `${r.target_name} — ${KIND_LABEL[r.kind].toLowerCase()}`.slice(0, 120), price, r.id, userId]))[0];
}

/** What the agreed price is: the counterpart's quote, else what the organiser offered. */
export const priceOf = (r) => Number(r.quote_cents ?? r.offer_cents ?? 0);

/** Apply a finalized request: crew post / team entry / sponsorship / venue, plus its budget line. */
export async function finalizeRequest(c, ev, r, actor, { price } = {}) {
  const p = price ?? priceOf(r);
  if (r.kind === 'team') {
    const cap = ev.capacity ? Number((await q(c, "SELECT count(*) AS n FROM event_entries WHERE event_id=$1 AND status='accepted'", [ev.id]))[0].n) : 0;
    if (ev.capacity && cap >= ev.capacity) throw conflict('The event is full');
    await q(c, "INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted') ON CONFLICT (event_id, team_id, user_id) DO UPDATE SET status='accepted'", [ev.id, r.team_id]);
  } else if (STAFF_KINDS.includes(r.kind)) {
    const open = (await q(c, "SELECT 1 FROM event_staff WHERE event_id=$1 AND user_id=$2 AND role=$3 AND status IN ('invited','accepted')", [ev.id, r.recipient_id, r.kind])).length;
    if (!open) await q(c, "INSERT INTO event_staff(event_id, user_id, role, sport_id, status, rate_cents, currency, invited_by, responded_at) VALUES ($1,$2,$3,$4,'accepted',$5,$6,$7,now())", [ev.id, r.recipient_id, r.kind, r.sport_ids?.[0] ?? null, p, r.currency, actor.id]);
  } else if (r.kind === 'sponsor') {
    await q(c, "INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, status, proposed_by, starts_on, ends_on, decided_at, decided_by) VALUES ($1,'event',$2,$3,'active',$4,$5,$6,now(),$7)", [r.sponsor_id, ev.id, p, actor.id, r.starts_on, r.ends_on, r.recipient_id]);
  } else if (r.kind === 'venue' && !ev.venue_id) {
    await q(c, 'UPDATE events SET venue_id=$2 WHERE id=$1', [ev.id, r.venue_id]);
  }
  const line = p > 0 || r.kind !== 'team' ? await upsertBudgetLine(c, ev, r, p, actor.id) : null;
  const row = (await q(c, "UPDATE event_requests SET status='finalized', finalized_at=now(), budget_line_id=$2, updated_at=now() WHERE id=$1 RETURNING *", [r.id, line?.id ?? null]))[0];
  if (r.recipient_id && r.recipient_id !== actor.id) await notify(c, r.recipient_id, { kind: 'event_request', title: `Confirmed: ${ev.name}`, body: `${ev.name} confirmed ${KIND_LABEL[r.kind].toLowerCase()}${p ? ` at ${(p / 100).toFixed(2)} ${r.currency}` : ''}.`, data: { event_id: ev.id, request_id: r.id } });
  return row;
}

