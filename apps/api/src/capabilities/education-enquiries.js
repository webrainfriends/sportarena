// Education pathways, part 2: the conversation between an athlete and an institution's admissions team.
// Enquiry -> replies (with brochures) -> route to the institution's website -> applied -> admitted -> enrolled. Broadcasts reach only
// enquirers who consented to them; sponsor introductions only those who consented to that. Everyone is told through the normal
// notification channels (in-app, push and email, subject to their own switches). Message text is encrypted and staff reads are logged.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, query } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, mustFind, PUBLIC_USER } from '../helpers.js';
import { sponsorContactUser, sponsorRole } from '../sponsor-access.js';
import { notify } from '../notify.js';
import { isYouth } from '../youth.js';
import { orgFor } from '../org-access.js';
import { ADMISSIONS, PIPELINE_OPEN, STAFF_STATUSES, addMessage, auditEnquiryRead, enquiryFor, openBody, staffIds } from '../education.js';

const TAG = 'Education';
const MAX_BROADCAST = 1000;
const text = (max) => z.string().trim().min(1).max(max);

const ENQ_COLS = `e.id, e.organisation_id, e.programme_id, e.athlete_id, e.sport_id, e.status, e.comms_consent, e.sponsor_consent, e.assigned_to, e.created_at, e.updated_at, e.last_message_at`;
const ENQ_JOIN = `FROM enquiries e JOIN organisations o ON o.id=e.organisation_id LEFT JOIN programmes p ON p.id=e.programme_id LEFT JOIN sports s ON s.id=e.sport_id`;
const ENQ_WHAT = `o.name AS institution, p.title AS programme_title, s.name AS sport, s.emoji AS sport_emoji`;

// ------------------------------------------------------------------ athlete side
cap({
  name: 'create_enquiry', method: 'POST', path: '/enquiries', tag: TAG, status: 201,
  summary: 'Ask a listed institution about a programme (or in general). The admissions team is told and answers here; your email and phone are never shared with them. Two optional, separately withdrawable consents: `comms_consent` lets the institution include you in announcements to enquirers, `sponsor_consent` lets it introduce you to a sponsor. Young people need a parent or guardian to do this.',
  input: z.object({ organisation_id: id, programme_id: id.optional(), sport_id: id.optional().describe('the sport you are interested in; defaults to the programme\'s only sport'), message: text(2000), comms_consent: z.boolean().default(false), sponsor_consent: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    if (await isYouth(user.id, c)) throw forbidden('A parent or guardian needs to send enquiries for you');
    const org = (await c.query("SELECT o.* FROM organisations o JOIN institution_profiles ip ON ip.organisation_id=o.id WHERE o.id=$1 AND o.status='active' AND ip.listed", [i.organisation_id])).rows[0];
    if (!org) throw notFound('Institution');
    let sportId = i.sport_id ?? null;
    if (i.programme_id) {
      const prog = (await c.query("SELECT id FROM programmes WHERE id=$1 AND organisation_id=$2 AND status='active'", [i.programme_id, org.id])).rows[0];
      if (!prog) throw notFound('Programme');
      const sports = (await c.query('SELECT sport_id FROM programme_sports WHERE programme_id=$1 AND removed_at IS NULL', [prog.id])).rows.map((r) => r.sport_id);
      if (sportId && sports.length && !sports.includes(sportId)) throw badRequest('That programme does not cover this sport');
      if (!sportId && sports.length === 1) sportId = sports[0];
    }
    if (sportId && !(await c.query('SELECT 1 FROM sports WHERE id=$1', [sportId])).rowCount) throw notFound('Sport');
    const dup = (await c.query("SELECT id FROM enquiries WHERE organisation_id=$1 AND athlete_id=$2 AND programme_id IS NOT DISTINCT FROM $3 AND status = ANY($4)", [org.id, user.id, i.programme_id ?? null, PIPELINE_OPEN])).rows[0];
    if (dup) throw conflict('You already have an open enquiry about this. Continue the conversation there.', { enquiry_id: dup.id });
    const enq = (await c.query(
      `INSERT INTO enquiries(organisation_id, programme_id, athlete_id, sport_id, comms_consent, comms_consent_at, sponsor_consent, sponsor_consent_at, athlete_read_at)
       VALUES ($1,$2,$3,$4,$5, CASE WHEN $5 THEN now() END, $6, CASE WHEN $6 THEN now() END, now()) RETURNING *`,
      [org.id, i.programme_id ?? null, user.id, sportId, i.comms_consent, i.sponsor_consent])).rows[0];
    await addMessage(c, enq, { senderId: user.id, side: 'athlete', body: i.message });
    for (const s of await staffIds(c, org.id)) await notify(c, s, { kind: 'enquiry_new', title: 'New enquiry', body: `${user.display_name} asked about ${i.programme_id ? 'a programme' : 'your institution'}. Open Admissions to answer.`, data: { enquiry_id: enq.id, organisation_id: org.id } });
    return enq;
  }),
});

