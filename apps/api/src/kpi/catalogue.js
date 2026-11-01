// The governed metric catalogue (#596): the ONE place a shared sports/business KPI is defined. Every module, dashboard, export and scheduled report
// asks the engine (engine.js) for a metric by key, so two callers asking for the same metric, scope and period always get the same definition and figure.
//
// A metric is a versioned definition plus a single `facts` query. The value, every group-by, the drill-down list, the freshness indicators and the
// data-quality warnings are all derived from that one query, so a KPI can never disagree with the records behind it. Nothing here is stored:
// facts are read live from the canonical tables (the Sports Graph, finance, sponsorship and venue modules still own their data).
//
// Changing a formula = bump `version`. The engine refuses to publish a changed definition under the same version (see syncCatalogue), and old versions
// stay readable forever (kpi_definition_versions is append-only), so a figure quoted last quarter can always be traced to the formula that produced it.
import { createHash } from 'node:crypto';
import { YOUTH_SQL } from '../youth.js';
import { LIC_STATUS } from '../federation.js';

/** Parameters every facts query receives: $1 event ids, $2 venue ids, $3 team ids, $4 organisation id, $5 unrestricted, $6 from (date), $7 to (date, inclusive), $9 sponsor ids. */
const FROM = '$6::date';
const TO_EXCL = '($7::date + 1)';
const inRange = (ts) => `${ts} >= ${FROM} AND ${ts} < ${TO_EXCL}`;
const person = (u) => `CASE WHEN ${YOUTH_SQL.replaceAll('u.', `${u}.`)} THEN 'Youth athlete' ELSE ${u}.display_name END`;

const TYPES = { rec_id: 'text', rec_kind: 'text', label: 'text', at: 'timestamptz', subject: 'text', sport_id: 'uuid', event_id: 'uuid', venue_id: 'uuid', team_id: 'uuid', org_id: 'uuid', sponsor_id: 'uuid', currency: 'text', amount: 'bigint', num: 'numeric', den: 'numeric', channel: 'text', flag: 'text', link_kind: 'text', link_id: 'uuid' };
/** One SELECT list with every fact column typed, so each UNION branch lines up and a missing column is NULL rather than a different shape. */
const fact = (o) => Object.entries(TYPES).map(([k, t]) => `${o[k] ?? 'NULL'}::${t} AS ${k}`).join(', ');

export const AUDIENCES = {
  // who may read the metric in an organisation scope (organisation_members.role)
  ops: ['owner', 'admin', 'manager', 'coach', 'staff', 'finance', 'auditor'],
  finance: ['owner', 'admin', 'finance', 'auditor'],
  squad: ['owner', 'admin', 'manager', 'coach'],
};
export const SCOPE_TYPES = ['platform', 'organisation', 'venue', 'event', 'team', 'sponsor', 'federation'];

// ---- federation census (#703): codes the census dimensions use, and the facts columns only census metrics carry
export const AGE_BANDS = { under_13: 'Under 13', '13_17': '13 to 17', '18_24': '18 to 24', '25_34': '25 to 34', '35_44': '35 to 44', '45_54': '45 to 54', '55_64': '55 to 64', '65_plus': '65 and over', unknown: 'Not stated' };
/** Gender is held only when the person chose to give it (person_demographics); `key` is what is stored (encrypted, with a blind index of `gender|key`). */
export const GENDERS = [{ key: 'female', label: 'Female' }, { key: 'male', label: 'Male' }, { key: 'non_binary', label: 'Non-binary' }, { key: 'self_described', label: 'Self-described' }];
export const STANDING_LABELS = { active: 'In good standing', suspended: 'Suspended', expired: 'Expired' };
const CENSUS_TYPES = { body_id: 'uuid', region: 'text', age_band: 'text', gender: 'text', status: 'text' };
const censusFact = (o) => `${fact(o)}, ${Object.entries(CENSUS_TYPES).map(([k, t]) => `${o[k] ?? 'NULL'}::${t} AS ${k}`).join(', ')}`;
/** Year of birth is kept coarse (users.birth_year), so an age band is the difference of years at the end of the period: never a decrypt, accurate to a year. */
const AGE_BAND_SQL = `CASE WHEN u.birth_year IS NULL THEN 'unknown' WHEN extract(year FROM $7::date) - u.birth_year < 13 THEN 'under_13' WHEN extract(year FROM $7::date) - u.birth_year < 18 THEN '13_17'
  WHEN extract(year FROM $7::date) - u.birth_year < 25 THEN '18_24' WHEN extract(year FROM $7::date) - u.birth_year < 35 THEN '25_34' WHEN extract(year FROM $7::date) - u.birth_year < 45 THEN '35_44'
  WHEN extract(year FROM $7::date) - u.birth_year < 55 THEN '45_54' WHEN extract(year FROM $7::date) - u.birth_year < 65 THEN '55_64' ELSE '65_plus' END`;
