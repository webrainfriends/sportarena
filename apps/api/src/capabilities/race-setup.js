// Race operations (issue #487), part 1: setting a race up. A race is an existing multi-sport DISCIPLINE (event_disciplines) of an existing event;
// its entrants are existing event_participants + discipline_nominations; nothing about the person, the event or the final result is copied.
// This file adds what a mass-participation race needs on top: a pinned policy, declared categories, bib/chip tags with reissue history,
// waves with server-enforced capacity, versioned courses with checkpoints, and bulk entrant import with reconciliation.
import qrcode from 'qrcode-generator';
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, sportBySlugOrId } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { enqueue } from '../jobs.js';
import { YOUTH_SQL, guardiansOf, hasConsent } from '../youth.js';
import { eventAccess, organizerOnly } from './multisport.js';
import { lockEvent } from '../multisport.js';
import { rulesSchema, STAFF_TIMING, STAFF_CHIEF, governedStatuses, encodeCursor, decodeCursor, parseCsv } from '../race.js';

export const TAG = 'Race operations';
const dt = z.string().datetime({ offset: true });
const gender = z.enum(['male', 'female', 'other']);
const ref = z.string().trim().min(1).max(40);
const chunk = (a, n) => { const out = []; for (let k = 0; k < a.length; k += n) out.push(a.slice(k, k + n)); return out; };
export const NO_ACCESS = (m = 'Race') => notFound(m);

// ---------------------------------------------------------------- shared helpers (used by race-timing.js and race-results.js)

/** Run several queries on one transaction client one after another (pg forbids overlapping queries on a client). */
export const serial = (c) => { let last = Promise.resolve(); return { query: (...a) => { const p = last.then(() => c.query(...a)); last = p.catch(() => {}); return p; } }; };

export const lockRace = (c, disciplineId) => c.query("SELECT pg_advisory_xact_lock(hashtextextended('race:' || $1::text, 0))", [disciplineId]);
export const sealReason = (text) => encrypt(text, 'race.reason');
export const openReason = (blob) => (blob ? decrypt(blob, 'race.reason') : null);

export async function currentPolicy(c, disciplineId) {
  const p = (await c.query('SELECT version, rules FROM race_policies WHERE discipline_id=$1 ORDER BY version DESC LIMIT 1', [disciplineId])).rows[0];
  if (!p) throw conflict('This race has no policy');
  return { version: p.version, rules: rulesSchema.parse(p.rules) };
}

/**
 * Who may do what on a race. Organiser (and org admins): everything. Accepted event crew: timekeeper / starter / judge / referee / umpire / scorer run the timing desk;
 * judge / referee / umpire are the chief officials who approve corrections, disqualify and publish. Anyone else gets 404, so ids cannot be probed.
 * need: 'view' and 'timing' = timing desk; 'chief' = chief official or organiser; 'organizer' = organiser only.
 */
export async function raceCtx(c, user, disciplineId, need = 'view', { lock = false } = {}) {
  const d = (await c.query(`SELECT d.*, s.session_id FROM race_setups s JOIN event_disciplines d ON d.id=s.discipline_id WHERE s.discipline_id=$1 ${lock ? 'FOR UPDATE OF s' : ''}`, [disciplineId])).rows[0];
  if (!d) throw NO_ACCESS();
  const { ev, scope } = await eventAccess(c, user, d.event_id);
  const roles = scope.staff.map((s) => s.role);
  const organizer = !!scope.organizer;
  const timing = organizer || roles.some((r) => STAFF_TIMING.includes(r));
  const chief = organizer || roles.some((r) => STAFF_CHIEF.includes(r));
  if (!timing) throw NO_ACCESS();
  if (need === 'chief' && !chief) throw forbidden('Only the organiser or a chief official (judge, referee, umpire) can do that');
  if (need === 'organizer' && !organizer) throw forbidden('Only the organiser can do that');
  const policy = await currentPolicy(c, disciplineId);
  return { d, ev, organizer, timing, chief, rules: policy.rules, policyVersion: policy.version, user };
}

