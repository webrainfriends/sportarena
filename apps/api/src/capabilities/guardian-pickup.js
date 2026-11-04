// Guardian side of pickup & handover (#788). Reuses the canonical guardian link, scopes and pickup_delegates (guardians.js owns add/list/revoke of collectors);
// this file adds what a guardian needs on the day: standing departure permissions, today's status, the confirm-or-stop decision and a collector's pass.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { decrypt } from '../crypto.js';
import { audit, isAdmin } from '../helpers.js';
import { guardianCan, guardianLink } from '../youth.js';
import { mintToken } from '../access-layer.js';
import { confirmHandover, delegatesAt } from '../pickup.js';

const TAG = 'Youth & guardians';

const requirePickup = async (user, childId, c, orgId = null) => {
  const link = await guardianLink(user.id, childId, c);
  if (!link) throw notFound('Young person');             // not a guardian: do not reveal that the child exists
  if (!(await guardianCan(link, 'pickup', orgId, c))) throw forbidden('Your guardian authority for this young person does not cover pickups (pickup)');
  return link;
};

cap({
  name: 'set_pickup_departure_modes', method: 'POST', path: '/youth/children/:child_id/departure-modes', tag: TAG,
  summary: 'Guardian (pickup scope): say which departures besides "collected by an authorised adult" the academy may allow for a young person: walks home, or takes transport. Replaces the current standing permission for that academy (or all academies); an empty list withdraws it. It stops the moment it is withdrawn.',
  input: z.object({ child_id: id, modes: z.array(z.enum(['walks_home', 'transport'])).max(2), organisation_id: id.optional(), valid_days: z.number().int().min(1).max(365).default(180) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requirePickup(user, i.child_id, c, i.organisation_id ?? null);
      await c.query('UPDATE pickup_departure_modes SET revoked_at=now(), revoked_by=$3 WHERE child_id=$1 AND organisation_id IS NOT DISTINCT FROM $2 AND revoked_at IS NULL', [i.child_id, i.organisation_id ?? null, user.id]);
      for (const m of new Set(i.modes)) await c.query("INSERT INTO pickup_departure_modes(child_id, organisation_id, mode, granted_by, valid_until) VALUES ($1,$2,$3,$4, now() + make_interval(days => $5))", [i.child_id, i.organisation_id ?? null, m, user.id, i.valid_days]);
      await audit(c, user.id, 'set_pickup_departure_modes', 'users', i.child_id);
      return { modes: [...new Set(i.modes)] };
    });
  },
});