const CENSUS_FROM = `fed_licences l JOIN fed_licence_types t ON t.id=l.type_id JOIN governing_bodies gb ON gb.id=l.body_id JOIN users u ON u.id=l.holder_id
        LEFT JOIN fed_affiliations af ON af.id=l.affiliation_id LEFT JOIN person_demographics pd ON pd.user_id=u.id AND pd.withdrawn_at IS NULL`;
const CENSUS_COLS = (at, subject) => ({ rec_id: 'l.id::text', rec_kind: "'licence'", label: "'Licence'", at, subject, sport_id: 't.sport_id', org_id: 'af.organisation_id', body_id: 'l.body_id',
  region: "coalesce(gb.region, gb.state, gb.country, 'Not stated')", age_band: AGE_BAND_SQL, gender: "coalesce(pd.gender_idx, 'not_stated')", status: LIC_STATUS('l'), link_kind: "'Licence'", link_id: 'l.id' });
const HELD = "l.status IN ('active','suspended','expired')";   // a licence that was issued; drafts, rejections, withdrawals and revocations are never members
const CENSUS = { census: true, minCell: 5, scopes: ['federation', 'platform'], audience: 'ops', owner: 'Federation Governance', domain: 'Federation', pointInTime: false,
  drillScopes: [], drillNote: 'The census is an aggregate: it is read by body, region, club, sport, age band, gender and standing, never person by person. Use the licence register for individual records.',
  dimensions: ['body', 'region', 'sport', 'club', 'age_band', 'gender', 'status', 'month'] };

const CHANNEL = `CASE WHEN i.academy_charge_id IS NOT NULL THEN 'academy' WHEN i.team_charge_id IS NOT NULL THEN 'team' WHEN i.marketplace_engagement_id IS NOT NULL THEN 'marketplace'
  WHEN i.svc_order_id IS NOT NULL THEN 'services' WHEN i.pos_sale_id IS NOT NULL THEN 'pos' WHEN i.venue_id IS NOT NULL THEN 'venue_booking' ELSE 'other' END`;
const SPONSOR_DEAL = `FROM sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id
  LEFT JOIN events ev ON s.target_type='event' AND ev.id=s.target_id LEFT JOIN teams tm ON s.target_type='team' AND tm.id=s.target_id`;
const SPONSOR_RUNNING = "s.status IN ('active','paused','ended','term_expired','completed') AND s.accepted_version IS NOT NULL";
const SPONSOR_ATTRIB = { sport_id: 'coalesce(ev.sport_id, tm.sport_id)', event_id: 'ev.id', venue_id: 'ev.venue_id', team_id: 'tm.id', org_id: "CASE WHEN s.target_type='organisation' THEN s.target_id END", sponsor_id: 's.sponsor_id' };

/**
 * unit: count | money | percent.   aggregation: distinct_count (subject) | count | sum_money (per currency) | ratio (sum num / sum den, as a percentage).
 * scopes: which scope types can answer it (others are reported as not applicable, never as zero).
 * sources: the record kinds (rec_kind) the facts are read from, with a human name; freshness and "no records" are reported per source.
 * flags: data-quality codes the facts can raise, with the warning shown to the reader.
 */
