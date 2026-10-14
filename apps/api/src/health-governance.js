// Shared rules for health-data governance (issue: physio module compliance across 11 countries). The regime catalogue is in health-regimes.js.
import { one } from './db.js';
import { AppError } from './errors.js';
import { REGIME_VERSION, regimeFor } from './health-regimes.js';

/** Where a person stands with their country's notice. `needs_notice` is true only once they have chosen a country. */
export async function noticeState(userId, client) {
  const db = client ?? { query: (q, p) => one(q, p).then((r) => ({ rows: r ? [r] : [] })) };
  const u = (await db.query('SELECT health_country FROM users WHERE id=$1', [userId])).rows[0];
  const country = u?.health_country ?? null;
  if (!country || !regimeFor(country)) return { country: null, regime: null, accepted_version: null, current_version: REGIME_VERSION, needs_notice: false };
  const a = (await db.query('SELECT regime_version, country FROM health_notice_acceptances WHERE user_id=$1 ORDER BY accepted_at DESC, id DESC LIMIT 1', [userId])).rows[0];
  const ok = a && a.country === country && a.regime_version >= REGIME_VERSION;
  return { country, regime: regimeFor(country), accepted_version: a?.regime_version ?? null, current_version: REGIME_VERSION, needs_notice: !ok };
}

/** Sharing health records is refused until the person has read the current notice of the country they chose. No country chosen = unchanged behaviour. */
export async function requireHealthNotice(userId, client) {
  const s = await noticeState(userId, client);
  if (s.needs_notice) throw new AppError(409, 'health_notice_required', `Please read and accept the ${s.regime.name} health-privacy notice before sharing health records (Health → Privacy).`, { country: s.country, current_version: s.current_version });
  return s;
}

/** Telehealth across countries: the patient is told whose rules apply and must confirm. Unknown countries are not blocked. */
export async function crossBorderCheck(patientId, providerId, acknowledged) {
  const rows = (await Promise.all([patientId, providerId].map((id) => one('SELECT health_country FROM users WHERE id=$1', [id])))).map((r) => r?.health_country ?? null);
  const [patient, provider] = rows;
  if (!patient || !provider || patient === provider || acknowledged) return { cross_border: !!patient && !!provider && patient !== provider, patient_country: patient, provider_country: provider };
  const p = regimeFor(patient), v = regimeFor(provider);
  throw new AppError(409, 'cross_border_care', `This clinician practises under ${v?.name ?? provider} rules and you are governed by ${p?.name ?? patient} rules. ${v?.telehealth ?? ''} Confirm to continue.`, { patient_country: patient, provider_country: provider, transfer: p?.transfer ?? null });
}
