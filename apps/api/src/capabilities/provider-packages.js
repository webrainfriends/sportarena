// Physio/doctor prepaid session packages (#210): define, buy (canonical payments, purpose physio_package), redeem at booking.
import { z } from 'zod';
import { cap, id, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { paymentsEnabled } from '../payments/service.js';
import { requireConsent } from '../youth.js';
import { requireVerifiedProvider } from '../clinical-access.js';
import { TAX_CLASSES, SERVICE_SELECT } from './provider-services.js';

const TAG = 'Health';
const LIVE_USED = "(SELECT count(*)::int FROM package_redemptions r JOIN appointments a ON a.id=r.appointment_id WHERE r.patient_package_id=pp.id AND a.status NOT IN ('cancelled','expired'))";

/** Activation after payment (called by payments fulfil). Idempotent: only an awaiting package activates. */
export async function activatePhysioPackage(c, packageId) {
  const r = await c.query("UPDATE patient_packages SET status='active', activated_at=now(), expires_at=CASE WHEN valid_days IS NULL THEN NULL ELSE now() + make_interval(days => valid_days) END WHERE id=$1 AND status='awaiting_payment'", [packageId]);
  return r.rowCount > 0;
}

/** Spend one session. Caller holds the provider booking lock; this row-locks the package so concurrent bookings cannot overspend. */
export async function redeemPackage(c, { patientPackageId, patientId, providerId, serviceId }) {
  const pp = (await c.query(`SELECT pp.*, ${LIVE_USED} AS used FROM patient_packages pp WHERE pp.id=$1 FOR UPDATE`, [patientPackageId])).rows[0];
  if (!pp || pp.patient_id !== patientId || pp.provider_id !== providerId) throw notFound('Package');
  if (pp.status !== 'active') throw conflict('That package is not active');
  if (pp.expires_at && new Date(pp.expires_at) <= new Date()) throw conflict('That package has expired');
  if (pp.service_id !== serviceId) throw badRequest('That package is for a different service');
  if (pp.used >= pp.sessions_total) throw conflict('No sessions left in that package');
  return pp;
}

cap({
  name: 'upsert_provider_package', method: 'POST', path: '/me/provider-packages', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: define a prepaid package of 2+ sessions of one of your services (or edit it by `id`; purchases already made keep their original terms). Set `valid_days` for an expiry counted from payment, and `refund_terms` shown before purchase. No automatic recurring charge.',
  input: z.object({
    id: id.optional(), service_id: id, title: z.string().trim().min(2).max(120), sessions: z.number().int().min(2).max(100), price_cents: money, tax_class: z.enum(TAX_CLASSES).default('unspecified'),
    valid_days: z.number().int().min(1).max(1825).nullable().optional(), refund_terms: z.string().max(500).nullable().optional(),
  }),
  async handler({ user }, i) {
    const svc = await one(`${SERVICE_SELECT} WHERE s.id=$1 AND s.provider_id=$2`, [i.service_id, user.id]);
    if (!svc || svc.archived_at || !svc.price_id) throw badRequest('Choose one of your active services with a price');
    const v = [i.service_id, i.title, i.sessions, i.price_cents, svc.currency, i.tax_class, i.valid_days ?? null, i.refund_terms ?? null];
    if (i.id) {
      const r = await one('UPDATE provider_packages SET service_id=$3, title=$4, sessions=$5, price_cents=$6, currency=$7, tax_class=$8, valid_days=$9, refund_terms=$10 WHERE id=$1 AND provider_id=$2 AND archived_at IS NULL RETURNING *', [i.id, user.id, ...v]);
      if (!r) throw notFound('Package');
      return r;
    }
    return one('INSERT INTO provider_packages(service_id, title, sessions, price_cents, currency, tax_class, valid_days, refund_terms, provider_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [...v, user.id]);
  },
});

cap({
  name: 'archive_provider_package', method: 'POST', path: '/me/provider-packages/:id/archive', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: stop selling a package. Packages already bought stay usable.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE provider_packages SET archived_at=COALESCE(archived_at, now()) WHERE id=$1 AND provider_id=$2 RETURNING id, archived_at', [i.id, user.id]);
    if (!r) throw notFound('Package');
    return r;
  },
});

cap({
  name: 'list_my_provider_packages', method: 'GET', path: '/me/provider-packages', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: your packages and how many have been sold (paid).',
  input: z.object({}),
  handler: ({ user }) => many("SELECT p.*, (SELECT count(*)::int FROM patient_packages x WHERE x.package_id=p.id AND x.status='active') AS sold FROM provider_packages p WHERE p.provider_id=$1 ORDER BY (p.archived_at IS NOT NULL), p.created_at DESC, p.id", [user.id]),
});

cap({
  name: 'list_provider_packages', method: 'GET', path: '/providers/:id/packages', tag: TAG, auth: 'public',
  summary: 'Packages a physio/doctor currently sells (sessions, price, validity, refund terms).',
  input: z.object({ id }),
  handler: (_, i) => many('SELECT id, service_id, title, sessions, price_cents, currency, tax_class, valid_days, refund_terms FROM provider_packages WHERE provider_id=$1 AND archived_at IS NULL ORDER BY created_at, id', [i.id]),
});

cap({
  name: 'buy_provider_package', credential: true, method: 'POST', path: '/provider-packages/:id/buy', tag: TAG, status: 201,
  summary: 'Buy a package. It stays awaiting payment until paid through create_payment with purpose_type physio_package and the returned id; then it activates and the validity period starts. Free packages, or a platform without payments, activate immediately.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const pkg = await one('SELECT * FROM provider_packages WHERE id=$1 AND archived_at IS NULL', [i.id]);
    if (!pkg) throw notFound('Package');
    if (pkg.provider_id === user.id) throw badRequest('Cannot buy your own package');
    await requireConsent(user.id, 'medical', 'buying a health package');
    await requireVerifiedProvider(pkg.provider_id, { action: 'buy_package', athleteId: user.id, forOther: true });
    return tx(async (c) => {
      const row = (await c.query('INSERT INTO patient_packages(package_id, provider_id, patient_id, service_id, title, sessions_total, price_cents, currency, tax_class, valid_days, refund_terms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
        [pkg.id, pkg.provider_id, user.id, pkg.service_id, pkg.title, pkg.sessions, pkg.price_cents, pkg.currency, pkg.tax_class, pkg.valid_days, pkg.refund_terms])).rows[0];
      if (!paymentsEnabled() || Number(pkg.price_cents) === 0) await activatePhysioPackage(c, row.id);
      return (await c.query(`SELECT pp.*, ${LIVE_USED} AS used FROM patient_packages pp WHERE pp.id=$1`, [row.id])).rows[0];
    });
  },
});

cap({
  name: 'list_my_packages', method: 'GET', path: '/me/packages', tag: TAG,
  summary: 'Your purchased packages with sessions left and expiry. Pass `id` of one as `patient_package_id` to book_appointment to spend a session.',
  input: z.object({}),
  handler: async ({ user }) => (await many(`SELECT pp.*, ${LIVE_USED} AS used FROM patient_packages pp WHERE pp.patient_id=$1 ORDER BY pp.created_at DESC, pp.id`, [user.id]))
    .map((p) => ({ ...p, sessions_left: p.status === 'active' && !(p.expires_at && new Date(p.expires_at) <= new Date()) ? p.sessions_total - p.used : 0 })),
});

cap({
  name: 'cancel_unpaid_package', method: 'POST', path: '/me/packages/:id/cancel', tag: TAG,
  summary: 'Cancel a package purchase that has not been paid yet. Paid packages are not cancelled here (refunds are handled by the provider per the stated refund terms).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one("UPDATE patient_packages SET status='cancelled' WHERE id=$1 AND patient_id=$2 AND status='awaiting_payment' RETURNING id, status", [i.id, user.id]);
    if (!r) throw conflict('Only your own unpaid packages can be cancelled');
    return r;
  },
});
