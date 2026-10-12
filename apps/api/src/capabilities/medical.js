import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { notify } from '../notify.js';
import { assertTransition, setTransitionContext, refundKey, timelineFor } from '../lifecycle.js';
import { isBookable } from '../health/slots.js';
import { config } from '../config.js';
import { paymentsEnabled, refundFor } from '../payments/service.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, mustFind, PUBLIC_USER } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { clinicalCredential, lockCredential, requireVerifiedProvider } from '../clinical-access.js';
import { guardianLink, hasConsent, requireConsent } from '../youth.js';

const dt = z.string().datetime({ offset: true });
/** Is there a current (not revoked, not expired) consent? `need='clearance'` accepts either scope; the default needs full record access. */
const hasGrant = async (athleteId, providerId, need = 'full') => (await hasConsent(athleteId, 'medical')) && !!(await one(
  "SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND ($3::text = 'clearance' OR scope = 'full')", [athleteId, providerId, need]));
const logGrant = (c, athleteId, providerId, action, scope, expiresAt) => c.query('INSERT INTO medical_grant_events(athlete_id, provider_id, action, scope, expires_at) VALUES ($1,$2,$3,$4,$5)', [athleteId, providerId, action, scope ?? null, expiresAt ?? null]);

cap({
  name: 'list_providers', method: 'GET', path: '/providers', tag: 'Health', auth: 'public', summary: 'Find physios and doctors, optionally by sport.',
  input: z.object({ role: z.enum(['physio', 'doctor']).optional(), sport: z.string().optional(), ...page }),
  handler: (_, i) => many(
    `SELECT ${PUBLIC_USER}, p.role AS provider_role, p.hourly_rate_cents, s.name AS sport, s.emoji AS sport_emoji, p.level FROM sport_profiles p JOIN users u ON u.id=p.user_id JOIN sports s ON s.id=p.sport_id
      WHERE p.role IN ('physio','doctor') AND ($1::text IS NULL OR p.role=$1) AND ($2::text IS NULL OR s.slug=$2) ORDER BY u.display_name LIMIT $3 OFFSET $4`, [i.role ?? null, i.sport ?? null, i.limit, i.offset]),
});

cap({
  name: 'book_appointment', credential: true, method: 'POST', path: '/appointments', tag: 'Health', status: 201,
  summary: 'Request an appointment with a physio/doctor. If the provider has published weekly hours the time must be one of list_provider_slots (and not clash with time off or another appointment); otherwise any free time can be requested. The reason is encrypted. The provider is notified.',
  input: z.object({ provider_id: id, starts_at: dt, duration_min: z.number().int().min(10).max(240).default(30), mode: z.enum(['in_person', 'remote']).default('in_person'), followup_id: id.optional().describe('the follow-up this appointment is for'), reason: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    if (i.provider_id === user.id) throw badRequest('Cannot book yourself');
    await requireConsent(user.id, 'medical', 'booking a health appointment');
    const p = await one("SELECT 1 FROM sport_profiles WHERE user_id=$1 AND role IN ('physio','doctor') UNION SELECT 1 FROM provider_profiles WHERE user_id=$1", [i.provider_id]);
    if (!p) throw badRequest('That person is not a registered physio or doctor');
    if (Date.parse(i.starts_at) < Date.now()) throw badRequest('Choose a time in the future');
    await requireVerifiedProvider(i.provider_id, { action: 'book_appointment', athleteId: user.id, forOther: true });
    return tx(async (c) => {
      // one booking at a time per provider so two people cannot take the same slot
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`appt:${i.provider_id}`]);
      const prof = (await c.query('SELECT accepting_patients, in_person, remote_ok, consult_fee_cents, currency FROM provider_profiles WHERE user_id=$1', [i.provider_id])).rows[0];
      if (prof && !prof.accepting_patients) throw conflict('This provider is not taking new appointments right now');
      if (prof && (i.mode === 'remote' ? !prof.remote_ok : !prof.in_person)) throw badRequest(`This provider does not offer ${i.mode === 'remote' ? 'remote' : 'in-person'} appointments`);
      let followup = null;
      if (i.followup_id) {
        followup = (await c.query('SELECT * FROM appointment_followups WHERE id=$1 AND athlete_id=$2 AND provider_id=$3 FOR UPDATE', [i.followup_id, user.id, i.provider_id])).rows[0];
        if (!followup) throw notFound('Follow-up');
        if (followup.status !== 'due') throw conflict(`That follow-up is ${followup.status}`);
      }
      // price: the provider's consultation fee, else the hourly rate on their sport profile for this length
      let fee = prof?.consult_fee_cents == null ? null : Number(prof.consult_fee_cents);
      if (fee === null) {
        const rate = Number((await c.query("SELECT min(hourly_rate_cents) AS r FROM sport_profiles WHERE user_id=$1 AND role IN ('physio','doctor') AND hourly_rate_cents > 0", [i.provider_id])).rows[0].r ?? 0);
        fee = Math.round((rate * i.duration_min) / 60);
      }
      const slot = await isBookable(i.provider_id, i.starts_at, i.duration_min, c);
      if (slot.grid && !slot.ok) throw conflict('That time is not available. Pick one of the provider\'s open slots.');
      const clash = (await c.query("SELECT 1 FROM appointments WHERE provider_id=$1 AND status IN ('requested','confirmed') AND starts_at < $2::timestamptz + make_interval(mins => $3) AND starts_at + make_interval(mins => duration_min) > $2", [i.provider_id, i.starts_at, i.duration_min])).rows[0];
      if (clash) throw conflict('Provider is not free then');
      const a = (await c.query(
        'INSERT INTO appointments(athlete_id, provider_id, starts_at, duration_min, reason_enc, fee_cents, currency, payment_status, mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, athlete_id, provider_id, starts_at, duration_min, status, mode, fee_cents, currency, payment_status',
        [user.id, i.provider_id, i.starts_at, i.duration_min, encrypt(i.reason, 'appointments.reason'), fee, prof?.currency ?? config.payments.currency, paymentsEnabled() && fee > 0 ? 'unpaid' : 'not_required', i.mode])).rows[0];
      if (followup) await c.query("UPDATE appointment_followups SET status='booked', booked_appointment_id=$2, updated_at=now() WHERE id=$1", [followup.id, a.id]);
      await notify(c, i.provider_id, { kind: 'appointment_requested', title: 'New appointment request', body: 'Open Health to confirm or decline it.', data: { appointment_id: a.id } });
      return a;
    });
  },
});

