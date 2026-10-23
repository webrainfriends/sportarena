// Renewal of a sponsorship agreement (#299). Nothing renews by itself: each side records what it intends, and a renewal is proposed as a NEW,
// linked agreement (`renews_id`) that the other side must accept at its exact current terms version, through the same offer and sign-off flow
// as any agreement. The predecessor, its dues and its payment history are never modified by a renewal. Versioned by `renewal_rev`.
import { z } from 'zod';
import { guardedAthleteSql } from '../youth-sponsorship.js';
import { cap, id, page } from '../registry.js';
import { tx, pool, many } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { dealContext, loadLines, saveLines, logHistory } from '../sponsor-agreements.js';
import { LINE, addDays, buildSchedule } from '../sponsor-schedule.js';
import { snapshotIdentity } from '../sponsor-identity-access.js';
import { sponsorStaffSql } from '../sponsor-access.js';
import { ORG_TARGETS, beneficiaryScopeSql } from '../sponsor-beneficiaries.js';
import { pingParties } from '../sponsor-pause.js';
import { localToday, RENEWABLE, RENEWAL_INTENTS, RENEWAL_WINDOW_DAYS, openDues } from '../sponsor-renewals.js';
import { NOT_YOUTH_SQL } from '../youth.js';

const date = z.string().date();
const rev = z.coerce.number().int().min(0).describe('the renewal_rev you were looking at; a changed agreement is refused (409) so nobody acts on stale terms');

/** Which side the caller acts for. Only the two parties decide on renewals; a platform admin can read but never binds either side. */
function sideOf(ctx, what) {
  if (ctx.role === 'sponsor') { ctx.need('propose', what); return 'sponsor'; }
  if (ctx.role === 'recipient') {
    if (ctx.beneficiary && !ctx.beneficiary.representative) throw forbidden('Only a representative of the recipient can do that');
    return 'recipient';
  }
  throw forbidden('Only the sponsor or the recipient can do that');
}
const stale = (d, expected) => { if (d.renewal_rev !== expected) throw conflict(`This agreement changed (now version ${d.renewal_rev}); review it again`, { code: 'stale_version', renewal_rev: d.renewal_rev }); };
const accepted = (d) => { if (!d.accepted_version || !RENEWABLE.includes(d.status)) throw conflict(`Only an accepted agreement that is running or past its term can be renewed (this one is ${d.status})`); };

cap({
  name: 'assess_sponsorship_renewal', method: 'POST', path: '/sponsorships/:id/renewal-assessment', tag: 'Sponsors',
  summary: 'Either side records whether it wants to renew, renegotiate or not renew an accepted agreement. It is only a stated intention shared with the other side: it never renews anything and never commits either party. Each side has one current answer (changing it is kept in the history). Send the renewal_rev you were looking at.',
  input: z.object({ id, expected_renewal_rev: rev, intent: z.enum(RENEWAL_INTENTS), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      const side = sideOf(ctx, 'record renewal plans');
      const { d } = ctx;
      stale(d, i.expected_renewal_rev);
      accepted(d);
      await c.query(
        `INSERT INTO sponsorship_renewal_assessments(sponsorship_id, side, intent, note, decided_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (sponsorship_id, side) DO UPDATE SET intent=EXCLUDED.intent, note=EXCLUDED.note, decided_by=EXCLUDED.decided_by, decided_at=now()`, [d.id, side, i.intent, i.note?.trim() || null, user.id]);
      await c.query('UPDATE sponsorships SET renewal_rev=renewal_rev+1 WHERE id=$1', [d.id]);
      await logHistory(c, d.id, d.accepted_version, user.id, `renewal_intent_${i.intent}`, i.note);
      await pingParties(c, d, 'The other side shared its renewal plans', user.id);
      return { side, intent: i.intent, renewal_rev: d.renewal_rev + 1 };
    });
  },
});