export const raceLog = (c, { discipline_id, entrant_id = null, subject, subject_id = null, action, before = null, after = null, actor_id }) =>
  c.query('INSERT INTO race_log(discipline_id, entrant_id, subject, subject_id, action, before, after, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [discipline_id, entrant_id, subject, subject_id, action, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), actor_id]);

/** Tell entrants (and the guardians of young account holders) something that affects them. A few inline, the rest as durable notify jobs. */
export async function notifyEntrants(c, entrantIds, msg) {
  if (!entrantIds.length) return 0;
  const users = (await c.query(
    `SELECT DISTINCT p.user_id FROM race_entrants e JOIN event_participants p ON p.id=e.participant_id WHERE e.id = ANY($1) AND p.user_id IS NOT NULL`, [entrantIds])).rows.map((r) => r.user_id);
  const recipients = new Set(users);
  const youth = users.length ? (await c.query(`SELECT u.id FROM users u WHERE u.id = ANY($1) AND ${YOUTH_SQL}`, [users])).rows.map((r) => r.id) : [];
  for (const kid of youth) for (const g of await guardiansOf(kid, c)) recipients.add(g);
  let n = 0;
  for (const u of recipients) {
    if (n++ < 100) await notify(c, u, msg);
    else await enqueue(c, { category: 'notify', kind: 'notify.retry', payload: { user_id: u, ...msg }, maxAttempts: 8 });
  }
  return recipients.size;
}

/** SQL: the first holder of a chip/bib holds it from the beginning of time (a tag recorded late still explains the reads it made); a re-used reference starts now. */
const FIRST_HOLDER = (scope, kind, value) => `CASE WHEN EXISTS (SELECT 1 FROM race_assignments x WHERE x.scope_key=${scope} AND x.kind=${kind} AND lower(x.ref)=lower(${value})) THEN now() ELSE '-infinity'::timestamptz END`;

const bibScope = (ctx) => (ctx.rules.bib_scope === 'event' ? ctx.d.event_id : ctx.d.id);

/** Close the entrant's current tag of `kind` (if any) and open a new one, in one step. Throws a readable 409 when the reference is taken. */
export async function placeTag(c, ctx, entrant, { kind, ref: value, closeAs = 'replaced', reason = null, at = null }) {
  const scope = kind === 'bib' ? bibScope(ctx) : ctx.d.event_id;
  const when = at ?? new Date();
  // the first holder of a chip or bib holds it from the beginning: a tag recorded late (even after the race) still explains the reads it made
  const everHeld = (await c.query('SELECT 1 FROM race_assignments WHERE scope_key=$1 AND kind=$2 AND lower(ref)=lower($3) LIMIT 1', [scope, kind, value])).rowCount > 0;
  const live = (await c.query("SELECT * FROM race_assignments WHERE entrant_id=$1 AND kind=$2 AND state='active' FOR UPDATE", [entrant.id, kind])).rows[0];
  if (live) await c.query('UPDATE race_assignments SET state=$2, to_at=$3, reason=coalesce($4, reason) WHERE id=$1', [live.id, closeAs, when, reason]);
  try {
    const row = (await c.query(
      `INSERT INTO race_assignments(entrant_id, discipline_id, event_id, kind, ref, scope_key, state, reason, from_at, actor_id) VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9) RETURNING *`,
      [entrant.id, ctx.d.id, ctx.d.event_id, kind, value, scope, reason, everHeld ? when : '-infinity', ctx.user.id])).rows[0];
    return { previous: live ?? null, current: row };
  } catch (e) {
    if (e.code === '23505') throw conflict(`${kind === 'bib' ? 'Bib' : 'Chip'} ${value} is already assigned to another entrant`);
    throw e;
  }
}

async function mustEntrant(c, entrantId, lock = false) {
  const e = (await c.query(`SELECT e.*, n.status AS entry_state, p.full_name, p.gender, p.user_id, p.medical_hold, p.house_id FROM race_entrants e
     JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id WHERE e.id=$1 ${lock ? 'FOR UPDATE OF e' : ''}`, [entrantId])).rows[0];
  if (!e) throw NO_ACCESS('Entrant');
  return e;
}
export const loadEntrant = mustEntrant;

export const ENTRANT_SELECT = `e.id, e.participant_id, e.nomination_id, e.race_status, e.status_locked, e.source, e.external_ref, e.name_public, e.category_id, e.wave_id, e.created_at,
  n.status AS entry_state, n.seed, p.full_name, p.gender, p.grade, p.house_id, p.user_id IS NOT NULL AS has_account, h.name AS club, cat.name AS category, w.name AS wave,
  bib.ref AS bib_no, chip.ref AS chip_ref`;
export const ENTRANT_FROM = `race_entrants e JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id
  LEFT JOIN event_houses h ON h.id=p.house_id LEFT JOIN race_categories cat ON cat.id=e.category_id LEFT JOIN race_waves w ON w.id=e.wave_id
  LEFT JOIN race_assignments bib ON bib.entrant_id=e.id AND bib.kind='bib' AND bib.state='active'
  LEFT JOIN race_assignments chip ON chip.entrant_id=e.id AND chip.kind='chip' AND chip.state='active'`;
export const ACTIVE_ENTRY = "n.status IN ('nominated','confirmed') AND p.status='active'";

// ---------------------------------------------------------------- the race itself

async function raceCard(c, ctx) {
  const d = ctx.d;
  const q = serial(c);
  const [counts, course, drafts, waves, categories, sources, pub, sport] = await Promise.all([
    q.query(
      `SELECT count(*) FILTER (WHERE ${ACTIVE_ENTRY})::int AS entrants,
              count(*) FILTER (WHERE ${ACTIVE_ENTRY} AND bib.id IS NULL)::int AS no_bib,
              count(*) FILTER (WHERE ${ACTIVE_ENTRY} AND chip.id IS NULL)::int AS no_chip,
              count(*) FILTER (WHERE ${ACTIVE_ENTRY} AND e.wave_id IS NULL)::int AS no_wave,
              count(*) FILTER (WHERE ${ACTIVE_ENTRY} AND e.race_status='started')::int AS started,
              count(*) FILTER (WHERE ${ACTIVE_ENTRY} AND e.race_status='finished')::int AS finished
         FROM race_entrants e JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id
         LEFT JOIN race_assignments bib ON bib.entrant_id=e.id AND bib.kind='bib' AND bib.state='active'
         LEFT JOIN race_assignments chip ON chip.entrant_id=e.id AND chip.kind='chip' AND chip.state='active'
        WHERE e.discipline_id=$1`, [d.id]).then((r) => r.rows[0]),
    q.query("SELECT * FROM race_courses WHERE discipline_id=$1 AND status='published'", [d.id]).then((r) => r.rows[0] ?? null),
    q.query("SELECT id, version, name, status, created_at FROM race_courses WHERE discipline_id=$1 AND status='draft' ORDER BY version DESC", [d.id]).then((r) => r.rows),
    q.query(
      `SELECT w.*, (SELECT count(*)::int FROM race_wave_assignments a JOIN race_entrants e ON e.id=a.entrant_id JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id
                     WHERE a.wave_id=w.id AND a.ended_at IS NULL AND ${ACTIVE_ENTRY}) AS assigned
         FROM race_waves w WHERE w.discipline_id=$1 AND w.status <> 'cancelled' ORDER BY w.position, w.start_at, w.id`, [d.id]).then((r) => r.rows),
    q.query(
      `SELECT k.*, (SELECT count(*)::int FROM race_entrants e WHERE e.category_id=k.id) AS entrants FROM race_categories k WHERE k.discipline_id=$1 AND k.archived_at IS NULL ORDER BY lower(k.name)`, [d.id]).then((r) => r.rows),
    q.query('SELECT * FROM race_sources WHERE discipline_id=$1 AND retired_at IS NULL ORDER BY created_at, id', [d.id]).then((r) => r.rows),
    q.query('SELECT id, version, label, published_at, entrants, finishers FROM race_publications WHERE discipline_id=$1 ORDER BY version DESC LIMIT 1', [d.id]).then((r) => r.rows[0] ?? null),
    q.query('SELECT slug, name, emoji FROM sports WHERE id=$1', [d.sport_id]).then((r) => r.rows[0]),
  ]);
  const checkpoints = course ? (await q.query('SELECT * FROM race_checkpoints WHERE course_id=$1 ORDER BY seq', [course.id])).rows : [];
  return {
    race: { id: d.id, event_id: ctx.ev.id, event_name: ctx.ev.name, name: d.name, sport, gender: d.gender, status: d.status, session_id: d.session_id, starts_on: ctx.ev.starts_on },
    access: { organizer: ctx.organizer, chief: ctx.chief, timing: ctx.timing },
    policy: { version: ctx.policyVersion, rules: ctx.rules },
    counts, course: course ? { ...course, checkpoints } : null, draft_courses: drafts, waves, categories, sources, last_publication: pub,
    statuses: ['registered', 'started', 'finished', ...governedStatuses(ctx.rules)],
  };
}

cap({
  name: 'setup_race', method: 'POST', path: '/events/:id/races', tag: TAG, status: 201,
  summary: 'Turn a discipline of an event into a mass-participation race (road race, cross-country, cycling, triathlon-style stages, swimming meet): create a timed individual discipline, or convert an existing one with `discipline_id`. Pins policy v1 (time basis, duplicate window, tie rule, bib scope, guests, public page). Reuses the event, its multi-sport programme and the canonical result session; call it again for a second distance.',
  input: z.object({
    id, discipline_id: id.optional().describe('convert an existing individual discipline instead of creating one'),
    name: z.string().trim().min(1).max(80).optional(), sport: z.string().optional().describe('sport slug or id (creating a discipline)'),
    gender: z.enum(['any', 'male', 'female']).default('any'), rules: rulesSchema.optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await organizerOnly(c, user, i.id);
      await lockEvent(c, ev.id);
      if (['completed', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
      await c.query('INSERT INTO event_programmes(event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING', [ev.id]);
      let d;
      if (i.discipline_id) {
        d = (await c.query('SELECT * FROM event_disciplines WHERE id=$1 AND event_id=$2 FOR UPDATE', [i.discipline_id, ev.id])).rows[0];
        if (!d) throw notFound('Discipline');
        if (d.mode !== 'individual') throw badRequest('A race is an individual discipline');
        if (d.status === 'cancelled') throw conflict('Discipline is cancelled');
        if ((await c.query('SELECT 1 FROM race_setups WHERE discipline_id=$1', [d.id])).rowCount) throw conflict('That discipline is already a race');
        if (d.result_type !== 'time') await c.query("UPDATE event_disciplines SET result_type='time' WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM event_session_entries x JOIN event_sessions s ON s.id=x.session_id WHERE s.discipline_id=$1 AND x.result_value IS NOT NULL)", [d.id]);
      } else {
        if (!i.name || !i.sport) throw badRequest('Give a name and a sport, or a discipline_id');
        const sport = await sportBySlugOrId(i.sport);
        if (!sport) throw notFound('Sport');
        d = (await c.query("INSERT INTO event_disciplines(event_id, sport_id, name, mode, gender, result_type, status, created_by) VALUES ($1,$2,$3,'individual',$4,'time','nominations',$5) RETURNING *", [ev.id, sport.id, i.name, i.gender, user.id])).rows[0];
      }
      await c.query('INSERT INTO race_setups(discipline_id, event_id, created_by) VALUES ($1,$2,$3)', [d.id, ev.id, user.id]);
      const rules = rulesSchema.parse(i.rules ?? {});
      await c.query('INSERT INTO race_policies(discipline_id, version, rules, note, created_by) VALUES ($1,1,$2,$3,$4)', [d.id, JSON.stringify(rules), 'Initial policy', user.id]);
      await raceLog(c, { discipline_id: d.id, subject: 'policy', action: 'race_created', after: { version: 1 }, actor_id: user.id });
      return raceCard(c, await raceCtx(c, user, d.id, 'organizer'));
    });
  },
});

cap({
  name: 'get_race', method: 'GET', path: '/races/:id', tag: TAG,
  summary: 'The race card for the organiser and timing crew: pinned policy, published course with checkpoints, waves with assigned counts, declared categories, timing sources, readiness counts and the latest publication.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => raceCard(c, await raceCtx(c, user, i.id))),
});

cap({
  name: 'list_event_races', method: 'GET', path: '/events/:id/races', tag: TAG, auth: 'public',
  summary: 'Races of an event. Anyone sees the races whose organiser switched the public page on (name, sport, status, latest result label); the organiser and crew see every race.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await one('SELECT id, name, organizer_id, organisation_id FROM events WHERE id=$1', [i.id]);
    if (!ev) throw notFound('Event');
    let staff = false;
    if (user) { const { scope } = await eventAccess(pool, user, i.id); staff = scope.organizer || scope.staff.some((s) => STAFF_TIMING.includes(s.role)); }
    const rows = await many(
      `SELECT d.id, d.name, d.status, s.slug AS sport, s.name AS sport_name, s.emoji, pol.rules->'public'->>'enabled' AS pub,
              (SELECT label FROM race_publications q WHERE q.discipline_id=d.id ORDER BY version DESC LIMIT 1) AS result_label
         FROM race_setups r JOIN event_disciplines d ON d.id=r.discipline_id JOIN sports s ON s.id=d.sport_id
         JOIN LATERAL (SELECT rules FROM race_policies WHERE discipline_id=d.id ORDER BY version DESC LIMIT 1) pol ON true
        WHERE r.event_id=$1 AND d.status <> 'cancelled' ORDER BY d.created_at, d.id`, [i.id]);
    return rows.filter((r) => staff || r.pub === 'true').map(({ pub, ...r }) => ({ ...r, public: pub === 'true' }));
  },
});

cap({
  name: 'set_race_policy', method: 'POST', path: '/races/:id/policy', tag: TAG, status: 201,
  summary: 'Publish a new version of the race policy (changes are merged into the current one). Older versions are kept: every result records the policy version it was computed under. The bib scope cannot change once bibs exist, and the clock/tie rules cannot change after a final publication (use a governed correction).',
  input: z.object({ id, rules: z.record(z.string(), z.unknown()), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await raceCtx(c, user, i.id, 'organizer');
      await lockRace(c, i.id);
      const merged = rulesSchema.safeParse({ ...ctx.rules, ...i.rules, team_scoring: { ...ctx.rules.team_scoring, ...(i.rules.team_scoring ?? {}) }, public: { ...ctx.rules.public, ...(i.rules.public ?? {}) } });
      if (!merged.success) throw badRequest(merged.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '));
      const next = merged.data;
      if (next.bib_scope !== ctx.rules.bib_scope && (await c.query("SELECT 1 FROM race_assignments WHERE discipline_id=$1 AND kind='bib' LIMIT 1", [i.id])).rowCount) throw conflict('Bibs already exist; the bib scope can no longer change');
      const finalised = (await c.query("SELECT 1 FROM race_publications WHERE discipline_id=$1 AND label IN ('final','corrected') LIMIT 1", [i.id])).rowCount > 0;
      if (finalised && ['time_basis', 'cutoff_basis', 'tie_rule', 'dedupe_window_s'].some((k) => next[k] !== ctx.rules[k])) throw conflict('Results are final; the clock and tie rules can only change through a governed correction');
      if (next.max_entrants) {
        const n = (await c.query(`SELECT count(*)::int AS n FROM race_entrants e JOIN discipline_nominations x ON x.id=e.nomination_id WHERE e.discipline_id=$1 AND x.status IN ('nominated','confirmed')`, [i.id])).rows[0].n;
        if (n > next.max_entrants) throw conflict(`${n} entrants are already registered; the limit cannot be below that`);
      }
      const row = (await c.query('INSERT INTO race_policies(discipline_id, version, rules, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, version, rules, note, created_at', [i.id, ctx.policyVersion + 1, JSON.stringify(next), i.note ?? null, user.id])).rows[0];
      await raceLog(c, { discipline_id: i.id, subject: 'policy', subject_id: row.id, action: 'policy_published', before: { version: ctx.policyVersion }, after: { version: row.version }, actor_id: user.id });
      return row;
    });
  },
});

cap({
  name: 'list_race_policy_versions', method: 'GET', path: '/races/:id/policy/versions', tag: TAG,
  summary: 'Every pinned version of the race policy, newest first, with who published it and why.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => { await raceCtx(c, user, i.id); return (await c.query('SELECT id, version, rules, note, created_by, created_at FROM race_policies WHERE discipline_id=$1 ORDER BY version DESC', [i.id])).rows; }),
});

// ---------------------------------------------------------------- categories (declared by the organiser; nothing is inferred)

cap({
  name: 'create_race_category', method: 'POST', path: '/races/:id/categories', tag: TAG, status: 201,
  summary: 'Declare a competition category (age group, open, para, custom) with an optional gender rule and the rule it comes from. Entrants are placed in a category explicitly; the platform never infers one from a name, a photo or a profile.',
  input: z.object({ id, name: z.string().trim().min(1).max(80), kind: z.enum(['age_group', 'open', 'para', 'custom']).default('age_group'), gender_rule: z.enum(['any', 'male', 'female']).default('any'), eligibility_ref: z.string().max(120).optional(), award_depth: z.number().int().min(0).max(50).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await raceCtx(c, user, i.id, 'organizer');
      try {
        const row = (await c.query('INSERT INTO race_categories(discipline_id, name, kind, gender_rule, eligibility_ref, award_depth, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [i.id, i.name, i.kind, i.gender_rule, i.eligibility_ref ?? null, i.award_depth ?? null, user.id])).rows[0];
        await raceLog(c, { discipline_id: i.id, subject: 'category', subject_id: row.id, action: 'category_created', after: { name: row.name, gender_rule: row.gender_rule }, actor_id: user.id });
        return row;
      } catch (e) { if (e.code === '23505') throw conflict('A category with that name already exists'); throw e; }
    });
  },
});

cap({
  name: 'update_race_category', method: 'PATCH', path: '/race-categories/:id', tag: TAG,
  summary: 'Rename a category, change its eligibility reference or award depth, or archive it (entrants already placed keep it; it cannot take new entrants).',
  input: z.object({ id, name: z.string().trim().min(1).max(80).optional(), eligibility_ref: z.string().max(120).nullable().optional(), award_depth: z.number().int().min(0).max(50).nullable().optional(), archived: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cat = (await c.query('SELECT * FROM race_categories WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!cat) throw NO_ACCESS('Category');
      await raceCtx(c, user, cat.discipline_id, 'organizer');
      const row = (await c.query(
        `UPDATE race_categories SET name=coalesce($2,name), eligibility_ref=CASE WHEN $3::boolean THEN $4 ELSE eligibility_ref END, award_depth=CASE WHEN $5::boolean THEN $6 ELSE award_depth END,
                archived_at=CASE WHEN $7::boolean IS TRUE THEN now() WHEN $7::boolean IS FALSE THEN NULL ELSE archived_at END WHERE id=$1 RETURNING *`,
        [i.id, i.name ?? null, i.eligibility_ref !== undefined, i.eligibility_ref ?? null, i.award_depth !== undefined, i.award_depth ?? null, i.archived ?? null])).rows[0];
      await raceLog(c, { discipline_id: cat.discipline_id, subject: 'category', subject_id: cat.id, action: 'category_updated', before: { name: cat.name, archived: !!cat.archived_at }, after: { name: row.name, archived: !!row.archived_at }, actor_id: user.id });
      return row;
    });
  },
});

// ---------------------------------------------------------------- entrants

function eligible(d, rules, p, cat) {
  if (p.medical_hold) return `${p.full_name} is on a medical hold`;
  if (d.gender !== 'any' && p.gender !== d.gender) return `${d.name} is for ${d.gender} participants only (declared gender is ${p.gender ?? 'missing'})`;
  if (cat && cat.gender_rule !== 'any' && p.gender !== cat.gender_rule) return `Category "${cat.name}" is for ${cat.gender_rule} entrants; the declared gender is ${p.gender ?? 'missing'}`;
  return null;
}

const rowIn = z.object({
  external_ref: z.string().trim().min(1).max(60), full_name: z.string().trim().min(1).max(120), gender: gender.optional(), grade: z.string().trim().max(30).optional(),
  club: z.string().trim().max(60).optional(), user_handle: z.string().trim().max(40).optional(), category: z.string().trim().max(80).optional(), wave: z.string().trim().max(60).optional(),
  bib: ref.optional(), chip: ref.optional(), seed_s: z.number().min(0).max(1e7).optional(), name_public: z.boolean().optional(), confirm_distinct: z.boolean().optional(),
});
const emptyToUndef = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null));
const truthy = (v) => (typeof v === 'string' ? ['1', 'true', 'yes', 'y'].includes(v.toLowerCase()) : v);

cap({
  name: 'import_race_entrants', method: 'POST', path: '/races/:id/entrants/import', tag: TAG,
  summary: 'Bulk-register entrants (up to 5000 rows, JSON rows or CSV text) with a dry run first. Each row needs the registration system\'s `external_ref`, which makes the import idempotent: an entrant already imported is reported unchanged, never duplicated or overwritten. Rows match existing event participants by that reference or an account `user_handle`; a name that looks like an existing person is reported as a possible duplicate instead of creating a second person. Bib, chip, wave and category are optional and validated (unique, capacity, gender rule).',
  input: z.object({ id, dry_run: z.boolean().default(true), csv: z.string().max(5_000_000).optional().describe('CSV with a header row using the same field names'), rows: z.array(z.record(z.string(), z.unknown())).max(5000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await raceCtx(c, user, i.id, 'organizer');
      await lockEvent(c, ctx.d.event_id);
      if (['completed', 'cancelled'].includes(ctx.d.status)) throw conflict(`Race is ${ctx.d.status}`);
      let raw = i.rows ?? [];
      if (i.csv) { try { raw = parseCsv(i.csv, { maxRows: 5000 }); } catch (e) { throw badRequest(e.message); } }
      if (!raw.length) throw badRequest('Send `rows` or `csv`');
      if (raw.length > 5000) throw badRequest('At most 5000 rows per import');
      const d = ctx.d, rules = ctx.rules;
      const errors = [], out = [];
      const seenRef = new Set(), seenBib = new Set(), seenChip = new Set();
      const err = (idx, field, message) => errors.push({ row: idx + 1, field, message });
      raw.forEach((r0, idx) => {
        const r = emptyToUndef({ ...r0, name_public: truthy(r0.name_public), confirm_distinct: truthy(r0.confirm_distinct), seed_s: r0.seed_s === undefined || r0.seed_s === '' ? undefined : Number(r0.seed_s) });
        const p = rowIn.safeParse(r);
        if (!p.success) { for (const x of p.error.issues) err(idx, x.path.join('.') || 'row', x.message); return; }
        const v = p.data;
        if (seenRef.has(v.external_ref.toLowerCase())) return err(idx, 'external_ref', 'Repeated in this file');
        seenRef.add(v.external_ref.toLowerCase());
        if (v.bib) { if (seenBib.has(v.bib.toLowerCase())) return err(idx, 'bib', 'Bib repeated in this file'); seenBib.add(v.bib.toLowerCase()); }
        if (v.chip) { if (seenChip.has(v.chip.toLowerCase())) return err(idx, 'chip', 'Chip repeated in this file'); seenChip.add(v.chip.toLowerCase()); }
        out.push({ idx, v });
      });
      const refs = out.map((o) => o.v.external_ref);
      const [cats, waves, existing, parts, handles, houses, bibsUsed, chipsUsed, nameKeys, count] = await Promise.all([
        c.query('SELECT * FROM race_categories WHERE discipline_id=$1 AND archived_at IS NULL', [d.id]).then((r) => new Map(r.rows.map((x) => [x.name.toLowerCase(), x]))),
        c.query(`SELECT w.*, (SELECT count(*)::int FROM race_wave_assignments a WHERE a.wave_id=w.id AND a.ended_at IS NULL) AS assigned FROM race_waves w WHERE w.discipline_id=$1 AND w.status <> 'cancelled'`, [d.id]).then((r) => new Map(r.rows.map((x) => [x.name.toLowerCase(), x]))),
        c.query('SELECT external_ref, id FROM race_entrants WHERE discipline_id=$1 AND external_ref = ANY($2)', [d.id, refs]).then((r) => new Map(r.rows.map((x) => [x.external_ref.toLowerCase(), x.id]))),
        c.query('SELECT * FROM event_participants WHERE event_id=$1 AND roll_no = ANY($2)', [d.event_id, refs]).then((r) => new Map(r.rows.map((x) => [x.roll_no.toLowerCase(), x]))),
        c.query('SELECT id, handle FROM users WHERE lower(handle) = ANY($1)', [out.map((o) => o.v.user_handle?.toLowerCase()).filter(Boolean)]).then((r) => new Map(r.rows.map((x) => [x.handle.toLowerCase(), x.id]))),
        c.query('SELECT id, lower(name) AS k FROM event_houses WHERE event_id=$1 AND archived_at IS NULL', [d.event_id]).then((r) => new Map(r.rows.map((x) => [x.k, x.id]))),
        c.query("SELECT lower(ref) AS ref FROM race_assignments WHERE scope_key=$1 AND kind='bib' AND state='active'", [rules.bib_scope === 'event' ? d.event_id : d.id]).then((r) => new Set(r.rows.map((x) => x.ref))),
        c.query("SELECT lower(ref) AS ref FROM race_assignments WHERE scope_key=$1 AND kind='chip' AND state='active'", [d.event_id]).then((r) => new Set(r.rows.map((x) => x.ref))),
        c.query("SELECT lower(full_name) || '|' || coalesce(gender,'') AS k, roll_no FROM event_participants WHERE event_id=$1 AND status='active'", [d.event_id]).then((r) => { const m = new Map(); for (const x of r.rows) { if (!m.has(x.k)) m.set(x.k, []); m.get(x.k).push(x.roll_no); } return m; }),
        c.query(`SELECT count(*)::int AS n FROM race_entrants e JOIN discipline_nominations x ON x.id=e.nomination_id WHERE e.discipline_id=$1 AND x.status IN ('nominated','confirmed')`, [d.id]).then((r) => r.rows[0].n),
      ]);
      const plan = [], unchanged = [], planned = new Map();
      let fresh = 0;
      for (const { idx, v } of out) {
        const has = existing.get(v.external_ref.toLowerCase());
        if (has) { unchanged.push({ row: idx + 1, external_ref: v.external_ref, entrant_id: has }); continue; }
        const cat = v.category ? cats.get(v.category.toLowerCase()) : null;
        if (v.category && !cat) { err(idx, 'category', `No category named "${v.category}"; create it first`); continue; }
        const wave = v.wave ? waves.get(v.wave.toLowerCase()) : null;
        if (v.wave && !wave) { err(idx, 'wave', `No wave named "${v.wave}"; create it first`); continue; }
        if (wave && !['open'].includes(wave.status)) { err(idx, 'wave', `Wave "${wave.name}" is ${wave.status}`); continue; }
        if (wave?.category_id && cat?.id !== wave.category_id) { err(idx, 'wave', `Wave "${wave.name}" is reserved for another category`); continue; }
        if (wave && wave.assigned + (planned.get(wave.id) ?? 0) >= wave.capacity) { err(idx, 'wave', `Wave "${wave.name}" is full (${wave.capacity})`); continue; }
        const person = parts.get(v.external_ref.toLowerCase()) ?? null;
        const accountId = v.user_handle ? handles.get(v.user_handle.toLowerCase()) : null;
        if (v.user_handle && !accountId) { err(idx, 'user_handle', `No account with handle "${v.user_handle}"`); continue; }
        if (!accountId && !person && !rules.allow_guests) { err(idx, 'user_handle', 'Guest entrants are not enabled for this race (policy allow_guests)'); continue; }
        const gender_ = v.gender ?? person?.gender ?? null;
        const why = eligible(d, rules, { full_name: v.full_name, gender: gender_, medical_hold: person?.medical_hold }, cat);
        if (why) { err(idx, 'gender', why); continue; }
        if (!person && !accountId) {
          const others = (nameKeys.get(`${v.full_name.toLowerCase()}|${gender_ ?? ''}`) ?? []).filter((rn) => rn !== v.external_ref);
          if (others.length && !v.confirm_distinct) { err(idx, 'full_name', `Looks like an existing participant (${others.length} with this name${others[0] ? `, ref ${others[0]}` : ''}); link their account with user_handle or set confirm_distinct if this is a different person`); continue; }
        }
        if (v.bib && bibsUsed.has(v.bib.toLowerCase())) { err(idx, 'bib', `Bib ${v.bib} is already assigned`); continue; }
        if (v.chip && chipsUsed.has(v.chip.toLowerCase())) { err(idx, 'chip', `Chip ${v.chip} is already assigned`); continue; }
        if (rules.max_entrants && count + fresh >= rules.max_entrants) { err(idx, 'row', `The race is full (${rules.max_entrants} entrants)`); continue; }
        fresh++;
        if (wave) planned.set(wave.id, (planned.get(wave.id) ?? 0) + 1);
        plan.push({ idx, v, cat, wave, person, accountId, gender: gender_ });
      }
      const summary = { received: raw.length, will_create: plan.length, unchanged: unchanged.length, rejected: new Set(errors.map((e) => e.row)).size };
      if (i.dry_run) return { dry_run: true, ...summary, errors: errors.slice(0, 500), unchanged_sample: unchanged.slice(0, 50) };
      if (errors.length) throw badRequest('Fix the rows with errors (or remove them) and import again; nothing was imported', { ...summary, errors: errors.slice(0, 500) });

      const houseIds = new Map(houses);
      for (const clubName of new Set(plan.map((p) => p.v.club).filter(Boolean))) {
        if (houseIds.has(clubName.toLowerCase())) continue;
        const h = (await c.query("INSERT INTO event_houses(event_id, name, kind) VALUES ($1,$2,'club') RETURNING id", [d.event_id, clubName])).rows[0];
        houseIds.set(clubName.toLowerCase(), h.id);
      }
      const created = [];
      for (const part of chunk(plan, 1000)) {
        const newPeople = part.filter((p) => !p.person);
        const personByRef = new Map(part.filter((p) => p.person).map((p) => [p.v.external_ref, p.person.id]));
        if (newPeople.length) {
          const ins = await c.query(
            `INSERT INTO event_participants(event_id, user_id, full_name, house_id, gender, grade, roll_no, created_by)
             SELECT $1, u, n, h, g, gr, r, $2 FROM unnest($3::uuid[], $4::text[], $5::uuid[], $6::text[], $7::text[], $8::text[]) AS t(u, n, h, g, gr, r) RETURNING id, roll_no`,
            [d.event_id, user.id, newPeople.map((p) => p.accountId ?? null), newPeople.map((p) => p.v.full_name), newPeople.map((p) => (p.v.club ? houseIds.get(p.v.club.toLowerCase()) : null)),
              newPeople.map((p) => p.gender), newPeople.map((p) => p.v.grade ?? null), newPeople.map((p) => p.v.external_ref)]).catch((e) => { if (e.code === '23505') throw conflict('One of the accounts is already a participant of this event under another reference; use that reference'); throw e; });
          for (const r of ins.rows) personByRef.set(r.roll_no, r.id);
        }
        const pids = part.map((p) => personByRef.get(p.v.external_ref));
        // adopt an existing nomination (made through the multi-sport flow) or open a new one; a withdrawn one is reinstated
        await c.query(
          `INSERT INTO discipline_nominations(discipline_id, participant_id, house_id, status, seed, created_by)
           SELECT $1, pid, h, 'confirmed', s, $2 FROM unnest($3::uuid[], $4::uuid[], $5::numeric[]) AS t(pid, h, s)
           ON CONFLICT (discipline_id, participant_id) DO UPDATE SET status='confirmed' WHERE discipline_nominations.status IN ('withdrawn','rejected')`,
          [d.id, user.id, pids, part.map((p) => (p.v.club ? houseIds.get(p.v.club.toLowerCase()) : null)), part.map((p) => p.v.seed_s ?? null)]);
        const noms = await c.query('SELECT id, participant_id FROM discipline_nominations WHERE discipline_id=$1 AND participant_id = ANY($2)', [d.id, pids]);
        const nomOf = new Map(noms.rows.map((r) => [r.participant_id, r.id]));
        const ents = await c.query(
          `INSERT INTO race_entrants(discipline_id, event_id, participant_id, nomination_id, category_id, wave_id, source, external_ref, name_public, created_by)
           SELECT $1, $2, pid, nid, cid, wid, src, ext, np, $3 FROM unnest($4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[], $8::text[], $9::text[], $10::boolean[]) AS t(pid, nid, cid, wid, src, ext, np) RETURNING id, external_ref`,
          [d.id, d.event_id, user.id, pids, pids.map((pid) => nomOf.get(pid)), part.map((p) => p.cat?.id ?? null), part.map((p) => p.wave?.id ?? null),
            part.map((p) => (p.accountId || p.person ? 'import' : 'guest')), part.map((p) => p.v.external_ref), part.map((p) => !!p.v.name_public && !p.accountId)])
          .catch((e) => { if (e.code === '23505') throw conflict('One of these people is already an entrant of this race under another reference'); throw e; });
        const entOf = new Map(ents.rows.map((r) => [r.external_ref, r.id]));
        const tags = [];
        for (const p of part) {
          const eid = entOf.get(p.v.external_ref);
          created.push({ external_ref: p.v.external_ref, entrant_id: eid });
          if (p.v.bib) tags.push([eid, 'bib', p.v.bib, rules.bib_scope === 'event' ? d.event_id : d.id]);
          if (p.v.chip) tags.push([eid, 'chip', p.v.chip, d.event_id]);
        }
        if (tags.length) await c.query(
          `INSERT INTO race_assignments(entrant_id, discipline_id, event_id, kind, ref, scope_key, actor_id, from_at)
           SELECT eid, $1, $2, k, r, sk, $3, ${FIRST_HOLDER('sk', 'k', 'r')} FROM unnest($4::uuid[], $5::text[], $6::text[], $7::uuid[]) AS t(eid, k, r, sk)`,
          [d.id, d.event_id, user.id, tags.map((t) => t[0]), tags.map((t) => t[1]), tags.map((t) => t[2]), tags.map((t) => t[3])])
          .catch((e) => { if (e.code === '23505') throw conflict('A bib or chip in this file was taken while importing; run the dry run again'); throw e; });
        const withWave = part.filter((p) => p.wave);
        if (withWave.length) await c.query(
          `INSERT INTO race_wave_assignments(entrant_id, wave_id, reason, actor_id) SELECT eid, wid, 'Imported with the entry list', $1 FROM unnest($2::uuid[], $3::uuid[]) AS t(eid, wid)`,
          [user.id, withWave.map((p) => entOf.get(p.v.external_ref)), withWave.map((p) => p.wave.id)]);
      }
      if (created.length >= 500) await c.query('ANALYZE race_entrants, race_assignments, race_wave_assignments, event_participants, discipline_nominations');
      await raceLog(c, { discipline_id: d.id, subject: 'import', action: 'entrants_imported', after: { created: created.length, unchanged: unchanged.length }, actor_id: user.id });
      return { dry_run: false, ...summary, created: created.length, entrants: created.slice(0, 50), unchanged_sample: unchanged.slice(0, 50) };
    });
  },
});

cap({
  name: 'add_race_entrant', method: 'POST', path: '/races/:id/entrants', tag: TAG, status: 201,
  summary: 'Register one entrant. Give `participant_id` (an existing event participant, so nobody is typed in twice), or `user_id` (an account), or a guest by name when the race allows guests. Medical holds, the discipline gender rule, the category gender rule and the entrant limit are enforced.',
  input: z.object({
    id, participant_id: id.optional(), user_id: id.optional(), full_name: z.string().trim().min(1).max(120).optional(), gender: gender.optional(), grade: z.string().max(30).optional(), club: z.string().max(60).optional(),
    category_id: id.optional(), external_ref: z.string().trim().max(60).optional(), seed_s: z.number().min(0).max(1e7).optional(), name_public: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await raceCtx(c, user, i.id, 'organizer');
      await lockEvent(c, ctx.d.event_id);
      return addEntrant(c, ctx, i, { source: i.participant_id || i.user_id ? 'organiser' : 'guest' });
    });
  },
});

