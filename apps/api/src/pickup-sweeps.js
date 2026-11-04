// Background safety sweep (#788): late-pickup escalation, handovers nobody confirmed, and no-shows. Everything is idempotent: levels only rise,
// events are de-duplicated by key and notifications by dedupe_key, so a retried or concurrent run cannot double up. Timings come from each
// academy's policy (defaults 10 / 20 / 40 minutes); nothing here deletes or rewrites existing data.
import { many, tx } from './db.js';
import { notify } from './notify.js';
import { guardiansOf } from './youth.js';
import { escalate, lockHandover, openSafetyEvent, policyFor, safeguardingOfficers, tellGuardians } from './pickup.js';

const YOUTH = '(u.youth_until IS NOT NULL AND u.youth_until > current_date)';

/** Raise an event's routing to the officers (once). */
async function routeToOfficers(c, event, officers) {
  if (event.status === 'resolved' || event.severity === 'high') return;
  await c.query("UPDATE academy_safety_events SET severity='high', status='escalated', routed_to=$2, row_version=row_version+1 WHERE id=$1", [event.id, officers]);
  await c.query("INSERT INTO academy_safety_event_log(event_id, kind, detail) VALUES ($1,'escalated','officer')", [event.id]);
  for (const u of officers) await notify(c, u, { kind: 'academy_safety_event', title: 'Safety event needs attention', body: 'Open Academy > Safety & pickup.', urgent: true, data: { event_id: event.id, organisation_id: event.organisation_id }, dedupe_key: `safety:${event.id}:${u}` });
}

export async function sweepPickups() {
  let n = 0;
  const policies = new Map();
  const policy = async (c, org) => { if (!policies.has(org)) policies.set(org, await policyFor(c, org)); return policies.get(org); };

  // 1. athletes who arrived and have not been handed over, after the session ended
  const late = await many(
    `SELECT s.id, s.organisation_id, s.ends_at, a.user_id AS athlete_id FROM academy_sessions s JOIN academy_attendance a ON a.session_id=s.id AND a.status IN ('present','late','left_early') JOIN users u ON u.id=a.user_id AND ${YOUTH}
      LEFT JOIN academy_handovers h ON h.session_id=s.id AND h.athlete_id=a.user_id
      WHERE s.status IN ('published','completed') AND s.ends_at < now() AND s.ends_at > now() - interval '24 hours' AND (h.id IS NULL OR h.state IN ('awaiting','disputed')) ORDER BY s.ends_at, a.user_id LIMIT 500`);
  for (const r of late) {
    await tx(async (c) => {
      const p = await policy(c, r.organisation_id);
      const mins = (Date.now() - new Date(r.ends_at).getTime()) / 60000;
      const level = mins >= p.officer_after_min ? 3 : mins >= p.second_after_min ? 2 : mins >= p.late_after_min ? 1 : 0;
      if (!level) return;
      const h = await lockHandover(c, r, r.athlete_id);
      if (h.state === 'handed_over' || h.state === 'pending_confirmation' || level <= h.escalation_level) return;
      await escalate(c, h, level, { policy: p }); n++;
    });
  }

  // 2. a collector was recorded but no guardian confirmed in time: the athlete is still in care
  const unconfirmed = await many("SELECT h.id, h.organisation_id FROM academy_handovers h WHERE h.state='pending_confirmation' AND h.recorded_at < now() ORDER BY h.recorded_at LIMIT 500");
  for (const r of unconfirmed) {
    await tx(async (c) => {
      const h = (await c.query("SELECT * FROM academy_handovers WHERE id=$1 AND state='pending_confirmation' FOR UPDATE", [r.id])).rows[0];
      if (!h) return;
      const p = await policy(c, h.organisation_id);
      const mins = (Date.now() - new Date(h.recorded_at).getTime()) / 60000;
      if (mins < p.confirm_timeout_min) return;
      const { event, created } = await openSafetyEvent(c, { orgId: h.organisation_id, sessionId: h.session_id, athleteId: h.athlete_id, handoverId: h.id, kind: 'unconfirmed_handover', severity: 'medium', dedupeKey: `unconfirmed:${h.id}` });
      if (created) { await tellGuardians(c, h.athlete_id, h, { kind: 'pickup_confirm', title: 'Pickup still needs your confirmation', body: 'The athlete stays with the academy until a guardian confirms.', urgent: true, key: 'confirm2' }); n++; }
      if (mins >= p.confirm_timeout_min * 2) await routeToOfficers(c, event, await safeguardingOfficers(c, h.organisation_id, p));
    });
  }

  // 3. no-shows: expected, never arrived, nobody said they would miss it
  const absent = await many(
    `SELECT s.id, s.organisation_id, s.starts_at, u.id AS athlete_id FROM academy_sessions s JOIN org_enrolments e ON e.cohort_id=s.cohort_id AND e.status='enrolled' JOIN users u ON u.id=e.user_id AND ${YOUTH}
      LEFT JOIN academy_attendance a ON a.session_id=s.id AND a.user_id=u.id
      WHERE s.status='published' AND s.starts_at < now() AND s.starts_at > now() - interval '12 hours' AND (a.id IS NULL OR a.status='expected') ORDER BY s.starts_at, u.id LIMIT 500`);
  for (const r of absent) {
    await tx(async (c) => {
      const p = await policy(c, r.organisation_id);
      const mins = (Date.now() - new Date(r.starts_at).getTime()) / 60000;
      if (mins < p.no_show_after_min) return;
      const { event, created } = await openSafetyEvent(c, { orgId: r.organisation_id, sessionId: r.id, athleteId: r.athlete_id, kind: 'no_show', severity: 'medium', dedupeKey: `noshow:${r.id}:${r.athlete_id}` });
      if (created) {
        for (const g of await guardiansOf(r.athlete_id, c)) await notify(c, g, { kind: 'no_show', title: 'Not at the session', body: 'Your child has not arrived. Please tell the academy if they are not coming.', urgent: true, data: { session_id: r.id, child_id: r.athlete_id }, dedupe_key: `noshow:${r.id}:${r.athlete_id}:${g}` });
        n++;
      }
      if (mins >= p.no_show_after_min * 2) await routeToOfficers(c, event, await safeguardingOfficers(c, r.organisation_id, p));
    });
  }
  return n;
}