export const METRICS = [
  {
    key: 'active_athletes', version: 1, label: 'Active athletes', domain: 'Participation', unit: 'count', aggregation: 'distinct_count', audience: 'ops',
    owner: 'Participation & Competition', scopes: ['platform', 'organisation', 'venue', 'event', 'team'], dimensions: ['sport', 'event', 'venue', 'team', 'month'],
    formula: 'Distinct athletes with at least one recorded appearance in the period: a participant of a game that was live or completed, or a match appearance (started, came on as a substitute). A name appearing twice counts once.',
    sources: [{ key: 'game_participation', label: 'Game participants (every sport)' }, { key: 'appearance', label: 'Match appearances' }],
    flags: {},
    drilldown: 'Athletes and the match behind each appearance',
    facts: () => `
      SELECT ${fact({ rec_id: 'gp.id::text', rec_kind: "'game_participation'", label: `${person('u')} || ' · ' || g.title`, at: 'g.starts_at', subject: 'gp.user_id::text', sport_id: 'g.sport_id', event_id: 'g.competition_id', venue_id: 'g.venue_id', team_id: 'gp.team_id', org_id: 'e.organisation_id', link_kind: "'Person'", link_id: 'gp.user_id' })}
        FROM game_participants gp JOIN games g ON g.id=gp.game_id JOIN users u ON u.id=gp.user_id LEFT JOIN events e ON e.id=g.competition_id
       WHERE g.status IN ('mid-event','post-event','intermission') AND ${inRange('g.starts_at')}
      UNION ALL
      SELECT ${fact({ rec_id: 'ma.id::text', rec_kind: "'appearance'", label: `${person('u')} || ' · ' || e.name`, at: 'coalesce(fx.scheduled_at, fx.started_at)', subject: 'ma.user_id::text', sport_id: 'e.sport_id', event_id: 'fx.event_id', venue_id: 'e.venue_id', team_id: 'ma.team_id', org_id: 'e.organisation_id', link_kind: "'Person'", link_id: 'ma.user_id' })}
        FROM match_appearances ma JOIN fixtures fx ON fx.id=ma.fixture_id JOIN events e ON e.id=fx.event_id JOIN users u ON u.id=ma.user_id
       WHERE ma.archived_at IS NULL AND ma.status IN ('started','substitute_on') AND ${inRange('coalesce(fx.scheduled_at, fx.started_at)')}`,
  },
  {
    key: 'registered_participants', version: 1, label: 'Registered participants', domain: 'Participation', unit: 'count', aggregation: 'distinct_count', audience: 'ops',
    owner: 'Competition Registration', scopes: ['platform', 'organisation', 'venue', 'event', 'team'], dimensions: ['sport', 'event', 'venue', 'team', 'month'],
    formula: 'Distinct people whose competition registration has status "registered" and was in effect on at least one day of the period (effective from/to; a registration with no start date counts from the day it was created). Submitted, under-review, rejected, withdrawn, suspended and expired registrations never count.',
    sources: [{ key: 'registration', label: 'Competition registrations' }],
    flags: { no_division: 'registered without a division' },
    drilldown: 'Registrations',
    facts: () => `
      SELECT ${fact({ rec_id: 'r.id::text', rec_kind: "'registration'", label: `${person('u')} || ' · ' || e.name`, at: 'coalesce(r.effective_from::timestamptz, r.created_at)', subject: 'r.user_id::text', sport_id: 'e.sport_id', event_id: 'r.event_id', venue_id: 'e.venue_id', team_id: 'r.team_id', org_id: 'e.organisation_id', flag: "CASE WHEN r.division_id IS NULL THEN 'no_division' END", link_kind: "'Event'", link_id: 'e.id' })}
        FROM reg_registrations r JOIN events e ON e.id=r.event_id JOIN users u ON u.id=r.user_id
       WHERE r.status='registered' AND coalesce(r.effective_from, r.created_at::date) <= $7::date AND (r.effective_to IS NULL OR r.effective_to >= ${FROM})`,
  },
  {
    key: 'matches_played', version: 1, label: 'Matches played', domain: 'Competition', unit: 'count', aggregation: 'distinct_count', audience: 'ops',
    owner: 'Participation & Competition', scopes: ['platform', 'organisation', 'venue', 'event', 'team'], dimensions: ['sport', 'event', 'venue', 'team', 'month'],
    formula: 'Distinct games, in any sport, whose status is "post-event" (completed) and that started in the period. Postponed, cancelled, forfeited, discarded and still-live games are not "played". A game with several teams counts once.',
    sources: [{ key: 'game', label: 'Games (every sport)' }],
    flags: { no_result: 'completed with no result recorded' },
    drilldown: 'Games',
    facts: () => `
      SELECT ${fact({ rec_id: 'g.id::text', rec_kind: "'game'", label: 'g.title', at: 'g.starts_at', subject: 'g.id::text', sport_id: 'g.sport_id', event_id: 'g.competition_id', venue_id: 'g.venue_id', team_id: 'gp.team_id', org_id: 'e.organisation_id',
        flag: "CASE WHEN NOT EXISTS (SELECT 1 FROM game_participants x WHERE x.game_id=g.id AND (x.outcome IS NOT NULL OR x.score IS NOT NULL)) THEN 'no_result' END", link_kind: "'OpenGame'", link_id: 'g.id' })}
        FROM games g LEFT JOIN (SELECT DISTINCT game_id, team_id FROM game_participants) gp ON gp.game_id=g.id LEFT JOIN events e ON e.id=g.competition_id
       WHERE g.status='post-event' AND ${inRange('g.starts_at')}`,
  },
  {
    key: 'attendees', version: 1, label: 'Attendees', domain: 'Participation', unit: 'count', aggregation: 'distinct_count', audience: 'ops',
    owner: 'Participation & Competition', scopes: ['platform', 'organisation', 'venue', 'event', 'team'], dimensions: ['sport', 'event', 'venue', 'team', 'month'],
    formula: 'Distinct (person, day) check-ins in the period: a venue booking checked in, an academy session marked "present", or a team training/match check-in. The same person on the same day counts once however many sources recorded them; a walk-in booking counts as its own attendee.',
    sources: [{ key: 'booking_checkin', label: 'Venue booking check-ins' }, { key: 'academy_attendance', label: 'Academy attendance' }, { key: 'team_checkin', label: 'Team check-ins' }],
    flags: {},
    drilldown: 'Check-ins',
    facts: () => `
      SELECT ${fact({ rec_id: 'b.id::text', rec_kind: "'booking_checkin'", label: `coalesce(${person('u')}, 'Walk-in') || ' · ' || rs.name`, at: 'b.checked_in_at', subject: "coalesce(b.user_id::text, b.id::text) || ':' || b.checked_in_at::date", sport_id: 'rs.sport_id', event_id: 'b.event_id', venue_id: 'rs.venue_id', team_id: 'b.team_id', link_kind: "'Reservation'", link_id: 'b.reservation_id' })}
        FROM bookings b JOIN resources rs ON rs.id=b.resource_id LEFT JOIN users u ON u.id=b.user_id
       WHERE b.checked_in_at IS NOT NULL AND ${inRange('b.checked_in_at')}
      UNION ALL
      SELECT ${fact({ rec_id: 'a.id::text', rec_kind: "'academy_attendance'", label: `${person('u')} || ' · ' || k.name`, at: 'a.session_date::timestamptz', subject: "a.user_id::text || ':' || a.session_date", team_id: 'k.team_id', org_id: 'k.organisation_id', link_kind: "'Org'", link_id: 'k.organisation_id' })}
        FROM org_attendance a JOIN org_cohorts k ON k.id=a.cohort_id JOIN users u ON u.id=a.user_id
       WHERE a.status='present' AND a.session_date BETWEEN ${FROM} AND $7::date
      UNION ALL
      SELECT ${fact({ rec_id: 'ta.id::text', rec_kind: "'team_checkin'", label: `${person('u')} || ' · ' || t.name`, at: 'ta.checked_in_at', subject: "ta.user_id::text || ':' || ta.checked_in_at::date", sport_id: 't.sport_id', event_id: 'ta.event_id', team_id: 'ta.team_id', org_id: 't.organisation_id', link_kind: "'Team'", link_id: 'ta.team_id' })}
        FROM team_attendance ta JOIN teams t ON t.id=ta.team_id JOIN users u ON u.id=ta.user_id
       WHERE ta.checked_in_at IS NOT NULL AND ${inRange('ta.checked_in_at')}`,
  },
  {
    key: 'revenue', version: 1, label: 'Revenue', domain: 'Finance', unit: 'money', aggregation: 'sum_money', audience: 'finance',
    owner: 'Finance', scopes: ['platform', 'organisation', 'venue', 'team'], dimensions: ['venue', 'team', 'channel', 'month'],
    formula: 'Paid invoices net of tax, minus credit notes, dated by the day the invoice was paid (the credit note by the day it was issued). Open and void invoices never count. Amounts stay in the invoice currency and are never added across currencies.',
    sources: [{ key: 'invoice', label: 'Invoices and credit notes' }],
    flags: { no_payment_date: 'paid but with no payment date (dated by issue date)' },
    drilldown: 'Invoices and credit notes',
    facts: () => `
      SELECT ${fact({ rec_id: 'i.id::text', rec_kind: "'invoice'", label: "i.number || CASE WHEN i.kind='credit_note' THEN ' (credit note)' ELSE '' END", at: "CASE WHEN i.kind='credit_note' THEN i.issued_at ELSE coalesce(i.paid_at, i.issued_at) END", subject: 'i.id::text', venue_id: 'i.venue_id', team_id: 'i.team_id', org_id: 'i.organisation_id', currency: 'i.currency',
        amount: "CASE WHEN i.kind='credit_note' THEN -(i.total_cents - i.tax_cents) ELSE (i.total_cents - i.tax_cents) END", channel: CHANNEL, flag: "CASE WHEN i.kind='invoice' AND i.paid_at IS NULL THEN 'no_payment_date' END", link_kind: "'Invoice'", link_id: 'i.id' })}
        FROM invoices i
       WHERE i.status='paid' AND ${inRange("CASE WHEN i.kind='credit_note' THEN i.issued_at ELSE coalesce(i.paid_at, i.issued_at) END")}`,
  },
  {
    key: 'receivable', version: 1, label: 'Receivable', domain: 'Finance', unit: 'money', aggregation: 'sum_money', audience: 'finance',
    owner: 'Finance', scopes: ['platform', 'organisation', 'venue', 'team'], dimensions: ['venue', 'team', 'channel', 'month'],
    formula: 'What is still owed today, raised in the period: open invoices (not credit notes) at their total minus credits already applied, plus academy fee charges and team dues that are awaiting payment at their amount minus what has been settled or adjusted. A charge that already has an invoice is counted once. Paid, waived, cancelled and void items are excluded. Per currency.',
    sources: [{ key: 'invoice', label: 'Open invoices' }, { key: 'academy_charge', label: 'Academy fee charges' }, { key: 'team_charge', label: 'Team dues' }],
    flags: { over_90_days: 'open for more than 90 days' },
    drilldown: 'Open invoices and unpaid charges',
    facts: () => `
      SELECT ${fact({ rec_id: 'i.id::text', rec_kind: "'invoice'", label: 'i.number', at: 'i.issued_at', subject: 'i.id::text', venue_id: 'i.venue_id', team_id: 'i.team_id', org_id: 'i.organisation_id', currency: 'i.currency', amount: 'i.total_cents - coalesce(i.credits_cents, 0)', channel: CHANNEL,
        flag: "CASE WHEN i.issued_at < now() - interval '90 days' THEN 'over_90_days' END", link_kind: "'Invoice'", link_id: 'i.id' })}
        FROM invoices i
       WHERE i.kind='invoice' AND i.status='open' AND i.academy_charge_id IS NULL AND i.team_charge_id IS NULL AND ${inRange('i.issued_at')}
      UNION ALL
      SELECT ${fact({ rec_id: 'ch.id::text', rec_kind: "'academy_charge'", label: "'Academy fee · due ' || ch.due_on", at: 'ch.created_at', subject: 'ch.id::text', org_id: 'ch.organisation_id', currency: 'ch.currency', amount: 'ch.amount_minor - ch.settled_minor - ch.adjusted_minor', channel: "'academy'",
        flag: "CASE WHEN ch.created_at < now() - interval '90 days' THEN 'over_90_days' END", link_kind: "'Org'", link_id: 'ch.organisation_id' })}
        FROM academy_charges ch
       WHERE ch.status='awaiting_payment' AND ch.amount_minor - ch.settled_minor - ch.adjusted_minor > 0 AND ${inRange('ch.created_at')}
      UNION ALL
      SELECT ${fact({ rec_id: 'tc.id::text', rec_kind: "'team_charge'", label: "tb.title || ' · due ' || tc.due_on", at: 'tc.created_at', subject: 'tc.id::text', team_id: 'tc.team_id', currency: 'tb.currency', amount: 'tc.amount_minor - tc.settled_minor - tc.adjusted_minor', channel: "'team'",
        flag: "CASE WHEN tc.created_at < now() - interval '90 days' THEN 'over_90_days' END", link_kind: "'Team'", link_id: 'tc.team_id' })}
        FROM team_charges tc JOIN team_charge_batches tb ON tb.id=tc.batch_id
       WHERE tc.status='awaiting_payment' AND tc.amount_minor - tc.settled_minor - tc.adjusted_minor > 0 AND ${inRange('tc.created_at')}`,
  },
  {
    key: 'sponsor_value', version: 1, label: 'Sponsor value received', domain: 'Sponsorship', unit: 'money', aggregation: 'sum_money', audience: 'finance',
    owner: 'Sponsorship', scopes: ['platform', 'organisation', 'venue', 'event', 'team', 'sponsor'], dimensions: ['sport', 'event', 'venue', 'team', 'month'],
    formula: 'Confirmed sponsorship cash payments, net of refunds, dated by the day the payment was made, on agreements that are running or have run. Reported-but-unconfirmed, rejected and reversed payments never count; goods and endorsements are estimates and are never cash. Per currency.',
    sources: [{ key: 'sponsorship_payment', label: 'Sponsorship payments' }],
    flags: {},
    drilldown: 'Confirmed payments',
    facts: () => `
      SELECT ${fact({ ...SPONSOR_ATTRIB, rec_id: 'p.id::text', rec_kind: "'sponsorship_payment'", label: "sp.name || ' · ' || coalesce(p.reference, 'payment')", at: 'p.paid_on::timestamptz', subject: 'p.id::text', currency: 'p.currency', amount: 'p.amount_cents - coalesce(p.refunded_cents, 0)', link_kind: "'SponsorDeal'", link_id: 's.id' })}
        ${SPONSOR_DEAL} JOIN sponsorship_obligations o ON o.sponsorship_id=s.id JOIN sponsorship_payments p ON p.obligation_id=o.id
       WHERE p.status='confirmed' AND ${SPONSOR_RUNNING} AND p.paid_on BETWEEN ${FROM} AND $7::date`,
  },
  {
    key: 'sponsor_fulfilment', version: 1, label: 'Sponsor fulfilment', domain: 'Sponsorship', unit: 'percent', aggregation: 'ratio', audience: 'ops',
    owner: 'Sponsorship', scopes: ['platform', 'organisation', 'venue', 'event', 'team', 'sponsor'], dimensions: ['sport', 'event', 'venue', 'team', 'month'],
    formula: 'Of the sponsorship deliverables that fall due in the period (cancelled and formally excepted ones removed), the share the sponsor has reviewed and accepted. Submitted-but-unreviewed and sent-back-for-rework deliverables are not fulfilled.',
    sources: [{ key: 'deliverable', label: 'Sponsorship deliverables' }],
    flags: { overdue: 'past due and not yet delivered' },
    drilldown: 'Deliverables',
    facts: () => `
      SELECT ${fact({ ...SPONSOR_ATTRIB, rec_id: 'd.id::text', rec_kind: "'deliverable'", label: "sp.name || ' · ' || d.title", at: 'd.due_on::timestamptz', subject: 'd.id::text', num: "(d.status='accepted')::int", den: '1',
        flag: "CASE WHEN d.due_on < current_date AND d.status IN ('planned','rework') THEN 'overdue' END", link_kind: "'SponsorDeal'", link_id: 's.id' })}
        ${SPONSOR_DEAL} JOIN sponsorship_deliverables d ON d.sponsorship_id=s.id
       WHERE d.status NOT IN ('cancelled','excepted') AND ${SPONSOR_RUNNING} AND d.due_on BETWEEN ${FROM} AND $7::date`,
  },
  {
    key: 'venue_utilisation', version: 1, label: 'Venue utilisation', domain: 'Venues', unit: 'percent', aggregation: 'ratio', audience: 'ops',
    owner: 'Venue Operations', scopes: ['platform', 'organisation', 'venue'], dimensions: ['sport', 'venue', 'month'],
    formula: 'Confirmed booked minutes divided by bookable minutes for active courts/pitches/resources over the period. Bookable minutes are the venue\'s published opening hours for each day in the venue\'s own time zone; a booking is clipped to the period. Cancelled and no-show bookings are not utilisation, and resources whose venue has no opening hours are left out (and flagged) rather than counted as 0%.',
    sources: [{ key: 'resource', label: 'Venue resources and bookings' }],
    flags: { no_opening_hours: 'has no opening hours, so it is left out' },
    drilldown: 'Resources with booked and bookable minutes',
    facts: () => `
      SELECT ${fact({ rec_id: 'rs.id::text', rec_kind: "'resource'", label: "v.name || ' · ' || rs.name", at: `${TO_EXCL}::timestamptz`, subject: 'rs.id::text', sport_id: 'rs.sport_id', venue_id: 'rs.venue_id', org_id: 'v.organisation_id',
        num: 'LEAST(bk.booked_min, op.open_min)', den: 'op.open_min', flag: "CASE WHEN op.open_min = 0 THEN 'no_opening_hours' END", link_kind: "'Venue'", link_id: 'v.id' })}
        FROM resources rs JOIN venues v ON v.id=rs.venue_id
        CROSS JOIN LATERAL (SELECT coalesce(sum(vh.closes_min - vh.opens_min), 0)::numeric AS open_min
                              FROM generate_series(${FROM}, $7::date, interval '1 day') d
                              JOIN venue_hours vh ON vh.venue_id=rs.venue_id AND vh.removed_at IS NULL AND vh.weekday = extract(dow FROM d)::int) op
        CROSS JOIN LATERAL (SELECT coalesce(sum(extract(epoch FROM (LEAST(b.ends_at, (${TO_EXCL}::timestamp AT TIME ZONE coalesce(v.timezone, 'UTC'))) - GREATEST(b.starts_at, (${FROM}::timestamp AT TIME ZONE coalesce(v.timezone, 'UTC'))))) / 60), 0)::numeric AS booked_min
                              FROM bookings b WHERE b.resource_id=rs.id AND b.status='confirmed'
                               AND b.starts_at < (${TO_EXCL}::timestamp AT TIME ZONE coalesce(v.timezone, 'UTC')) AND b.ends_at > (${FROM}::timestamp AT TIME ZONE coalesce(v.timezone, 'UTC'))) bk
       WHERE rs.active AND v.active`,
  },
  {
    key: 'athlete_availability', version: 1, label: 'Athlete availability', domain: 'Athletes', unit: 'percent', aggregation: 'ratio', audience: 'squad', pointInTime: true,
    owner: 'Team Management', scopes: ['platform', 'organisation', 'team'], dimensions: ['sport', 'team'],
    formula: 'Of the active players and captains on non-archived squads, the share whose availability is "available" right now. Tentative, unavailable and injured count as not available. It is the squad\'s own availability status only: no clinical record, clearance or injury detail is read, and the period filter does not apply. Groups of fewer than 5 athletes are hidden outside a team you manage.',
    sources: [{ key: 'squad_member', label: 'Squad availability' }],
    flags: {},
    drilldown: 'Squad members and their availability (only inside a team you manage)',
    minGroup: 5,
    drillScopes: ['team'],
    facts: () => `
      SELECT ${fact({ rec_id: "(m.team_id::text || ':' || m.user_id::text)", rec_kind: "'squad_member'", label: `${person('u')} || ' · ' || m.availability`, at: 'coalesce(m.availability_set_at, m.joined_at)', subject: 'm.user_id::text', sport_id: 't.sport_id', event_id: 't.event_id', team_id: 't.id', org_id: 't.organisation_id',
        num: "(m.availability = 'available')::int", den: '1', link_kind: "'Person'", link_id: 'm.user_id' })}
        FROM team_members m JOIN teams t ON t.id=m.team_id AND t.archived_at IS NULL JOIN users u ON u.id=m.user_id
       WHERE m.status='active' AND m.role IN ('player','captain')`,
  },
  {
    ...CENSUS, key: 'members', version: 1, label: 'Federation members', unit: 'count', aggregation: 'distinct_count',
    formula: 'Distinct people holding a federation licence that was in force on at least one day of the period: issued on or before the end, expiring on or after the start, and not revoked, rejected or withdrawn. A person with several licences counts once. Region is the issuing body\'s region; the age band is the year difference to the end of the period; gender is only counted for people who chose to give it. Counts below 5 are hidden.',
    sources: [{ key: 'licence', label: 'Federation licences' }], flags: {},
    drilldown: 'Aggregate only: split by body, region, sport, club, age band, gender and standing',
    facts: () => `
      SELECT ${censusFact(CENSUS_COLS('l.issued_on::timestamptz', 'l.holder_id::text'))}
        FROM ${CENSUS_FROM}
       WHERE ${HELD} AND l.issued_on <= $7::date AND l.expires_on >= $6::date`,
  },
  {
    ...CENSUS, key: 'new_members', version: 1, label: 'New federation members', unit: 'count', aggregation: 'distinct_count',
    formula: 'Distinct people whose first licence with the issuing body was issued in the period (a renewal, or a person who held a licence with that body before, is not new). Grouped by month this is the membership growth. Counts below 5 are hidden.',
    sources: [{ key: 'licence', label: 'Federation licences' }], flags: {},
    drilldown: 'Aggregate only: split by body, region, sport, club, age band, gender and month',
    facts: () => `
      SELECT ${censusFact(CENSUS_COLS('l.issued_on::timestamptz', 'l.holder_id::text'))}
        FROM ${CENSUS_FROM}
       WHERE ${HELD} AND l.issued_on BETWEEN $6::date AND $7::date
         AND NOT EXISTS (SELECT 1 FROM fed_licences p WHERE p.body_id=l.body_id AND p.holder_id=l.holder_id AND p.id <> l.id AND p.issued_on < l.issued_on AND p.status IN ('active','suspended','expired','revoked'))`,
  },
  {
    ...CENSUS, key: 'licence_renewals', version: 1, label: 'Licence renewals', unit: 'count', aggregation: 'distinct_count',
    formula: 'Licences issued in the period as the renewal of an earlier licence (they point at the licence they renew). Counts below 5 are hidden.',
    sources: [{ key: 'licence', label: 'Federation licences' }], flags: {},
    drilldown: 'Aggregate only: split by body, region, sport, club, age band, gender and month',
    facts: () => `
      SELECT ${censusFact(CENSUS_COLS('l.issued_on::timestamptz', 'l.id::text'))}
        FROM ${CENSUS_FROM}
       WHERE ${HELD} AND l.previous_id IS NOT NULL AND l.issued_on BETWEEN $6::date AND $7::date`,
  },
  {
    ...CENSUS, key: 'renewal_rate', version: 1, label: 'Licence renewal rate', unit: 'percent', aggregation: 'ratio',
    formula: 'Of the licences that ran out in the period (expiry date in the period; revoked ones are not a lapse), the share that have been renewed by a later licence. A licence still inside its renewal notice period counts as not renewed yet. Groups of fewer than 5 licences are hidden.',
    sources: [{ key: 'licence', label: 'Federation licences' }], flags: {}, minGroup: 5, minCell: undefined,
    drilldown: 'Aggregate only: split by body, region, sport, club, age band, gender and month',
    facts: () => `
      SELECT ${censusFact({ ...CENSUS_COLS('l.expires_on::timestamptz', 'l.id::text'), num: "(EXISTS (SELECT 1 FROM fed_licences n WHERE n.previous_id=l.id AND n.status IN ('active','suspended','expired')))::int", den: '1' })}
        FROM ${CENSUS_FROM}
       WHERE ${HELD} AND l.expires_on BETWEEN $6::date AND $7::date`,
  },
];

export const byKey = (key) => METRICS.find((m) => m.key === key);

/** The public, serialisable form of a definition (no SQL). */
export function describeMetric(m) {
  return { key: m.key, version: m.version, label: m.label, domain: m.domain, unit: m.unit, aggregation: m.aggregation, formula: m.formula, owner: m.owner, audience: m.audience, scopes: m.scopes, dimensions: m.dimensions,
    point_in_time: !!m.pointInTime, provenance: m.sources, quality_checks: Object.entries(m.flags).map(([code, text]) => ({ code, text })), drilldown: m.drilldown, definition_hash: hashOf(m) };
}

/** Hash of everything that changes what a number means (the formula text, the SQL and the shape); a change forces a version bump. */
export function hashOf(m) {
  return createHash('sha256').update(JSON.stringify([m.key, m.unit, m.aggregation, m.formula, m.dimensions, m.scopes, m.sources, m.flags, m.pointInTime ?? false, m.minGroup ?? 0, ...(m.minCell ? [m.minCell] : []), m.facts()])).digest('hex');
}
