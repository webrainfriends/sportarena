// Open positions as a public job board. Organisers open positions (crew or vendor places) in the tournament console; anyone signed in
// can apply; both sides exchange documents; the organiser accepts and a contract is generated; the applicant accepts the contract to be
// confirmed. Nothing is deleted: applications, contracts and documents only move through statuses (or are hidden).
import { createHash } from 'node:crypto';
import { requireApproved } from '../access.js';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { cap, id, money, page } from '../registry.js';
import { config } from '../config.js';
import { authenticate } from '../auth.js';
import { many, one, query, tx } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { toErrorBody } from '../invoke.js';
import { audit, isAdmin, mustFind } from '../helpers.js';
import { DOC_LIMITS, docHeaders, loadEncrypted, readBody, saveEncrypted, sniffDoc } from '../doc-store.js';
import { formatMinor, toMajor } from '../currency.js';
import { renderApplication } from '../documents/application-pdf.js';
import { notify } from '../notify.js';
import { eventForOrganizer } from './events.js';
import { ROLES, VENDOR_ROLES, assertEligible, confirmVendor, history, lockPerson } from './event-staff.js';

const GROUPS = { crew: ROLES.filter((r) => !VENDOR_ROLES[r]), vendor: Object.keys(VENDOR_ROLES) };
const LIVE = ['applied', 'contract_sent', 'accepted'];
const MAX_DOCS = 30;
const ended = (ev) => ['completed', 'cancelled'].includes(ev.status);

const POSITION_COLS = `r.id, r.event_id, r.role, r.title, r.notes, r.needed, r.fee_cents, r.currency, r.pay_direction, r.is_public, r.closed_at, r.created_at,
  r.requirements, r.min_experience, r.qualifications_required, r.application_deadline,
  (SELECT count(*)::int FROM event_staff_assignments a WHERE a.role_id=r.id AND a.status='accepted') AS filled,
  e.name AS event_name, e.kind AS event_kind, e.city, e.starts_on, e.ends_on, e.banner_emoji, e.organizer_id,
  s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji, u.display_name AS organiser_name,
  (e.organizer_id = $1) AS is_mine,
  (SELECT a.status FROM event_staff_assignments a WHERE a.role_id=r.id AND a.user_id=$1 ORDER BY a.created_at DESC LIMIT 1) AS my_status,
  (SELECT a.id FROM event_staff_assignments a WHERE a.role_id=r.id AND a.user_id=$1 ORDER BY a.created_at DESC LIMIT 1) AS my_assignment_id`;
const POSITION_FROM = 'FROM event_staff_roles r JOIN events e ON e.id=r.event_id JOIN users u ON u.id=e.organizer_id LEFT JOIN sports s ON s.id=e.sport_id';
const OPEN_NOW = `r.closed_at IS NULL AND r.is_public AND e.status NOT IN ('cancelled','completed') AND (e.ends_on IS NULL OR e.ends_on >= current_date)`;

const shape = (row, user) => {
  const { organizer_id, ...rest } = row;
  return { ...rest, open_places: Math.max(rest.needed - rest.filled, 0), login_required_for: user ? [] : ['apply'] };
};