async function addEntrant(c, ctx, i, { source }) {
  const { d, rules } = ctx;
  if (['completed', 'cancelled'].includes(d.status)) throw conflict(`Race is ${d.status}`);
  let p;
  if (i.participant_id) {
    p = (await c.query('SELECT * FROM event_participants WHERE id=$1 AND event_id=$2', [i.participant_id, d.event_id])).rows[0];
    if (!p) throw notFound('Participant');
    if (p.status !== 'active') throw conflict('That participant has withdrawn from the event');
  } else if (i.user_id) {
    const u = (await c.query('SELECT id, display_name FROM users WHERE id=$1', [i.user_id])).rows[0];
    if (!u) throw notFound('User');
    p = (await c.query('SELECT * FROM event_participants WHERE event_id=$1 AND user_id=$2', [d.event_id, u.id])).rows[0];
    if (!p) p = (await c.query('INSERT INTO event_participants(event_id, user_id, full_name, gender, grade, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [d.event_id, u.id, i.full_name ?? u.display_name, i.gender ?? null, i.grade ?? null, ctx.user.id])).rows[0];
  } else {
    if (!rules.allow_guests) throw badRequest('Guest entrants are not enabled for this race (policy allow_guests)');
    if (!i.full_name) throw badRequest('Give the guest\'s full name');
    p = (await c.query('INSERT INTO event_participants(event_id, full_name, gender, grade, roll_no, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [d.event_id, i.full_name, i.gender ?? null, i.grade ?? null, i.external_ref ?? null, ctx.user.id])
      .catch((e) => { if (e.code === '23505') throw conflict('That reference is already used by another participant'); throw e; })).rows[0];
  }
  const cat = i.category_id ? (await c.query('SELECT * FROM race_categories WHERE id=$1 AND discipline_id=$2 AND archived_at IS NULL', [i.category_id, d.id])).rows[0] : null;
  if (i.category_id && !cat) throw notFound('Category');
  const why = eligible(d, rules, p, cat);
  if (why) throw badRequest(why);
  if (i.club && !p.house_id) {
    const h = (await c.query("SELECT id FROM event_houses WHERE event_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL", [d.event_id, i.club])).rows[0]
      ?? (await c.query("INSERT INTO event_houses(event_id, name, kind) VALUES ($1,$2,'club') RETURNING id", [d.event_id, i.club])).rows[0];
    await c.query('UPDATE event_participants SET house_id=$2 WHERE id=$1', [p.id, h.id]);
    p.house_id = h.id;
  }
  if (rules.max_entrants) {
    const n = (await c.query("SELECT count(*)::int AS n FROM race_entrants e JOIN discipline_nominations x ON x.id=e.nomination_id WHERE e.discipline_id=$1 AND x.status IN ('nominated','confirmed')", [d.id])).rows[0].n;
    if (n >= rules.max_entrants) throw conflict(`The race is full (${rules.max_entrants} entrants)`);
  }
  const prior = (await c.query('SELECT * FROM discipline_nominations WHERE discipline_id=$1 AND participant_id=$2 FOR UPDATE', [d.id, p.id])).rows[0];
  if (prior && ['nominated', 'confirmed'].includes(prior.status)) throw conflict(`${p.full_name} is already entered in this race`);
  const nom = prior
    ? (await c.query("UPDATE discipline_nominations SET status='confirmed', seed=coalesce($2,seed) WHERE id=$1 RETURNING *", [prior.id, i.seed_s ?? null])).rows[0]
    : (await c.query("INSERT INTO discipline_nominations(discipline_id, participant_id, house_id, status, seed, created_by) VALUES ($1,$2,$3,'confirmed',$4,$5) RETURNING *", [d.id, p.id, p.house_id, i.seed_s ?? null, ctx.user.id])).rows[0];
  const isMinorAccount = p.user_id ? (await c.query(`SELECT 1 FROM users u WHERE u.id=$1 AND ${YOUTH_SQL}`, [p.user_id])).rowCount > 0 : false;
  let entrant = (await c.query('SELECT * FROM race_entrants WHERE discipline_id=$1 AND participant_id=$2', [d.id, p.id])).rows[0];
  if (entrant) entrant = (await c.query('UPDATE race_entrants SET nomination_id=$2, category_id=coalesce($3,category_id), updated_at=now() WHERE id=$1 RETURNING *', [entrant.id, nom.id, cat?.id ?? null])).rows[0];
  else entrant = (await c.query('INSERT INTO race_entrants(discipline_id, event_id, participant_id, nomination_id, category_id, source, external_ref, name_public, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [d.id, d.event_id, p.id, nom.id, cat?.id ?? null, source, i.external_ref ?? null, !!i.name_public && !isMinorAccount, ctx.user.id])
    .catch((e) => { if (e.code === '23505') throw conflict('That external reference is already used in this race'); throw e; })).rows[0];
  await raceLog(c, { discipline_id: d.id, entrant_id: entrant.id, subject: 'entrant', subject_id: entrant.id, action: 'entrant_added', after: { source }, actor_id: ctx.user.id });
  return { ...entrant, entry_state: nom.status, full_name: p.full_name };
}

cap({
  name: 'enter_race', method: 'POST', path: '/races/:id/entries', tag: TAG, status: 201,
  summary: 'Enter yourself in a race (entries must be open). Your declared gender is used for the gender rule of the race and category; a young account holder needs an active guardian consent for participation. Reuses the event participant record and the canonical nomination.',
  input: z.object({ id, gender: gender.optional(), category_id: id.optional(), seed_s: z.number().min(0).max(1e7).optional(), name_public: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d0 = (await c.query('SELECT d.*, s.event_id AS ev FROM race_setups s JOIN event_disciplines d ON d.id=s.discipline_id WHERE s.discipline_id=$1', [i.id])).rows[0];
      if (!d0) throw NO_ACCESS();
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [d0.event_id])).rows[0];
      await lockEvent(c, ev.id);
      const prog = (await c.query('SELECT nominations_open FROM event_programmes WHERE event_id=$1', [ev.id])).rows[0];
      if (!prog?.nominations_open || d0.status !== 'nominations') throw conflict('Entries are closed for this race');
      if (!(await hasConsent(user.id, 'participation', c))) throw forbidden('A guardian must give participation consent before you can enter');
      const ctx = { d: d0, ev, user, rules: (await currentPolicy(c, d0.id)).rules };
      const row = await addEntrant(c, ctx, { id: i.id, user_id: user.id, gender: i.gender, category_id: i.category_id, seed_s: i.seed_s, name_public: i.name_public }, { source: 'self' });
      return row;
    });
  },
});

cap({
  name: 'list_race_entrants', method: 'GET', path: '/races/:id/entrants', tag: TAG,
  summary: 'Entrants of a race in bib order, paged with a stable keyset cursor (`after`). Filter by free search (bib, chip or name), state, wave, category, or what is missing (bib, chip, wave). Organiser and timing crew only.',
  input: z.object({
    id, q: z.string().max(80).optional(), state: z.string().max(24).optional(), wave_id: id.optional(), category_id: id.optional(), missing: z.enum(['bib', 'chip', 'wave']).optional(),
    after: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await raceCtx(c, user, i.id);
      const args = [i.id], where = [ACTIVE_ENTRY];
      const p = (v) => { args.push(v); return `$${args.length}`; };
      if (i.q) { const q = p(i.q); where.push(`(lower(bib.ref)=lower(${q}) OR lower(chip.ref)=lower(${q}) OR p.full_name ILIKE '%' || ${q} || '%')`); }
      if (i.state) where.push(`e.race_status=${p(i.state)}`);
      if (i.wave_id) where.push(`e.wave_id=${p(i.wave_id)}`);
      if (i.category_id) where.push(`e.category_id=${p(i.category_id)}`);
      if (i.missing === 'bib') where.push('bib.id IS NULL');
      if (i.missing === 'chip') where.push('chip.id IS NULL');
      if (i.missing === 'wave') where.push('e.wave_id IS NULL');
      const bibSort = "coalesce((CASE WHEN bib.ref ~ '^[0-9]{1,15}$' THEN bib.ref::bigint END), 9223372036854775807)";
      const cur = decodeCursor(i.after);
      if (cur) where.push(`(${bibSort}, e.id) > (${p(cur[0])}::bigint, ${p(cur[1])}::uuid)`);
      const rows = (await c.query(`SELECT ${ENTRANT_SELECT}, ${bibSort} AS bib_sort FROM ${ENTRANT_FROM} WHERE e.discipline_id=$1 AND ${where.join(' AND ')} ORDER BY ${bibSort}, e.id LIMIT ${p(i.limit + 1)}`, args)).rows;
      const more = rows.length > i.limit;
      const items = rows.slice(0, i.limit);
      const last = items[items.length - 1];
      return { items: items.map(({ bib_sort, ...x }) => x), next: more && last ? encodeCursor([String(last.bib_sort), last.id]) : null };
    });
  },
});

