// Health-data breach register (platform team). Every country that applies to the affected people starts its own clock
// (src/health/regimes.js): the regulator and the individuals each get a legal due time where the law fixes one, otherwise the platform's own target.
// Nothing is ever deleted: closing a breach keeps it, its notices and who sent them.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { REGIMES, REGIME_CODES, breachClocks } from '../health/regimes.js';

const TAG = 'Health';
const regime = z.string().trim().toUpperCase().refine((v) => REGIME_CODES.includes(v), { message: `Choose from: ${REGIME_CODES.join(', ')}` });

const present = (b, notices) => {
  const now = Date.now();
  const rows = (notices ?? []).map((n) => ({
    id: n.id, regime: n.regime, country: REGIMES[n.regime]?.name, audience: n.audience, rule: n.rule, due_at: n.due_at, target_at: n.target_at, sent_at: n.sent_at, not_required_at: n.not_required_at,
    reference: decrypt(n.reference_enc, 'health_breach_notices.reference'), not_required_reason: decrypt(n.not_required_reason_enc, 'health_breach_notices.not_required_reason'),
    state: n.sent_at ? 'sent' : n.not_required_at ? 'not_required' : n.due_at && new Date(n.due_at).getTime() < now ? 'overdue_legal' : new Date(n.target_at).getTime() < now ? 'overdue_target' : 'pending',
  }));
  return { id: b.id, discovered_at: b.discovered_at, scope: b.scope, event_id: b.event_id, regimes: b.regimes, affected_count: b.affected_count, severity: b.severity, status: b.status, summary: decrypt(b.summary_enc, 'health_breaches.summary'), containment: decrypt(b.containment_enc, 'health_breaches.containment'), contained_at: b.contained_at, closed_at: b.closed_at, created_at: b.created_at, notices: rows, open_notices: rows.filter((r) => r.state !== 'sent' && r.state !== 'not_required').length, worst: rows.some((r) => r.state === 'overdue_legal') ? 'overdue_legal' : rows.some((r) => r.state === 'overdue_target') ? 'overdue_target' : 'ok' };
};

