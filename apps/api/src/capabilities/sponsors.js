import { badgesFor, withBadges } from '../verification.js';
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, mustFind, mustOwn } from '../helpers.js';
import { decryptFields, encryptFields } from '../crypto.js';
import { notify } from '../notify.js';
import { tx } from '../db.js';
import { PUBLIC_USER } from '../helpers.js';

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
  input: z.object({ q: z.string().optional(), mine: z.coerce.boolean().optional().describe('only brands you own (needs sign-in)'), ...page }),
  handler: async ({ user }, i) => withBadges('sponsor', await many("SELECT id, name, industry, website, emoji FROM sponsors WHERE ($1::text IS NULL OR name ILIKE '%'||$1||'%') AND (NOT $4 OR owner_id = $5) ORDER BY name LIMIT $2 OFFSET $3", [i.q ?? null, i.limit, i.offset, !!i.mine, user?.id ?? null])),
});

cap({
  name: 'get_sponsor', method: 'GET', path: '/sponsors/:id', tag: 'Sponsors', auth: 'public',
  summary: 'Sponsor profile and active sponsorships. Contact details are returned only to the owner.', input: z.object({ id }),
  async handler({ user }, i) {
    const s = await mustFind('sponsors', i.id);
    const deals = await many("SELECT id, target_type, target_id, amount_cents, in_kind, starts_on, ends_on FROM sponsorships WHERE sponsor_id=$1 AND status='active' AND visibility='public'", [i.id]);
    const out = { id: s.id, name: s.name, industry: s.industry, website: s.website, emoji: s.emoji, verified: (await badgesFor('sponsor', [s.id])).get(s.id) ?? [], active_sponsorships: deals };
    if (user && (isAdmin(user) || user.id === s.owner_id)) {
      await audit(null, user.id, 'read_pii', 'sponsors', s.id);
      Object.assign(out, decryptFields(s, 'sponsors', CONTACT));
    }
    return out;
  },
});

const DECLINE_COOLDOWN_DAYS = 30;
const LOOKING_FOR = z.enum(['cash', 'equipment', 'travel', 'coaching', 'apparel', 'nutrition', 'media']);

cap({
  name: 'get_my_sponsorship_profile', method: 'GET', path: '/me/sponsorship-profile', tag: 'Sponsors',
  summary: 'Your sponsorship discovery settings. Off by default: nobody can find you or send you an offer until you opt in.',
  handler: async ({ user }) => (await one('SELECT open_to_sponsors, pitch, looking_for, verified_sponsors_only, updated_at FROM sponsorship_profiles WHERE user_id=$1', [user.id]))
    ?? { open_to_sponsors: false, pitch: null, looking_for: [], verified_sponsors_only: false, updated_at: null },
});

cap({
  name: 'set_sponsorship_profile', method: 'POST', path: '/me/sponsorship-profile', tag: 'Sponsors',
  summary: 'Opt in or out of sponsorship discovery and set your public pitch. Only a handle, display name, sports, your pitch and what you are looking for are ever shown to sponsors; contact details never are. Turning it off hides you immediately; offers already sent stay yours to answer.',
  input: z.object({ open_to_sponsors: z.boolean(), pitch: z.string().max(600).nullable().optional(), looking_for: z.array(LOOKING_FOR).max(7).optional(), verified_sponsors_only: z.boolean().optional() }),
  async handler({ user }, i) {
    if (i.open_to_sponsors && !user.roles.includes('athlete')) throw forbidden('Add the athlete role to be open to sponsors');
    const cur = await one('SELECT * FROM sponsorship_profiles WHERE user_id=$1', [user.id]);
    const next = { pitch: i.pitch === undefined ? cur?.pitch ?? null : i.pitch, looking_for: i.looking_for ?? cur?.looking_for ?? [], verified_sponsors_only: i.verified_sponsors_only ?? cur?.verified_sponsors_only ?? false };
    return one(
      `INSERT INTO sponsorship_profiles(user_id, open_to_sponsors, pitch, looking_for, verified_sponsors_only) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET open_to_sponsors=$2, pitch=$3, looking_for=$4, verified_sponsors_only=$5, updated_at=now()
       RETURNING open_to_sponsors, pitch, looking_for, verified_sponsors_only, updated_at`,
      [user.id, i.open_to_sponsors, next.pitch, next.looking_for, next.verified_sponsors_only]);
  },
});

