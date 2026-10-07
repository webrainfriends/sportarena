import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, conflict } from '../errors.js';
import { audit, isAdmin, mustFind } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { randomBytes } from 'node:crypto';
import { canManageTeam } from './teams.js';

const mask = (n) => (n ? `••••${n.slice(-4)}` : null);

cap({
  name: 'list_insurance_plans', method: 'GET', path: '/insurance/plans', tag: 'Insurance', auth: 'public', summary: 'Insurance plans for individuals, teams and events.',
  input: z.object({ cover_for: z.enum(['individual', 'team', 'event']).optional() }),
  handler: (_, i) => many('SELECT * FROM insurance_plans WHERE ($1::text IS NULL OR cover_for=$1) ORDER BY premium_cents', [i.cover_for ?? null]),
});

cap({
  name: 'create_insurance_plan', method: 'POST', path: '/insurance/plans', tag: 'Insurance', auth: ['admin'], status: 201, summary: 'Admin: publish an insurance plan.',
  input: z.object({ name: z.string().min(2), insurer: z.string().min(2), cover_for: z.enum(['individual', 'team', 'event']), premium_cents: money, coverage_cents: money, description: z.string().max(1000).optional(), emoji: z.string().max(8).optional() }),
  handler: (_, i) => one("INSERT INTO insurance_plans(name, insurer, cover_for, premium_cents, coverage_cents, description, emoji) VALUES ($1,$2,$3,$4,$5,$6,coalesce($7,'🛡️')) RETURNING *", [i.name, i.insurer, i.cover_for, i.premium_cents, i.coverage_cents, i.description, i.emoji]),
});

cap({
  name: 'buy_policy', method: 'POST', path: '/insurance/policies', tag: 'Insurance', status: 201,
  summary: 'Insure yourself (individual), a team you manage, or an event you organise. Policy number and beneficiary are encrypted.',
  input: z.object({ plan_id: id, subject_id: id.optional().describe('team or event id; omit for individual (you)'), months: z.number().int().min(1).max(36).default(12), beneficiary: z.string().max(200).optional() }),
  async handler({ user }, i) {
    const plan = await mustFind('insurance_plans', i.plan_id);
    if (plan.cover_for !== 'individual' && !i.subject_id) throw badRequest('subject_id is required for team/event cover');
    const subject = plan.cover_for === 'individual' ? user.id : i.subject_id;
    if (plan.cover_for === 'team' && !(await canManageTeam(user, await mustFind('teams', subject)))) throw forbidden('You do not manage that team');
    if (plan.cover_for === 'event') {
      const ev = await mustFind('events', subject);
      if (!isAdmin(user) && ev.organizer_id !== user.id) throw forbidden('You do not organise that event');
    }
    const policyNo = `SA-${randomBytes(5).toString('hex').toUpperCase()}`;
    const p = await one(
      `INSERT INTO insurance_policies(plan_id, holder_id, subject_type, subject_id, policy_no_enc, beneficiary_enc, ends_on)
       VALUES ($1,$2,$3,$4,$5,$6, current_date + make_interval(months => $7)::interval) RETURNING id, plan_id, subject_type, subject_id, status, starts_on, ends_on`,
      [plan.id, user.id, plan.cover_for, subject, encrypt(policyNo, 'insurance_policies.policy_no'), encrypt(i.beneficiary, 'insurance_policies.beneficiary'), i.months]);
    return { ...p, policy_no: mask(policyNo), premium_cents: plan.premium_cents * i.months, coverage_cents: plan.coverage_cents };
  },
});

cap({
  name: 'list_policies', method: 'GET', path: '/insurance/policies', tag: 'Insurance', summary: 'Your policies (policy numbers masked; use get_policy for full details).',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many("SELECT p.*, pl.name AS plan_name, pl.insurer, pl.coverage_cents, pl.emoji, (CASE WHEN p.ends_on < current_date AND p.status='active' THEN 'expired' ELSE p.status END) AS effective_status FROM insurance_policies p JOIN insurance_plans pl ON pl.id=p.plan_id WHERE p.holder_id=$1 ORDER BY p.created_at DESC LIMIT $2 OFFSET $3", [user.id, i.limit, i.offset]);
    return rows.map(({ policy_no_enc, beneficiary_enc, ...r }) => ({ ...r, policy_no: mask(decrypt(policy_no_enc, 'insurance_policies.policy_no')) }));
  },
});

cap({
  name: 'get_policy', method: 'GET', path: '/insurance/policies/:id', tag: 'Insurance', summary: 'Full policy incl. decrypted number and beneficiary (holder only; audit-logged).', input: z.object({ id }),
  async handler({ user }, i) {
    const p = await mustFind('insurance_policies', i.id);
    if (!isAdmin(user) && p.holder_id !== user.id) throw forbidden();
    await audit(null, user.id, 'read_pii', 'insurance_policies', p.id);
    const { policy_no_enc, beneficiary_enc, ...r } = p;
    return { ...r, policy_no: decrypt(policy_no_enc, 'insurance_policies.policy_no'), beneficiary: decrypt(beneficiary_enc, 'insurance_policies.beneficiary') };
  },
});

cap({
  name: 'file_claim', method: 'POST', path: '/insurance/policies/:id/claims', tag: 'Insurance', status: 201,
  summary: 'File a claim against an active policy. Description is encrypted; amount cannot exceed coverage.',
  input: z.object({ id, description: z.string().min(5).max(3000), amount_cents: money.refine((n) => n > 0) }),
  async handler({ user }, i) {
    const p = await mustFind('insurance_policies', i.id);
    if (p.holder_id !== user.id) throw forbidden();
    if (p.status !== 'active' || p.ends_on < new Date().toISOString().slice(0, 10)) throw conflict('Policy is not active');
    const plan = await mustFind('insurance_plans', p.plan_id);
    if (i.amount_cents > plan.coverage_cents) throw badRequest('Claim exceeds coverage', { coverage_cents: plan.coverage_cents });
    return one('INSERT INTO insurance_claims(policy_id, claimant_id, description_enc, amount_cents) VALUES ($1,$2,$3,$4) RETURNING id, policy_id, amount_cents, status, created_at', [i.id, user.id, encrypt(i.description, 'insurance_claims.description'), i.amount_cents]);
  },
});

cap({
  name: 'list_claims', method: 'GET', path: '/insurance/claims', tag: 'Insurance', summary: 'Your claims (admins see all).', input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many('SELECT * FROM insurance_claims WHERE ($1 OR claimant_id=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4', [isAdmin(user), user.id, i.limit, i.offset]);
    if (rows.length) await audit(null, user.id, 'read_pii', 'insurance_claims', null);
    return rows.map(({ description_enc, ...r }) => ({ ...r, description: decrypt(description_enc, 'insurance_claims.description') }));
  },
});

cap({
  name: 'review_claim', method: 'PATCH', path: '/insurance/claims/:id', tag: 'Insurance', auth: ['admin'], summary: 'Admin: move a claim through review → approved/rejected → paid.',
  input: z.object({ id, status: z.enum(['under_review', 'approved', 'rejected', 'paid']) }),
  handler: (_, i) => one('UPDATE insurance_claims SET status=$2 WHERE id=$1 RETURNING id, policy_id, amount_cents, status', [i.id, i.status]),
});
