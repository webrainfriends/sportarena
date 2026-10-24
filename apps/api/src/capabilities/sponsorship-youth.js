// Guardian-authorized youth sponsorship (#307). A young person stays undiscoverable and cannot be offered anything unless a verified
// guardian names a sponsor here. The guardian then answers offers, shares results and allows media/contact (youth.js consents) for them.
// Withdrawing is a status change: it blocks every future sponsor action, while the agreement, payments and history stay.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { guardianLink, isYouth } from '../youth.js';
import { sponsorAccess, assertSponsorCan, notifySponsor } from '../sponsor-access.js';

const TAG = 'Sponsors';
const forChild = async (user, childId, c) => {
  if (!(await isYouth(childId, c))) throw conflict('Only a young person needs guardian authority for sponsorship');
  if (!(await guardianLink(user.id, childId, c))) throw forbidden('You are not a verified guardian of this young person');
};

cap({
  name: 'authorize_youth_sponsor', method: 'POST', path: '/youth/children/:child_id/sponsors', tag: TAG, status: 201,
  summary: 'Verified guardian: let one named sponsor send a young person a sponsorship offer. Nobody else can: the young person is never listed to sponsors, and an offer from a sponsor you did not authorize is refused. Authorizing grants no photo/video, contact or results permission — those stay separate. Idempotent per sponsor; withdraw it at any time.',
  input: z.object({ child_id: id, sponsor_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await forChild(user, i.child_id, c);
      const sp = (await c.query('SELECT id, name, owner_id, organisation_id, entity_id FROM sponsors WHERE id=$1', [i.sponsor_id])).rows[0];
      if (!sp) throw notFound('Sponsor');
      const made = (await c.query(
        `INSERT INTO sponsorship_guardian_authorities(child_id, sponsor_id, authorized_by) VALUES ($1,$2,$3)
         ON CONFLICT (child_id, sponsor_id) WHERE status='active' DO NOTHING RETURNING id, child_id, sponsor_id, authorized_by, status, created_at`, [i.child_id, i.sponsor_id, user.id])).rows[0];
      const row = made ?? (await c.query("SELECT id, child_id, sponsor_id, authorized_by, status, created_at FROM sponsorship_guardian_authorities WHERE child_id=$1 AND sponsor_id=$2 AND status='active'", [i.child_id, i.sponsor_id])).rows[0];
      if (made) {
        await audit(c, user.id, 'authorize_youth_sponsor', 'users', i.child_id);
        await notifySponsor(c, sp, 'propose', { kind: 'sponsorship_authorization', title: 'A guardian authorized you to send an offer', body: 'Open Guardian-authorized athletes to make an offer.', data: { sponsor_id: sp.id } });
      }
      return { ...row, sponsor_name: sp.name, created: !!made };
    });
  },
});

cap({
  name: 'withdraw_youth_sponsor', method: 'DELETE', path: '/youth/children/:child_id/sponsors/:sponsor_id', tag: TAG,
  summary: 'Any verified guardian: withdraw a sponsor\'s authority. It blocks the sponsor\'s future offers, messages, reviews and results access at once; the agreement, payments and history are untouched.',
  input: z.object({ child_id: id, sponsor_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await forChild(user, i.child_id, c);
      const r = (await c.query("UPDATE sponsorship_guardian_authorities SET status='withdrawn', withdrawn_by=$3, withdrawn_at=now() WHERE child_id=$1 AND sponsor_id=$2 AND status='active' RETURNING id", [i.child_id, i.sponsor_id, user.id])).rows[0];
      if (r) await audit(c, user.id, 'withdraw_youth_sponsor', 'users', i.child_id);
      return { ok: true, changed: !!r };
    });
  },
});

cap({
  name: 'list_youth_sponsors', method: 'GET', path: '/youth/children/:child_id/sponsors', tag: TAG,
  summary: 'The sponsors a young person\'s guardians authorized (live ones first, then withdrawn), each with how many agreements exist. Visible to the young person, their verified guardians and the platform team.',
  input: z.object({ child_id: id, ...page }),
  async handler({ user }, i) {
    if (user.id !== i.child_id && !isAdmin(user) && !(await guardianLink(user.id, i.child_id))) throw notFound('Young person');
    return many(
      `SELECT a.id, a.sponsor_id, sp.name AS sponsor_name, sp.emoji AS sponsor_emoji, a.status, a.created_at, a.withdrawn_at,
              (SELECT count(*)::int FROM sponsorships s WHERE s.sponsor_id=a.sponsor_id AND s.target_type='athlete' AND s.target_id=a.child_id) AS agreements
         FROM sponsorship_guardian_authorities a JOIN sponsors sp ON sp.id=a.sponsor_id WHERE a.child_id=$1
        ORDER BY (a.status='active') DESC, a.created_at DESC, a.id LIMIT $2 OFFSET $3`, [i.child_id, i.limit, i.offset]);
  },
});

cap({
  name: 'list_youth_authorizations', method: 'GET', path: '/sponsors/:id/youth-authorizations', tag: TAG,
  summary: 'Sponsor staff: the young athletes whose guardian currently authorized this brand to send an offer. Only a display name and the authorization date are shown — never contact, health or guardian details.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const sp = await one('SELECT id, name, owner_id, organisation_id, entity_id FROM sponsors WHERE id=$1', [i.id]);
    if (!sp) throw notFound('Sponsor');
    if (!isAdmin(user)) assertSponsorCan(await sponsorAccess(user, sp), 'propose', { what: 'see guardian-authorized athletes' });
    return many(
      `SELECT a.id, a.child_id AS athlete_id, u.display_name, a.created_at
         FROM sponsorship_guardian_authorities a JOIN users u ON u.id=a.child_id
         JOIN guardian_links l ON l.guardian_id=a.authorized_by AND l.child_id=a.child_id AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())
        WHERE a.sponsor_id=$1 AND a.status='active' AND u.youth_until IS NOT NULL AND u.youth_until > current_date
        ORDER BY a.created_at DESC, a.id LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset]);
  },
});
