// Doctor workspace (issue #212, slice 2c): referrals to a platform doctor/physio or an external provider.
// The referring doctor chooses exactly what is shared (`shared` items); the recipient can read it only while the referral is live AND the athlete
// has consented to this referral. The athlete can withdraw at any time. An external recipient's status is never fabricated: the platform records
// that a letter was prepared/consented, not that the other clinic accepted or completed care. Roles stay separate: nobody overwrites another's records.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { notify } from '../notify.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { lockCredential, requireVerifiedProvider } from '../clinical-access.js';
import { hasGrant } from './medical.js';

const t = (n) => z.string().trim().max(n);
const seal = (o, f) => encrypt(JSON.stringify(o), `clinical_referrals.${f}`);
const open = (e, f) => (e == null ? null : JSON.parse(decrypt(e, `clinical_referrals.${f}`)));
const COLS = 'id, athlete_id, from_provider_id, to_provider_id, external_recipient, urgency, expires_at, status, consent, consent_at, appointment_id, version, created_at, updated_at';
const SENDER_ACTIONS = ['send', 'withdraw', 'close'];
const RECIPIENT_ACTIONS = ['acknowledge', 'accept', 'decline', 'book', 'complete'];
const lockGrant = async (c, athleteId, providerId) => {
  if (!(await c.query("SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full' FOR SHARE", [athleteId, providerId])).rows[0]) throw forbidden('The athlete has not granted you access');
};
const log = (c, refId, actor, action) => c.query('INSERT INTO clinical_referral_events(referral_id, actor_id, action) VALUES ($1,$2,$3)', [refId, actor, action]);
const live = (r) => !['draft', 'withdrawn', 'closed'].includes(r.status) && !(r.expires_at && new Date(r.expires_at) < new Date());

/** Shape a referral for a viewer; the recipient only gets content while the referral is live and consented. */
function shape(r, viewerId) {
  const meta = Object.fromEntries(COLS.split(', ').map((k) => [k, r[k]]));
  const full = () => ({ ...meta, reason: open(r.reason_enc, 'reason').v, requested_action: r.requested_action_enc ? open(r.requested_action_enc, 'action').v : null, shared: open(r.shared_enc, 'shared'), return_summary: r.return_summary_enc ? open(r.return_summary_enc, 'return').v : null });
  const names = { from_name: r.from_name, to_name: r.to_name ?? null };
  if (viewerId === r.athlete_id || viewerId === r.from_provider_id) {
    const out = { ...full(), ...names, expired: !!r.expires_at && new Date(r.expires_at) < new Date() };
    if (r.external_recipient) out.external = { recipient: r.external_recipient, status_known: false, note: 'Prepared for an external provider. The platform cannot confirm it was received, accepted or completed.', letter: r.consent === 'granted' && live(r) ? { reason: out.reason, requested_action: out.requested_action, shared: out.shared } : null };
    return out;
  }
  // recipient
  if (r.consent !== 'granted' || !live(r)) return { ...meta, from_name: r.from_name, content_available: false };
  return { ...full(), ...names, content_available: true, return_summary: undefined };
}
const FROM = 'FROM clinical_referrals r JOIN users f ON f.id=r.from_provider_id LEFT JOIN users tu ON tu.id=r.to_provider_id';
const COLSQ = 'r.*, f.display_name AS from_name, tu.display_name AS to_name';