cap({
  name: 'get_race_entrant', method: 'GET', path: '/race-entrants/:id', tag: TAG,
  summary: 'One entrant for the timing desk: identity as registered, bib and chip history (every reissue), wave history, governed status history with reasons (decrypted and audit-logged), current result and its older versions.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e0 = await mustEntrant(c, i.id);
      await raceCtx(c, user, e0.discipline_id);
      const [row, tags, waves, log, results, corrections] = await Promise.all([
        c.query(`SELECT ${ENTRANT_SELECT} FROM ${ENTRANT_FROM} WHERE e.id=$1`, [i.id]).then((r) => r.rows[0]),
        c.query('SELECT id, kind, ref, state, reason, from_at, to_at, actor_id FROM race_assignments WHERE entrant_id=$1 ORDER BY created_at, id', [i.id]).then((r) => r.rows),
        c.query('SELECT a.id, a.wave_id, w.name, w.start_at, a.reason, a.assigned_at, a.ended_at FROM race_wave_assignments a JOIN race_waves w ON w.id=a.wave_id WHERE a.entrant_id=$1 ORDER BY a.assigned_at, a.id', [i.id]).then((r) => r.rows),
        c.query('SELECT id, from_status, to_status, source, reason_enc, evidence, actor_id, created_at FROM race_status_log WHERE entrant_id=$1 ORDER BY created_at, id', [i.id]).then((r) => r.rows),
        c.query('SELECT id, version, race_status, official_time_ms, gun_time_ms, net_time_ms, adjustment_ms, basis_used, flags, splits, policy_version, course_version, superseded_at, created_at FROM race_results WHERE entrant_id=$1 ORDER BY version DESC', [i.id]).then((r) => r.rows),
        c.query('SELECT id, kind, state, payload, reason_enc, proposed_by, decided_by, decided_at, created_at FROM race_corrections WHERE entrant_id=$1 ORDER BY created_at', [i.id]).then((r) => r.rows),
      ]);
      const sealed = log.some((l) => l.reason_enc) || corrections.some((x) => x.reason_enc);
      if (sealed) await audit(c, user.id, 'read_race_reasons', 'race_entrant', i.id);
      return {
        entrant: row, tags, waves,
        status_history: log.map(({ reason_enc, ...l }) => ({ ...l, reason: openReason(reason_enc) })),
        results, corrections: corrections.map(({ reason_enc, ...x }) => ({ ...x, reason: openReason(reason_enc) })),
      };
    });
  },
});