cap({
  name: 'list_appointments', method: 'GET', path: '/appointments', tag: 'Health', summary: 'Your appointments as athlete or provider (reason decrypted for the two parties; access is audit-logged).',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT a.*, ua.display_name AS athlete_name, up.display_name AS provider_name FROM appointments a JOIN users ua ON ua.id=a.athlete_id JOIN users up ON up.id=a.provider_id
        WHERE a.athlete_id=$1 OR a.provider_id=$1 ORDER BY a.starts_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    if (rows.some((r) => r.reason_enc)) await audit(null, user.id, 'read_clinical', 'appointments', null);
    return rows.map(({ reason_enc, ...r }) => ({ ...r, reason: decrypt(reason_enc, 'appointments.reason') }));
  },
});

cap({
  name: 'update_appointment', credential: true, method: 'PATCH', path: '/appointments/:id', tag: 'Health',
  summary: 'Provider confirms/completes; either party can cancel. Moves follow the shared lifecycle (src/lifecycle.js): requested -> confirmed -> completed, cancel until completed, unanswered requests expire on their own. Completing needs payment (if required) and a start time that has passed. A final appointment (completed, cancelled, expired) cannot be changed. The other party is notified.',
  input: z.object({ id, status: z.enum(['confirmed', 'completed', 'cancelled']), reason: z.string().trim().max(500).optional().describe('why (kept, encrypted, in the appointment timeline)') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = (await c.query('SELECT * FROM appointments WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!a) throw notFound('Appointment');
      const isProvider = a.provider_id === user.id, isAthlete = a.athlete_id === user.id;
      if (!isProvider && !isAthlete && !isAdmin(user)) throw forbidden();
      if (i.status !== 'cancelled' && !isProvider) throw forbidden('Only the provider can confirm or complete');
      // confirming or completing is a clinical action: needs a current credential (completing an existing appointment may use the configured grace)
      if (i.status !== 'cancelled' && isProvider) await requireVerifiedProvider(user.id, { action: 'update_appointment', athleteId: a.athlete_id, allowGrace: i.status === 'completed' });
      if (i.status === 'confirmed' && a.payment_status === 'unpaid') throw conflict('Waiting for the athlete to pay');
      if (i.status === 'completed' && a.payment_status === 'unpaid') throw conflict('This appointment has not been paid for');
      assertTransition(a, i.status, { isProvider, isCustomer: isAthlete, isAdmin: isAdmin(user) }, { noun: 'appointment', customerWord: 'athlete' });
      await setTransitionContext(c, user.id, i.reason);
      let payment = a.payment_status;
      if (i.status === 'cancelled' && a.payment_status === 'paid') {
        await refundFor('appointment', a.id, { key: refundKey('appointment', a.id) });      // refund at the provider first; if it refuses nothing is cancelled
        payment = 'refunded';
      }
      const row = (await c.query('UPDATE appointments SET status=$2, payment_status=$4, updated_at=now(), cancelled_by=CASE WHEN $2 = \'cancelled\' THEN $3::uuid ELSE cancelled_by END WHERE id=$1 AND status=$5 RETURNING id, athlete_id, provider_id, starts_at, duration_min, status, payment_status', [i.id, i.status, user.id, payment, a.status])).rows[0];
      if (!row) throw conflict('This appointment was just changed by someone else; reload and try again');
      // follow-ups follow the appointment they were booked into
      if (i.status === 'completed') await c.query("UPDATE appointment_followups SET status='done', completed_at=now(), closed_by=$2, updated_at=now() WHERE booked_appointment_id=$1 AND status='booked'", [a.id, user.id]);
      if (i.status === 'cancelled') await c.query("UPDATE appointment_followups SET status='due', booked_appointment_id=NULL, updated_at=now() WHERE booked_appointment_id=$1 AND status='booked'", [a.id]);
      const other = isProvider ? a.athlete_id : a.provider_id;
      if (other !== user.id) await notify(c, other, { kind: 'appointment_update', title: `Appointment ${i.status}`, body: 'Open Health to see the details.', data: { appointment_id: a.id } });
      return row;
    });
  },
});

cap({
  name: 'get_appointment_timeline', method: 'GET', path: '/appointments/:id/timeline', tag: 'Health',
  summary: 'The append-only history of one appointment (who moved it from which status to which, when, why and the payment state), oldest first. Only the athlete and the provider can read it; reasons are decrypted for them and the read is audit-logged.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const a = await mustFind('appointments', i.id, 'id, athlete_id, provider_id, status');
    if (a.athlete_id !== user.id && a.provider_id !== user.id) throw forbidden();
    return { appointment_id: a.id, status: a.status, entries: await timelineFor('appointment', a.id, user.id, i) };
  },
});

