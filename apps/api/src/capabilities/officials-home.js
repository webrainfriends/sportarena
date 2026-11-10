// Officials Home (#88): the match official's own operating view over the canonical assignment, fixture, verification and licence data.
// Nothing here copies fixtures into a second calendar: every entry carries source_type + source_id and is read live. Availability is the
// one new thing an official owns; it lives in officials-availability.js (#994) and the server enforces it in assertOfficialEligible.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, pool } from '../db.js';
import { badRequest } from '../errors.js';
import { ASSIGNMENT_SQL, OFFICIAL_ROLES, credentialFor } from '../officials.js';
import { BLOCK_KINDS, loadAvailability, expandBlocks, withinHours, bufferMs, localDate, noteOf } from '../official-availability.js';
import { ACTIVE } from '../cases.js';
import { checklistFor } from '../officials-checklist.js';

const TAG = 'Officials';
const DAY = 864e5;
const dt = z.string().datetime({ offset: true });
const STATUSES = ['invited', 'accepted', 'declined', 'withdrawn', 'released', 'cancelled', 'completed'];
const OPEN_FIXTURE = ['scheduled', 'live', 'paused'];
const myAssignments = (userId, where = 'TRUE', args = [], tail = 'ORDER BY x.scheduled_at, x.id') =>
  many(`SELECT x.* FROM (${ASSIGNMENT_SQL} WHERE fo.user_id=$1) x WHERE ${where} ${tail}`, [userId, ...args]);

/**
 * Where an official stands on getting ready to be asked and paid: public profile, rate cards, payout account, tax profile and verification.
 * Each step reads the record its own capability owns (nothing is stored here), so this can never disagree with those screens.
 */
async function setupFor(userId, credential) {
  const profile = await one('SELECT status, step_reached FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL', [userId]);
  const rates = await one("SELECT count(*) FILTER (WHERE r.status='active')::int AS active, count(*) FILTER (WHERE r.status='draft')::int AS draft FROM official_profile_rates r JOIN official_profiles p ON p.id=r.profile_id WHERE p.user_id=$1 AND p.archived_at IS NULL AND r.archived_at IS NULL", [userId]);
  const payout = await one("SELECT status FROM payout_accounts WHERE owner_id=$1 AND status IN ('pending','verified') ORDER BY (status='verified') DESC, created_at DESC LIMIT 1", [userId]);
  const tax = await one('SELECT 1 AS ok FROM official_tax_profiles WHERE user_id=$1 LIMIT 1', [userId]);
  const steps = [
    { key: 'profile', state: profile?.status === 'published' ? 'done' : profile ? 'in_progress' : 'todo', progress: profile ? Math.min(100, Math.round((profile.step_reached / 9) * 100)) : 0 },
    { key: 'rates', state: rates?.active ? 'done' : rates?.draft ? 'in_progress' : 'todo', count: rates?.active ?? 0, drafts: rates?.draft ?? 0 },
    { key: 'payout', state: payout?.status === 'verified' ? 'done' : payout ? 'in_progress' : 'todo' },
    { key: 'tax', state: tax ? 'done' : 'todo' },
    { key: 'verification', state: credential.state === 'verified' ? 'done' : ['pending', 'expiring'].includes(credential.state) ? 'in_progress' : 'todo', credential: credential.state },
  ];
  return { steps, done: steps.filter((x) => x.state === 'done').length, total: steps.length, next: steps.find((x) => x.state !== 'done')?.key ?? null };
}

/** Credential state for one sport: what the public sees (self-declared / verified / expiring / expired / revoked) plus the federation licence behind the grade. */
async function credentialState(userId, sportId) {
  const cred = await credentialFor(pool, userId, sportId);
  const last = await one(`SELECT status, expires_at, decided_at, decision_reason FROM verification_cases WHERE type='referee' AND subject_type='user' AND subject_id=$1 AND (sport_id IS NULL OR sport_id=$2) ORDER BY submitted_at DESC LIMIT 1`, [userId, sportId]);
  let state = 'self_declared';
  if (last?.status === 'approved') state = last.expires_at > new Date() ? (last.expires_at < new Date(Date.now() + 30 * DAY) ? 'expiring' : 'verified') : 'expired';
  else if (last?.status === 'revoked') state = 'revoked';
  else if (['submitted', 'in_review', 'needs_info'].includes(last?.status)) state = 'pending';
  else if (last?.status === 'rejected') state = 'rejected';
  return { state, verification: last ? { status: last.status, expires_at: last.expires_at, decided_at: last.decided_at } : null, licence: cred?.licence ?? null };
}