cap({
  name: 'list_open_positions', method: 'GET', path: '/open-positions', tag: 'Open positions', auth: 'public',
  summary: 'The arena job board: every open position of every event (referees, scorers, doctors, volunteers, security … and vendor places such as retail stalls and catering) that still has places. Public — anyone can browse; applying needs a login (apply_to_position).',
  input: z.object({ group: z.enum(['crew', 'vendor']).optional(), role: z.enum(ROLES).optional(), sport: z.string().max(60).optional(), city: z.string().max(80).optional(), q: z.string().max(100).optional(), event_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT ${POSITION_COLS} ${POSITION_FROM}
        WHERE ${OPEN_NOW} AND (SELECT count(*) FROM event_staff_assignments a WHERE a.role_id=r.id AND a.status='accepted') < r.needed
          AND ($2::text[] IS NULL OR r.role = ANY($2)) AND ($3::text IS NULL OR r.role=$3) AND ($4::text IS NULL OR s.slug=$4 OR s.id::text=$4)
          AND ($5::text IS NULL OR e.city ILIKE $5) AND ($6::uuid IS NULL OR r.event_id=$6)
          AND ($7::text IS NULL OR r.title ILIKE '%'||$7||'%' OR r.notes ILIKE '%'||$7||'%' OR e.name ILIKE '%'||$7||'%' OR r.role ILIKE '%'||$7||'%')
        ORDER BY r.created_at DESC LIMIT $8 OFFSET $9`,
      [user?.id ?? null, i.group ? GROUPS[i.group] : null, i.role ?? null, i.sport ?? null, i.city ? `%${i.city}%` : null, i.event_id ?? null, i.q ?? null, i.limit, i.offset]);
    return rows.map((r) => shape(r, user));
  },
});

cap({
  name: 'get_open_position', method: 'GET', path: '/open-positions/:id', tag: 'Open positions', auth: 'public',
  summary: 'One open position with its event, fee, places left and (when signed in) your own application status.', input: z.object({ id }),
  async handler({ user }, i) {
    const row = await one(`SELECT ${POSITION_COLS} ${POSITION_FROM} WHERE r.id=$2 AND (r.is_public OR e.organizer_id=$1)`, [user?.id ?? null, i.id]);
    if (!row) throw notFound('Position');
    return shape(row, user);
  },
});

cap({
  name: 'apply_to_position', method: 'POST', path: '/staff-roles/:id/apply', tag: 'Open positions', status: 201,
  summary: 'Apply for an open position (any signed-in user). The organiser reviews it, can exchange documents with you, and accepts by issuing a contract that you then accept. For vendor places the fee is what you pay the organiser; fee_cents is an optional counter-proposal. application_data carries structured profile details: strengths, experience level, credentials, logistics, vendor stall info.',
  input: z.object({
    id,
    message: z.string().max(2000).optional(),
    fee_cents: money.optional(),
    application_data: z.object({
      strengths:             z.array(z.string().max(60)).max(8).optional(),
      experience_level:      z.enum(['first_time','some','experienced','expert']).optional(),
      years_active:          z.number().int().min(0).max(60).optional(),
      has_qualification:     z.boolean().optional(),
      qualification_body:    z.string().max(120).optional(),
      qualification_level:   z.string().max(120).optional(),
      qualification_ref:     z.string().max(120).optional(),
      qualification_expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      confirms_dates:        z.boolean().optional(),
      transport:             z.enum(['own_vehicle','public_transport','any']).optional(),
      accommodation_needed:  z.boolean().optional(),
      stall_name:            z.string().max(120).optional(),
      product_category:      z.enum(['retail','food','beverage','services']).optional(),
      products_desc:         z.string().max(1000).optional(),
      stall_width_m:         z.number().min(1).max(20).optional(),
      power_needed:          z.boolean().optional(),
      power_amps:            z.number().int().min(5).max(200).optional(),
      food_cert:             z.string().max(120).optional(),
      additional:            z.string().max(1000).optional(),
    }).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const role = (await c.query('SELECT * FROM event_staff_roles WHERE id=$1', [i.id])).rows[0];
      if (!role || !role.is_public) throw notFound('Position');
      const ev = await mustFind('events', role.event_id, '*', c);
      if (role.closed_at) throw conflict('This position is closed');
      if (ended(ev)) throw conflict(`Event is ${ev.status}`);
      if (ev.organizer_id === user.id) throw conflict('You organise this event');
      await lockPerson(c, user.id);
      if ((await c.query("SELECT count(*)::int AS n FROM event_staff_assignments WHERE role_id=$1 AND status='accepted'", [role.id])).rows[0].n >= role.needed) throw conflict('All places for this position are filled');
      const dup = await c.query("SELECT status FROM event_staff_assignments WHERE role_id=$1 AND user_id=$2 AND status IN ('invited','accepted','applied','contract_sent')", [role.id, user.id]);
      if (dup.rowCount) throw conflict(dup.rows[0].status === 'accepted' ? 'You already have this position' : 'You already have an open application or offer for this position');
      const a = (await c.query(
        "INSERT INTO event_staff_assignments(role_id, event_id, user_id, status, source, fee_cents, proposed_fee_cents, message, application_data) VALUES ($1,$2,$3,'applied','application',$4,$5,$6,$7) RETURNING *",
        [role.id, ev.id, user.id, role.fee_cents, i.fee_cents ?? null, i.message ?? null, i.application_data ? JSON.stringify(i.application_data) : null])).rows[0];
      await history(c, a.id, user.id, null, 'applied', null);
      await notify(c, ev.organizer_id, { kind: 'event_staff', title: `New applicant: ${ev.name}`, body: `${user.display_name} applied for ${role.title || role.role}.`, data: { event_id: ev.id, assignment_id: a.id } });
      return a;
    });
  },
});

const contractText = ({ ev, role, organiser, party, fee, currency, terms }) => {
  const when = ev.starts_on ? `${String(ev.starts_on).slice(0, 10)}${ev.ends_on && String(ev.ends_on).slice(0, 10) !== String(ev.starts_on).slice(0, 10) ? ` to ${String(ev.ends_on).slice(0, 10)}` : ''}` : 'dates to be confirmed';
  const vendor = !!VENDOR_ROLES[role.role];
  const amount = `${currency} ${toMajor(fee, currency)}`;
  return [
    'ENGAGEMENT AGREEMENT',
    '',
    `Event: ${ev.name}${ev.city ? `, ${ev.city}` : ''} (${when})`,
    `Position: ${role.title || role.role}`,
    `Organiser: ${organiser.display_name}`,
    `${vendor ? 'Vendor' : 'Engaged person'}: ${party.display_name}`,
    '',
    `1. Engagement. The Organiser engages ${party.display_name} for the position above at the event above, and ${party.display_name} accepts.`,
    fee > 0
      ? (vendor ? `2. Fee. ${party.display_name} pays the Organiser ${amount} for the place at the event.` : `2. Fee. The Organiser pays ${party.display_name} ${amount} for the engagement.`)
      : '2. Fee. No fee is payable by either party.',
    '3. Conduct. Both parties act in good faith, follow the event rules and the instructions of the Organiser on the day, and keep each other\'s documents and details confidential.',
    '4. Changes. Either party may withdraw, and the Organiser may release the engagement, through the platform; the record of that stays attached to this agreement.',
    ...(terms ? ['5. Additional terms.', terms] : []),
    '',
    `Accepting this agreement on GotMyGame is a binding electronic signature by both parties.`,
  ].join('\n');
};

cap({
  name: 'decide_application', method: 'POST', path: '/staff-assignments/:id/decide', tag: 'Open positions',
  summary: 'Organiser decision on an application. Accept generates a contract (optionally with an agreed fee and extra terms) that the applicant must then accept; reject closes the application.',
  input: z.object({ id, decision: z.enum(['accept', 'reject']), fee_cents: money.optional(), terms: z.string().max(4000).optional(), reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a0 = await mustFind('event_staff_assignments', i.id, '*', c);
      const ev = await eventForOrganizer(user, a0.event_id, c);
      await lockPerson(c, a0.user_id);
      const role = (await c.query('SELECT * FROM event_staff_roles WHERE id=$1 FOR UPDATE', [a0.role_id])).rows[0];
      const a = (await c.query('SELECT * FROM event_staff_assignments WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (a.status !== 'applied') throw conflict(`This application is ${a.status}`);
      if (i.decision === 'reject') {
        const out = (await c.query("UPDATE event_staff_assignments SET status='rejected', responded_at=now() WHERE id=$1 RETURNING *", [a.id])).rows[0];
        await history(c, a.id, user.id, 'applied', 'rejected', i.reason);
        await notify(c, a.user_id, { kind: 'event_staff', title: 'Application not taken forward', body: `${ev.name}: your application for ${role.title || role.role} was declined.${i.reason ? ` ${i.reason}` : ''}`, data: { event_id: ev.id, assignment_id: a.id } });
        return { assignment: out, contract: null };
      }
      if (ended(ev)) throw conflict(`Event is ${ev.status}`);
      if (role.closed_at) throw conflict('This position is closed');
      const taken = (await c.query("SELECT count(*)::int AS n FROM event_staff_assignments WHERE role_id=$1 AND status IN ('accepted','contract_sent')", [role.id])).rows[0].n;
      if (taken >= role.needed) throw conflict('All places for this position are filled or have a contract waiting');
      const fee = i.fee_cents ?? a.proposed_fee_cents ?? role.fee_cents;
      const party = await mustFind('users', a.user_id, 'id, display_name', c);
      const organiser = await mustFind('users', user.id, 'id, display_name', c);
      const title = `${role.title || role.role} — ${ev.name}`;
      const body = contractText({ ev, role, organiser, party, fee, currency: role.currency, terms: i.terms });
      const out = (await c.query("UPDATE event_staff_assignments SET status='contract_sent', fee_cents=$2, responded_at=now() WHERE id=$1 RETURNING *", [a.id, fee])).rows[0];
      const contract = (await c.query(
        'INSERT INTO event_contracts(event_id, assignment_id, organiser_id, party_id, title, body, fee_cents, currency, pay_direction) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [ev.id, a.id, user.id, a.user_id, title, body, fee, role.currency, role.pay_direction])).rows[0];
      await history(c, a.id, user.id, 'applied', 'contract_sent', i.reason);
      await audit(c, user.id, 'issue_event_contract', 'event_contracts', contract.id);
      await notify(c, a.user_id, { kind: 'event_staff', title: `Contract ready: ${ev.name}`, body: `${organiser.display_name} accepted your application for ${role.title || role.role}. Review and accept the contract.`, data: { event_id: ev.id, assignment_id: a.id, contract_id: contract.id } });
      return { assignment: out, contract };
    });
  },
});

async function contractFor(user, contractId) {
  const k = await one('SELECT * FROM event_contracts WHERE id=$1', [contractId]);
  if (!k) throw notFound('Contract');
  if (k.party_id !== user.id && !isAdmin(user)) await eventForOrganizer(user, k.event_id).catch(() => { throw notFound('Contract'); });
  return k;
}

cap({
  name: 'get_event_contract', method: 'GET', path: '/event-contracts/:id', tag: 'Open positions',
  summary: 'Read a contract (the organiser or the other party).', input: z.object({ id }),
  async handler({ user }, i) {
    const k = await contractFor(user, i.id);
    const names = await one('SELECT (SELECT display_name FROM users WHERE id=$1) AS organiser_name, (SELECT display_name FROM users WHERE id=$2) AS party_name, (SELECT name FROM events WHERE id=$3) AS event_name', [k.organiser_id, k.party_id, k.event_id]);
    return { ...k, ...names, mine_to_sign: k.party_id === user.id && k.status === 'pending' };
  },
});

cap({
  name: 'respond_event_contract', method: 'POST', path: '/event-contracts/:id/respond', tag: 'Open positions',
  summary: 'The person engaged accepts or declines the contract. Accepting confirms the position (and, for a vendor place, makes them a vendor of the event); declining reopens the place.',
  input: z.object({ id, accept: z.boolean(), reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k0 = await mustFind('event_contracts', i.id, '*', c);
      if (k0.party_id !== user.id) throw notFound('Contract');
      await lockPerson(c, user.id);
      const role = (await c.query('SELECT r.* FROM event_staff_roles r JOIN event_staff_assignments a ON a.role_id=r.id WHERE a.id=$1 FOR UPDATE OF r', [k0.assignment_id])).rows[0];
      const k = (await c.query('SELECT * FROM event_contracts WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      const a = (await c.query('SELECT * FROM event_staff_assignments WHERE id=$1 FOR UPDATE', [k.assignment_id])).rows[0];
      if (k.status !== 'pending' || a.status !== 'contract_sent') throw conflict(`This contract is ${k.status === 'pending' ? a.status : k.status}`);
      const ev = await mustFind('events', k.event_id, '*', c);
      if (i.accept) {
        if (ended(ev)) throw conflict(`Event is ${ev.status}`);
        if ((await c.query("SELECT count(*)::int AS n FROM event_staff_assignments WHERE role_id=$1 AND status='accepted'", [role.id])).rows[0].n >= role.needed) throw conflict('All places for this position are filled');
        await assertEligible(c, ev, role.role, a.user_id, { credentials: false });
      }
      const status = i.accept ? 'signed' : 'declined', to = i.accept ? 'accepted' : 'declined';
      const out = (await c.query('UPDATE event_contracts SET status=$2, party_signed_at=CASE WHEN $2=\'signed\' THEN now() END WHERE id=$1 RETURNING *', [k.id, status])).rows[0];
      await c.query('UPDATE event_staff_assignments SET status=$2, responded_at=now() WHERE id=$1', [a.id, to]);
      await history(c, a.id, user.id, 'contract_sent', to, i.reason);
      if (i.accept) await confirmVendor(c, ev, role, a.user_id, k.organiser_id, k.fee_cents);
      await audit(c, user.id, i.accept ? 'sign_event_contract' : 'decline_event_contract', 'event_contracts', k.id);
      await notify(c, k.organiser_id, { kind: 'event_staff', title: i.accept ? `Contract signed: ${ev.name}` : `Contract declined: ${ev.name}`, body: `${role.title || role.role}: the contract was ${status}.`, data: { event_id: ev.id, assignment_id: a.id, contract_id: k.id } });
      return out;
    });
  },
});

// ----------------------------------------------------------------------------------------------------- documents on an application
async function assignmentAccess(user, assignmentId) {
  const a = await one('SELECT * FROM event_staff_assignments WHERE id=$1', [assignmentId]);
  if (!a) throw notFound('Application');
  if (a.user_id === user.id) return { a, side: 'applicant' };
  try { await eventForOrganizer(user, a.event_id); } catch { throw notFound('Application'); }
  return { a, side: 'organiser' };
}
const DOC_COLS = 'd.id, d.assignment_id, d.title, d.content_type, d.size_bytes, d.uploaded_by, u.display_name AS uploaded_by_name, d.created_at';

cap({
  name: 'list_staff_documents', method: 'GET', path: '/staff-assignments/:id/documents', tag: 'Open positions',
  summary: 'Documents exchanged on an application: the organiser and the applicant both add and read them. Upload with PUT /staff-assignments/{id}/documents (raw PDF or photo body; query: title); download with GET /staff-documents/{id}/file.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await assignmentAccess(user, i.id);
    return many(`SELECT ${DOC_COLS} FROM event_staff_documents d JOIN users u ON u.id=d.uploaded_by WHERE d.assignment_id=$1 AND d.removed_at IS NULL ORDER BY d.created_at DESC`, [i.id]);
  },
});

// ----------------------------------------------------------------------------------------------------- the submitted application, in full
const ROLE_LABEL = { referee: 'Referee', umpire: 'Umpire', linesman: 'Assistant referee', scorer: 'Scorer', doctor: 'Doctor', physio: 'Physio', medic: 'Medic', volunteer: 'Volunteer', security: 'Security', other: 'Crew', retail: 'Retail stall', catering: 'Catering', vendor: 'Vendor', assessor: 'Assessor' };
const STATUS_LABEL = { invited: 'Offer made', applied: 'Applied - awaiting the organiser', contract_sent: 'Contract to sign', accepted: 'Confirmed', rejected: 'Not taken forward', declined: 'Declined', withdrawn: 'Withdrawn', released: 'Released', completed: 'Completed' };
const CHOICE = {
  experience_level: { first_time: 'First time in this role', some: 'Some experience', experienced: 'Experienced', expert: 'Expert' },
  transport: { own_vehicle: 'Own vehicle', public_transport: 'Public transport', any: 'Either' },
  product_category: { retail: 'Retail', food: 'Food', beverage: 'Beverage', services: 'Services' },
};
// Every answer the form can hold, in the order it is asked: [section, key, label, unit]. The screen, the PDF and agents all read this one list.
const ANSWERS = [
  ['strengths', 'strengths', 'Key strengths'],
  ['experience', 'experience_level', 'Experience level'], ['experience', 'years_active', 'Years in this role', 'years'],
  ['credentials', 'has_qualification', 'Holds a valid licence or certification'], ['credentials', 'qualification_body', 'Issuing body'], ['credentials', 'qualification_level', 'Grade, badge or licence level'],
  ['credentials', 'qualification_ref', 'Licence reference'], ['credentials', 'qualification_expires', 'Expires on'],
  ['stall', 'stall_name', 'Trading or stall name'], ['stall', 'product_category', 'Category'], ['stall', 'products_desc', 'What is sold'], ['stall', 'stall_width_m', 'Stall width', 'm'],
  ['stall', 'power_needed', 'Power needed at the stall'], ['stall', 'power_amps', 'Power requirement', 'A'], ['stall', 'food_cert', 'Food safety certificate'],
  ['logistics', 'confirms_dates', 'Available for all event dates'], ['logistics', 'transport', 'Getting there'], ['logistics', 'accommodation_needed', 'Accommodation needed'],
  ['additional', 'additional', 'Anything else for the organiser'],
];
const SECTION_TITLE = { strengths: 'What the applicant brings', experience: 'Experience', credentials: 'Credentials', stall: 'Stall details', logistics: 'Availability and logistics', additional: 'Additional information' };
const answerText = (key, v, unit) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : Array.isArray(v) ? v.join(', ') : CHOICE[key]?.[v] ?? `${v}${unit ? ` ${unit}` : ''}`);
const eventDates = (ev) => (ev.starts_on ? `${String(new Date(ev.starts_on).toISOString()).slice(0, 10)}${ev.ends_on && String(new Date(ev.ends_on).toISOString()).slice(0, 10) !== String(new Date(ev.starts_on).toISOString()).slice(0, 10) ? ` to ${String(new Date(ev.ends_on).toISOString()).slice(0, 10)}` : ''}` : null);

/** One application with everything that was submitted on it, for the applicant or the event's organiser. */
async function applicationView(user, assignmentId) {
  const { a, side } = await assignmentAccess(user, assignmentId);
  const role = await one('SELECT id, role, title, notes, requirements, min_experience, qualifications_required, application_deadline, fee_cents, currency, pay_direction FROM event_staff_roles WHERE id=$1', [a.role_id]);
  const ev = await one('SELECT e.id, e.name, e.city, e.starts_on, e.ends_on, e.status, e.organizer_id, u.display_name AS organiser_name FROM events e JOIN users u ON u.id=e.organizer_id WHERE e.id=$1', [a.event_id]);
  const applicant = await one('SELECT id, display_name, handle FROM users WHERE id=$1', [a.user_id]);
  const documents = await many(`SELECT ${DOC_COLS} FROM event_staff_documents d JOIN users u ON u.id=d.uploaded_by WHERE d.assignment_id=$1 AND d.removed_at IS NULL ORDER BY d.created_at`, [a.id]);
  const hist = await many('SELECT h.from_status, h.to_status, h.reason, h.at, u.display_name AS actor FROM event_staff_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.assignment_id=$1 ORDER BY h.at, h.id', [a.id]);
  const contract = await one("SELECT id, status FROM event_contracts WHERE assignment_id=$1 AND status <> 'void' ORDER BY created_at DESC LIMIT 1", [a.id]);
  const data = a.application_data ?? {};
  const sections = [];
  for (const [sec, key, label, unit] of ANSWERS) {
    if (data[key] === undefined || data[key] === null || data[key] === '' || (Array.isArray(data[key]) && !data[key].length)) continue;
    let s = sections.find((x) => x.key === sec);
    if (!s) sections.push(s = { key: sec, title: SECTION_TITLE[sec], rows: [] });
    s.rows.push({ key, label, value: data[key], text: answerText(key, data[key], unit) });
  }
  const vendor = role.pay_direction === 'applicant_pays';
  const amount = (c) => (c > 0 ? formatMinor(c, role.currency) : null);
  return {
    id: a.id, reference: `APP-${String(a.id).slice(0, 8).toUpperCase()}`, side, status: a.status, status_label: STATUS_LABEL[a.status] ?? a.status, source: a.source, submitted_at: a.created_at,
    position: { id: role.id, role: role.role, title: role.title || ROLE_LABEL[role.role] || role.role, kind_label: ROLE_LABEL[role.role] ?? role.role, notes: role.notes, requirements: role.requirements, min_experience: role.min_experience, qualifications_required: role.qualifications_required, application_deadline: role.application_deadline, pay_direction: role.pay_direction },
    event: { id: ev.id, name: ev.name, city: ev.city, starts_on: ev.starts_on, ends_on: ev.ends_on, dates: eventDates(ev), status: ev.status },
    organiser: { id: ev.organizer_id, display_name: ev.organiser_name },
    applicant: { id: applicant.id, display_name: applicant.display_name, handle: applicant.handle },
    fee: { currency: role.currency, posted_cents: role.fee_cents, proposed_cents: a.proposed_fee_cents, agreed_cents: a.fee_cents, vendor,
      posted: amount(role.fee_cents) ?? (vendor ? 'No stall fee' : 'Unpaid'), proposed: amount(a.proposed_fee_cents), agreed: amount(a.fee_cents) },
    message: a.message ?? null, sections, documents: documents.map((d) => ({ ...d, kind: d.content_type === 'application/pdf' ? 'PDF' : 'Photo' })),
    timeline: hist.map((h) => ({ at: h.at, from: h.from_status, to: h.to_status, label: STATUS_LABEL[h.to_status] ?? h.to_status, actor: h.actor, reason: h.reason })),
    contract: contract ? { id: contract.id, status: contract.status, status_label: `Contract ${String(contract.status).replace(/_/g, ' ')}` } : null,
    can: { add_documents: LIVE.includes(a.status) || a.status === 'invited', withdraw: side === 'applicant' && LIVE.includes(a.status) },
  };
}

cap({
  name: 'get_staff_application', method: 'GET', path: '/staff-assignments/:id/application', tag: 'Open positions',
  summary: 'The full submitted application for an event position: the position and event, both parties, the cover statement, every answer grouped as on the form (with a readable label and text for each), the fees posted, proposed and agreed, the documents attached, the status history and any contract. Readable by the applicant and by the event organiser only; anyone else gets 404. Download it as a PDF with GET /staff-assignments/{id}/application.pdf.',
  input: z.object({ id }),
  handler: ({ user }, i) => applicationView(user, i.id),
});

cap({
  name: 'remove_staff_document', method: 'DELETE', path: '/staff-documents/:id', tag: 'Open positions',
  summary: 'Hide a document you uploaded to an application. The encrypted file and audit trail are kept.', input: z.object({ id }),
  async handler({ user }, i) {
    const d = await one('SELECT * FROM event_staff_documents WHERE id=$1 AND removed_at IS NULL', [i.id]);
    if (!d) throw notFound('Document');
    if (d.uploaded_by !== user.id && !isAdmin(user)) throw forbidden('Only the person who added a document can hide it');
    await query('UPDATE event_staff_documents SET removed_at=now() WHERE id=$1', [d.id]);
    await audit(null, user.id, 'remove_staff_document', 'event_staff_documents', d.id);
    return { id: d.id, removed: true };
  },
});

export function staffDocsRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false });

  // PUT /api/v1/staff-assignments/:id/documents?title=…   body = the raw file (PDF, JPEG, PNG, WebP or GIF)
  r.put('/staff-assignments/:id/documents', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      requireApproved(user);
      const q = z.object({ id, title: z.string().min(1).max(120).optional() }).parse({ id: req.params.id, title: req.query.title });
      if (Number(req.headers['content-length'] ?? 0) > DOC_LIMITS.bytes) throw new AppError(413, 'too_large', 'File too large');
      const { a } = await assignmentAccess(user, q.id);
      const used = await one('SELECT count(*)::int AS n FROM event_staff_documents WHERE assignment_id=$1 AND removed_at IS NULL', [a.id]);
      if (used.n >= MAX_DOCS) throw new AppError(409, 'limit_reached', `Up to ${MAX_DOCS} documents can be kept on one application`);
      const buf = await readBody(req);
      if (!buf.length) throw badRequest('Empty upload');
      const t = sniffDoc(buf);
      if (!t) throw badRequest('Unsupported file. Use a PDF or a JPEG, PNG, WebP or GIF image.');
      const { id: did, file } = await saveEncrypted('staff-docs', 'event_staff_documents.file', buf);
      const row = await one(
        `INSERT INTO event_staff_documents(id, assignment_id, uploaded_by, title, content_type, file_name, size_bytes, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, assignment_id, title, content_type, size_bytes, uploaded_by, created_at`,
        [did, a.id, user.id, q.title ?? 'Document', t.type, file, buf.length, createHash('sha256').update(buf).digest('hex')]);
      await audit(null, user.id, 'upload_staff_document', 'event_staff_documents', did);
      const other = a.user_id === user.id ? (await mustFind('events', a.event_id, 'organizer_id')).organizer_id : a.user_id;
      await notify(null, other, { kind: 'event_staff', title: 'New document on an application', body: `${user.display_name} added “${row.title}”.`, data: { event_id: a.event_id, assignment_id: a.id } });
      res.status(201).json({ ...row, url: `/api/v1/staff-documents/${did}/file` });
    } catch (e) { req.resume(); fail(res, e); }
  });

  // GET /api/v1/staff-assignments/:id/application.pdf — the submitted application as a document; needs the Authorization header and is audit-logged.
  r.get('/staff-assignments/:id/application.pdf', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Application');
      const view = await applicationView(user, req.params.id);
      const { buffer } = await renderApplication(view);
      await audit(null, user.id, 'export_staff_application', 'event_staff_assignments', view.id);
      res.set({ ...docHeaders('application/pdf', buffer), 'Content-Disposition': `inline; filename="application-${view.reference}.pdf"` });
      res.end(buffer);
    } catch (e) { fail(res, e); }
  });

  // GET /api/v1/staff-documents/:id/file — needs the Authorization header; every download is audit-logged.
  r.get('/staff-documents/:id/file', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Document');
      const d = await one('SELECT * FROM event_staff_documents WHERE id=$1 AND removed_at IS NULL', [req.params.id]);
      if (!d) throw notFound('Document');
      await assignmentAccess(user, d.assignment_id);
      const bytes = await loadEncrypted('staff-docs', 'event_staff_documents.file', d.file_name);
      await audit(null, user.id, 'read_pii', 'event_staff_documents', d.id);
      res.set(docHeaders(d.content_type, bytes));
      res.end(bytes);
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('Document') : e); }
  });
  return r;
}