cap({
  name: 'grant_medical_access', method: 'POST', path: '/medical/grants', tag: 'Health', status: 201,
  summary: 'Consent: let a physio/doctor see your records (scope `full`, can also write) or only your fit-to-play status (scope `clearance`). Optionally for a limited number of days. By default the provider sees records they write plus anything written from now on; choose history `all` to share earlier records too. You can revoke at any time; the history of grants and revocations is kept.',
  input: z.object({ provider_id: id, scope: z.enum(['full', 'clearance']).default('full'), expires_in_days: z.number().int().min(1).max(730).optional(), history: z.enum(['since_grant', 'all']).default('since_grant').describe('how far back the provider may read records written by others: since_grant (default) or all (your whole history)') }),
  async handler({ user }, i) {
    const p = await one("SELECT 1 FROM sport_profiles WHERE user_id=$1 AND role IN ('physio','doctor') UNION SELECT 1 FROM provider_profiles WHERE user_id=$1", [i.provider_id]);
    if (!p) throw badRequest('That person is not a registered physio or doctor');
    if (i.provider_id === user.id) throw badRequest('You cannot grant access to yourself');
    await requireConsent(user.id, 'medical', 'sharing health records');
    // consent is the athlete's choice even for a provider whose credential lapsed, but they are told, and the provider cannot use it until verified
    const cred = await clinicalCredential(i.provider_id, { athleteId: user.id });
    const expires = i.expires_in_days ? new Date(Date.now() + i.expires_in_days * 864e5) : null;
    return tx(async (c) => {
      await c.query(
        `INSERT INTO medical_grants(athlete_id, provider_id, scope, expires_at, history_scope) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (athlete_id, provider_id) DO UPDATE SET scope=$3, expires_at=$4, history_scope=$5, revoked_at=NULL, granted_at=now()`, [user.id, i.provider_id, i.scope, expires, i.history]);
      await logGrant(c, user.id, i.provider_id, 'grant', i.scope, expires);
      await audit(c, user.id, 'grant_medical', 'users', i.provider_id);
      await notify(c, i.provider_id, { kind: 'consent_granted', title: 'An athlete shared access with you', body: 'Open Health to see who.', data: { athlete_id: user.id } });
      return { ok: true, scope: i.scope, history: i.history, expires_at: expires, provider_verified: cred.ok, ...(cred.ok ? {} : { warning: `This ${cred.type}'s professional verification is not current (${cred.reason}). They cannot view or write records until it is renewed; your consent stays in place.`, credential_reason: cred.reason }) };
    });
  },
});
cap({
  name: 'revoke_medical_access', method: 'DELETE', path: '/medical/grants/:provider_id', tag: 'Health', summary: 'Withdraw consent from a provider. Access stops immediately; the grant and revocation stay in your history.', input: z.object({ provider_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('UPDATE medical_grants SET revoked_at=now() WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL RETURNING scope', [user.id, i.provider_id])).rows[0];
      if (r) {
        await logGrant(c, user.id, i.provider_id, 'revoke', r.scope, null);
        await audit(c, user.id, 'revoke_medical', 'users', i.provider_id);
        await notify(c, i.provider_id, { kind: 'consent_revoked', title: 'An athlete withdrew access', body: 'You can no longer open their records.', data: { athlete_id: user.id } });
      }
      return { ok: true };
    });
  },
});