// ------------------------------------------------------------------ home
cap({
  name: 'get_officials_home', method: 'GET', path: '/me/officials/home', tag: TAG,
  summary: 'The match official\'s home: today\'s matches, pending requests, the next assignment, this season\'s count, credential state and an action inbox (invitations, changed times, released, pre-match checks, reports due, disputes to answer).',
  input: z.object({ sport_id: id.optional() }),
  async handler({ user }, i) {
    const sports = await many(
      `SELECT s.id, s.slug, s.name, s.emoji, p.is_default FROM active_sport_profiles p JOIN sports s ON s.id=p.sport_id WHERE p.user_id=$1 AND p.role='referee' ORDER BY p.is_default DESC, s.name`, [user.id]);
    const sport = sports.find((s) => s.id === i.sport_id) ?? sports[0] ?? null;
    const all = await myAssignments(user.id, i.sport_id ? 'x.sport_id=$2' : 'TRUE', i.sport_id ? [i.sport_id] : []);
    const now = Date.now(), live = (a) => OPEN_FIXTURE.includes(a.fixture_status);
    const startMs = (a) => new Date(a.scheduled_at).getTime(), endMs = (a) => startMs(a) + a.duration_min * 60000;
    const confirmed = all.filter((a) => a.status === 'accepted' && live(a) && endMs(a) >= now);
    const pending = all.filter((a) => a.status === 'invited' && live(a) && endMs(a) >= now);
    const dayKey = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(new Date(iso));
    const prefs = await one('SELECT * FROM official_prefs WHERE user_id=$1', [user.id]);
    const tz = prefs?.timezone ?? 'UTC';
    const today = confirmed.filter((a) => dayKey(a.scheduled_at, tz) === dayKey(new Date(), tz));
    const weekEnd = now + 7 * DAY;
    const seasonStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString();
    const completed = all.filter((a) => a.status === 'completed' && new Date(a.scheduled_at) >= new Date(seasonStart));

    // action inbox: every item points at the canonical record it concerns
    const inbox = [];
    for (const a of pending) inbox.push({ kind: 'invitation', fixture_id: a.fixture_id, official_id: a.id, title: `Officiating request: ${a.event_name}`, detail: `${a.role} · ${a.home_name ?? 'TBD'} v ${a.away_name ?? 'TBD'}`, at: a.scheduled_at });
    for (const a of confirmed.filter((x) => x.needs_ack)) inbox.push({ kind: 'changed', fixture_id: a.fixture_id, official_id: a.id, title: `Match changed: ${a.event_name}`, detail: 'The time or venue changed. Acknowledge to stay on the crew.', at: a.scheduled_at });
    const lost = await many(
      `SELECT h.fixture_official_id AS id, h.to_status, h.reason, h.at, x.fixture_id, x.event_name, x.role FROM fixture_official_history h
         JOIN (${ASSIGNMENT_SQL} WHERE fo.user_id=$1) x ON x.id=h.fixture_official_id
        WHERE h.to_status IN ('released','cancelled') AND h.at > now() - interval '14 days' AND h.actor_id IS DISTINCT FROM $1 ORDER BY h.at DESC LIMIT 10`, [user.id]);
    for (const l of lost) inbox.push({ kind: 'released', fixture_id: l.fixture_id, official_id: l.id, title: `${l.to_status === 'cancelled' ? 'Match cancelled' : 'Released'}: ${l.event_name}`, detail: l.reason ?? '', at: l.at });
    for (const a of confirmed.filter((x) => startMs(x) < now + 2 * DAY)) {
      const items = await checklistFor(a.fixture_id, a.sport_slug);
      const left = items.filter((it) => !it.done).length;
      if (left) inbox.push({ kind: 'checklist', fixture_id: a.fixture_id, official_id: a.id, title: `Pre-match checks: ${a.event_name}`, detail: `${left} of ${items.length} still to tick`, at: a.scheduled_at });
    }
    const due = await myAssignments(user.id,
      `x.status='completed' AND x.role IN ('referee','umpire') AND x.scheduled_at > now() - interval '14 days' AND NOT EXISTS (SELECT 1 FROM official_reports r WHERE r.fixture_id=x.fixture_id AND r.author_id=$2 AND r.category='match_report')`, [user.id]);
    for (const a of due) inbox.push({ kind: 'report_due', fixture_id: a.fixture_id, official_id: a.id, title: `Match report due: ${a.event_name}`, detail: `${a.home_name ?? ''} v ${a.away_name ?? ''}`, at: a.scheduled_at });
    const disputes = await many(
      `SELECT DISTINCT c.id, c.case_no, c.subject, c.created_at, c.resolution_due, l.entity_id AS fixture_id FROM cases c JOIN case_links l ON l.case_id=c.id AND l.entity_type='fixture'
         JOIN fixtures f ON f.id=l.entity_id
        WHERE c.routed_to='game_officials' AND c.requester_id <> $1 AND c.status = ANY($2)
          AND (f.referee_id=$1 OR EXISTS (SELECT 1 FROM fixture_officials fo WHERE fo.fixture_id=f.id AND fo.user_id=$1 AND fo.status='accepted'))
        ORDER BY c.created_at LIMIT 10`, [user.id, ACTIVE]);
    for (const d of disputes) inbox.push({ kind: 'dispute', fixture_id: d.fixture_id, case_id: d.id, title: `Result dispute #${d.case_no}`, detail: d.subject, at: d.resolution_due ?? d.created_at });

    const credential = sport ? await credentialState(user.id, sport.id) : { state: 'none', verification: null, licence: null };
    if (['expiring', 'expired'].includes(credential.state)) inbox.push({ kind: 'credential', title: credential.state === 'expired' ? 'Your official badge has expired' : 'Your official badge expires soon', detail: 'Renew your verification so you stay eligible for assignments.', at: credential.verification?.expires_at });
    if (credential.licence && new Date(credential.licence.expires_on) < new Date(now + 30 * DAY)) inbox.push({ kind: 'credential', title: 'Your federation licence is ending', detail: `${credential.licence.licence_type} ends ${credential.licence.expires_on.toISOString?.().slice(0, 10) ?? credential.licence.expires_on}`, at: credential.licence.expires_on });

    return {
      user_id: user.id,
      sports, sport, timezone: tz, credential, setup: await setupFor(user.id, credential),
      next: confirmed[0] ?? null, today, pending_requests: pending,
      stats: { this_week: confirmed.filter((a) => startMs(a) < weekEnd).length, pending: pending.length, completed_this_season: completed.length, actions: inbox.length },
      inbox: inbox.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? ''))),
    };
  },
});

