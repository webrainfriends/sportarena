import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, mustFind, mustOwn } from '../helpers.js';
import { decryptFields, encryptFields } from '../crypto.js';

const CONTACT = ['contact_name', 'contact_email', 'contact_phone'];
const date = z.string().date();

/** Who has to approve a sponsorship offer aimed at this target. */
async function targetOwner(type, targetId) {
  if (type === 'event') return (await mustFind('events', targetId, 'organizer_id')).organizer_id;
  if (type === 'team') return (await mustFind('teams', targetId, 'owner_id')).owner_id;
  await mustFind('users', targetId, 'id');
  return targetId;
}

cap({
  name: 'create_sponsor', method: 'POST', path: '/sponsors', tag: 'Sponsors', auth: ['sponsor'], status: 201,
  summary: 'Create a sponsor brand profile. Contact name/email/phone are encrypted.',
  input: z.object({ name: z.string().min(2).max(80), industry: z.string().max(60).optional(), website: z.string().url().optional(), emoji: z.string().max(8).optional(), contact_name: z.string().max(80).optional(), contact_email: z.string().email().optional(), contact_phone: z.string().max(30).optional() }),
  async handler({ user }, i) {
    const e = encryptFields(i, 'sponsors', CONTACT);
    const r = await one("INSERT INTO sponsors(owner_id, name, industry, website, emoji, contact_name_enc, contact_email_enc, contact_phone_enc) VALUES ($1,$2,$3,$4,coalesce($5,'💎'),$6,$7,$8) RETURNING id, name, industry, website, emoji",
      [user.id, i.name, i.industry, i.website, i.emoji, e.contact_name_enc ?? null, e.contact_email_enc ?? null, e.contact_phone_enc ?? null]);
    return r;
  },
});

cap({
  name: 'list_sponsors', method: 'GET', path: '/sponsors', tag: 'Sponsors', auth: 'public', summary: 'Sponsor directory (no contact details).',
  input: z.object({ q: z.string().optional(), ...page }),
  handler: (_, i) => many("SELECT id, name, industry, website, emoji FROM sponsors WHERE ($1::text IS NULL OR name ILIKE '%'||$1||'%') ORDER BY name LIMIT $2 OFFSET $3", [i.q ?? null, i.limit, i.offset]),
});

cap({
  name: 'get_sponsor', method: 'GET', path: '/sponsors/:id', tag: 'Sponsors', auth: 'public',
  summary: 'Sponsor profile and active sponsorships. Contact details are returned only to the owner.', input: z.object({ id }),
  async handler({ user }, i) {
    const s = await mustFind('sponsors', i.id);
    const deals = await many("SELECT id, target_type, target_id, amount_cents, in_kind, starts_on, ends_on FROM sponsorships WHERE sponsor_id=$1 AND status='active'", [i.id]);
    const out = { id: s.id, name: s.name, industry: s.industry, website: s.website, emoji: s.emoji, active_sponsorships: deals };
    if (user && (isAdmin(user) || user.id === s.owner_id)) {
      await audit(null, user.id, 'read_pii', 'sponsors', s.id);
      Object.assign(out, decryptFields(s, 'sponsors', CONTACT));
    }
    return out;
  },
});

cap({
  name: 'propose_sponsorship', method: 'POST', path: '/sponsorships', tag: 'Sponsors', auth: ['sponsor'], status: 201,
  summary: 'Offer sponsorship money/in-kind support to an event, team or athlete. The target owner must accept.',
  input: z.object({ sponsor_id: id, target_type: z.enum(['event', 'team', 'athlete']), target_id: id, amount_cents: money, in_kind: z.string().max(200).optional(), starts_on: date.optional(), ends_on: date.optional() }),
  async handler({ user }, i) {
    const s = await mustFind('sponsors', i.sponsor_id);
    mustOwn(user, s.owner_id, 'sponsor');
    await targetOwner(i.target_type, i.target_id);
    return one('INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, in_kind, starts_on, ends_on, proposed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [i.sponsor_id, i.target_type, i.target_id, i.amount_cents, i.in_kind, i.starts_on, i.ends_on, user.id]);
  },
});

cap({
  name: 'list_sponsorships', method: 'GET', path: '/sponsorships', tag: 'Sponsors',
  summary: 'Deals you are part of: ones you proposed, or offers aimed at things you own (events, teams, yourself).',
  input: z.object({ status: z.enum(['proposed', 'active', 'declined', 'ended']).optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT ss.*, sp.name AS sponsor_name, sp.emoji AS sponsor_emoji FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id
      WHERE (sp.owner_id=$1 OR (ss.target_type='event' AND ss.target_id IN (SELECT id FROM events WHERE organizer_id=$1))
         OR (ss.target_type='team' AND ss.target_id IN (SELECT id FROM teams WHERE owner_id=$1)) OR (ss.target_type='athlete' AND ss.target_id=$1))
        AND ($2::text IS NULL OR ss.status=$2) ORDER BY ss.created_at DESC LIMIT $3 OFFSET $4`, [user.id, i.status ?? null, i.limit, i.offset]),
});

cap({
  name: 'decide_sponsorship', method: 'PATCH', path: '/sponsorships/:id', tag: 'Sponsors',
  summary: 'Target owner accepts/declines an offer; sponsor owner can end an active deal.',
  input: z.object({ id, status: z.enum(['active', 'declined', 'ended']) }),
  async handler({ user }, i) {
    const d = await mustFind('sponsorships', i.id);
    const sp = await mustFind('sponsors', d.sponsor_id);
    const owner = await targetOwner(d.target_type, d.target_id);
    const isTarget = user.id === owner, isSponsor = user.id === sp.owner_id;
    if (!isAdmin(user)) {
      if (i.status === 'ended' ? !(isSponsor || isTarget) : !isTarget) throw forbidden();
    }
    if (d.status === 'declined' || d.status === 'ended') throw conflict(`Sponsorship already ${d.status}`);
    if (i.status === 'ended' && d.status !== 'active') throw badRequest('Only active deals can be ended');
    return one('UPDATE sponsorships SET status=$2 WHERE id=$1 RETURNING *', [i.id, i.status]);
  },
});
