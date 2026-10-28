// Officials Home (#88): the match official's own operating view over the canonical assignment, fixture, verification and licence data.
// Nothing here copies fixtures into a second calendar: every entry carries source_type + source_id and is read live. Availability is the
// one new thing an official owns (weekly windows, time off, travel buffer); the server enforces it in assertOfficialEligible.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { ASSIGNMENT_SQL, credentialFor } from '../officials.js';
import { ACTIVE } from '../cases.js';
import { checklistFor } from '../officials-checklist.js';

const TAG = 'Officials';
const DAY = 864e5;
const dt = z.string().datetime({ offset: true });
const STATUSES = ['invited', 'accepted', 'declined', 'withdrawn', 'released', 'cancelled', 'completed'];
const OPEN_FIXTURE = ['scheduled', 'live', 'paused'];
const validZone = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

/** Minutes since local midnight and weekday (0 = Sunday) of an instant in an IANA zone. */
export function localParts(iso, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), minute: Number(p.hour) * 60 + Number(p.minute) };
}

const myAssignments = (userId, where = 'TRUE', args = [], tail = 'ORDER BY x.scheduled_at, x.id') =>
  many(`SELECT x.* FROM (${ASSIGNMENT_SQL} WHERE fo.user_id=$1) x WHERE ${where} ${tail}`, [userId, ...args]);

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
      sports, sport, timezone: tz, credential,
      next: confirmed[0] ?? null, today, pending_requests: pending,
      stats: { this_week: confirmed.filter((a) => startMs(a) < weekEnd).length, pending: pending.length, completed_this_season: completed.length, actions: inbox.length },
      inbox: inbox.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? ''))),
    };
  },
});

