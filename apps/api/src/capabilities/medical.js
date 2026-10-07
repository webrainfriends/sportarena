import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, mustFind, PUBLIC_USER } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';

const dt = z.string().datetime({ offset: true });
const hasGrant = async (athleteId, providerId) => !!(await one('SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2', [athleteId, providerId]));

cap({
  name: 'list_providers', method: 'GET', path: '/providers', tag: 'Health', auth: 'public', summary: 'Find physios and doctors, optionally by sport.',
  input: z.object({ role: z.enum(['physio', 'doctor']).optional(), sport: z.string().optional(), ...page }),
  handler: (_, i) => many(
    `SELECT ${PUBLIC_USER}, p.role AS provider_role, p.hourly_rate_cents, s.name AS sport, s.emoji AS sport_emoji, p.level FROM sport_profiles p JOIN users u ON u.id=p.user_id JOIN sports s ON s.id=p.sport_id
      WHERE p.role IN ('physio','doctor') AND ($1::text IS NULL OR p.role=$1) AND ($2::text IS NULL OR s.slug=$2) ORDER BY u.display_name LIMIT $3 OFFSET $4`, [i.role ?? null, i.sport ?? null, i.limit, i.offset]),
});

cap({
  name: 'book_appointment', method: 'POST', path: '/appointments', tag: 'Health', status: 201,
  summary: 'Request an appointment with a physio/doctor. The reason is encrypted.',
  input: z.object({ provider_id: id, starts_at: dt, duration_min: z.number().int().min(10).max(240).default(30), reason: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    if (i.provider_id === user.id) throw badRequest('Cannot book yourself');
    const p = await one("SELECT 1 FROM sport_profiles WHERE user_id=$1 AND role IN ('physio','doctor')", [i.provider_id]);
    if (!p) throw badRequest('That person is not a registered physio or doctor');
    const clash = await one("SELECT 1 FROM appointments WHERE provider_id=$1 AND status IN ('requested','confirmed') AND starts_at < $2::timestamptz + make_interval(mins => $3) AND starts_at + make_interval(mins => duration_min) > $2", [i.provider_id, i.starts_at, i.duration_min]);
    if (clash) throw conflict('Provider is not free then');
    const a = await one('INSERT INTO appointments(athlete_id, provider_id, starts_at, duration_min, reason_enc) VALUES ($1,$2,$3,$4,$5) RETURNING id, athlete_id, provider_id, starts_at, duration_min, status', [user.id, i.provider_id, i.starts_at, i.duration_min, encrypt(i.reason, 'appointments.reason')]);
    return a;
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
  name: 'update_appointment', method: 'PATCH', path: '/appointments/:id', tag: 'Health',
  summary: 'Provider confirms/completes; either party can cancel.', input: z.object({ id, status: z.enum(['confirmed', 'completed', 'cancelled']) }),
  async handler({ user }, i) {
    const a = await mustFind('appointments', i.id);
    const isProvider = a.provider_id === user.id, isAthlete = a.athlete_id === user.id;
    if (!isProvider && !isAthlete && !isAdmin(user)) throw forbidden();
    if (i.status !== 'cancelled' && !isProvider) throw forbidden('Only the provider can confirm or complete');
    return one('UPDATE appointments SET status=$2 WHERE id=$1 RETURNING id, athlete_id, provider_id, starts_at, duration_min, status', [i.id, i.status]);
  },
});

cap({
  name: 'grant_medical_access', method: 'POST', path: '/medical/grants', tag: 'Health', status: 201,
  summary: 'Consent: let a physio/doctor read and write your medical records.', input: z.object({ provider_id: id }),
  async handler({ user }, i) {
    const p = await one("SELECT 1 FROM sport_profiles WHERE user_id=$1 AND role IN ('physio','doctor')", [i.provider_id]);
    if (!p) throw badRequest('That person is not a registered physio or doctor');
    await query('INSERT INTO medical_grants(athlete_id, provider_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [user.id, i.provider_id]);
    await audit(null, user.id, 'grant_medical', 'users', i.provider_id);
    return { ok: true };
  },
});
cap({
  name: 'revoke_medical_access', method: 'DELETE', path: '/medical/grants/:provider_id', tag: 'Health', summary: 'Withdraw consent from a provider.', input: z.object({ provider_id: id }),
  async handler({ user }, i) {
    await query('DELETE FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2', [user.id, i.provider_id]);
    await audit(null, user.id, 'revoke_medical', 'users', i.provider_id);
    return { ok: true };
  },
});

cap({
  name: 'add_medical_record', method: 'POST', path: '/medical/records', tag: 'Health', auth: ['physio', 'doctor'], status: 201,
  summary: 'Provider writes an injury/checkup/clearance/rehab note for an athlete who granted access. Text is encrypted.',
  input: z.object({ athlete_id: id, kind: z.enum(['injury', 'checkup', 'clearance', 'rehab', 'note']), clearance: z.enum(['cleared', 'restricted', 'not_cleared']).optional(), summary: z.string().min(1).max(500), details: z.string().max(5000).optional() }),
  async handler({ user }, i) {
    if (!(await hasGrant(i.athlete_id, user.id))) throw forbidden('The athlete has not granted you access');
    const r = await one('INSERT INTO medical_records(athlete_id, provider_id, kind, clearance, summary_enc, details_enc) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, athlete_id, kind, clearance, created_at',
      [i.athlete_id, user.id, i.kind, i.clearance ?? null, encrypt(i.summary, 'medical_records.summary'), encrypt(i.details, 'medical_records.details')]);
    await audit(null, user.id, 'write_clinical', 'medical_records', r.id);
    return r;
  },
});

cap({
  name: 'list_medical_records', method: 'GET', path: '/medical/records', tag: 'Health',
  summary: 'Athletes: your own records. Providers: pass athlete_id (requires consent). Decrypted; every read is audit-logged.',
  input: z.object({ athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const athlete = i.athlete_id ?? user.id;
    if (athlete !== user.id && !(await hasGrant(athlete, user.id))) throw forbidden('The athlete has not granted you access');
    const rows = await many('SELECT r.*, p.display_name AS provider_name FROM medical_records r JOIN users p ON p.id=r.provider_id WHERE r.athlete_id=$1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3', [athlete, i.limit, i.offset]);
    await audit(null, user.id, 'read_clinical', 'medical_records', athlete);
    return rows.map(({ summary_enc, details_enc, ...r }) => ({ ...r, summary: decrypt(summary_enc, 'medical_records.summary'), details: decrypt(details_enc, 'medical_records.details') }));
  },
});

cap({
  name: 'get_clearance', method: 'GET', path: '/people/:id/clearance', tag: 'Health',
  summary: 'Fit-to-play status only (cleared / restricted / not_cleared) — no clinical detail. Visible to the athlete, consented providers and owners of teams the athlete plays for.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ok = isAdmin(user) || user.id === i.id || (await hasGrant(i.id, user.id)) ||
      !!(await one("SELECT 1 FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1 AND m.status='active' AND (t.owner_id=$2 OR EXISTS (SELECT 1 FROM team_members c WHERE c.team_id=t.id AND c.user_id=$2 AND c.role IN ('coach','manager','captain') AND c.status='active'))", [i.id, user.id]));
    if (!ok) throw forbidden();
    const r = await one("SELECT clearance, created_at FROM medical_records WHERE athlete_id=$1 AND clearance IS NOT NULL ORDER BY created_at DESC LIMIT 1", [i.id]);
    return { athlete_id: i.id, status: r?.clearance ?? 'unknown', as_of: r?.created_at ?? null };
  },
});