// ------------------------------------------------------------------ calendar
cap({
  name: 'get_official_calendar', method: 'GET', path: '/me/officials/calendar', tag: TAG,
  summary: 'My officiating calendar for a date range (up to 62 days): confirmed matches (a reserved slot), requests I have not answered (a tentative hold), time off of every kind (one-off, repeating, public holidays), extra open windows and dispute deadlines, each pointing at its source record. Flags clashes (including my buffer), matches on time off and matches outside my hours; gives the venue\'s timezone when it differs from mine, and a per-day load summary in my timezone.',
  input: z.object({ from: dt, to: dt, sport_id: id.optional(), role: z.enum(OFFICIAL_ROLES).optional(), status: z.enum(STATUSES).optional() }),
  async handler({ user }, i) {
    const from = new Date(i.from), to = new Date(i.to);
    if (!(to > from)) throw badRequest('to must be after from');
    if (to - from > 62 * DAY) throw badRequest('Ask for at most 62 days at a time');
    const { prefs, rows: avail } = await loadAvailability(pool, user.id);
    const tz = prefs.timezone;
    const off = expandBlocks(avail.filter((r) => BLOCK_KINDS.includes(r.kind)), from.getTime(), to.getTime(), tz);
    const byId = Object.fromEntries(avail.map((r) => [r.id, r]));
    const rows = await myAssignments(user.id, `x.scheduled_at < $2 AND x.scheduled_at + x.duration_min * interval '1 minute' > $3 AND x.status IN ('invited','accepted','completed') AND ($4::uuid IS NULL OR x.sport_id=$4) AND ($5::text IS NULL OR x.role=$5) AND ($6::text IS NULL OR x.status=$6)`,
      [to, from, i.sport_id ?? null, i.role ?? null, i.status ?? null]);
    const span = (a) => [new Date(a.scheduled_at).getTime(), new Date(a.scheduled_at).getTime() + a.duration_min * 60000];
    const gap = (a, b) => bufferMs(prefs, a.venue_id, b.venue_id);
    const entries = rows.map((a) => {
      const [s, e] = span(a);
      const clashes = rows.filter((b) => b.id !== a.id && b.fixture_id !== a.fixture_id && b.status !== 'completed' && a.status !== 'completed' && (a.status === 'accepted' || b.status === 'accepted') && (() => { const [bs, be] = span(b); const g = gap(a, b); return bs < e + g && be > s - g; })()).map((b) => b.id);
      const rivals = a.status === 'invited' ? rows.filter((b) => b.id !== a.id && b.fixture_id !== a.fixture_id && b.status === 'invited' && (() => { const [bs, be] = span(b); return bs < e && be > s; })()).map((b) => b.id) : [];
      const blocked = [...new Set(off.filter((o) => o.startMs < e && o.endMs > s).map((o) => o.id))];
      const inside = withinHours(avail, s, a.duration_min, tz);
      return {
        source_type: 'fixture_official', source_id: a.id, fixture_id: a.fixture_id, kind: 'assignment', status: a.status, role: a.role, needs_ack: a.needs_ack,
        hold: a.status === 'accepted' ? 'reserved' : a.status === 'invited' ? 'tentative' : null,
        locked_at: a.locked_at ?? null, reporting_min: a.reporting_min ?? 0,
        starts_at: a.scheduled_at, ends_at: new Date(e).toISOString(), local_date: localDate(s, tz), title: `${a.home_name ?? 'TBD'} v ${a.away_name ?? 'TBD'}`, subtitle: a.event_name,
        sport: { id: a.sport_id, slug: a.sport_slug, name: a.sport_name, emoji: a.sport_emoji }, venue: a.resource_name ?? a.venue_name ?? null,
        venue_timezone: a.venue_timezone && a.venue_timezone !== tz ? a.venue_timezone : null,
        clash_with: clashes, rival_requests: rivals, unavailable_with: blocked, outside_availability: inside === false && !blocked.length,
      };
    });
    for (const o of off) {
      const r = byId[o.id];
      entries.push({
        source_type: 'official_availability', source_id: o.id, kind: o.kind === 'holiday' ? 'holiday' : 'time_off', status: 'blocked', repeats: o.kind === 'recurring', occurrence: o.date, all_day: o.all_day, category: o.category,
        starts_at: new Date(o.startMs).toISOString(), ends_at: new Date(o.endMs).toISOString(), local_date: localDate(o.startMs, tz), title: o.kind === 'holiday' ? (o.label ?? 'Public holiday') : 'Unavailable', subtitle: o.kind === 'holiday' ? null : noteOf(r),
      });
    }
    for (const r of avail.filter((x) => x.kind === 'available' && new Date(x.starts_at) < to && new Date(x.ends_at) > from)) entries.push({ source_type: 'official_availability', source_id: r.id, kind: 'open_window', status: 'open', starts_at: new Date(r.starts_at).toISOString(), ends_at: new Date(r.ends_at).toISOString(), local_date: localDate(new Date(r.starts_at).getTime(), tz), title: 'Extra availability', subtitle: null });
    const deadlines = await many(
      `SELECT DISTINCT c.id, c.case_no, c.subject, c.resolution_due, l.entity_id AS fixture_id FROM cases c JOIN case_links l ON l.case_id=c.id AND l.entity_type='fixture' JOIN fixtures f ON f.id=l.entity_id
        WHERE c.routed_to='game_officials' AND c.requester_id <> $1 AND c.status = ANY($2) AND c.resolution_due >= $3 AND c.resolution_due < $4
          AND (f.referee_id=$1 OR EXISTS (SELECT 1 FROM fixture_officials fo WHERE fo.fixture_id=f.id AND fo.user_id=$1 AND fo.status='accepted'))`, [user.id, ACTIVE, from, to]);
    for (const d of deadlines) entries.push({ source_type: 'case', source_id: d.id, fixture_id: d.fixture_id, kind: 'deadline', status: 'open', starts_at: d.resolution_due, ends_at: d.resolution_due, local_date: localDate(new Date(d.resolution_due).getTime(), tz), title: `Dispute #${d.case_no} due`, subtitle: d.subject });
    entries.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at) || String(a.source_id).localeCompare(String(b.source_id)));
    const days = {};
    for (const e of entries) {
      const d = (days[e.local_date] ??= { date: e.local_date, reserved: 0, tentative: 0, blocked: 0, conflicts: 0 });
      if (e.hold === 'reserved') d.reserved++; else if (e.hold === 'tentative') d.tentative++; else if (e.kind === 'time_off' || e.kind === 'holiday') d.blocked++;
      if (e.clash_with?.length || e.unavailable_with?.length) d.conflicts++;
    }
    return {
      timezone: tz, from: from.toISOString(), to: to.toISOString(), buffer_min: prefs.buffer_min ?? 0, buffer_same_venue_min: prefs.buffer_same_venue_min ?? null, entries,
      days: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)),
      totals: { reserved: entries.filter((e) => e.hold === 'reserved').length, tentative: entries.filter((e) => e.hold === 'tentative').length, blocked: entries.filter((e) => e.kind === 'time_off' || e.kind === 'holiday').length },
      conflicts: entries.filter((e) => e.clash_with?.length || e.unavailable_with?.length).length,
    };
  },
});