cap({
  name: 'update_race_entrant', method: 'PATCH', path: '/race-entrants/:id', tag: TAG,
  summary: 'Change an entrant\'s declared category or public-name consent. The category is always an explicit organiser/entrant declaration (checked against the category gender rule), logged with who and when; published results keep what they showed until a corrected publication.',
  input: z.object({ id, category_id: id.nullable().optional(), name_public: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await mustEntrant(c, i.id, true);
      const ctx = await raceCtx(c, user, e.discipline_id, 'organizer');
      let cat = null;
      if (i.category_id) {
        cat = (await c.query('SELECT * FROM race_categories WHERE id=$1 AND discipline_id=$2 AND archived_at IS NULL', [i.category_id, e.discipline_id])).rows[0];
        if (!cat) throw notFound('Category');
        const why = eligible(ctx.d, ctx.rules, e, cat);
        if (why) throw badRequest(why);
      }
      if (i.name_public && e.user_id && (await c.query(`SELECT 1 FROM users u WHERE u.id=$1 AND ${YOUTH_SQL}`, [e.user_id])).rowCount) throw forbidden('A public name is never shown for a young account holder');
      const row = (await c.query(
        'UPDATE race_entrants SET category_id=CASE WHEN $2::boolean THEN $3 ELSE category_id END, name_public=coalesce($4,name_public), updated_at=now() WHERE id=$1 RETURNING *',
        [i.id, i.category_id !== undefined, i.category_id ?? null, i.name_public ?? null])).rows[0];
      if (i.category_id !== undefined) await raceLog(c, { discipline_id: e.discipline_id, entrant_id: e.id, subject: 'category', subject_id: e.id, action: 'entrant_category_changed', before: { category_id: e.category_id }, after: { category_id: row.category_id }, actor_id: user.id });
      return row;
    });
  },
});