cap({
  name: 'propose_sponsorship_renewal', method: 'POST', path: '/sponsorships/:id/renewal', tag: 'Sponsors', status: 201,
  summary: `Either side proposes a renewal of an accepted agreement as a NEW agreement for a later period, linked to the old one. Allowed in the last ${RENEWAL_WINDOW_DAYS} days of the term, after it, and after final settlement. The new period must start after the old one ends. Without lines the old terms are carried over, with every date moved by the shift between the two start dates; send lines to propose different ones. The other side must accept the exact terms version (or counter it) like any offer, so a renewal can never happen silently, and the old agreement, its dues and its payments are untouched. One live renewal per agreement. The budget, program and award are not carried over.`,
  input: z.object({ id, expected_renewal_rev: rev, starts_on: date, ends_on: date, timezone: z.string().max(60).optional(), lines: z.array(LINE).min(1).max(12).optional(), message: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      const side = sideOf(ctx, 'propose renewals');
      const { d, sp } = ctx;
      stale(d, i.expected_renewal_rev);
      accepted(d);
      if (!d.ends) throw badRequest('An agreement without an end date has no term to renew');
      const days = (await c.query(`SELECT (s.ends_on - ${localToday()})::int AS n FROM sponsorships s WHERE s.id=$1`, [d.id])).rows[0].n;
      if (d.status === 'active' && days > RENEWAL_WINDOW_DAYS) throw conflict(`A renewal can be proposed in the last ${RENEWAL_WINDOW_DAYS} days of the term (${days} days remain)`, { code: 'renewal_window' });
      const live = (await c.query("SELECT id FROM sponsorships WHERE renews_id=$1 AND status NOT IN ('declined','withdrawn')", [d.id])).rows[0];
      if (live) throw conflict('This agreement already has a renewal', { code: 'renewal_exists', successor_id: live.id });
      if (i.ends_on < i.starts_on) throw badRequest('ends_on is before starts_on');
      if (i.starts_on <= d.ends) throw badRequest('The renewal must start after the current agreement ends');
      // the people and bodies the new agreement binds must still be willing and eligible: a renewal never overrides a withdrawn consent
      if (ORG_TARGETS.includes(d.target_type)) {
        const org = (await c.query(`SELECT o.status, o.open_to_sponsors FROM organisations o WHERE o.id = CASE $1 WHEN 'organisation' THEN $2::uuid ELSE (SELECT organisation_id FROM org_cohorts WHERE id=$2) END`, [d.target_type, d.target_id])).rows[0];
        if (!org || org.status !== 'active' || (side === 'sponsor' && !org.open_to_sponsors)) throw conflict('This organisation is not open to sponsorship offers');
        if (d.target_type === 'group' && !(await c.query("SELECT 1 FROM org_cohorts WHERE id=$1 AND status='active'", [d.target_id])).rowCount) throw conflict('This group is archived');
      }
      if (d.target_type === 'athlete') {
        const a = (await c.query(`SELECT sp.open_to_sponsors, (${NOT_YOUTH_SQL}) AS adult FROM users u LEFT JOIN sponsorship_profiles sp ON sp.user_id=u.id WHERE u.id=$1`, [d.target_id])).rows[0];
        if (!a?.adult) throw forbidden('This athlete cannot be approached about a new sponsorship');
        if (side === 'sponsor' && !a.open_to_sponsors) throw conflict('This athlete is not open to sponsorship offers');
      }
      const shift = Math.round((Date.parse(i.starts_on) - Date.parse(d.starts ?? d.ends)) / 86400000) ;
      const lines = i.lines ?? (await loadLines(c, d.id, d.accepted_version)).map(({ id: _line, ...l }) => ({
        ...l, first_due_on: l.first_due_on ? addDays(l.first_due_on, shift) : undefined, custom_dates: l.custom_dates?.map((x) => addDays(x, shift)),
      }));
      const tz = i.timezone ?? d.timezone ?? 'UTC';
      const plan = buildSchedule(lines, { starts_on: i.starts_on, ends_on: i.ends_on }); // validates every line and the whole schedule up front
      const cash = Object.entries(plan.committed);
      const n = (await c.query(
        `INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, in_kind, starts_on, ends_on, proposed_by, objectives, deliverables, message, visibility, department_id, renews_id, terms_side)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [d.sponsor_id, d.target_type, d.target_id, cash.length === 1 ? cash[0][1] : 0, d.in_kind, i.starts_on, i.ends_on, user.id, d.objectives, d.deliverables, i.message ?? null, d.visibility, d.department_id, d.id, side])).rows[0];
      await c.query("UPDATE sponsorships SET agreement_ref='SPA-'||upper(substr(id::text,1,8)), timezone=$2, currency=$3 WHERE id=$1", [n.id, tz, cash.length === 1 ? cash[0][0] : null]);
      await saveLines(c, n.id, 1, lines);
      if (side === 'sponsor') await snapshotIdentity(c, n.id, 1, d.sponsor_id, user.id);
      await c.query('UPDATE sponsorship_versions SET authored_side=$2, authored_by=$3, timezone=$4 WHERE sponsorship_id=$1 AND version=1', [n.id, side, user.id, tz]); // a trigger recorded v1 as the sponsor\'s; who really wrote it decides who may withdraw and who may decline
      await logHistory(c, n.id, 1, user.id, 'proposed', `renewal of ${d.agreement_ref ?? d.id}`);
      await c.query('UPDATE sponsorships SET renewal_rev=renewal_rev+1 WHERE id=$1', [d.id]);
      await logHistory(c, d.id, d.accepted_version, user.id, 'renewal_proposed', i.message);
      await pingParties(c, { ...d, id: n.id }, side === 'sponsor' ? 'You have a sponsorship renewal to review' : 'A sponsorship renewal is waiting for you to sign off', user.id);
      const ref = (await c.query('SELECT agreement_ref FROM sponsorships WHERE id=$1', [n.id])).rows[0].agreement_ref;
      return { id: n.id, agreement_ref: ref, status: n.status, terms_version: 1, terms_side: side, renews_id: d.id, starts_on: i.starts_on, ends_on: i.ends_on, committed: plan.committed, renewal_rev: d.renewal_rev + 1, sponsor: sp.name };
    });
  },
});

cap({
  name: 'list_sponsorship_renewals', method: 'GET', path: '/sponsorship-renewals', tag: 'Sponsors',
  summary: 'Agreements you are part of that are in their renewal window, past their term, or fully settled, and have no renewal yet, soonest end first, with what is still owed (per currency) and each side\'s stated plan. Pure read; limited to what you may see.',
  input: z.object({ as: z.enum(['sponsor', 'target']).optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT ss.id, ss.agreement_ref, ss.status, ss.target_type, ss.target_id, ss.ends_on::text AS ends_on, (ss.ends_on - ${localToday('ss')})::int AS days_left, ss.renewal_rev, ss.term_expired_at, ss.settled_at,
            sp.name AS sponsor_name, ${sponsorStaffSql(1)} AS i_am_sponsor,
            (SELECT count(*)::int FROM sponsorship_obligations o WHERE o.sponsorship_id=ss.id AND o.status='scheduled') AS open_dues,
            (SELECT coalesce(jsonb_agg(jsonb_build_object('side', a.side, 'intent', a.intent) ORDER BY a.side), '[]') FROM sponsorship_renewal_assessments a WHERE a.sponsorship_id=ss.id) AS assessments
       FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id
      WHERE ss.accepted_version IS NOT NULL AND ss.ends_on IS NOT NULL AND ss.status IN ('active','term_expired','completed')
        AND (ss.status <> 'active' OR ss.ends_on - ${localToday('ss')} <= ${RENEWAL_WINDOW_DAYS})
        AND NOT EXISTS (SELECT 1 FROM sponsorships n WHERE n.renews_id=ss.id AND n.status NOT IN ('declined','withdrawn'))
        AND (($4::text IS DISTINCT FROM 'target' AND ${sponsorStaffSql(1)})
          OR ($4::text IS DISTINCT FROM 'sponsor' AND ((ss.target_type='event' AND ss.target_id IN (SELECT id FROM events WHERE organizer_id=$1))
              OR (ss.target_type='team' AND ss.target_id IN (SELECT id FROM teams WHERE owner_id=$1)) OR (ss.target_type='athlete' AND ss.target_id=$1) OR ${guardedAthleteSql('ss')} OR ${beneficiaryScopeSql('$1')})))
      ORDER BY ss.ends_on, ss.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset, i.as ?? null]),
});