cap({
  name: 'list_my_enquiries', method: 'GET', path: '/me/enquiries', tag: TAG,
  summary: 'Your enquiries to institutions, most recent conversation first, with where each one stands and whether there is an unread reply.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT ${ENQ_COLS}, ${ENQ_WHAT},
            EXISTS (SELECT 1 FROM enquiry_messages m WHERE m.enquiry_id=e.id AND m.side <> 'athlete' AND m.created_at > coalesce(e.athlete_read_at, '-infinity')) AS unread
       ${ENQ_JOIN} WHERE e.athlete_id=$1 ORDER BY e.last_message_at DESC, e.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'update_enquiry_consent', method: 'PATCH', path: '/enquiries/:id/consent', tag: TAG,
  summary: 'Athlete: switch announcements (`comms_consent`) or sponsor introductions (`sponsor_consent`) on or off for this enquiry, any time. Switching sponsor introductions off withdraws the introductions already made.',
  input: z.object({ id, comms_consent: z.boolean().optional(), sponsor_consent: z.boolean().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    if (i.comms_consent === undefined && i.sponsor_consent === undefined) throw badRequest('Nothing to update');
    const { enq } = await enquiryFor(user, i.id, { c, side: 'athlete' });
    const row = (await c.query(
      `UPDATE enquiries SET comms_consent=coalesce($2,comms_consent), sponsor_consent=coalesce($3,sponsor_consent),
              comms_consent_at = CASE WHEN $2 IS NOT NULL AND $2 <> comms_consent THEN now() ELSE comms_consent_at END,
              sponsor_consent_at = CASE WHEN $3 IS NOT NULL AND $3 <> sponsor_consent THEN now() ELSE sponsor_consent_at END, updated_at=now() WHERE id=$1
       RETURNING id, comms_consent, comms_consent_at, sponsor_consent, sponsor_consent_at`, [enq.id, i.comms_consent ?? null, i.sponsor_consent ?? null])).rows[0];
    if (i.sponsor_consent === false) await c.query("UPDATE enquiry_sponsor_links SET status='withdrawn', withdrawn_at=now() WHERE enquiry_id=$1 AND status='introduced'", [enq.id]);
    await audit(c, user.id, 'update_enquiry_consent', 'enquiries', enq.id);
    return row;
  }),
});

cap({
  name: 'withdraw_enquiry', method: 'POST', path: '/enquiries/:id/withdraw', tag: TAG,
  summary: 'Athlete: close your enquiry. You stop receiving announcements for it and sponsor introductions are withdrawn. The conversation is kept.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const { enq } = await enquiryFor(user, i.id, { c, side: 'athlete' });
    if (['withdrawn', 'closed', 'enrolled', 'declined'].includes(enq.status)) throw conflict(`This enquiry is already ${enq.status}`);
    const row = (await c.query("UPDATE enquiries SET status='withdrawn', comms_consent=false, sponsor_consent=false, updated_at=now() WHERE id=$1 RETURNING id, status", [enq.id])).rows[0];
    await c.query("UPDATE enquiry_sponsor_links SET status='withdrawn', withdrawn_at=now() WHERE enquiry_id=$1 AND status='introduced'", [enq.id]);
    await addMessage(c, enq, { side: 'system', kind: 'status', body: 'The athlete withdrew this enquiry.' });
    for (const s of await staffIds(c, enq.organisation_id)) await notify(c, s, { kind: 'enquiry_update', title: 'An enquiry was withdrawn', body: 'An athlete withdrew their enquiry.', data: { enquiry_id: enq.id } });
    return row;
  }),
});