// ------------------------------------------------------------------ history
cap({
  name: 'list_my_officiating_history', method: 'GET', path: '/me/officials/history', tag: TAG,
  summary: 'My officiating record, derived from the canonical assignments: matches officiated, role, sport, status, whether I held a verified-official badge at the time, reports I filed and disputes linked to the match. No scores, ratings or rankings of officials.',
  input: z.object({ sport_id: id.optional(), role: z.enum(['referee', 'umpire', 'linesman', 'scorer']).optional(), status: z.enum(['completed', 'cancelled', 'released', 'withdrawn', 'declined']).optional(), from: dt.optional(), to: dt.optional(), ...page }),
  async handler({ user }, i) {
    const where = `x.status IN ('completed','cancelled','released','withdrawn','declined') AND ($2::uuid IS NULL OR x.sport_id=$2) AND ($3::text IS NULL OR x.role=$3) AND ($4::text IS NULL OR x.status=$4) AND ($5::timestamptz IS NULL OR x.scheduled_at >= $5) AND ($6::timestamptz IS NULL OR x.scheduled_at < $6)`;
    const args = [i.sport_id ?? null, i.role ?? null, i.status ?? null, i.from ?? null, i.to ?? null];
    const items = await myAssignments(user.id, where, args, `ORDER BY x.scheduled_at DESC, x.id LIMIT ${i.limit} OFFSET ${i.offset}`);
    const out = [];
    for (const a of items) {
      const [rep, disp, ver] = await Promise.all([
        one("SELECT count(*)::int AS n FROM official_reports WHERE fixture_id=$1 AND author_id=$2", [a.fixture_id, user.id]),
        one("SELECT count(DISTINCT c.id)::int AS n FROM cases c JOIN case_links l ON l.case_id=c.id AND l.entity_type='fixture' WHERE l.entity_id=$1 AND c.routed_to='game_officials'", [a.fixture_id]),
        one("SELECT EXISTS (SELECT 1 FROM verification_cases WHERE type='referee' AND subject_type='user' AND subject_id=$1 AND status IN ('approved','revoked') AND decided_at <= $2 AND expires_at >= $2 AND (sport_id IS NULL OR sport_id=$3)) AS held", [user.id, a.scheduled_at, a.sport_id]),
      ]);
      out.push({ ...a, reports_filed: rep.n, disputes_linked: disp.n, verified_at_the_time: ver.held });
    }
    const totals = await many(`SELECT x.sport_name, x.role, count(*)::int AS matches FROM (${ASSIGNMENT_SQL} WHERE fo.user_id=$1) x WHERE x.status='completed' GROUP BY x.sport_name, x.role ORDER BY x.sport_name, x.role`, [user.id]);
    return { items: out, totals };
  },
});