// ---------------------------------------------------------------- bibs and chips

const reasonEnum = z.enum(['lost', 'damaged', 'replaced', 'wrong']);

cap({
  name: 'assign_race_tag', method: 'POST', path: '/race-entrants/:id/tags', tag: TAG, status: 201,
  summary: 'Give an entrant a bib number or a timing chip. A bib is unique within the policy scope (this race or the whole event), a chip is unique across the event. An entrant that already has a tag of that kind keeps it: use reissue_race_tag so the history is recorded.',
  input: z.object({ id, kind: z.enum(['bib', 'chip']), ref }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await mustEntrant(c, i.id, true);
      const ctx = await raceCtx(c, user, e.discipline_id, 'timing');
      await lockEvent(c, ctx.d.event_id);
      if (!['nominated', 'confirmed'].includes(e.entry_state)) throw conflict('This entrant has withdrawn');
      if ((await c.query("SELECT 1 FROM race_assignments WHERE entrant_id=$1 AND kind=$2 AND state='active'", [e.id, i.kind])).rowCount) throw conflict(`This entrant already has a ${i.kind}; reissue it to keep the history`);
      const r = await placeTag(c, ctx, e, { kind: i.kind, ref: i.ref });
      await raceLog(c, { discipline_id: e.discipline_id, entrant_id: e.id, subject: 'entrant', subject_id: e.id, action: `${i.kind}_assigned`, after: { ref: i.ref }, actor_id: user.id });
      return r.current;
    });
  },
});

cap({
  name: 'reissue_race_tag', method: 'POST', path: '/race-entrants/:id/tags/reissue', tag: TAG, status: 201,
  summary: 'Replace a lost, damaged or wrong bib or chip. The old tag is closed with the reason and the time (its earlier reads still count for this entrant), the new one opens now. The entrant, their registration and their result are the same single record, so a reissue can never create a second entrant or a duplicate result. A bib may be reprinted with the same number.',
  input: z.object({ id, kind: z.enum(['bib', 'chip']), reason: reasonEnum, new_ref: ref.optional(), note: z.string().max(200).optional(), effective_at: dt.optional().describe('when the swap really happened (defaults to now); reads of the old tag before it, and of the new tag from it, belong to the same entrant') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await mustEntrant(c, i.id, true);
      const ctx = await raceCtx(c, user, e.discipline_id, 'timing');
      await lockEvent(c, ctx.d.event_id);
      const live = (await c.query("SELECT * FROM race_assignments WHERE entrant_id=$1 AND kind=$2 AND state='active'", [e.id, i.kind])).rows[0];
      if (!live) throw conflict(`This entrant has no active ${i.kind}; assign one instead`);
      const next = i.new_ref ?? (i.kind === 'bib' ? live.ref : null);
      if (!next) throw badRequest('Give the new chip reference');
      if (next.toLowerCase() === live.ref.toLowerCase() && i.kind === 'chip') throw badRequest('That is the same chip');
      const at = i.effective_at ? new Date(i.effective_at) : null;
      if (at && at.getTime() > Date.now() + 60_000) throw badRequest('effective_at cannot be in the future');
      if (at && live.from_at instanceof Date && at <= live.from_at) throw badRequest('effective_at must be after the tag was assigned');
      const r = await placeTag(c, ctx, e, { kind: i.kind, ref: next, closeAs: i.reason === 'wrong' ? 'replaced' : i.reason, reason: i.note ?? i.reason, at });
      await raceLog(c, { discipline_id: e.discipline_id, entrant_id: e.id, subject: 'entrant', subject_id: e.id, action: `${i.kind}_reissued`, before: { ref: live.ref, state: r.previous.state }, after: { ref: next, reason: i.reason }, actor_id: user.id });
      return { entrant_id: e.id, previous: { ref: live.ref, state: i.reason === 'wrong' ? 'replaced' : i.reason }, current: r.current };
    });
  },
});

cap({
  name: 'release_race_tag', method: 'POST', path: '/race-entrants/:id/tags/release', tag: TAG,
  summary: 'Mark an entrant\'s bib or chip lost, damaged or released without a replacement yet. The entrant shows as unassigned on the timing desk until a new tag is assigned; reads already recorded stay attached to them.',
  input: z.object({ id, kind: z.enum(['bib', 'chip']), state: z.enum(['lost', 'damaged', 'released']), note: z.string().max(200).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await mustEntrant(c, i.id, true);
      const ctx = await raceCtx(c, user, e.discipline_id, 'timing');
      await lockEvent(c, ctx.d.event_id);
      const live = (await c.query("SELECT * FROM race_assignments WHERE entrant_id=$1 AND kind=$2 AND state='active' FOR UPDATE", [e.id, i.kind])).rows[0];
      if (!live) throw conflict(`This entrant has no active ${i.kind}`);
      const row = (await c.query('UPDATE race_assignments SET state=$2, to_at=now(), reason=coalesce($3,reason) WHERE id=$1 RETURNING *', [live.id, i.state, i.note ?? null])).rows[0];
      await raceLog(c, { discipline_id: e.discipline_id, entrant_id: e.id, subject: 'entrant', subject_id: e.id, action: `${i.kind}_${i.state}`, before: { ref: live.ref }, actor_id: user.id });
      return row;
    });
  },
});

cap({
  name: 'auto_assign_race_bibs', method: 'POST', path: '/races/:id/bibs/auto', tag: TAG,
  summary: 'Controlled bulk bib assignment for entrants that have none: numbers from `start` upwards (skipping any already in use in the bib scope), in registration order or by wave then seed. Dry run first; the result lists exactly who gets which number.',
  input: z.object({ id, start: z.number().int().min(0).max(9_999_999).default(1), step: z.number().int().min(1).max(100).default(1), prefix: z.string().max(6).default(''), order: z.enum(['registration', 'wave_seed']).default('registration'), dry_run: z.boolean().default(true) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await raceCtx(c, user, i.id, 'organizer');
      await lockEvent(c, ctx.d.event_id);
      const used = new Set((await c.query("SELECT lower(ref) AS r FROM race_assignments WHERE scope_key=$1 AND kind='bib' AND state='active'", [bibScope(ctx)])).rows.map((r) => r.r));
      const order = i.order === 'wave_seed' ? 'w.position NULLS LAST, w.start_at NULLS LAST, n.seed NULLS LAST, e.created_at, e.id' : 'e.created_at, e.id';
      const todo = (await c.query(
        `SELECT e.id, p.full_name FROM race_entrants e JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id LEFT JOIN race_waves w ON w.id=e.wave_id
          WHERE e.discipline_id=$1 AND ${ACTIVE_ENTRY} AND NOT EXISTS (SELECT 1 FROM race_assignments a WHERE a.entrant_id=e.id AND a.kind='bib' AND a.state='active') ORDER BY ${order}`, [i.id])).rows;
      const plan = [];
      let num = i.start;
      for (const e of todo) {
        let r = `${i.prefix}${num}`;
        while (used.has(r.toLowerCase())) { num += i.step; r = `${i.prefix}${num}`; }
        used.add(r.toLowerCase());
        plan.push({ entrant_id: e.id, full_name: e.full_name, bib: r });
        num += i.step;
      }
      if (!i.dry_run && plan.length) {
        for (const part of chunk(plan, 2000)) await c.query(
          `INSERT INTO race_assignments(entrant_id, discipline_id, event_id, kind, ref, scope_key, actor_id, from_at)
           SELECT eid, $1, $2, 'bib', r, $3, $4, ${FIRST_HOLDER('$3::uuid', "'bib'", 'r')} FROM unnest($5::uuid[], $6::text[]) AS t(eid, r)`, [i.id, ctx.d.event_id, bibScope(ctx), user.id, part.map((p) => p.entrant_id), part.map((p) => p.bib)]);
        await raceLog(c, { discipline_id: i.id, subject: 'entrant', action: 'bibs_auto_assigned', after: { count: plan.length, first: plan[0].bib, last: plan[plan.length - 1].bib }, actor_id: user.id });
      }
      return { dry_run: i.dry_run, assigned: plan.length, first: plan[0]?.bib ?? null, last: plan[plan.length - 1]?.bib ?? null, sample: plan.slice(0, 20) };
    });
  },
});

cap({
  name: 'import_race_chips', method: 'POST', path: '/races/:id/chips/import', tag: TAG,
  summary: 'Pair timing chips with bibs from a list (up to 5000 `{bib, chip}` rows or CSV text), dry run first. Rejects unknown bibs, chips already in use, repeats in the file and entrants that already have a chip (those use reissue_race_tag).',
  input: z.object({ id, dry_run: z.boolean().default(true), csv: z.string().max(2_000_000).optional(), rows: z.array(z.object({ bib: ref, chip: ref })).max(5000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await raceCtx(c, user, i.id, 'timing');
      await lockEvent(c, ctx.d.event_id);
      let rows = i.rows ?? [];
      if (i.csv) { try { rows = parseCsv(i.csv, { maxRows: 5000 }).map((r) => ({ bib: r.bib, chip: r.chip })); } catch (e) { throw badRequest(e.message); } }
      if (!rows.length) throw badRequest('Send `rows` or `csv`');
      const bibs = new Map((await c.query(
        `SELECT lower(a.ref) AS ref, e.id, (SELECT 1 FROM race_assignments x WHERE x.entrant_id=e.id AND x.kind='chip' AND x.state='active') AS has_chip
           FROM race_assignments a JOIN race_entrants e ON e.id=a.entrant_id WHERE a.discipline_id=$1 AND a.kind='bib' AND a.state='active'`, [i.id])).rows.map((r) => [r.ref, r]));
      const chipsUsed = new Set((await c.query("SELECT lower(ref) AS r FROM race_assignments WHERE scope_key=$1 AND kind='chip' AND state='active'", [ctx.d.event_id])).rows.map((r) => r.r));
      const errors = [], ok = [], seenB = new Set(), seenC = new Set();
      rows.forEach((r, k) => {
        const bib = String(r.bib ?? '').trim(), chip = String(r.chip ?? '').trim();
        const bad = (field, message) => errors.push({ row: k + 1, field, message });
        if (!bib || !chip) return bad('row', 'Both bib and chip are needed');
        if (chip.length > 40 || bib.length > 40) return bad('row', 'Too long');
        const e = bibs.get(bib.toLowerCase());
        if (!e) return bad('bib', `No entrant has bib ${bib}`);
        if (e.has_chip) return bad('bib', `Bib ${bib} already has a chip; use reissue`);
        if (seenB.has(bib.toLowerCase())) return bad('bib', 'Bib repeated in this file');
        if (seenC.has(chip.toLowerCase())) return bad('chip', 'Chip repeated in this file');
        if (chipsUsed.has(chip.toLowerCase())) return bad('chip', `Chip ${chip} is already assigned`);
        seenB.add(bib.toLowerCase()); seenC.add(chip.toLowerCase());
        ok.push({ entrant_id: e.id, chip });
      });
      if (i.dry_run) return { dry_run: true, received: rows.length, will_assign: ok.length, rejected: errors.length, errors: errors.slice(0, 500) };
      if (errors.length) throw badRequest('Fix the rows with errors and import again; nothing was imported', { errors: errors.slice(0, 500) });
      for (const part of chunk(ok, 2000)) await c.query(
        `INSERT INTO race_assignments(entrant_id, discipline_id, event_id, kind, ref, scope_key, actor_id, from_at)
         SELECT eid, $1, $2, 'chip', r, $2, $3, ${FIRST_HOLDER('$2::uuid', "'chip'", 'r')} FROM unnest($4::uuid[], $5::text[]) AS t(eid, r)`, [i.id, ctx.d.event_id, user.id, part.map((p) => p.entrant_id), part.map((p) => p.chip)]);
      await raceLog(c, { discipline_id: i.id, subject: 'import', action: 'chips_imported', after: { count: ok.length }, actor_id: user.id });
      return { dry_run: false, received: rows.length, assigned: ok.length };
    });
  },
});