// ------------------------------------------------------------------ calendar
cap({
  name: 'get_official_calendar', method: 'GET', path: '/me/officials/calendar', tag: TAG,
  summary: 'My officiating calendar for a date range (up to 62 days): confirmed and pending assignments, time off and dispute deadlines, each pointing at its source record, with clash and outside-availability flags.',
  input: z.object({ from: dt, to: dt, sport_id: id.optional(), role: z.enum(['referee', 'umpire', 'linesman', 'scorer']).optional(), status: z.enum(STATUSES).optional() }),
  async handler({ user }, i) {
    const from = new Date(i.from), to = new Date(i.to);
    if (!(to > from)) throw badRequest('to must be after from');
    if (to - from > 62 * DAY) throw badRequest('Ask for at most 62 days at a time');
    const prefs = await one('SELECT * FROM official_prefs WHERE user_id=$1', [user.id]);
    const tz = prefs?.timezone ?? 'UTC', buffer = (prefs?.buffer_min ?? 0) * 60000;
    const weekly = await many("SELECT weekday, start_minute, end_minute FROM official_availability WHERE user_id=$1 AND kind='weekly' AND archived_at IS NULL ORDER BY weekday, start_minute", [user.id]);
    const off = await many("SELECT id, starts_at, ends_at, note FROM official_availability WHERE user_id=$1 AND kind='blackout' AND archived_at IS NULL AND starts_at < $3 AND ends_at > $2 ORDER BY starts_at", [user.id, from, to]);
    const rows = await myAssignments(user.id, `x.scheduled_at < $2 AND x.scheduled_at + x.duration_min * interval '1 minute' > $3 AND x.status IN ('invited','accepted','completed') AND ($4::uuid IS NULL OR x.sport_id=$4) AND ($5::text IS NULL OR x.role=$5) AND ($6::text IS NULL OR x.status=$6)`,
      [to, from, i.sport_id ?? null, i.role ?? null, i.status ?? null]);
    const span = (a) => [new Date(a.scheduled_at).getTime(), new Date(a.scheduled_at).getTime() + a.duration_min * 60000];
    const entries = rows.map((a) => {
      const [s, e] = span(a);
      const clashes = rows.filter((b) => b.id !== a.id && b.status !== 'completed' && a.status !== 'completed' && (a.status === 'accepted' || b.status === 'accepted') && (() => { const [bs, be] = span(b); return bs < e + buffer && be > s - buffer; })()).map((b) => b.id);
      const blocked = off.filter((o) => new Date(o.starts_at) < e && new Date(o.ends_at) > s).map((o) => o.id);
      const lp = localParts(a.scheduled_at, tz);
      const inside = !weekly.length || weekly.some((w) => w.weekday === lp.weekday && lp.minute >= w.start_minute && lp.minute + a.duration_min <= w.end_minute);
      return {
        source_type: 'fixture_official', source_id: a.id, fixture_id: a.fixture_id, kind: 'assignment', status: a.status, role: a.role, needs_ack: a.needs_ack,
        starts_at: a.scheduled_at, ends_at: new Date(e).toISOString(), title: `${a.home_name ?? 'TBD'} v ${a.away_name ?? 'TBD'}`, subtitle: a.event_name,
        sport: { id: a.sport_id, slug: a.sport_slug, name: a.sport_name, emoji: a.sport_emoji }, venue: a.resource_name ?? a.venue_name ?? null,
        clash_with: clashes, unavailable_with: blocked, outside_availability: !inside && !blocked.length,
      };
    });
    for (const o of off) entries.push({ source_type: 'official_availability', source_id: o.id, kind: 'time_off', status: 'blocked', starts_at: o.starts_at, ends_at: o.ends_at, title: 'Unavailable', subtitle: o.note ?? null });
    const deadlines = await many(
      `SELECT DISTINCT c.id, c.case_no, c.subject, c.resolution_due, l.entity_id AS fixture_id FROM cases c JOIN case_links l ON l.case_id=c.id AND l.entity_type='fixture' JOIN fixtures f ON f.id=l.entity_id
        WHERE c.routed_to='game_officials' AND c.requester_id <> $1 AND c.status = ANY($2) AND c.resolution_due >= $3 AND c.resolution_due < $4
          AND (f.referee_id=$1 OR EXISTS (SELECT 1 FROM fixture_officials fo WHERE fo.fixture_id=f.id AND fo.user_id=$1 AND fo.status='accepted'))`, [user.id, ACTIVE, from, to]);
    for (const d of deadlines) entries.push({ source_type: 'case', source_id: d.id, fixture_id: d.fixture_id, kind: 'deadline', status: 'open', starts_at: d.resolution_due, ends_at: d.resolution_due, title: `Dispute #${d.case_no} due`, subtitle: d.subject });
    entries.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at) || String(a.source_id).localeCompare(String(b.source_id)));
    return { timezone: tz, from: from.toISOString(), to: to.toISOString(), buffer_min: prefs?.buffer_min ?? 0, entries, conflicts: entries.filter((e) => e.clash_with?.length || e.unavailable_with?.length).length };
  },
});

// ------------------------------------------------------------------ availability
cap({
  name: 'get_my_official_availability', method: 'GET', path: '/me/officials/availability', tag: TAG,
  summary: 'My availability: weekly windows, time off, preferred sports and levels, the minimum gap I need between matches and a coarse region (never an address).',
  async handler({ user }) {
    const prefs = (await one('SELECT * FROM official_prefs WHERE user_id=$1', [user.id])) ?? { user_id: user.id, timezone: 'UTC', buffer_min: 0, travel_km: null, region: null, sport_ids: [], levels: [] };
    return {
      prefs,
      weekly: await many("SELECT id, weekday, start_minute, end_minute FROM official_availability WHERE user_id=$1 AND kind='weekly' AND archived_at IS NULL ORDER BY weekday, start_minute", [user.id]),
      time_off: await many("SELECT id, starts_at, ends_at, note FROM official_availability WHERE user_id=$1 AND kind='blackout' AND archived_at IS NULL AND ends_at > now() ORDER BY starts_at", [user.id]),
    };
  },
});