cap({
  name: 'report_health_breach', method: 'POST', path: '/admin/health/breaches', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Platform team: record a suspected or confirmed breach of health data (patient records, appointments, event medical logs, credentials). Name every country whose people are affected: each starts its own clock for the regulator and for the individuals (the legal due time where fixed, plus the platform\'s own target). The register is append-only.',
  input: z.object({ discovered_at: z.string().datetime({ offset: true }).describe('when the platform became aware'), scope: z.enum(['records', 'appointments', 'event_coverage', 'credentials', 'other']), event_id: id.optional().describe('the event, for event_coverage'), regimes: z.array(regime).min(1).max(11), affected_count: z.number().int().min(0).max(1e8), severity: z.enum(['low', 'medium', 'high']), summary: z.string().trim().min(10).max(4000), containment: z.string().trim().max(4000).optional() }),
  async handler({ user }, i) {
    if (Date.parse(i.discovered_at) > Date.now() + 6e4) throw badRequest('The discovery time cannot be in the future');
    if (i.scope === 'event_coverage' && !i.event_id) throw badRequest('Name the event for an event-coverage breach');
    const regimes = [...new Set(i.regimes)];
    return tx(async (c) => {
      const b = (await c.query('INSERT INTO health_breaches(reported_by, discovered_at, scope, event_id, regimes, affected_count, severity, summary_enc, containment_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [user.id, i.discovered_at, i.scope, i.event_id ?? null, regimes, i.affected_count, i.severity, encrypt(i.summary, 'health_breaches.summary'), encrypt(i.containment, 'health_breaches.containment')])).rows[0];
      const notices = [];
      for (const k of breachClocks(regimes, i.discovered_at)) notices.push((await c.query('INSERT INTO health_breach_notices(breach_id, regime, audience, rule, due_at, target_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [b.id, k.regime, k.audience, k.rule, k.due_at, k.target_at])).rows[0]);
      await audit(c, user.id, 'report_health_breach', 'health_breaches', b.id);
      return present(b, notices);
    });
  },
});

cap({
  name: 'list_health_breaches', method: 'GET', path: '/admin/health/breaches', tag: TAG, auth: ['admin'],
  summary: 'Platform team: the health-breach register with each notice\'s state (pending, overdue against the legal clock, overdue against our target, sent, not required). Breaches with overdue legal notices come first.',
  input: z.object({ status: z.enum(['investigating', 'contained', 'notified', 'closed', 'open']).default('open').describe('open = not closed'), ...page }),
  async handler({ user }, i) {
    const bs = await many("SELECT * FROM health_breaches WHERE ($1 = 'open' AND status <> 'closed') OR status = $1 ORDER BY discovered_at DESC LIMIT $2 OFFSET $3", [i.status, i.limit, i.offset]);
    const ns = bs.length ? await many('SELECT * FROM health_breach_notices WHERE breach_id = ANY($1::uuid[]) ORDER BY regime, audience', [bs.map((b) => b.id)]) : [];
    await audit(null, user.id, 'read_clinical', 'health_breaches', null);
    const rank = { overdue_legal: 0, overdue_target: 1, ok: 2 };
    return bs.map((b) => present(b, ns.filter((n) => n.breach_id === b.id))).sort((a, b) => rank[a.worst] - rank[b.worst]);
  },
});

cap({
  name: 'update_health_breach', method: 'POST', path: '/admin/health/breaches/:id', tag: TAG, auth: ['admin'],
  summary: 'Platform team: move a breach along (contained, notified, closed), and record each notice: sent (with a reference such as the regulator\'s case number, or how individuals were told) or assessed as not required (with the reason). A breach cannot be closed while a notice is still open. Individuals who are platform users are told in the app when their country\'s notice is marked sent.',
  input: z.object({ id, status: z.enum(['contained', 'notified', 'closed']).optional(), containment: z.string().trim().max(4000).optional(),
    notice: z.object({ regime, audience: z.enum(['regulator', 'individuals']), outcome: z.enum(['sent', 'not_required']), reference: z.string().trim().max(3000).optional().describe('regulator: the case number; individuals: the notice text people will read'), reason: z.string().trim().min(5).max(1000).optional() }).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const b = (await c.query('SELECT * FROM health_breaches WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!b) throw notFound('Breach');
      if (b.status === 'closed') throw conflict('That breach is closed');
      if (i.notice) {
        const n = i.notice;
        if (n.outcome === 'not_required' && !n.reason) throw badRequest('Say why no notice is required');
        if (n.outcome === 'sent' && n.audience === 'individuals' && (n.reference ?? '').length < 20) throw badRequest('For individuals, `reference` is the notice text they will read: what happened, what data, what we did and what they should do (at least 20 characters)');
        const row = (await c.query(
          `UPDATE health_breach_notices SET sent_at=CASE WHEN $4='sent' THEN now() END, sent_by=$5, reference_enc=$6, not_required_at=CASE WHEN $4='not_required' THEN now() END, not_required_reason_enc=$7
            WHERE breach_id=$1 AND regime=$2 AND audience=$3 AND sent_at IS NULL AND not_required_at IS NULL RETURNING id`,
          [b.id, n.regime, n.audience, n.outcome, user.id, encrypt(n.reference, 'health_breach_notices.reference'), encrypt(n.reason, 'health_breach_notices.not_required_reason')])).rows[0];
        if (!row) throw conflict('That notice does not exist for this breach or is already recorded');
      }
      if (i.status === 'closed') {
        const open = (await c.query('SELECT count(*)::int AS n FROM health_breach_notices WHERE breach_id=$1 AND sent_at IS NULL AND not_required_at IS NULL', [b.id])).rows[0].n;
        if (open) throw conflict(`${open} notice${open === 1 ? ' is' : 's are'} still open: send them or record why none is required first.`, { open_notices: open });
      }
      const next = i.status ?? b.status;
      await c.query('UPDATE health_breaches SET status=$2, containment_enc=coalesce($3, containment_enc), contained_at=CASE WHEN $2 IN (\'contained\',\'notified\',\'closed\') THEN coalesce(contained_at, now()) END, closed_at=CASE WHEN $2=\'closed\' THEN now() END, updated_at=now() WHERE id=$1',
        [b.id, next, encrypt(i.containment, 'health_breaches.containment')]);
      await audit(c, user.id, 'update_health_breach', 'health_breaches', b.id);
      if (i.notice?.outcome === 'sent' && i.notice.audience === 'individuals') {
        const people = (await c.query('SELECT user_id FROM health_privacy_profiles WHERE regime=$1', [i.notice.regime])).rows;
        for (const p of people) await notify(c, p.user_id, { kind: 'health_breach', title: 'Important: a notice about your health data', body: 'Open Health → Privacy to read what happened and what to do.', data: { breach_id: b.id } });
      }
      const fresh = (await c.query('SELECT * FROM health_breaches WHERE id=$1', [b.id])).rows[0];
      return present(fresh, (await c.query('SELECT * FROM health_breach_notices WHERE breach_id=$1 ORDER BY regime, audience', [b.id])).rows);
    });
  },
});

// What an affected person reads: only the facts they need, never the register's internals.
cap({
  name: 'list_my_health_notices', method: 'GET', path: '/medical/privacy/notices', tag: TAG,
  summary: 'Breach notices that concern you: when it happened, what kind of data, how many people were affected and the notice text written for you. Shown once the platform team has marked your country\'s notice to individuals as sent.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const prof = await one('SELECT regime FROM health_privacy_profiles WHERE user_id=$1', [user.id]);
    if (!prof) return [];
    const rows = await many(
      `SELECT b.id, b.discovered_at, b.scope, b.affected_count, n.reference_enc, n.sent_at FROM health_breaches b JOIN health_breach_notices n ON n.breach_id=b.id AND n.regime=$1 AND n.audience='individuals' AND n.sent_at IS NOT NULL
        WHERE $1 = ANY(b.regimes) ORDER BY n.sent_at DESC LIMIT $2 OFFSET $3`, [prof.regime, i.limit, i.offset]);
    return rows.map((r) => ({ id: r.id, discovered_at: r.discovered_at, told_at: r.sent_at, scope: r.scope, affected_count: r.affected_count, notice: decrypt(r.reference_enc, 'health_breach_notices.reference') }));
  },
});