cap({
  name: 'discover_sponsorable_athletes', method: 'GET', path: '/sponsorable-athletes', tag: 'Sponsors', auth: ['sponsor'],
  summary: 'Sponsors: athletes who have explicitly opted in to sponsorship offers. Returns only public profile fields, their sports, pitch and what they are looking for; never contact details. Filter by sport, what they need, verified athletes and text.',
  input: z.object({ q: z.string().max(80).optional(), sport: z.string().max(60).optional().describe('sport slug'), looking_for: LOOKING_FOR.optional(), verified: z.coerce.boolean().optional(), ...page }),
  async handler(_, i) {
    const rows = await many(
      `SELECT ${PUBLIC_USER}, sp.pitch, sp.looking_for, sp.verified_sponsors_only,
              coalesce((SELECT array_agg(DISTINCT s.slug) FROM sport_profiles x JOIN sports s ON s.id=x.sport_id WHERE x.user_id=u.id), '{}') AS sports
         FROM sponsorship_profiles sp JOIN users u ON u.id=sp.user_id
        WHERE sp.open_to_sponsors AND 'athlete' = ANY(u.roles)
          AND ($1::text IS NULL OR u.display_name ILIKE '%'||$1||'%' OR u.handle ILIKE '%'||$1||'%' OR sp.pitch ILIKE '%'||$1||'%')
          AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM sport_profiles x JOIN sports s ON s.id=x.sport_id WHERE x.user_id=u.id AND s.slug=$2))
          AND ($3::text IS NULL OR $3 = ANY(sp.looking_for))
        ORDER BY u.display_name, u.id LIMIT $4 OFFSET $5`,
      [i.q ? i.q.replace(/[%_\\]/g, '\\$&') : null, i.sport ?? null, i.looking_for ?? null, i.limit, i.offset]);
    const out = await withBadges('user', rows);
    return i.verified ? out.filter((r) => r.verified?.length) : out;
  },
});