cap({
  name: 'save_my_official_prefs', method: 'POST', path: '/me/officials/availability/prefs', tag: TAG,
  summary: 'Set my timezone, the minimum minutes I need between matches (enforced when I am assigned), travel range, a coarse region, preferred sports and levels.',
  input: z.object({
    timezone: z.string().min(1).max(60), buffer_min: z.number().int().min(0).max(240).default(0), travel_km: z.number().int().min(1).max(1000).nullable().optional(),
    region: z.string().trim().max(80).nullable().optional(), sport_ids: z.array(id).max(30).default([]), levels: z.array(z.string().trim().min(1).max(30)).max(12).default([]),
  }),
  async handler({ user }, i) {
    if (!validZone(i.timezone)) throw badRequest('That is not a known timezone');
    return one(
      `INSERT INTO official_prefs(user_id, timezone, buffer_min, travel_km, region, sport_ids, levels) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO UPDATE SET timezone=$2, buffer_min=$3, travel_km=$4, region=$5, sport_ids=$6, levels=$7, updated_at=now() RETURNING *`,
      [user.id, i.timezone, i.buffer_min, i.travel_km ?? null, i.region || null, i.sport_ids, i.levels]);
  },
});

cap({
  name: 'set_my_weekly_availability', method: 'POST', path: '/me/officials/availability/weekly', tag: TAG,
  summary: 'Replace my weekly windows (weekday 0 = Sunday, minutes from local midnight). Earlier windows are archived, not deleted. An empty list means "no weekly restriction".',
  input: z.object({ windows: z.array(z.object({ weekday: z.number().int().min(0).max(6), start_minute: z.number().int().min(0).max(1439), end_minute: z.number().int().min(1).max(1440) }).refine((w) => w.end_minute > w.start_minute, 'A window must end after it starts')).max(28) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await c.query("UPDATE official_availability SET archived_at=now() WHERE user_id=$1 AND kind='weekly' AND archived_at IS NULL", [user.id]);
      for (const w of i.windows) await c.query("INSERT INTO official_availability(user_id, kind, weekday, start_minute, end_minute) VALUES ($1,'weekly',$2,$3,$4)", [user.id, w.weekday, w.start_minute, w.end_minute]);
      return (await c.query("SELECT id, weekday, start_minute, end_minute FROM official_availability WHERE user_id=$1 AND kind='weekly' AND archived_at IS NULL ORDER BY weekday, start_minute", [user.id])).rows;
    });
  },
});

cap({
  name: 'add_my_time_off', method: 'POST', path: '/me/officials/availability/time-off', tag: TAG, status: 201,
  summary: 'Block a period (holiday, work, injury: no reason is shared beyond your own note). Returns any confirmed matches that fall inside it so you can withdraw from them; it never silently drops an assignment.',
  input: z.object({ starts_at: dt, ends_at: dt, note: z.string().trim().max(200).optional() }),
  async handler({ user }, i) {
    if (!(new Date(i.ends_at) > new Date(i.starts_at))) throw badRequest('ends_at must be after starts_at');
    const row = await one("INSERT INTO official_availability(user_id, kind, starts_at, ends_at, note) VALUES ($1,'blackout',$2,$3,$4) RETURNING id, starts_at, ends_at, note", [user.id, i.starts_at, i.ends_at, i.note ?? null]);
    const affected = await myAssignments(user.id, `x.status IN ('invited','accepted') AND x.scheduled_at < $2 AND x.scheduled_at + x.duration_min * interval '1 minute' > $3`, [i.ends_at, i.starts_at]);
    return { ...row, affected_assignments: affected.map((a) => ({ id: a.id, fixture_id: a.fixture_id, status: a.status, role: a.role, scheduled_at: a.scheduled_at, event_name: a.event_name })) };
  },
});

cap({
  name: 'remove_my_time_off', method: 'POST', path: '/me/officials/availability/:id/remove', tag: TAG,
  summary: 'Remove a time-off block (it is archived, so the history is kept).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one("UPDATE official_availability SET archived_at=now() WHERE id=$1 AND user_id=$2 AND kind='blackout' AND archived_at IS NULL RETURNING id", [i.id, user.id]);
    if (!r) throw notFound('time off');
    return { id: r.id, removed: true };
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