cap({
  name: 'create_referral', credential: true, method: 'POST', path: '/medical/referrals', tag: 'Health', auth: ['doctor'], status: 201,
  summary: 'Doctor drafts a referral for an athlete who granted full access, to a verified platform doctor/physio (`to_provider_id`) or an external provider (`external_recipient`). You choose the urgency and exactly which items are shared (`shared`: label + text) - nothing else is ever visible to the recipient. The athlete must consent to this referral before anyone else can read it.',
  input: z.object({ athlete_id: id, to_provider_id: id.optional(), external_recipient: t(300).optional(), reason: t(2000).min(1), requested_action: t(1000).optional(), shared: z.array(z.object({ label: t(120).min(1), text: t(4000).min(1) }).strict()).min(1).max(20), urgency: z.enum(['routine', 'priority', 'urgent']).default('routine'), expires_at: z.string().datetime({ offset: true }).optional() })
    .refine((v) => !!v.to_provider_id !== !!v.external_recipient, 'Give either a platform recipient or an external recipient'),
  async handler({ user }, i) {
    if (i.athlete_id === user.id || i.to_provider_id === user.id) throw badRequest('Not a valid referral');
    if (i.expires_at && Date.parse(i.expires_at) <= Date.now()) throw badRequest('Expiry must be in the future');
    const cred = await requireVerifiedProvider(user.id, { action: 'create_referral', athleteId: i.athlete_id, types: ['doctor'] });
    if (!(await hasGrant(i.athlete_id, user.id))) throw forbidden('The athlete has not granted you access');
    if (i.to_provider_id && !(await one("SELECT 1 FROM users WHERE id=$1 AND roles && ARRAY['doctor','physio']::text[]", [i.to_provider_id]))) throw badRequest('That person is not a registered doctor or physio');
    const r = await tx(async (c) => {
      await lockCredential(c, cred); await lockGrant(c, i.athlete_id, user.id);
      const row = (await c.query(`INSERT INTO clinical_referrals(athlete_id, from_provider_id, to_provider_id, external_recipient, reason_enc, requested_action_enc, shared_enc, urgency, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [i.athlete_id, user.id, i.to_provider_id ?? null, i.external_recipient ?? null, seal({ v: i.reason }, 'reason'), i.requested_action ? seal({ v: i.requested_action }, 'action') : null, seal(i.shared, 'shared'), i.urgency, i.expires_at ?? null])).rows[0];
      await log(c, row.id, user.id, 'created');
      return row;
    });
    await audit(null, user.id, 'write_clinical', 'clinical_referrals', r.id);
    return shape({ ...r, from_name: user.display_name }, user.id);
  },
});

cap({
  name: 'update_referral', credential: true, method: 'POST', path: '/medical/referrals/:id/action', tag: 'Health', auth: ['doctor', 'physio'],
  summary: 'Move a referral on. Referring doctor: `send` (asks the athlete to consent; platform recipient is notified only once they consent), `withdraw`, `close`. Platform recipient (verified, referral live and consented): `acknowledge`, `accept`, `decline`, `book` (give the appointment_id of your appointment with the athlete), `complete` (optional return_summary for the referrer and athlete). External referrals only support send/withdraw/close - their outcome is never inferred.',
  input: z.object({ id, action: z.enum([...SENDER_ACTIONS, ...RECIPIENT_ACTIONS]), appointment_id: id.optional(), return_summary: t(4000).optional() }),
  async handler({ user }, i) {
    const r0 = await one('SELECT athlete_id, from_provider_id, to_provider_id FROM clinical_referrals WHERE id=$1', [i.id]);
    if (!r0) throw notFound('Referral');
    const sender = r0.from_provider_id === user.id, recipient = r0.to_provider_id === user.id;
    if (!sender && !recipient) throw notFound('Referral');
    if (SENDER_ACTIONS.includes(i.action) ? !sender : !recipient) throw forbidden(sender ? 'The recipient handles this step' : 'The referring doctor handles this step');
    const cred = await requireVerifiedProvider(user.id, { action: `referral_${i.action}`, athleteId: r0.athlete_id, ...(sender ? { types: ['doctor'] } : {}) });
    if (sender && !(await hasGrant(r0.athlete_id, user.id)) && i.action === 'send') throw forbidden('The athlete has not granted you access');
    const row = await tx(async (c) => {
      await lockCredential(c, cred);
      if (sender && i.action === 'send') await lockGrant(c, r0.athlete_id, user.id);
      const r = (await c.query('SELECT * FROM clinical_referrals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      const set = (status, extra = '', args = []) => c.query(`UPDATE clinical_referrals SET status=$2, version=version+1, updated_at=now()${extra} WHERE id=$1 RETURNING *`, [i.id, status, ...args]).then((q) => q.rows[0]);
      const need = (ok, msg) => { if (!ok) throw conflict(msg ?? `A ${r.status} referral cannot ${i.action}`); };
      let out;
      if (sender) {
        if (i.action === 'send') { need(r.status === 'draft'); out = await set('sent'); await notify(c, r.athlete_id, { kind: 'referral_consent', title: 'Your doctor would like to refer you', body: 'Open Health to review what would be shared and decide.', data: { referral_id: i.id } }); }
        else if (i.action === 'withdraw') { need(['draft', 'sent', 'acknowledged', 'accepted', 'booked'].includes(r.status)); out = await set('withdrawn'); }
        else { need(r.external_recipient ? r.status === 'sent' : ['completed', 'declined'].includes(r.status), r.external_recipient ? undefined : 'Only a completed or declined referral is closed; otherwise withdraw it'); out = await set('closed'); }
      } else {
        if (r.consent !== 'granted' || !live(r)) throw conflict('This referral is not available (not consented, withdrawn, closed or expired)');
        if (i.action === 'acknowledge') { need(r.status === 'sent'); out = await set('acknowledged'); }
        else if (i.action === 'accept' || i.action === 'decline') { need(['sent', 'acknowledged'].includes(r.status)); out = await set(i.action === 'accept' ? 'accepted' : 'declined'); }
        else if (i.action === 'book') {
          need(r.status === 'accepted');
          if (!i.appointment_id) throw badRequest('appointment_id is required to mark a referral as booked');
          const a = (await c.query('SELECT athlete_id, provider_id, status FROM appointments WHERE id=$1', [i.appointment_id])).rows[0];
          if (!a || a.athlete_id !== r.athlete_id || a.provider_id !== user.id || ['cancelled', 'expired'].includes(a.status)) throw notFound('Appointment');
          out = await set('booked', ', appointment_id=$3', [i.appointment_id]);
        } else { need(['accepted', 'booked'].includes(r.status)); out = await set('completed', ', return_summary_enc=$3', [i.return_summary ? seal({ v: i.return_summary }, 'return') : null]); }
      }
      await log(c, i.id, user.id, i.action);
      const other = sender ? r.to_provider_id : r.from_provider_id;
      if (other && !(sender && i.action === 'send')) await notify(c, other, { kind: 'referral_update', title: 'A referral was updated', body: 'Open Health to see it.', data: { referral_id: i.id } });
      return out;
    });
    await audit(null, user.id, 'write_clinical', 'clinical_referrals', row.id);
    return { id: row.id, status: row.status, version: row.version, appointment_id: row.appointment_id };
  },
});

cap({
  name: 'respond_referral_consent', method: 'POST', path: '/medical/referrals/:id/consent', tag: 'Health',
  summary: 'Athlete decides whether the items listed in this referral may be shared with the recipient: `grant` or `decline`. You can change your mind later: declining a granted referral withdraws it and the recipient loses access at once. A platform recipient is notified only after you grant.',
  input: z.object({ id, decision: z.enum(['grant', 'decline']) }),
  async handler({ user }, i) {
    const out = await tx(async (c) => {
      const r = (await c.query('SELECT * FROM clinical_referrals WHERE id=$1 AND athlete_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!r || r.status === 'draft') throw notFound('Referral');
      if (['withdrawn', 'closed', 'completed', 'declined'].includes(r.status)) throw conflict(`This referral is ${r.status}`);
      if (i.decision === 'grant' && r.consent === 'granted') return r;
      const granted = i.decision === 'grant';
      const row = (await c.query(`UPDATE clinical_referrals SET consent=$2, consent_at=now(), status=CASE WHEN $2='declined' THEN 'withdrawn' ELSE status END, version=version+1, updated_at=now() WHERE id=$1 RETURNING *`, [i.id, granted ? 'granted' : 'declined'])).rows[0];
      await log(c, i.id, user.id, granted ? 'consent_granted' : 'consent_declined');
      if (granted && r.to_provider_id) await notify(c, r.to_provider_id, { kind: 'referral_received', title: 'You received a referral', body: 'Open Health to see it.', data: { referral_id: i.id } });
      if (!granted) await notify(c, r.from_provider_id, { kind: 'referral_update', title: 'A referral was updated', body: 'Open Health to see it.', data: { referral_id: i.id } });
      return row;
    });
    await audit(null, user.id, 'consent_referral', 'clinical_referrals', out.id);
    return { id: out.id, status: out.status, consent: out.consent };
  },
});

cap({
  name: 'list_referrals', credential: true, method: 'GET', path: '/medical/referrals', tag: 'Health',
  summary: 'Referrals involving you. `box`: `mine` (as the patient), `sent` (as the referring doctor), `received` (as a recipient - only referrals the athlete consented to and that are still live show their content). Newest first; reads are audit-logged.',
  input: z.object({ box: z.enum(['mine', 'sent', 'received']).default('mine'), status: z.enum(['draft', 'sent', 'acknowledged', 'accepted', 'declined', 'booked', 'completed', 'closed', 'withdrawn']).optional(), ...page }),
  async handler({ user }, i) {
    const where = { mine: "r.athlete_id=$1 AND r.status <> 'draft'", sent: 'r.from_provider_id=$1', received: "r.to_provider_id=$1 AND r.consent='granted' AND r.status NOT IN ('draft','withdrawn')" }[i.box];
    if (i.box !== 'mine') await requireVerifiedProvider(user.id, { action: 'list_referrals', ...(i.box === 'sent' ? { types: ['doctor'] } : {}) });
    const rows = await many(`SELECT ${COLSQ} ${FROM} WHERE ${where} AND ($4::text IS NULL OR r.status=$4) ORDER BY r.created_at DESC, r.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset, i.status ?? null]);
    await audit(null, user.id, 'read_clinical', 'clinical_referrals', null);
    return rows.map((r) => shape(r, user.id));
  },
});

cap({
  name: 'get_referral_history', credential: true, method: 'GET', path: '/medical/referrals/:id/history', tag: 'Health',
  summary: 'Append-only trail of a referral (created, sent, consent, acknowledged, accepted, booked, completed, ...), oldest first. Visible to the athlete, the referring doctor and a recipient who has access.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('SELECT athlete_id, from_provider_id, to_provider_id, consent, status, expires_at FROM clinical_referrals WHERE id=$1', [i.id]);
    if (!r || !(r.athlete_id === user.id || r.from_provider_id === user.id || (r.to_provider_id === user.id && r.consent === 'granted' && live(r)))) throw notFound('Referral');
    const ev = await many('SELECT e.actor_id, u.display_name AS actor_name, e.action, e.created_at FROM clinical_referral_events e JOIN users u ON u.id=e.actor_id WHERE e.referral_id=$1 ORDER BY e.created_at, e.id', [i.id]);
    await audit(null, user.id, 'read_clinical', 'clinical_referrals', r.athlete_id);
    return { referral_id: i.id, events: ev };
  },
});