cap({
  name: 'propose_sponsorship', method: 'POST', path: '/sponsorships', tag: 'Sponsors', auth: ['sponsor'], status: 201,
  summary: 'Offer sponsorship (money and/or in-kind support) to an event, team or athlete. The target owner must accept. An athlete can only be approached if they opted in (and, if they asked for it, only by verified sponsors); a sponsor cannot repeat an open offer, or re-offer within 30 days of a decline. Athlete offers state objectives, deliverables and a period.',
  input: z.object({
    sponsor_id: id, target_type: z.enum(['event', 'team', 'athlete']), target_id: id, amount_cents: money.default(0), in_kind: z.string().max(200).optional(),
    starts_on: date.optional(), ends_on: date.optional(), objectives: z.string().max(1000).optional(), deliverables: z.string().max(1500).optional(), message: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    const s = await mustFind('sponsors', i.sponsor_id);
    mustOwn(user, s.owner_id, 'sponsor');
    if (i.starts_on && i.ends_on && i.ends_on < i.starts_on) throw badRequest('ends_on is before starts_on');
    if (i.target_type === 'athlete') {
      if (!i.amount_cents && !i.in_kind) throw badRequest('Offer money, in-kind support, or both');
      if (!i.deliverables || !i.starts_on || !i.ends_on) throw badRequest('State the deliverables and the period (starts_on and ends_on) of the sponsorship');
    }
    const owner = await targetOwner(i.target_type, i.target_id);
    return tx(async (c) => {
      if (i.target_type === 'athlete') {
        if (i.target_id === user.id) throw badRequest('You cannot sponsor yourself');
        const prof = (await c.query("SELECT sp.open_to_sponsors, sp.verified_sponsors_only FROM sponsorship_profiles sp JOIN users u ON u.id=sp.user_id WHERE sp.user_id=$1 AND 'athlete' = ANY(u.roles)", [i.target_id])).rows[0];
        if (!prof?.open_to_sponsors) throw conflict('This athlete is not open to sponsorship offers');
        if (prof.verified_sponsors_only && !(await badgesFor('sponsor', [s.id])).get(s.id)?.length) throw forbidden('This athlete only accepts offers from verified sponsors');
        const open = (await c.query("SELECT 1 FROM sponsorships WHERE sponsor_id=$1 AND target_type='athlete' AND target_id=$2 AND status='proposed'", [s.id, i.target_id])).rows[0];
        if (open) throw conflict('You already have an open offer to this athlete');
        const declined = (await c.query("SELECT 1 FROM sponsorships WHERE sponsor_id=$1 AND target_type='athlete' AND target_id=$2 AND status='declined' AND decided_at > now() - make_interval(days => $3)", [s.id, i.target_id, DECLINE_COOLDOWN_DAYS])).rows[0];
        if (declined) throw conflict(`This athlete declined your last offer; you can offer again after ${DECLINE_COOLDOWN_DAYS} days`);
      }
      const row = (await c.query(
        `INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, in_kind, starts_on, ends_on, proposed_by, objectives, deliverables, message, visibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [i.sponsor_id, i.target_type, i.target_id, i.amount_cents, i.in_kind, i.starts_on, i.ends_on, user.id, i.objectives ?? null, i.deliverables ?? null, i.message ?? null, i.target_type === 'athlete' ? 'private' : 'public'])).rows[0];
      await notify(c, owner, { kind: 'sponsorship_offer', title: 'You have a sponsorship offer', body: `${s.name} sent an offer. Open it to review and answer.`, data: { sponsorship_id: row.id } });
      return row;
    });
  },
});

cap({
  name: 'list_sponsorships', method: 'GET', path: '/sponsorships', tag: 'Sponsors',
  summary: 'Deals you are part of: ones you proposed, or offers aimed at things you own (events, teams, yourself), with who/what each is about, the terms, status and decision. `as` narrows to what you sent or what you received.',
  input: z.object({ status: z.enum(['proposed', 'active', 'declined', 'ended', 'withdrawn']).optional(), as: z.enum(['sponsor', 'target']).optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT ss.*, sp.name AS sponsor_name, sp.emoji AS sponsor_emoji, (sp.owner_id=$1) AS i_am_sponsor,
            CASE ss.target_type WHEN 'athlete' THEN (SELECT display_name FROM users WHERE id=ss.target_id) WHEN 'team' THEN (SELECT name FROM teams WHERE id=ss.target_id) ELSE (SELECT name FROM events WHERE id=ss.target_id) END AS target_name,
            EXISTS (SELECT 1 FROM verification_cases v WHERE v.type='sponsor' AND v.subject_id=sp.id AND v.status='approved' AND v.expires_at > now()) AS sponsor_verified
       FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id
      WHERE (($5::text IS DISTINCT FROM 'target' AND sp.owner_id=$1)
         OR ($5::text IS DISTINCT FROM 'sponsor' AND ((ss.target_type='event' AND ss.target_id IN (SELECT id FROM events WHERE organizer_id=$1))
              OR (ss.target_type='team' AND ss.target_id IN (SELECT id FROM teams WHERE owner_id=$1)) OR (ss.target_type='athlete' AND ss.target_id=$1))))
        AND ($2::text IS NULL OR ss.status=$2) ORDER BY ss.created_at DESC LIMIT $3 OFFSET $4`, [user.id, i.status ?? null, i.limit, i.offset, i.as ?? null]),
});

cap({
  name: 'withdraw_sponsorship', method: 'POST', path: '/sponsorships/:id/withdraw', tag: 'Sponsors',
  summary: 'Sponsor owner: take back an offer that has not been answered yet. The offer and its history are kept.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = (await c.query('SELECT * FROM sponsorships WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!d) throw notFound('Sponsorship');
      const sp = await mustFind('sponsors', d.sponsor_id);
      if (sp.owner_id !== user.id && !isAdmin(user)) throw forbidden();
      if (d.status !== 'proposed') throw conflict('Only an offer that has not been answered can be withdrawn');
      const row = (await c.query("UPDATE sponsorships SET status='withdrawn', decided_at=now(), decided_by=$2 WHERE id=$1 RETURNING *", [d.id, user.id])).rows[0];
      await notify(c, await targetOwner(d.target_type, d.target_id), { kind: 'sponsorship_update', title: 'A sponsorship offer was withdrawn', body: `${sp.name} withdrew its offer.`, data: { sponsorship_id: d.id } });
      return row;
    });
  },
});

cap({
  name: 'decide_sponsorship', method: 'PATCH', path: '/sponsorships/:id', tag: 'Sponsors',
  summary: 'Target owner accepts/declines an offer (athletes can add a reason and choose whether the deal is shown publicly on the sponsor page, default private); either side can end an active deal.',
  input: z.object({ id, status: z.enum(['active', 'declined', 'ended']), reason: z.string().max(500).optional(), show_publicly: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = (await c.query('SELECT * FROM sponsorships WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!d) throw notFound('Sponsorship');
      const sp = await mustFind('sponsors', d.sponsor_id);
      const owner = await targetOwner(d.target_type, d.target_id);
      const isTarget = user.id === owner, isSponsor = user.id === sp.owner_id;
      if (!isAdmin(user)) {
        if (i.status === 'ended' ? !(isSponsor || isTarget) : !isTarget) throw forbidden();
      }
      if (['declined', 'ended', 'withdrawn'].includes(d.status)) throw conflict(`Sponsorship already ${d.status}`);
      if (i.status === 'ended' && d.status !== 'active') throw badRequest('Only active deals can be ended');
      if (i.status !== 'ended' && d.status !== 'proposed') throw conflict(`Sponsorship is already ${d.status}`);
      const visibility = i.status === 'active' && d.target_type === 'athlete' && i.show_publicly !== undefined ? (i.show_publicly ? 'public' : 'private') : d.visibility;
      const row = (await c.query('UPDATE sponsorships SET status=$2, decision_reason=coalesce($3, decision_reason), decided_at=now(), decided_by=$4, visibility=$5 WHERE id=$1 RETURNING *', [i.id, i.status, i.reason ?? null, user.id, visibility])).rows[0];
      const word = { active: 'accepted', declined: 'declined', ended: 'ended' }[i.status];
      await notify(c, isSponsor && !isTarget ? owner : sp.owner_id, { kind: 'sponsorship_update', title: `Sponsorship ${word}`, body: i.status === 'declined' && i.reason ? i.reason : `A sponsorship with ${sp.name} was ${word}.`, data: { sponsorship_id: d.id } });
      return row;
    });
  },
});