cap({
  name: 'get_child_pickup_overview', method: 'GET', path: '/youth/children/:child_id/pickup', tag: TAG,
  summary: 'Guardian: one view of a young person\'s pickup situation: standing departure permissions, how many collectors and emergency contacts are live, today\'s academy sessions with arrival, attendance and handover state kept separate, and any handover waiting for a guardian to confirm. Collector names are decrypted (audit-logged).',
  input: z.object({ child_id: id }),
  async handler({ user }, i) {
    if (!(await guardianLink(user.id, i.child_id)) && !isAdmin(user)) throw notFound('Young person');
    const modes = await many("SELECT m.mode, m.organisation_id, m.valid_until FROM pickup_departure_modes m WHERE m.child_id=$1 AND m.revoked_at IS NULL AND (m.valid_until IS NULL OR m.valid_until > now()) ORDER BY m.mode", [i.child_id]);
    const counts = (await many(
      `SELECT count(*) FILTER (WHERE d.can_collect AND d.revoked_at IS NULL AND d.expires_at > now())::int AS collectors, count(*) FILTER (WHERE d.is_emergency AND d.revoked_at IS NULL AND d.expires_at > now())::int AS emergency,
              count(*) FILTER (WHERE d.can_collect AND d.revoked_at IS NULL AND d.expires_at > now() AND d.expires_at < now() + interval '7 days')::int AS expiring
         FROM pickup_delegates d WHERE d.child_id=$1`, [i.child_id]))[0];
    const today = await many(
      `SELECT s.id AS session_id, s.organisation_id, s.title, s.sport, s.starts_at, s.ends_at, o.name AS organisation_name, a.status AS attendance, a.arrived_at, h.id AS handover_id, h.state AS handover_state, h.handed_over_at, h.escalation_level, h.departure_mode,
              h.collector_user_id, h.delegate_id, h.confirm_method
         FROM academy_sessions s JOIN org_enrolments e ON e.cohort_id=s.cohort_id AND e.user_id=$1 AND e.status='enrolled' JOIN organisations o ON o.id=s.organisation_id
         LEFT JOIN academy_attendance a ON a.session_id=s.id AND a.user_id=$1 LEFT JOIN academy_handovers h ON h.session_id=s.id AND h.athlete_id=$1
        WHERE s.status IN ('published','completed') AND s.ends_at > now() - interval '12 hours' AND s.starts_at < now() + interval '24 hours' ORDER BY s.starts_at`, [i.child_id]);
    for (const t of today) {
      if (t.collector_user_id) t.collector_name = (await many('SELECT display_name FROM users WHERE id=$1', [t.collector_user_id]))[0]?.display_name ?? null;
      if (!t.collector_name && t.delegate_id) t.collector_name = decrypt((await many('SELECT delegate_name_enc FROM pickup_delegates WHERE id=$1', [t.delegate_id]))[0]?.delegate_name_enc, 'pickup_delegates.name');
      delete t.collector_user_id; delete t.delegate_id;
    }
    const academies = await many("SELECT DISTINCT o.id, o.name FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN organisations o ON o.id=k.organisation_id WHERE e.user_id=$1 AND e.status='enrolled' ORDER BY o.name", [i.child_id]);
    await audit(null, user.id, 'read_child_pickup_overview', 'users', i.child_id);
    return { child_id: i.child_id, academies, departure_modes: modes, ...counts, today, pending_confirmation: today.filter((t) => t.handover_state === 'pending_confirmation') };
  },
});

cap({
  name: 'confirm_academy_handover', method: 'POST', path: '/youth/handovers/:id/confirm', tag: TAG,
  summary: 'Guardian (pickup scope): confirm that the person collecting a young person is expected, or stop it. Until a guardian confirms (or the collector is a guardian showing their own pass, or staff override with a reason) the athlete stays in the academy\'s care. Stopping alerts the staff member and the safeguarding officer. Idempotent.',
  input: z.object({ id, confirm: z.boolean() }),
  async handler({ user }, i) { return tx(async (c) => { const r = await confirmHandover(c, { handoverId: i.id, user, confirm: i.confirm }); await audit(c, user.id, i.confirm ? 'confirm_academy_handover' : 'dispute_academy_handover', 'academy_handovers', i.id); return { id: r.handover.id, state: r.handover.state, replayed: !!r.replayed }; }); },
});

cap({
  name: 'get_pickup_pass', method: 'GET', path: '/me/pickup-pass', tag: TAG,
  summary: 'A guardian or an authorised collector with an account gets a rotating QR (refresh every 30 s) to show staff when collecting a young person from one academy session. It works only for that session, only while the person is a verified guardian (pickup scope) or a live collector, and never shows the child\'s details.',
  input: z.object({ session_id: id, child_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = (await c.query("SELECT s.id, s.organisation_id, s.title, s.cohort_id FROM academy_sessions s WHERE s.id=$1 AND s.status IN ('published','completed')", [i.session_id])).rows[0];
      if (!s || !(await c.query("SELECT 1 FROM org_enrolments WHERE cohort_id=$1 AND user_id=$2 AND status='enrolled'", [s.cohort_id, i.child_id])).rowCount) throw notFound('Session');
      const link = await guardianLink(user.id, i.child_id, c);
      if (link) { if (!(await guardianCan(link, 'pickup', s.organisation_id, c))) throw forbidden('Your guardian authority for this young person does not cover pickups (pickup)'); }
      else if (!(await delegatesAt(c, i.child_id, s.organisation_id)).some((d) => d.delegate_user_id === user.id)) throw notFound('Session');
      return { ...mintToken('academy_session', s.id, { type: 'P', userId: user.id }), subject: { domain: 'academy_session', ref: s.id, label: s.title } };
    });
  },
});