cap({
  name: 'find_race_entrant', method: 'GET', path: '/races/:id/find', tag: TAG,
  summary: 'Timing-desk lookup by bib, chip, scanned QR payload or name, for the finish queue and the bib-collection desk. Returns the few matches with bib, chip, wave and race status.',
  input: z.object({ id, q: z.string().trim().min(1).max(120) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await raceCtx(c, user, i.id);
      const q = i.q.startsWith('SA1:') ? i.q.split(':').pop() : i.q;
      return (await c.query(
        `SELECT ${ENTRANT_SELECT} FROM ${ENTRANT_FROM}
          WHERE e.discipline_id=$1 AND ${ACTIVE_ENTRY} AND (lower(bib.ref)=lower($2) OR lower(chip.ref)=lower($2) OR p.full_name ILIKE '%' || $2 || '%')
          ORDER BY (lower(bib.ref)=lower($2) OR lower(chip.ref)=lower($2)) DESC, p.full_name LIMIT 10`, [i.id, q])).rows;
    });
  },
});

cap({
  name: 'get_race_bib_code', method: 'GET', path: '/race-entrants/:id/bib-code', tag: TAG,
  summary: 'The bib\'s QR code (SVG) and its payload `SA1:<race>:<bib>` for printing on the bib or the entry confirmation; scanning it into find_race_entrant opens the entrant. The payload holds only the race and bib number, no personal data.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await mustEntrant(c, i.id);
      await raceCtx(c, user, e.discipline_id);
      const bib = (await c.query("SELECT ref FROM race_assignments WHERE entrant_id=$1 AND kind='bib' AND state='active'", [i.id])).rows[0];
      if (!bib) throw conflict('This entrant has no bib yet');
      const payload = `SA1:${e.discipline_id.slice(0, 8)}:${bib.ref}`;
      const q = qrcode(0, 'M'); q.addData(payload); q.make();
      return { bib_no: bib.ref, payload, qr_svg: q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) };
    });
  },
});

// ---------------------------------------------------------------- waves / corrals / start groups

const waveBasis = z.enum(['category', 'seed', 'accessibility', 'team', 'organiser']);
const waveIn = { name: z.string().trim().min(1).max(60), start_at: dt, capacity: z.number().int().min(1).max(100000), basis: waveBasis.default('organiser'), basis_note: z.string().max(200).optional(), category_id: id.optional() };

cap({
  name: 'create_race_wave', method: 'POST', path: '/races/:id/waves', tag: TAG, status: 201,
  summary: 'Create a wave / corral / start group with a start time, a hard capacity and the basis it is built on (category, expected performance, accessibility, team or organiser policy) with a note of the seed or reference used.',
  input: z.object({ id, ...waveIn }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await raceCtx(c, user, i.id, 'organizer');
      if (i.category_id && !(await c.query('SELECT 1 FROM race_categories WHERE id=$1 AND discipline_id=$2', [i.category_id, i.id])).rowCount) throw notFound('Category');
      const pos = (await c.query('SELECT coalesce(max(position),0)+1 AS n FROM race_waves WHERE discipline_id=$1', [i.id])).rows[0].n;
      try {
        const row = (await c.query('INSERT INTO race_waves(discipline_id, name, position, start_at, capacity, basis, basis_note, category_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [i.id, i.name, pos, i.start_at, i.capacity, i.basis, i.basis_note ?? null, i.category_id ?? null, user.id])).rows[0];
        await raceLog(c, { discipline_id: i.id, subject: 'wave', subject_id: row.id, action: 'wave_created', after: { name: row.name, start_at: row.start_at, capacity: row.capacity }, actor_id: user.id });
        return row;
      } catch (e) { if (e.code === '23505') throw conflict('A wave with that name already exists'); throw e; }
    });
  },
});

async function waveOf(c, waveId, lock = false) {
  const w = (await c.query(`SELECT w.*, (SELECT count(*)::int FROM race_wave_assignments a WHERE a.wave_id=w.id AND a.ended_at IS NULL) AS assigned FROM race_waves w WHERE w.id=$1 ${lock ? 'FOR UPDATE OF w' : ''}`, [waveId])).rows[0];
  if (!w) throw NO_ACCESS('Wave');
  return w;
}

cap({
  name: 'update_race_wave', method: 'PATCH', path: '/race-waves/:id', tag: TAG,
  summary: 'Change a wave\'s name, start time, capacity (never below who is assigned) or status (open, closed, cancelled once empty). Every change is logged with before and after, and entrants of a wave whose start time changed are notified (with the guardians of young account holders).',
  input: z.object({ id, name: z.string().trim().min(1).max(60).optional(), start_at: dt.optional(), capacity: z.number().int().min(1).max(100000).optional(), status: z.enum(['open', 'closed', 'cancelled']).optional(), basis: waveBasis.optional(), basis_note: z.string().max(200).nullable().optional(), reason: z.string().max(200).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const w = await waveOf(c, i.id, true);
      await raceCtx(c, user, w.discipline_id, 'organizer');
      if (w.status === 'started' && (i.start_at || i.capacity)) throw conflict('The wave has started; its start time and capacity are fixed');
      if (w.status === 'cancelled') throw conflict('The wave is cancelled');
      if (i.capacity !== undefined && i.capacity < w.assigned) throw conflict(`${w.assigned} entrants are assigned; capacity cannot be lower`);
      if (i.status === 'cancelled' && w.assigned > 0) throw conflict('Move the entrants to another wave first');
      if (i.status && w.status === 'started') throw conflict('The wave has started');
      const row = (await c.query(
        `UPDATE race_waves SET name=coalesce($2,name), start_at=coalesce($3,start_at), capacity=coalesce($4,capacity), status=coalesce($5,status), basis=coalesce($6,basis),
                basis_note=CASE WHEN $7::boolean THEN $8 ELSE basis_note END, updated_at=now() WHERE id=$1 RETURNING *`,
        [i.id, i.name ?? null, i.start_at ?? null, i.capacity ?? null, i.status ?? null, i.basis ?? null, i.basis_note !== undefined, i.basis_note ?? null]).catch((e) => { if (e.code === '23505') throw conflict('A wave with that name already exists'); throw e; })).rows[0];
      await raceLog(c, { discipline_id: w.discipline_id, subject: 'wave', subject_id: w.id, action: 'wave_updated', before: { name: w.name, start_at: w.start_at, capacity: w.capacity, status: w.status }, after: { name: row.name, start_at: row.start_at, capacity: row.capacity, status: row.status, reason: i.reason ?? null }, actor_id: user.id });
      let notified = 0;
      if (i.start_at && new Date(i.start_at).getTime() !== new Date(w.start_at).getTime()) {
        const ids = (await c.query('SELECT entrant_id FROM race_wave_assignments WHERE wave_id=$1 AND ended_at IS NULL', [w.id])).rows.map((r) => r.entrant_id);
        notified = await notifyEntrants(c, ids, { kind: 'race_wave', title: `Start time changed: ${w.name}`, body: `Your wave now starts at ${new Date(i.start_at).toISOString()}.${i.reason ? ` ${i.reason}` : ''}`, data: { discipline_id: w.discipline_id, wave_id: w.id } });
        await c.query('UPDATE race_wave_assignments SET notified_at=now() WHERE wave_id=$1 AND ended_at IS NULL', [w.id]);
      }
      return { ...row, notified };
    });
  },
});

async function moveEntrants(c, ctx, wave, entrantIds, reason) {
  const ents = (await c.query(
    `SELECT e.id, e.category_id, e.wave_id FROM race_entrants e JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id
      WHERE e.id = ANY($1) AND e.discipline_id=$2 AND ${ACTIVE_ENTRY} ORDER BY e.id FOR UPDATE OF e`, [entrantIds, ctx.d.id])).rows;
  if (ents.length !== new Set(entrantIds).size) throw notFound('Entrant');
  const moving = ents.filter((e) => e.wave_id !== wave.id);
  if (!moving.length) return { moved: 0, notified: 0 };
  if (wave.status !== 'open') throw conflict(`Wave "${wave.name}" is ${wave.status}`);
  if (wave.category_id && moving.some((e) => e.category_id !== wave.category_id)) throw conflict(`Wave "${wave.name}" is reserved for one category`);
  if (wave.assigned + moving.length > wave.capacity) throw conflict(`Wave "${wave.name}" has ${wave.capacity - wave.assigned} places left; ${moving.length} requested`, { capacity: wave.capacity, assigned: wave.assigned });
  const ids = moving.map((e) => e.id);
  await c.query('UPDATE race_wave_assignments SET ended_at=now() WHERE entrant_id = ANY($1) AND ended_at IS NULL', [ids]);
  await c.query('INSERT INTO race_wave_assignments(entrant_id, wave_id, reason, actor_id, notified_at) SELECT x, $2, $3, $4, now() FROM unnest($1::uuid[]) AS x', [ids, wave.id, reason ?? null, ctx.user.id]);
  await c.query('UPDATE race_entrants SET wave_id=$2, updated_at=now() WHERE id = ANY($1)', [ids, wave.id]);
  await raceLog(c, { discipline_id: ctx.d.id, subject: 'wave', subject_id: wave.id, action: 'entrants_moved', after: { count: ids.length, reason: reason ?? null }, actor_id: ctx.user.id });
  const notified = await notifyEntrants(c, ids, { kind: 'race_wave', title: `Your start wave: ${wave.name}`, body: `You are in ${wave.name}, starting ${new Date(wave.start_at).toISOString()}.${reason ? ` ${reason}` : ''}`, data: { discipline_id: ctx.d.id, wave_id: wave.id } });
  return { moved: ids.length, notified };
}