// ------------------------------------------------------------------ the conversation (both sides)
cap({
  name: 'get_enquiry', method: 'GET', path: '/enquiries/:id', tag: TAG,
  summary: 'An enquiry with its whole conversation, the programme, brochures shared, the apply link and sponsor introductions. Visible to the athlete and the institution\'s admissions team only. Opening it marks it read for your side; the team\'s reads are logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { enq, org, side } = await enquiryFor(user, i.id);
    const [athlete, programme, messages, links] = await Promise.all([
      one(`SELECT ${PUBLIC_USER} FROM users u WHERE u.id=$1`, [enq.athlete_id]),
      enq.programme_id ? one('SELECT p.id, p.title, p.kind, p.mode, p.apply_url FROM programmes p WHERE p.id=$1', [enq.programme_id]) : null,
      many(`SELECT m.id, m.side, m.kind, m.body_enc, m.link_url, m.created_at, m.sender_id, b.id AS brochure_id, b.title AS brochure_title, b.url AS brochure_url
              FROM enquiry_messages m LEFT JOIN brochures b ON b.id=m.brochure_id WHERE m.enquiry_id=$1 ORDER BY m.created_at, m.id`, [enq.id]),
      many("SELECT l.id, l.status, l.note, l.created_at, s.id AS sponsor_id, s.name AS sponsor_name, s.emoji AS sponsor_emoji FROM enquiry_sponsor_links l JOIN sponsors s ON s.id=l.sponsor_id WHERE l.enquiry_id=$1 ORDER BY l.created_at", [enq.id]),
    ]);
    if (side === 'staff') await auditEnquiryRead(user, enq.id);
    await one(side === 'athlete' ? 'UPDATE enquiries SET athlete_read_at=now() WHERE id=$1 RETURNING id' : 'UPDATE enquiries SET staff_read_at=now() WHERE id=$1 RETURNING id', [enq.id]);
    const inst = await one('SELECT website FROM institution_profiles WHERE organisation_id=$1', [org.id]);
    return {
      id: enq.id, status: enq.status, my_side: side, organisation: { id: org.id, name: org.name, kind: org.kind, city: org.city }, athlete, programme, sport_id: enq.sport_id,
      comms_consent: enq.comms_consent, sponsor_consent: enq.sponsor_consent, assigned_to: enq.assigned_to, created_at: enq.created_at,
      apply_url: programme?.apply_url ?? inst?.website ?? null, sponsor_links: links,
      messages: messages.map(({ body_enc, ...m }) => ({ ...m, body: openBody(body_enc) })),
    };
  },
});

cap({
  name: 'send_enquiry_message', method: 'POST', path: '/enquiries/:id/messages', tag: TAG, status: 201,
  summary: 'Reply in the conversation. The other side is notified (in-app, push, email per their settings). Admissions staff can attach one of the institution\'s brochures. A closed, declined or withdrawn enquiry is reopened by staff (set the status) before more messages.',
  input: z.object({ id, body: text(4000), brochure_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { enq, org, side } = await enquiryFor(user, i.id, { c, write: true });
    if (['closed', 'declined', 'withdrawn'].includes(enq.status)) throw conflict(`This enquiry is ${enq.status}`);
    if (i.brochure_id && side !== 'staff') throw forbidden('Only the institution can share brochures');
    let brochure = null;
    if (i.brochure_id) {
      brochure = (await c.query("SELECT id, title FROM brochures WHERE id=$1 AND organisation_id=$2 AND status='active'", [i.brochure_id, org.id])).rows[0];
      if (!brochure) throw notFound('Brochure');
    }
    const msg = await addMessage(c, enq, { senderId: user.id, side: side === 'staff' ? 'institution' : 'athlete', kind: brochure ? 'brochure' : 'message', body: i.body, brochureId: brochure?.id ?? null });
    if (side === 'staff') {
      if (enq.status === 'new') await c.query("UPDATE enquiries SET status='in_conversation' WHERE id=$1", [enq.id]);
      await notify(c, enq.athlete_id, { kind: 'enquiry_reply', title: `${org.name} replied`, body: `${org.name} answered your enquiry${brochure ? ' and shared a brochure' : ''}. Open Pathways to read it.`, data: { enquiry_id: enq.id } });
    } else {
      for (const s of enq.assigned_to ? [enq.assigned_to] : await staffIds(c, org.id)) await notify(c, s, { kind: 'enquiry_message', title: 'New message from an enquirer', body: `${user.display_name} replied to an enquiry. Open Admissions to answer.`, data: { enquiry_id: enq.id, organisation_id: org.id } });
    }
    return msg;
  }),
});