cap({
  name: 'list_my_grants', method: 'GET', path: '/medical/grants', tag: 'Health',
  summary: 'Athlete: who you have given access to, with scope, expiry and state (active / expired / revoked), plus the history of grants and revocations.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const grants = await many(
      `SELECT g.provider_id, u.display_name AS provider_name, g.scope, g.history_scope, g.granted_at, g.expires_at, g.revoked_at,
              CASE WHEN g.revoked_at IS NOT NULL THEN 'revoked' WHEN g.expires_at IS NOT NULL AND g.expires_at <= now() THEN 'expired' ELSE 'active' END AS state
         FROM medical_grants g JOIN users u ON u.id=g.provider_id WHERE g.athlete_id=$1 ORDER BY g.granted_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    // tell the athlete whose professional verification is not current (computed live, same rule as the clinical gate)
    for (const g of grants) { const cr = await clinicalCredential(g.provider_id, { athleteId: user.id }); g.provider_verified = cr.ok; g.credential_reason = cr.ok ? null : cr.reason; }
    const history = await many('SELECT e.provider_id, u.display_name AS provider_name, e.action, e.scope, e.expires_at, e.created_at FROM medical_grant_events e JOIN users u ON u.id=e.provider_id WHERE e.athlete_id=$1 ORDER BY e.created_at DESC LIMIT 100', [user.id]);
    return { grants, history };
  },
});

cap({
  name: 'list_my_patients', method: 'GET', path: '/medical/patients', tag: 'Health', auth: ['physio', 'doctor'],
  summary: 'Provider: athletes whose consent is currently active, with scope and expiry. Names only; clinical records still need list_medical_records (audit-logged).',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT u.id AS athlete_id, u.display_name, u.handle, g.scope, g.history_scope, g.granted_at, g.expires_at FROM medical_grants g JOIN users u ON u.id=g.athlete_id
      WHERE g.provider_id=$1 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()) ORDER BY u.display_name LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'add_medical_record', credential: true, method: 'POST', path: '/medical/records', tag: 'Health', auth: ['physio', 'doctor'], status: 201,
  summary: 'Provider writes an injury/checkup/clearance/rehab note for an athlete who granted access. Text is encrypted.',
  input: z.object({ athlete_id: id, sport_id: id.optional().describe('the sport this concerns; needed when your credential is limited to one sport and the athlete plays several'), kind: z.enum(['injury', 'checkup', 'clearance', 'rehab', 'note']), clearance: z.enum(['cleared', 'restricted', 'not_cleared']).optional(), summary: z.string().min(1).max(500), details: z.string().max(5000).optional() }),
  async handler({ user }, i) {
    const cred = await requireVerifiedProvider(user.id, { action: 'add_medical_record', athleteId: i.athlete_id, sportId: i.sport_id ?? null });
    if (!(await hasGrant(i.athlete_id, user.id))) throw forbidden('The athlete has not granted you access');
    // atomic: the credential case and the athlete's grant are locked FOR SHARE and re-read in the same transaction as the insert, so a
    // revocation / withdrawal that commits first is seen here and one that commits later waits for this write (nothing lands after it)
    const r = await tx(async (c) => {
      await lockCredential(c, cred);
      if (!(await c.query("SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full' FOR SHARE", [i.athlete_id, user.id])).rows[0]) throw forbidden('The athlete has not granted you access');
      return (await c.query('INSERT INTO medical_records(athlete_id, provider_id, kind, clearance, summary_enc, details_enc) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, athlete_id, kind, clearance, created_at',
        [i.athlete_id, user.id, i.kind, i.clearance ?? null, encrypt(i.summary, 'medical_records.summary'), encrypt(i.details, 'medical_records.details')])).rows[0];
    });
    await audit(null, user.id, 'write_clinical', 'medical_records', r.id);
    return r;
  },
});

cap({
  name: 'list_medical_records', credential: true, method: 'GET', path: '/medical/records', tag: 'Health',
  summary: 'Athletes: your own records (all of them). Providers: pass athlete_id (requires a current verified credential and consent); you see records you wrote plus those written since the grant, or the whole history if the athlete shared it (history `all`). Decrypted; every read is audit-logged.',
  input: z.object({ athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const athlete = i.athlete_id ?? user.id;
    // least privilege: a provider reads what they wrote, plus what was written since the grant; earlier records by others only if the athlete chose history `all`
    let scopeSince = null;
    if (athlete !== user.id) {
      await requireVerifiedProvider(user.id, { action: 'list_medical_records', athleteId: athlete });
      if (!(await hasGrant(athlete, user.id))) throw forbidden('The athlete has not granted you access');
      const g = await one('SELECT history_scope, granted_at FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2', [athlete, user.id]);
      if (g.history_scope !== 'all') scopeSince = g.granted_at;
    }
    const rows = await many('SELECT r.*, p.display_name AS provider_name FROM medical_records r JOIN users p ON p.id=r.provider_id WHERE r.athlete_id=$1 AND ($4::timestamptz IS NULL OR r.provider_id=$5 OR r.created_at >= $4) ORDER BY r.created_at DESC LIMIT $2 OFFSET $3', [athlete, i.limit, i.offset, scopeSince, user.id]);
    await audit(null, user.id, 'read_clinical', 'medical_records', athlete);
    return rows.map(({ summary_enc, details_enc, ...r }) => ({ ...r, summary: decrypt(summary_enc, 'medical_records.summary'), details: decrypt(details_enc, 'medical_records.details') }));
  },
});

cap({
  name: 'get_clearance', credential: true, method: 'GET', path: '/people/:id/clearance', tag: 'Health',
  summary: 'Fit-to-play status only (cleared / restricted / not_cleared) — no clinical detail. Visible to the athlete, consented providers and owners of teams the athlete plays for.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ok = isAdmin(user) || user.id === i.id || !!(await guardianLink(user.id, i.id)) || ((await hasGrant(i.id, user.id, 'clearance')) && (await clinicalCredential(user.id, { athleteId: i.id })).ok) ||
      !!(await one("SELECT 1 FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1 AND m.status='active' AND (t.owner_id=$2 OR EXISTS (SELECT 1 FROM team_members c WHERE c.team_id=t.id AND c.user_id=$2 AND c.role IN ('coach','manager','captain') AND c.status='active'))", [i.id, user.id]));
    if (!ok) throw forbidden();
    // for a young person, anyone but themselves, their guardians and the platform team also needs current medical consent
    if (!isAdmin(user) && user.id !== i.id && !(await guardianLink(user.id, i.id))) await requireConsent(i.id, 'medical', 'sharing fit-to-play status');
    const r = await one("SELECT clearance, created_at FROM medical_records WHERE athlete_id=$1 AND clearance IS NOT NULL ORDER BY created_at DESC LIMIT 1", [i.id]);
    return { athlete_id: i.id, status: r?.clearance ?? 'unknown', as_of: r?.created_at ?? null };
  },
});

cap({
  name: 'get_my_clinical_status', method: 'GET', path: '/medical/credential', tag: 'Health', auth: ['physio', 'doctor'],
  summary: 'Provider: is your professional verification current for clinical actions (records, follow-ups, confirming appointments, incidents)? Returns state (verified / expired / revoked / pending / not_verified), expiry, the grace and emergency policy, and the renewal route (`submit_verification`, linked by previous_case_id). Checked live, so a lapse or revocation shows immediately.',
  input: z.object({}),
  async handler({ user }) {
    const c = await clinicalCredential(user.id, { allowGrace: true });
    return { verified: c.ok && !c.grace, can_act: c.ok, state: c.ok ? (c.grace ? 'grace' : 'verified') : c.reason, profession: c.type, case_id: c.case_id, expires_at: c.expires_at,
      grace_days: config.clinical.graceDays, emergency_exception: 'Event doctors/physios may log serious or emergency incidents with a stated reason while unverified; this is audited.',
      renewal: c.ok && !c.grace ? null : c.renewal };
  },
});