cap({
  name: 'assign_race_wave', method: 'POST', path: '/race-waves/:id/entrants', tag: TAG,
  summary: 'Place (or move) up to 500 entrants into a wave. The capacity is enforced on the server under a lock, a category-reserved wave only takes that category, the previous place is closed (not erased) and the affected entrants are notified.',
  input: z.object({ id, entrant_ids: z.array(id).min(1).max(500), reason: z.string().max(200).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const w = await waveOf(c, i.id, true);
      const ctx = await raceCtx(c, user, w.discipline_id, 'organizer');
      return moveEntrants(c, ctx, await waveOf(c, i.id), i.entrant_ids, i.reason);
    });
  },
});

cap({
  name: 'auto_assign_race_waves', method: 'POST', path: '/races/:id/waves/auto', tag: TAG,
  summary: 'Fill waves for entrants that have none. `seed`: fastest declared seed first into the earliest wave; `category`: entrants go to the wave reserved for their category; `fill`: registration order. Capacity is respected; whoever does not fit is listed, never squeezed in. Dry run first.',
  input: z.object({ id, strategy: z.enum(['seed', 'category', 'fill']), dry_run: z.boolean().default(true) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await raceCtx(c, user, i.id, 'organizer');
      await lockEvent(c, ctx.d.event_id);
      const waves = (await c.query(
        `SELECT w.*, (SELECT count(*)::int FROM race_wave_assignments a WHERE a.wave_id=w.id AND a.ended_at IS NULL) AS assigned FROM race_waves w WHERE w.discipline_id=$1 AND w.status='open' ORDER BY w.position, w.start_at, w.id FOR UPDATE OF w`, [i.id])).rows;
      const todo = (await c.query(
        `SELECT e.id, e.category_id, n.seed FROM race_entrants e JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id
          WHERE e.discipline_id=$1 AND ${ACTIVE_ENTRY} AND e.wave_id IS NULL ORDER BY ${i.strategy === 'seed' ? 'n.seed ASC NULLS LAST,' : ''} e.created_at, e.id`, [i.id])).rows;
      const plan = new Map(waves.map((w) => [w.id, []]));
      const left = new Map(waves.map((w) => [w.id, w.capacity - w.assigned]));
      const unplaced = [];
      for (const e of todo) {
        const w = waves.find((x) => left.get(x.id) > 0 && (i.strategy === 'category' ? x.category_id === e.category_id && x.category_id : !x.category_id || x.category_id === e.category_id));
        if (!w) { unplaced.push(e.id); continue; }
        plan.get(w.id).push(e.id); left.set(w.id, left.get(w.id) - 1);
      }
      const summary = waves.map((w) => ({ wave_id: w.id, name: w.name, will_add: plan.get(w.id).length, free_after: left.get(w.id) }));
      let notified = 0;
      if (!i.dry_run) for (const w of waves) if (plan.get(w.id).length) notified += (await moveEntrants(c, ctx, { ...w, assigned: w.assigned }, plan.get(w.id), `Placed by ${i.strategy}`)).notified;
      return { dry_run: i.dry_run, placed: todo.length - unplaced.length, unplaced: unplaced.length, unplaced_sample: unplaced.slice(0, 20), waves: summary, notified };
    });
  },
});

cap({
  name: 'record_wave_gun', method: 'POST', path: '/race-waves/:id/gun', tag: TAG,
  summary: 'Record the actual gun time of a wave (default now) and mark it started. Gun times drive gun-clock results and cutoffs. Correcting a recorded gun time needs a chief official and a reason, is logged, and marks results to be re-reconciled.',
  input: z.object({ id, gun_at: dt.optional(), reason: z.string().max(200).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const w = await waveOf(c, i.id, true);
      const ctx = await raceCtx(c, user, w.discipline_id, w.gun_at ? 'chief' : 'timing');
      if (w.status === 'cancelled') throw conflict('The wave is cancelled');
      if (w.gun_at && !i.reason) throw badRequest('A gun time is already recorded; give the reason for changing it');
      if ((await c.query("SELECT 1 FROM race_publications WHERE discipline_id=$1 AND label IN ('final','corrected') LIMIT 1", [w.discipline_id])).rowCount) throw conflict('Results are final; correct the time through a governed correction');
      const gun = i.gun_at ?? new Date().toISOString();
      const row = (await c.query("UPDATE race_waves SET gun_at=$2, status='started', updated_at=now() WHERE id=$1 RETURNING *", [i.id, gun])).rows[0];
      await raceLog(c, { discipline_id: w.discipline_id, subject: 'wave', subject_id: w.id, action: w.gun_at ? 'gun_corrected' : 'gun_recorded', before: { gun_at: w.gun_at }, after: { gun_at: row.gun_at, reason: i.reason ?? null }, actor_id: ctx.user.id });
      return row;
    });
  },
});

// ---------------------------------------------------------------- course and checkpoints (versioned competition timing metadata)

const checkpointIn = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,16}$/), label: z.string().trim().min(1).max(60), kind: z.enum(['start', 'split', 'lap', 'finish']),
  distance_m: z.number().min(0).max(1e7), read_rule: z.enum(['first', 'last']).default('first'), cutoff_s: z.number().int().min(1).max(10 * 86400).optional(),
});

cap({
  name: 'create_race_course', method: 'POST', path: '/races/:id/courses', tag: TAG, status: 201,
  summary: 'Define a course version as a draft: ordered checkpoints (start, splits, laps, finish) with distance, which read counts when a chip is read more than once, and optional cutoffs. Checkpoints are competition timing points, not navigation. Publish it with publish_race_course; a published version is immutable and the next change is a new version.',
  input: z.object({ id, name: z.string().trim().min(1).max(80), unit: z.enum(['km', 'mi', 'm']).default('km'), total_distance_m: z.number().positive().max(1e7), notes: z.string().max(500).optional(), checkpoints: z.array(checkpointIn).min(2).max(60) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await raceCtx(c, user, i.id, 'organizer');
      const cps = i.checkpoints;
      if (cps[0].kind !== 'start' || cps[cps.length - 1].kind !== 'finish') throw badRequest('A course begins with a start checkpoint and ends with a finish checkpoint');
      if (cps.filter((x) => x.kind === 'start').length !== 1 || cps.filter((x) => x.kind === 'finish').length !== 1) throw badRequest('Exactly one start and one finish');
      if (new Set(cps.map((x) => x.code)).size !== cps.length) throw badRequest('Checkpoint codes must be unique');
      cps.forEach((x, k) => { if (k && x.distance_m < cps[k - 1].distance_m) throw badRequest(`Checkpoint ${x.code} is before ${cps[k - 1].code} by distance`); });
      if (Math.abs(cps[cps.length - 1].distance_m - i.total_distance_m) > i.total_distance_m * 0.01) throw badRequest('The finish distance must match the total distance (within 1%)');
      await lockRace(c, i.id);
      const v = (await c.query('SELECT coalesce(max(version),0)+1 AS n FROM race_courses WHERE discipline_id=$1', [i.id])).rows[0].n;
      await c.query("UPDATE race_courses SET status='retired' WHERE discipline_id=$1 AND status='draft'", [i.id]);
      const course = (await c.query('INSERT INTO race_courses(discipline_id, version, name, unit, total_distance_m, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [i.id, v, i.name, i.unit, i.total_distance_m, i.notes ?? null, user.id])).rows[0];
      for (const [k, x] of cps.entries()) await c.query('INSERT INTO race_checkpoints(course_id, seq, code, label, kind, distance_m, read_rule, cutoff_s) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [course.id, k + 1, x.code, x.label, x.kind, x.distance_m, x.read_rule, x.cutoff_s ?? null]);
      await raceLog(c, { discipline_id: i.id, subject: 'course', subject_id: course.id, action: 'course_drafted', after: { version: v, checkpoints: cps.length }, actor_id: user.id });
      return { ...course, checkpoints: (await c.query('SELECT * FROM race_checkpoints WHERE course_id=$1 ORDER BY seq', [course.id])).rows };
    });
  },
});

cap({
  name: 'publish_race_course', method: 'POST', path: '/race-courses/:id/publish', tag: TAG,
  summary: 'Publish a draft course version. The previous published version is retired (kept, with every result that used it). A course cannot change after results are final.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const course = (await c.query('SELECT * FROM race_courses WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!course) throw NO_ACCESS('Course');
      await raceCtx(c, user, course.discipline_id, 'organizer');
      await lockRace(c, course.discipline_id);
      if (course.status !== 'draft') throw conflict(`Course is ${course.status}`);
      if ((await c.query("SELECT 1 FROM race_publications WHERE discipline_id=$1 AND label IN ('final','corrected') LIMIT 1", [course.discipline_id])).rowCount) throw conflict('Results are final; the course can no longer change');
      await c.query("UPDATE race_courses SET status='retired' WHERE discipline_id=$1 AND status='published'", [course.discipline_id]);
      const row = (await c.query("UPDATE race_courses SET status='published', published_by=$2, published_at=now() WHERE id=$1 RETURNING *", [i.id, user.id])).rows[0];
      await raceLog(c, { discipline_id: course.discipline_id, subject: 'course', subject_id: course.id, action: 'course_published', after: { version: row.version }, actor_id: user.id });
      return row;
    });
  },
});

cap({
  name: 'list_race_courses', method: 'GET', path: '/races/:id/courses', tag: TAG,
  summary: 'Every course version of a race with its checkpoints (published, draft and retired).',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    await raceCtx(c, user, i.id);
    const courses = (await c.query('SELECT * FROM race_courses WHERE discipline_id=$1 ORDER BY version DESC', [i.id])).rows;
    const cps = (await c.query('SELECT * FROM race_checkpoints WHERE course_id = ANY($1) ORDER BY course_id, seq', [courses.map((x) => x.id)])).rows;
    return courses.map((x) => ({ ...x, checkpoints: cps.filter((p) => p.course_id === x.id) }));
  }),
});