// ------------------------------------------------------------------ admissions side
cap({
  name: 'list_org_enquiries', method: 'GET', path: '/organisations/:id/enquiries', tag: TAG,
  summary: 'Admissions staff: the enquiries to your institution, most recent conversation first. Filter by status, programme, sport, assignee, or the athlete\'s name or handle. Shows who has consented to announcements.',
  input: z.object({ id, status: z.enum(['new', 'in_conversation', 'referred', 'applied', 'admitted', 'enrolled', 'declined', 'withdrawn', 'closed']).optional(), programme_id: id.optional(), sport_id: id.optional(), mine: z.coerce.boolean().optional().describe('only enquiries assigned to you'), q: z.string().trim().max(60).optional(), ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, ADMISSIONS);
    return many(
      `SELECT ${ENQ_COLS}, ${ENQ_WHAT}, u.handle AS athlete_handle, u.display_name AS athlete_name, u.avatar_emoji, u.avatar_color,
              EXISTS (SELECT 1 FROM enquiry_messages m WHERE m.enquiry_id=e.id AND m.side = 'athlete' AND m.created_at > coalesce(e.staff_read_at, '-infinity')) AS unread
         ${ENQ_JOIN} JOIN users u ON u.id=e.athlete_id
        WHERE e.organisation_id=$1 AND ($2::text IS NULL OR e.status=$2) AND ($3::uuid IS NULL OR e.programme_id=$3) AND ($4::uuid IS NULL OR e.sport_id=$4)
          AND (NOT $5 OR e.assigned_to=$6) AND ($7::text IS NULL OR u.handle ILIKE '%'||$7||'%' OR u.display_name ILIKE '%'||$7||'%')
        ORDER BY e.last_message_at DESC, e.id LIMIT $8 OFFSET $9`,
      [i.id, i.status ?? null, i.programme_id ?? null, i.sport_id ?? null, !!i.mine, user.id, i.q ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_admissions_summary', method: 'GET', path: '/organisations/:id/admissions', tag: TAG,
  summary: 'Admissions staff: enquiries per stage, how many are unread, how many have consented to announcements, and how many programmes, brochures and broadcasts you have.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, ADMISSIONS);
    const [stages, totals] = await Promise.all([
      many('SELECT status, count(*)::int AS n FROM enquiries WHERE organisation_id=$1 GROUP BY status', [i.id]),
      one(`SELECT (SELECT count(*)::int FROM enquiries e WHERE e.organisation_id=$1 AND e.status = ANY($2) AND e.comms_consent) AS consenting,
                  (SELECT count(*)::int FROM enquiries e WHERE e.organisation_id=$1 AND EXISTS (SELECT 1 FROM enquiry_messages m WHERE m.enquiry_id=e.id AND m.side='athlete' AND m.created_at > coalesce(e.staff_read_at, '-infinity'))) AS unread,
                  (SELECT count(*)::int FROM programmes WHERE organisation_id=$1 AND status='active') AS programmes,
                  (SELECT count(*)::int FROM brochures WHERE organisation_id=$1 AND status='active') AS brochures,
                  (SELECT count(*)::int FROM enquiry_broadcasts WHERE organisation_id=$1) AS broadcasts,
                  (SELECT listed FROM institution_profiles WHERE organisation_id=$1) AS listed`, [i.id, PIPELINE_OPEN]),
    ]);
    return { stages: Object.fromEntries(['new', 'in_conversation', 'referred', 'applied', 'admitted', 'enrolled', 'declined', 'withdrawn', 'closed'].map((s) => [s, stages.find((r) => r.status === s)?.n ?? 0])), ...totals, listed: !!totals.listed };
  },
});

cap({
  name: 'update_enquiry_status', method: 'PATCH', path: '/enquiries/:id/status', tag: TAG,
  summary: 'Admissions staff: move an enquiry along the joining process (in_conversation, applied, admitted, enrolled, declined, closed) and/or assign it to a colleague. The athlete is told of each stage change. Withdrawn enquiries stay withdrawn.',
  input: z.object({ id, status: z.enum(STAFF_STATUSES).optional(), assigned_to: id.nullable().optional(), note: text(1000).optional().describe('shown to the athlete with the stage change') }),
  handler: ({ user }, i) => tx(async (c) => {
    if (i.status === undefined && i.assigned_to === undefined) throw badRequest('Nothing to update');
    const { enq, org } = await enquiryFor(user, i.id, { c, write: true, side: 'staff' });
    if (enq.status === 'withdrawn') throw conflict('The athlete withdrew this enquiry');
    if (i.assigned_to && !(await staffIds(c, org.id)).includes(i.assigned_to)) throw badRequest('Assign it to one of your admissions staff');
    const next = i.status ?? enq.status;
    if (next !== enq.status && ['new'].includes(next)) throw badRequest('An enquiry cannot go back to new');
    const row = (await c.query('UPDATE enquiries SET status=$2, assigned_to=CASE WHEN $4::boolean THEN $3 ELSE assigned_to END, updated_at=now() WHERE id=$1 RETURNING id, status, assigned_to', [enq.id, next, i.assigned_to ?? null, i.assigned_to !== undefined])).rows[0];
    if (next !== enq.status) {
      const label = next.replace('_', ' ');
      await addMessage(c, enq, { senderId: user.id, side: 'system', kind: 'status', body: `Status: ${label}${i.note ? ` — ${i.note}` : ''}` });
      await notify(c, enq.athlete_id, { kind: 'enquiry_status', title: `${org.name}: ${label}`, body: `Your enquiry is now "${label}".${i.note ? ` ${i.note}` : ''} Open Pathways for details.`, data: { enquiry_id: enq.id } });
    }
    return row;
  }),
});

cap({
  name: 'refer_enquiry_to_website', method: 'POST', path: '/enquiries/:id/refer', tag: TAG,
  summary: 'Admissions staff: send the athlete to the programme\'s application page (or the institution\'s website). The link is added to the conversation, the athlete is notified, and the enquiry moves to "referred".',
  input: z.object({ id, note: text(1000).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { enq, org } = await enquiryFor(user, i.id, { c, write: true, side: 'staff' });
    if (['withdrawn', 'closed', 'declined'].includes(enq.status)) throw conflict(`This enquiry is ${enq.status}`);
    const prog = enq.programme_id ? (await c.query('SELECT apply_url FROM programmes WHERE id=$1', [enq.programme_id])).rows[0] : null;
    const url = prog?.apply_url ?? (await c.query('SELECT website FROM institution_profiles WHERE organisation_id=$1', [org.id])).rows[0]?.website;
    if (!url) throw conflict('Add an apply link to the programme, or a website to your institution profile, first');
    await addMessage(c, enq, { senderId: user.id, side: 'institution', kind: 'referral', body: i.note ?? 'You can apply on our website.', linkUrl: url });
    if (['new', 'in_conversation'].includes(enq.status)) await c.query("UPDATE enquiries SET status='referred' WHERE id=$1", [enq.id]);
    await notify(c, enq.athlete_id, { kind: 'enquiry_reply', title: `${org.name}: how to apply`, body: `${org.name} sent you the link to apply. Open Pathways to continue.`, data: { enquiry_id: enq.id } });
    return { url, status: ['new', 'in_conversation'].includes(enq.status) ? 'referred' : enq.status };
  }),
});

// ------------------------------------------------------------------ broadcasts
cap({
  name: 'broadcast_to_enquirers', method: 'POST', path: '/organisations/:id/broadcasts', tag: TAG, status: 201,
  summary: `Admissions staff: send one announcement to everyone who enquired and agreed to announcements (comms_consent). Narrow it by programme, sport or stage; withdrawn enquiries never receive it. It lands in each person's conversation and is notified (in-app, push, email per their settings). Use dry_run to see how many would get it and how many are skipped for lack of consent. Up to ${MAX_BROADCAST} people per send.`,
  input: z.object({ id, subject: z.string().trim().min(2).max(120), body: text(4000), programme_id: id.optional(), sport_id: id.optional(), statuses: z.array(z.enum(PIPELINE_OPEN)).max(5).optional().describe('default: every open stage'), brochure_id: id.optional(), dry_run: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { org } = await orgFor(user, i.id, ADMISSIONS, { write: true, c });
    const statuses = i.statuses?.length ? i.statuses : PIPELINE_OPEN;
    if (i.brochure_id && !(await c.query("SELECT 1 FROM brochures WHERE id=$1 AND organisation_id=$2 AND status='active'", [i.brochure_id, org.id])).rowCount) throw notFound('Brochure');
    const { rows } = await c.query(
      `SELECT e.id, e.athlete_id, e.comms_consent FROM enquiries e
        WHERE e.organisation_id=$1 AND e.status = ANY($2) AND ($3::uuid IS NULL OR e.programme_id=$3) AND ($4::uuid IS NULL OR e.sport_id=$4) ORDER BY e.created_at, e.id`,
      [org.id, statuses, i.programme_id ?? null, i.sport_id ?? null]);
    const eligible = rows.filter((r) => r.comms_consent), people = [...new Set(eligible.map((r) => r.athlete_id))];
    const counts = { recipients: people.length, enquiries: eligible.length, skipped_no_consent: rows.filter((r) => !r.comms_consent).length };
    if (i.dry_run) return { dry_run: true, ...counts };
    if (!eligible.length) throw conflict('Nobody matches: no one in this selection has agreed to announcements', counts);
    if (people.length > MAX_BROADCAST) throw badRequest(`This would reach ${people.length} people; narrow it to ${MAX_BROADCAST} or fewer`, counts);
    const b = (await c.query(
      'INSERT INTO enquiry_broadcasts(organisation_id, sent_by, subject, body, programme_id, sport_id, statuses, recipients, skipped_no_consent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [org.id, user.id, i.subject, i.body, i.programme_id ?? null, i.sport_id ?? null, statuses, counts.recipients, counts.skipped_no_consent])).rows[0];
    for (const r of eligible) await addMessage(c, r, { senderId: user.id, side: 'institution', kind: 'broadcast', body: `${i.subject}\n\n${i.body}`, brochureId: i.brochure_id ?? null, broadcastId: b.id });
    for (const u of people) await notify(c, u, { kind: 'enquiry_broadcast', title: `${org.name}: ${i.subject}`, body: `${i.body}\n\nYou get this because you agreed to announcements when you enquired. Change that any time in Pathways.`, data: { organisation_id: org.id, broadcast_id: b.id } });
    await audit(c, user.id, 'broadcast_to_enquirers', 'organisations', org.id);
    return { dry_run: false, broadcast_id: b.id, ...counts };
  }),
});

cap({
  name: 'list_broadcasts', method: 'GET', path: '/organisations/:id/broadcasts', tag: TAG,
  summary: 'Admissions staff: announcements you have sent, newest first, with how many people received each and how many were skipped for lack of consent.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, ADMISSIONS);
    return many('SELECT b.*, u.display_name AS sent_by_name FROM enquiry_broadcasts b JOIN users u ON u.id=b.sent_by WHERE b.organisation_id=$1 ORDER BY b.created_at DESC, b.id LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ sponsors
cap({
  name: 'link_enquiry_sponsor', method: 'POST', path: '/enquiries/:id/sponsor-links', tag: TAG, status: 201,
  summary: 'Admissions staff: introduce an enquirer to a sponsor. Only possible when the athlete agreed to sponsor introductions. The sponsor is told (athlete handle and programme, no contact details) and can then send a normal sponsorship offer, which the athlete accepts or declines; the athlete sees the introduction.',
  input: z.object({ id, sponsor_id: id, note: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { enq, org } = await enquiryFor(user, i.id, { c, write: true, side: 'staff' });
    if (!enq.sponsor_consent) throw forbidden('The athlete has not agreed to sponsor introductions');
    if (['withdrawn', 'closed', 'declined'].includes(enq.status)) throw conflict(`This enquiry is ${enq.status}`);
    const sponsor = await mustFind('sponsors', i.sponsor_id, 'id, name, owner_id, entity_id', c);
    if ((await c.query("SELECT 1 FROM enquiry_sponsor_links WHERE enquiry_id=$1 AND sponsor_id=$2 AND status='introduced'", [enq.id, sponsor.id])).rowCount) throw conflict('This athlete is already introduced to that sponsor');
    const link = (await c.query('INSERT INTO enquiry_sponsor_links(enquiry_id, sponsor_id, note, linked_by) VALUES ($1,$2,$3,$4) RETURNING id, enquiry_id, sponsor_id, note, status, created_at', [enq.id, sponsor.id, i.note ?? null, user.id])).rows[0];
    await addMessage(c, enq, { senderId: user.id, side: 'system', kind: 'sponsor', body: `${org.name} introduced you to ${sponsor.name}.${i.note ? ` ${i.note}` : ''}` });
    await notify(c, enq.athlete_id, { kind: 'sponsor_introduction', title: `Introduced to ${sponsor.name}`, body: `${org.name} introduced you to a sponsor. They may send you an offer; you decide.`, data: { enquiry_id: enq.id } });
    await notify(c, await sponsorContactUser(c, sponsor), { kind: 'sponsor_introduction', title: 'An institution introduced an athlete', body: `${org.name} introduced an athlete to ${sponsor.name}. Open the sponsor page to see who.`, data: { sponsor_id: sponsor.id, link_id: link.id } });
    return link;
  }),
});

cap({
  name: 'withdraw_sponsor_link', method: 'POST', path: '/enquiries/:id/sponsor-links/:link_id/withdraw', tag: TAG,
  summary: 'Admissions staff: take back a sponsor introduction. The record is kept.',
  input: z.object({ id, link_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const { enq } = await enquiryFor(user, i.id, { c, write: true, side: 'staff' });
    const row = (await c.query("UPDATE enquiry_sponsor_links SET status='withdrawn', withdrawn_at=now() WHERE id=$1 AND enquiry_id=$2 AND status='introduced' RETURNING id, status", [i.link_id, enq.id])).rows[0];
    if (!row) throw notFound('Introduction');
    return row;
  }),
});

cap({
  name: 'list_sponsor_introductions', method: 'GET', path: '/sponsors/:id/introductions', tag: TAG,
  summary: 'Sponsor owner: athletes institutions have introduced to your brand, with the institution, programme and note. Send a sponsorship offer from here; the athlete still decides. Withdrawn introductions are marked.',
  input: z.object({ id, status: z.enum(['introduced', 'withdrawn']).optional(), ...page }),
  async handler({ user }, i) {
    const s = await mustFind('sponsors', i.id, 'id, owner_id, entity_id');
    if (!['owner', 'admin'].includes(await sponsorRole({ query }, user, s))) throw forbidden('Only the sponsor owner or an administrator can see introductions');
    return many(
      `SELECT l.id, l.status, l.note, l.created_at, u.id AS athlete_id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color, o.name AS institution, p.title AS programme_title, sp.name AS sport
         FROM enquiry_sponsor_links l JOIN enquiries e ON e.id=l.enquiry_id JOIN users u ON u.id=e.athlete_id JOIN organisations o ON o.id=e.organisation_id
         LEFT JOIN programmes p ON p.id=e.programme_id LEFT JOIN sports sp ON sp.id=e.sport_id
        WHERE l.sponsor_id=$1 AND ($2::text IS NULL OR l.status=$2) ORDER BY l.created_at DESC LIMIT $3 OFFSET $4`, [i.id, i.status ?? null, i.limit, i.offset]);
  },
});
