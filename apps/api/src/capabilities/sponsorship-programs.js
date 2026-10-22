// Sponsorship programs and funding rounds (#284). A program is a brand's funding container (budget, eligibility, caps) run in
// one-off or recurring rounds; an award becomes an ordinary `sponsorships` row (see sponsors.js), so agreements, obligations
// and payments stay where they are. Submitted applications keep a copy of the terms they were made under.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { audit, isAdmin, mustFind, PUBLIC_USER } from '../helpers.js';
import { notify } from '../notify.js';
import { badgesFor } from '../verification.js';
import { toCsv } from '../csv.js';
import { logHistory, saveLines } from '../sponsor-agreements.js';
import { buildSchedule } from '../sponsor-schedule.js';
import { sponsorAccess, assertSponsorCan, notifySponsor, sponsorBrandSql } from '../sponsor-access.js';

const date = z.string().date();
const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. USD');
const TARGETS = ['event', 'team', 'athlete'];
const slugs = z.array(z.string().min(1).max(60)).max(30);
const regions = z.array(z.string().min(1).max(80)).max(30);
const TRANSITIONS = { draft: ['published', 'archived'], published: ['closed'], closed: ['published', 'archived'], archived: [] };
const CADENCE_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };
const recurrence = z.object({ cadence: z.enum(['monthly', 'quarterly', 'yearly']), open_days: z.number().int().min(1).max(365) });

/** The state of a round right now, derived from its dates unless it was closed explicitly. Server date. */
const roundState = (a = 'r') => `(CASE WHEN ${a}.status='closed' OR current_date > ${a}.closes_on THEN 'closed' WHEN current_date < ${a}.opens_on THEN 'scheduled' ELSE 'open' END)`;
const lastRoundOf = (rows) => rows.reduce((m, r) => (r.seq > m.seq ? r : m), rows[0]);

/** pg returns a date as local midnight; format it back without a timezone shift. */
const iso = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d);
const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const addMonths = (d, n) => { // month-end clamps (31 Jan + 1 month = 28/29 Feb)
  const t = new Date(`${d}T00:00:00Z`), day = t.getUTCDate();
  t.setUTCDate(1); t.setUTCMonth(t.getUTCMonth() + n);
  t.setUTCDate(Math.min(day, new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()));
  return t.toISOString().slice(0, 10);
};

/** The terms an applicant applies under, copied onto the application at submit. Internal budgets are not part of it. */
const termsOf = (p, r) => ({
  program: { id: p.id, name: p.name, objective: p.objective, currency: p.currency, sports: p.sports, regions: p.regions, eligibility: p.eligibility, starts_on: iso(p.starts_on), ends_on: iso(p.ends_on), max_award_cents: p.max_award_cents, row_version: p.row_version },
  round: { id: r.id, seq: r.seq, name: r.name, opens_on: iso(r.opens_on), closes_on: iso(r.closes_on), terms_version: r.terms_version },
});

const PROGRAM_ROUND_BUDGET = 'a round budget cannot exceed the program budget';

async function brandFor(user, sponsorId, action, c) {
  const sp = await mustFind('sponsors', sponsorId, '*', c);
  if (!isAdmin(user)) assertSponsorCan(await sponsorAccess(user, sp, c), action, { departmentId: null, what: action === 'export' ? 'export program data' : 'run sponsorship programs' });
  return sp;
}
/** Loads a program (optionally locked) and checks the caller may do the action for its brand. */
async function programFor(user, programId, action, c, lock = false) {
  const p = (await c.query(`SELECT * FROM sponsorship_programs WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [programId])).rows[0];
  if (!p) throw notFound('Sponsorship program');
  const sp = await brandFor(user, p.sponsor_id, action, c);
  return { p, sp };
}
const checkVersion = (row, v, what) => { if (row.row_version !== v) throw conflict(`This ${what} was changed by someone else (now version ${row.row_version}); the latest was loaded, review it and try again`, { current_version: row.row_version }); };

async function validateSports(list) {
  if (!list?.length) return;
  const found = await many('SELECT slug FROM sports WHERE slug = ANY($1)', [list]);
  const missing = list.filter((s) => !found.some((f) => f.slug === s));
  if (missing.length) throw badRequest(`Unknown sport(s): ${missing.join(', ')}`);
}
/** Money that is already committed by awards, for the program and per round. */
const committed = async (c, programId) => {
  const r = (await c.query("SELECT coalesce(sum(awarded_cents),0)::bigint AS cents, count(*)::int AS n FROM sponsorship_applications WHERE program_id=$1 AND status='awarded'", [programId])).rows[0];
  return { cents: Number(r.cents), n: r.n };
};
const committedRound = async (c, roundId) => {
  const r = (await c.query("SELECT coalesce(sum(awarded_cents),0)::bigint AS cents, count(*)::int AS n FROM sponsorship_applications WHERE round_id=$1 AND status='awarded'", [roundId])).rows[0];
  return { cents: Number(r.cents), n: r.n };
};
const saveTerms = (c, round, userId) => c.query('INSERT INTO sponsorship_round_terms(round_id, version, snapshot, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
  [round.id, round.terms_version, { name: round.name, opens_on: iso(round.opens_on), closes_on: iso(round.closes_on), budget_cents: round.budget_cents, max_awards: round.max_awards }, userId]);

async function targetOwnerOf(c, type, targetId) {
  const r = type === 'event' ? await c.query('SELECT organizer_id AS o FROM events WHERE id=$1', [targetId])
    : type === 'team' ? await c.query('SELECT owner_id AS o FROM teams WHERE id=$1', [targetId])
      : await c.query('SELECT id AS o FROM users WHERE id=$1', [targetId]);
  if (!r.rows[0]) throw notFound(type);
  return r.rows[0].o;
}

const PROGRAM_FIELDS = {
  name: z.string().min(2).max(120), objective: z.string().max(2000), sports: slugs, regions,
  target_types: z.array(z.enum(TARGETS)).min(1).max(3), verified_only: z.boolean(),
  starts_on: date, ends_on: date, max_award_cents: money.min(1), max_awards: z.number().int().min(1).max(10000), recurrence,
};

cap({
  name: 'create_sponsorship_program', method: 'POST', path: '/sponsorship-programs', tag: 'Sponsors', status: 201,
  summary: 'Brand manager/approver: create a draft sponsorship program (objective, budget in one currency, sports, regions, eligibility, dates, award caps, owner and optional recurrence). It is invisible to applicants until published. Add rounds with create_program_round.',
  input: z.object({
    sponsor_id: id, owner_id: id.optional().describe('the person accountable for the program; must run the brand (default: you)'),
    name: PROGRAM_FIELDS.name, objective: PROGRAM_FIELDS.objective.optional(), currency, budget_cents: money,
    sports: PROGRAM_FIELDS.sports.default([]), regions: PROGRAM_FIELDS.regions.default([]),
    target_types: PROGRAM_FIELDS.target_types.default(['athlete', 'team', 'event']), verified_only: z.boolean().default(false),
    starts_on: date.optional(), ends_on: date.optional(), max_award_cents: PROGRAM_FIELDS.max_award_cents.optional(), max_awards: PROGRAM_FIELDS.max_awards.optional(), recurrence: recurrence.optional(),
  }),
  async handler({ user }, i) {
    const sp = await brandFor(user, i.sponsor_id, 'program', pool);
    return create(user, sp, i);
  },
});
async function create(user, sp, i) {
  if (i.starts_on && i.ends_on && i.ends_on < i.starts_on) throw badRequest('ends_on is before starts_on');
  if (i.max_award_cents && i.budget_cents && i.max_award_cents > i.budget_cents) throw badRequest('The maximum award cannot exceed the budget');
  await validateSports(i.sports);
  const ownerId = i.owner_id ?? user.id;
  if (ownerId !== user.id) {
    const owner = (await many('SELECT id, roles FROM users WHERE id=$1', [ownerId]))[0];
    if (!owner) throw notFound('Owner');
    if (!(await sponsorAccess(owner, sp)) && !isAdmin(owner)) throw badRequest('The owner must run this brand');
  }
  return tx(async (c) => {
    const row = (await c.query(
      `INSERT INTO sponsorship_programs(sponsor_id, owner_id, created_by, name, objective, currency, budget_cents, sports, regions, eligibility, starts_on, ends_on, max_award_cents, max_awards, recurrence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [sp.id, ownerId, user.id, i.name, i.objective ?? null, i.currency, i.budget_cents, i.sports, i.regions, { target_types: i.target_types, verified_only: i.verified_only }, i.starts_on ?? null, i.ends_on ?? null, i.max_award_cents ?? null, i.max_awards ?? null, i.recurrence ?? null])).rows[0];
    await audit(c, user.id, 'create', 'sponsorship_programs', row.id);
    return row;
  });
}

cap({
  name: 'update_sponsorship_program', method: 'PATCH', path: '/sponsorship-programs/:id', tag: 'Sponsors',
  summary: 'Brand manager/approver: change a draft or published program. Needs the current `version`; a stale version is rejected (409). Changes apply to future applications only: every submitted application keeps the terms it was made under. The budget cannot go below what is already awarded, and the currency can only change while nothing is awarded.',
  input: z.object({
    id, version: z.coerce.number().int().positive(),
    name: PROGRAM_FIELDS.name.optional(), objective: PROGRAM_FIELDS.objective.nullable().optional(), budget_cents: money.optional(), currency: currency.optional(),
    sports: PROGRAM_FIELDS.sports.optional(), regions: PROGRAM_FIELDS.regions.optional(), target_types: PROGRAM_FIELDS.target_types.optional(), verified_only: z.boolean().optional(),
    starts_on: date.nullable().optional(), ends_on: date.nullable().optional(), max_award_cents: PROGRAM_FIELDS.max_award_cents.nullable().optional(), max_awards: PROGRAM_FIELDS.max_awards.nullable().optional(), recurrence: recurrence.nullable().optional(),
    owner_id: id.optional(),
  }),
  async handler({ user }, i) {
    await validateSports(i.sports);
    return tx(async (c) => {
      const { p, sp } = await programFor(user, i.id, 'program', c, true);
      checkVersion(p, i.version, 'program');
      if (!['draft', 'published'].includes(p.status)) throw conflict(`A ${p.status} program cannot be edited`);
      const used = await committed(c, p.id);
      const next = { ...p, ...Object.fromEntries(['name', 'objective', 'budget_cents', 'currency', 'sports', 'regions', 'starts_on', 'ends_on', 'max_award_cents', 'max_awards', 'recurrence', 'owner_id'].filter((k) => i[k] !== undefined).map((k) => [k, i[k]])) };
      if (i.currency && i.currency !== p.currency && used.n) throw conflict('The currency cannot change once an award has been made');
      if (next.budget_cents < used.cents) throw conflict(`The budget cannot be lower than what is already awarded (${used.cents})`);
      if (next.starts_on && next.ends_on && next.ends_on < next.starts_on) throw badRequest('ends_on is before starts_on');
      if (next.max_award_cents && next.budget_cents && next.max_award_cents > next.budget_cents) throw badRequest('The maximum award cannot exceed the budget');
      if (i.owner_id && i.owner_id !== p.owner_id) {
        const owner = (await c.query('SELECT id, roles FROM users WHERE id=$1', [i.owner_id])).rows[0];
        if (!owner) throw notFound('Owner');
        if (!(await sponsorAccess(owner, sp, c)) && !isAdmin(owner)) throw badRequest('The owner must run this brand');
      }
      const elig = { ...p.eligibility, ...(i.target_types ? { target_types: i.target_types } : {}), ...(i.verified_only !== undefined ? { verified_only: i.verified_only } : {}) };
      const row = (await c.query(
        `UPDATE sponsorship_programs SET name=$2, objective=$3, currency=$4, budget_cents=$5, sports=$6, regions=$7, eligibility=$8, starts_on=$9, ends_on=$10, max_award_cents=$11, max_awards=$12, recurrence=$13, owner_id=$14,
                row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [p.id, next.name, next.objective, next.currency, next.budget_cents, next.sports, next.regions, elig, next.starts_on, next.ends_on, next.max_award_cents, next.max_awards, next.recurrence, next.owner_id])).rows[0];
      await audit(c, user.id, 'update', 'sponsorship_programs', p.id);
      return row;
    });
  },
});

cap({
  name: 'set_sponsorship_program_status', method: 'POST', path: '/sponsorship-programs/:id/status', tag: 'Sponsors',
  summary: 'Brand manager/approver: move a program through its lifecycle. draft -> published | archived; published -> closed; closed -> published | archived; archived is final. Closing a program closes all its rounds, so no new application can be submitted; applications already submitted can still be decided. Needs the current `version` (409 if stale). Nothing is deleted.',
  input: z.object({ id, status: z.enum(['published', 'closed', 'archived']), version: z.coerce.number().int().positive() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { p } = await programFor(user, i.id, 'program', c, true);
      checkVersion(p, i.version, 'program');
      if (!TRANSITIONS[p.status].includes(i.status)) throw conflict(`A ${p.status} program cannot become ${i.status}`);
      if (i.status === 'published') {
        const n = (await c.query('SELECT count(*)::int AS n FROM sponsorship_rounds WHERE program_id=$1', [p.id])).rows[0].n;
        if (!n) throw unprocessable('Add at least one round before publishing');
      }
      if (i.status === 'closed' || i.status === 'archived') await c.query("UPDATE sponsorship_rounds SET status='closed', closed_at=coalesce(closed_at, now()), row_version=row_version+1, updated_at=now() WHERE program_id=$1 AND status<>'closed'", [p.id]);
      const row = (await c.query(
        `UPDATE sponsorship_programs SET status=$2, row_version=row_version+1, updated_at=now(),
                published_at=CASE WHEN $2='published' THEN coalesce(published_at, now()) ELSE published_at END,
                closed_at=CASE WHEN $2='closed' THEN now() ELSE closed_at END, archived_at=CASE WHEN $2='archived' THEN now() ELSE archived_at END WHERE id=$1 RETURNING *`, [p.id, i.status])).rows[0];
      await audit(c, user.id, `program_${i.status}`, 'sponsorship_programs', p.id);
      return row;
    });
  },
});

const STAFF_LIST = `SELECT p.*, sp.name AS sponsor_name, sp.emoji AS sponsor_emoji,
  coalesce((SELECT sum(a.awarded_cents) FROM sponsorship_applications a WHERE a.program_id=p.id AND a.status='awarded'),0)::bigint AS awarded_cents,
  (SELECT count(*)::int FROM sponsorship_applications a WHERE a.program_id=p.id AND a.status='awarded') AS awards,
  (SELECT count(*)::int FROM sponsorship_applications a WHERE a.program_id=p.id AND a.status='submitted') AS pending_applications,
  (SELECT r.id FROM sponsorship_rounds r WHERE r.program_id=p.id AND ${roundState('r')}='open' ORDER BY r.seq LIMIT 1) AS open_round_id,
  (SELECT r.closes_on FROM sponsorship_rounds r WHERE r.program_id=p.id AND ${roundState('r')}='open' ORDER BY r.seq LIMIT 1) AS open_round_closes_on
 FROM sponsorship_programs p JOIN sponsors sp ON sp.id=p.sponsor_id`;

cap({
  name: 'list_sponsorship_programs', method: 'GET', path: '/sponsorship-programs', tag: 'Sponsors',
  summary: 'Programs of the brands you run (brand-wide roles only), newest first, with the amount awarded, award count, pending applications and the currently open round. Filter by brand and status. Other brands\' programs are never returned.',
  input: z.object({ sponsor_id: id.optional(), status: z.enum(['draft', 'published', 'closed', 'archived']).optional(), ...page }),
  handler: ({ user }, i) => many(
    `${STAFF_LIST} WHERE (${isAdmin(user) ? 'true' : sponsorBrandSql(1)}) AND ($2::uuid IS NULL OR p.sponsor_id=$2) AND ($3::text IS NULL OR p.status=$3)
      ORDER BY p.created_at DESC, p.id LIMIT $4 OFFSET $5`, [user.id, i.sponsor_id ?? null, i.status ?? null, i.limit, i.offset]),
});

cap({
  name: 'get_sponsorship_program', method: 'GET', path: '/sponsorship-programs/:id', tag: 'Sponsors',
  summary: 'One program with its rounds (derived state, applications and awards per round), the budget committed and what remains. Brand staff only.',
  input: z.object({ id }),
  async handler({ user }, i) {
        const { p, sp } = await programFor(user, i.id, 'read', pool);
    const sa = isAdmin(user) ? { role: 'admin' } : await sponsorAccess(user, sp);
    const rounds = await many(
      `SELECT r.*, ${roundState('r')} AS state,
              (SELECT count(*)::int FROM sponsorship_applications a WHERE a.round_id=r.id AND a.status='submitted') AS pending,
              (SELECT count(*)::int FROM sponsorship_applications a WHERE a.round_id=r.id AND a.status='awarded') AS awards,
              coalesce((SELECT sum(a.awarded_cents) FROM sponsorship_applications a WHERE a.round_id=r.id AND a.status='awarded'),0)::bigint AS awarded_cents
         FROM sponsorship_rounds r WHERE r.program_id=$1 ORDER BY r.seq`, [p.id]);
    const used = await committed(pool, p.id);
    return { ...p, sponsor_name: sp.name, my_role: sa.role, awarded_cents: used.cents, awards: used.n, remaining_cents: Number(p.budget_cents) - used.cents, rounds };
  },
});

cap({
  name: 'create_program_round', method: 'POST', path: '/sponsorship-programs/:id/rounds', tag: 'Sponsors', status: 201,
  summary: 'Brand manager/approver: add a funding round (opening and closing dates, optional round budget and award count) to a draft or published program. Rounds are numbered in order. A round accepts applications from its opening date until its closing date or until it is closed.',
  input: z.object({ id, name: z.string().min(1).max(120).optional(), opens_on: date, closes_on: date, budget_cents: money.optional(), max_awards: z.number().int().min(1).max(10000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { p } = await programFor(user, i.id, 'program', c, true);
      if (!['draft', 'published'].includes(p.status)) throw conflict(`A ${p.status} program cannot get new rounds`);
      if (i.closes_on < i.opens_on) throw badRequest('closes_on is before opens_on');
      if (p.starts_on && i.opens_on < iso(p.starts_on)) throw badRequest('The round opens before the program starts');
      if (p.ends_on && i.closes_on > iso(p.ends_on)) throw badRequest('The round closes after the program ends');
      if (i.budget_cents != null && i.budget_cents > Number(p.budget_cents)) throw badRequest(PROGRAM_ROUND_BUDGET);
      const seq = (await c.query('SELECT coalesce(max(seq),0)+1 AS s FROM sponsorship_rounds WHERE program_id=$1', [p.id])).rows[0].s;
      const row = (await c.query(
        'INSERT INTO sponsorship_rounds(program_id, seq, name, opens_on, closes_on, budget_cents, max_awards) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [p.id, seq, i.name ?? `Round ${seq}`, i.opens_on, i.closes_on, i.budget_cents ?? null, i.max_awards ?? null])).rows[0];
      await saveTerms(c, row, user.id);
      await audit(c, user.id, 'create', 'sponsorship_rounds', row.id);
      return row;
    });
  },
});

const roundFor = async (c, user, roundId, action) => {
  const r0 = (await c.query('SELECT program_id FROM sponsorship_rounds WHERE id=$1', [roundId])).rows[0];
  if (!r0) throw notFound('Round');
  const { p, sp } = await programFor(user, r0.program_id, action, c, true); // program first, then round: one lock order everywhere
  const r = (await c.query('SELECT * FROM sponsorship_rounds WHERE id=$1 FOR UPDATE', [roundId])).rows[0];
  return { p, sp, r };
};

cap({
  name: 'update_program_round', method: 'PATCH', path: '/program-rounds/:id', tag: 'Sponsors',
  summary: 'Brand manager/approver: change an open or scheduled round (name, dates, budget, award count). Needs the current `version` (409 if stale). A change creates a new numbered terms version; applications already submitted keep the terms they were made under. A closed round cannot be edited.',
  input: z.object({ id, version: z.coerce.number().int().positive(), name: z.string().min(1).max(120).optional(), opens_on: date.optional(), closes_on: date.optional(), budget_cents: money.nullable().optional(), max_awards: z.number().int().min(1).max(10000).nullable().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { p, r } = await roundFor(c, user, i.id, 'program');
      checkVersion(r, i.version, 'round');
      if (r.status === 'closed') throw conflict('A closed round cannot be edited');
      const next = { ...r, ...Object.fromEntries(['name', 'opens_on', 'closes_on', 'budget_cents', 'max_awards'].filter((k) => i[k] !== undefined).map((k) => [k, i[k]])) };
      if (iso(next.closes_on) < iso(next.opens_on)) throw badRequest('closes_on is before opens_on');
      if (p.starts_on && iso(next.opens_on) < iso(p.starts_on)) throw badRequest('The round opens before the program starts');
      if (p.ends_on && iso(next.closes_on) > iso(p.ends_on)) throw badRequest('The round closes after the program ends');
      if (next.budget_cents != null && Number(next.budget_cents) > Number(p.budget_cents)) throw badRequest(PROGRAM_ROUND_BUDGET);
      const used = await committedRound(c, r.id);
      if (next.budget_cents != null && Number(next.budget_cents) < used.cents) throw conflict(`The round budget cannot be lower than what is already awarded (${used.cents})`);
      if (next.max_awards != null && next.max_awards < used.n) throw conflict(`The round already has ${used.n} awards`);
      const row = (await c.query(
        'UPDATE sponsorship_rounds SET name=$2, opens_on=$3, closes_on=$4, budget_cents=$5, max_awards=$6, terms_version=terms_version+1, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *',
        [r.id, next.name, next.opens_on, next.closes_on, next.budget_cents, next.max_awards])).rows[0];
      await saveTerms(c, row, user.id);
      await audit(c, user.id, 'update', 'sponsorship_rounds', r.id);
      return row;
    });
  },
});

cap({
  name: 'close_program_round', method: 'POST', path: '/program-rounds/:id/close', tag: 'Sponsors',
  summary: 'Brand manager/approver: close a round now. From that moment no new application can be submitted (even one racing with the close); applications already submitted can still be decided. Needs the current `version` (409 if stale). A closed round stays on record.',
  input: z.object({ id, version: z.coerce.number().int().positive() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { r } = await roundFor(c, user, i.id, 'program');
      checkVersion(r, i.version, 'round');
      if (r.status === 'closed') throw conflict('This round is already closed');
      const row = (await c.query("UPDATE sponsorship_rounds SET status='closed', closed_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [r.id])).rows[0];
      await audit(c, user.id, 'close', 'sponsorship_rounds', r.id);
      return row;
    });
  },
});

cap({
  name: 'schedule_program_rounds', method: 'POST', path: '/sponsorship-programs/:id/schedule-rounds', tag: 'Sponsors',
  summary: 'Brand manager/approver: for a recurring program, create the rounds that fall between the last existing round and `through`, following its cadence (monthly, quarterly, yearly) and opening length. Idempotent: repeating the same call creates nothing new. Needs at least one existing round to anchor the cadence; never goes past the program end date.',
  input: z.object({ id, through: date }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { p } = await programFor(user, i.id, 'program', c, true);
      if (!['draft', 'published'].includes(p.status)) throw conflict(`A ${p.status} program cannot get new rounds`);
      if (!p.recurrence) throw unprocessable('This program is not recurring; set a recurrence first');
      const all = (await c.query('SELECT * FROM sponsorship_rounds WHERE program_id=$1 ORDER BY seq', [p.id])).rows;
      if (!all.length) throw unprocessable('Create the first round to anchor the cadence');
      const first = iso(all[0].opens_on), last = lastRoundOf(all), step = CADENCE_MONTHS[p.recurrence.cadence], days = p.recurrence.open_days;
      const end = p.ends_on ? iso(p.ends_on) : null, created = [];
      for (let seq = last.seq + 1; seq < last.seq + 200; seq++) {
        const opens = addMonths(first, (seq - 1) * step), closes = addDays(opens, days - 1);
        if (opens > i.through || (end && closes > end)) break;
        created.push((await c.query(
          'INSERT INTO sponsorship_rounds(program_id, seq, name, opens_on, closes_on, budget_cents, max_awards) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [p.id, seq, `Round ${seq}`, opens, closes, last.budget_cents, last.max_awards])).rows[0]);
      }
      for (const r of created) await saveTerms(c, r, user.id);
      return { created: created.length, rounds: created };
    });
  },
});

// ---------------------------------------------------------------- applicants

cap({
  name: 'list_funding_opportunities', method: 'GET', path: '/funding-opportunities', tag: 'Sponsors',
  summary: 'Published sponsorship programs that have a round open for applications today, with the sponsor, objective, sports, regions, eligibility, maximum award and open round dates. The program budget and its remaining balance are not shown. Filter by sport slug or text.',
  input: z.object({ sport: z.string().max(60).optional(), q: z.string().max(80).optional(), ...page }),
  handler: async ({ user }, i) => many(
    `SELECT p.id, p.name, p.objective, p.currency, p.sports, p.regions, p.eligibility, p.starts_on, p.ends_on, p.max_award_cents, sp.id AS sponsor_id, sp.name AS sponsor_name, sp.emoji AS sponsor_emoji,
            (SELECT json_agg(json_build_object('id', r.id, 'seq', r.seq, 'name', r.name, 'opens_on', r.opens_on, 'closes_on', r.closes_on, 'terms_version', r.terms_version) ORDER BY r.seq)
               FROM sponsorship_rounds r WHERE r.program_id=p.id AND ${roundState('r')}='open') AS rounds
       FROM sponsorship_programs p JOIN sponsors sp ON sp.id=p.sponsor_id
      WHERE p.status='published' AND EXISTS (SELECT 1 FROM sponsorship_rounds r WHERE r.program_id=p.id AND ${roundState('r')}='open')
        AND ($1::text IS NULL OR cardinality(p.sports)=0 OR $1 = ANY(p.sports))
        AND ($2::text IS NULL OR p.name ILIKE '%'||$2||'%' OR p.objective ILIKE '%'||$2||'%' OR sp.name ILIKE '%'||$2||'%')
      ORDER BY p.published_at DESC NULLS LAST, p.id LIMIT $3 OFFSET $4`,
    [i.sport ?? null, i.q ? i.q.replace(/[%_\\]/g, '\\$&') : null, i.limit, i.offset]),
});

cap({
  name: 'apply_to_program_round', method: 'POST', path: '/program-rounds/:id/applications', tag: 'Sponsors', status: 201,
  summary: 'Apply to a funding round for something you own: yourself (athlete), a team you own or an event you organise. Rejected unless the round is open right now and its program is published. Checks eligibility (target type, sport, known region, verified-only), the program currency and maximum award, and that the applicant is not a minor athlete or part of the sponsoring brand. A copy of the terms is stored with the application and never changes afterwards. One live application per round and target.',
  input: z.object({ id, target_type: z.enum(TARGETS), target_id: id, requested_cents: money.min(1), pitch: z.string().max(2000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r0 = (await c.query('SELECT program_id FROM sponsorship_rounds WHERE id=$1', [i.id])).rows[0];
      if (!r0) throw notFound('Round');
      const p = (await c.query('SELECT * FROM sponsorship_programs WHERE id=$1 FOR UPDATE', [r0.program_id])).rows[0];
      const r = (await c.query(`SELECT *, ${roundState('r')} AS state FROM sponsorship_rounds r WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
      if (p.status !== 'published') throw conflict('This program is not accepting applications');
      if (r.state !== 'open') throw conflict(r.state === 'scheduled' ? 'This round has not opened yet' : 'This round is closed and no longer accepts applications');
      const sp = await mustFind('sponsors', p.sponsor_id, '*', c);
      if (!isAdmin(user) && (await sponsorAccess(user, sp, c))) throw forbidden('Staff of the sponsoring brand cannot apply to its own program');
      const owner = await targetOwnerOf(c, i.target_type, i.target_id);
      if (owner !== user.id) throw forbidden(i.target_type === 'athlete' ? 'You can only apply for yourself' : `You can only apply for a ${i.target_type} you ${i.target_type === 'team' ? 'own' : 'organise'}`);
      const el = p.eligibility ?? {};
      if (el.target_types?.length && !el.target_types.includes(i.target_type)) throw unprocessable(`This program funds ${el.target_types.join(', ')} only`);
      if (i.target_type === 'athlete') {
        const youth = (await c.query('SELECT 1 FROM users u WHERE u.id=$1 AND (u.youth_until IS NOT NULL AND u.youth_until > current_date)', [user.id])).rowCount;
        if (youth) throw unprocessable('Applications for athletes under the age of independence are not accepted here; a guardian-led process is required');
      }
      if (i.requested_cents > Number(p.max_award_cents ?? Infinity)) throw unprocessable(`The request is above the maximum award of ${p.max_award_cents}`);
      if (el.verified_only && !(await badgesFor(i.target_type === 'athlete' ? 'user' : i.target_type, [i.target_id])).get(i.target_id)?.length) throw forbidden('This program only funds verified applicants');
      if (p.sports.length) {
        const sports = i.target_type === 'athlete' ? (await c.query('SELECT s.slug FROM sport_profiles x JOIN sports s ON s.id=x.sport_id WHERE x.user_id=$1', [i.target_id])).rows
          : (await c.query(`SELECT s.slug FROM ${i.target_type === 'team' ? 'teams' : 'events'} x JOIN sports s ON s.id=x.sport_id WHERE x.id=$1`, [i.target_id])).rows;
        if (!sports.some((s) => p.sports.includes(s.slug))) throw unprocessable(`This program funds ${p.sports.join(', ')} only`);
      }
      if (p.regions.length) {
        const reg = i.target_type === 'athlete' ? (await c.query('SELECT region AS v FROM sport_profiles WHERE user_id=$1 AND region IS NOT NULL', [i.target_id])).rows
          : i.target_type === 'team' ? (await c.query('SELECT city AS v FROM teams WHERE id=$1 AND city IS NOT NULL', [i.target_id])).rows : [];
        const want = p.regions.map((x) => x.trim().toLowerCase());
        if (reg.length && !reg.some((x) => want.includes(String(x.v).trim().toLowerCase()))) throw unprocessable(`This program funds applicants in ${p.regions.join(', ')} only`);
      }
      const snap = termsOf(p, r);
      let row;
      try {
        row = (await c.query(
          `INSERT INTO sponsorship_applications(program_id, round_id, round_terms_version, terms_snapshot, applicant_id, target_type, target_id, requested_cents, currency, pitch)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [p.id, r.id, r.terms_version, snap, user.id, i.target_type, i.target_id, i.requested_cents, p.currency, i.pitch ?? null])).rows[0];
      } catch (e) {
        if (e.code === '23505') throw conflict('There is already an application for this in this round');
        throw e;
      }
      await notifySponsor(c, sp, 'program', { kind: 'sponsorship_program', title: 'New funding application', body: `A new application arrived for ${p.name}. Open the program to review it.`, data: { program_id: p.id, application_id: row.id } });
      return row;
    });
  },
});

cap({
  name: 'withdraw_program_application', method: 'POST', path: '/program-applications/:id/withdraw', tag: 'Sponsors',
  summary: 'The applicant takes back an application that has not been decided. It is kept on record as withdrawn.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = (await c.query('SELECT * FROM sponsorship_applications WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!a) throw notFound('Application');
      if (a.applicant_id !== user.id && !isAdmin(user)) throw forbidden('Only the applicant can withdraw it');
      if (a.status !== 'submitted') throw conflict(`This application is already ${a.status}`);
      return (await c.query("UPDATE sponsorship_applications SET status='withdrawn', decided_at=now(), decided_by=$2 WHERE id=$1 RETURNING *", [a.id, user.id])).rows[0];
    });
  },
});

const APP_COLS = `a.id, a.program_id, a.round_id, a.round_terms_version, a.terms_snapshot, a.applicant_id, a.target_type, a.target_id, a.requested_cents, a.currency, a.pitch, a.status, a.awarded_cents, a.decided_at, a.decision_reason, a.sponsorship_id, a.created_at,
  CASE a.target_type WHEN 'athlete' THEN (SELECT display_name FROM users WHERE id=a.target_id) WHEN 'team' THEN (SELECT name FROM teams WHERE id=a.target_id) ELSE (SELECT name FROM events WHERE id=a.target_id) END AS target_name,
  p.name AS program_name, r.seq AS round_seq, r.name AS round_name`;

cap({
  name: 'list_my_program_applications', method: 'GET', path: '/my/program-applications', tag: 'Sponsors',
  summary: 'Your own funding applications, newest first, each with the terms it was made under, its status and (once awarded) the resulting sponsorship agreement id.',
  input: z.object({ status: z.enum(['submitted', 'awarded', 'declined', 'withdrawn']).optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT ${APP_COLS}, sp.name AS sponsor_name FROM sponsorship_applications a JOIN sponsorship_programs p ON p.id=a.program_id JOIN sponsorship_rounds r ON r.id=a.round_id JOIN sponsors sp ON sp.id=p.sponsor_id
      WHERE a.applicant_id=$1 AND ($2::text IS NULL OR a.status=$2) ORDER BY a.created_at DESC, a.id LIMIT $3 OFFSET $4`, [user.id, i.status ?? null, i.limit, i.offset]),
});

cap({
  name: 'list_program_applications', method: 'GET', path: '/sponsorship-programs/:id/applications', tag: 'Sponsors',
  summary: 'Brand staff: applications to a program (filter by round and status), oldest first so none is missed. Shows the applicant\'s public profile and what they applied for; no contact details.',
  input: z.object({ id, round_id: id.optional(), status: z.enum(['submitted', 'awarded', 'declined', 'withdrawn']).optional(), ...page }),
  async handler({ user }, i) {
        const { p } = await programFor(user, i.id, 'read', pool);
    return many(
      `SELECT ${APP_COLS}, ${PUBLIC_USER.replace(/u\./g, 'ap.').replace(/ap\.id/, 'ap.id AS applicant_user_id')}
         FROM sponsorship_applications a JOIN sponsorship_programs p ON p.id=a.program_id JOIN sponsorship_rounds r ON r.id=a.round_id JOIN users ap ON ap.id=a.applicant_id
        WHERE a.program_id=$1 AND ($2::uuid IS NULL OR a.round_id=$2) AND ($3::text IS NULL OR a.status=$3) ORDER BY a.created_at, a.id LIMIT $4 OFFSET $5`,
      [p.id, i.round_id ?? null, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'decide_program_application', method: 'PATCH', path: '/program-applications/:id', tag: 'Sponsors',
  summary: 'Brand manager/approver: award or decline an application. Awarding needs the program\'s current `program_version` (409 if the caps changed since you looked) and checks, under lock, the award size, the program and round budgets and award counts, and the currency. It creates a proposed sponsorship from the brand to the applicant that references the program, round and application; the recipient still has to accept it (no consent or payment is assumed). Deciding twice is rejected.',
  input: z.object({ id, decision: z.enum(['award', 'decline']), program_version: z.coerce.number().int().positive().optional(), awarded_cents: money.min(1).optional().describe('defaults to the amount requested; cannot exceed it'), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a0 = (await c.query('SELECT program_id, round_id FROM sponsorship_applications WHERE id=$1', [i.id])).rows[0];
      if (!a0) throw notFound('Application');
      const { p, sp } = await programFor(user, a0.program_id, 'program', c, true);
      const r = (await c.query('SELECT * FROM sponsorship_rounds WHERE id=$1 FOR UPDATE', [a0.round_id])).rows[0];
      const a = (await c.query('SELECT * FROM sponsorship_applications WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (a.status !== 'submitted') throw conflict(`This application is already ${a.status}`);
      if (['draft', 'archived'].includes(p.status)) throw conflict(`A ${p.status} program cannot decide applications`);
      if (i.decision === 'decline') {
        const row = (await c.query("UPDATE sponsorship_applications SET status='declined', decided_at=now(), decided_by=$2, decision_reason=$3 WHERE id=$1 RETURNING *", [a.id, user.id, i.reason ?? null])).rows[0];
        await notify(c, a.applicant_id, { kind: 'sponsorship_program', title: 'Funding application declined', body: `Your application to ${p.name} was declined.`, data: { application_id: a.id } });
        return row;
      }
      if (i.program_version == null) throw badRequest('Award against a specific version of the program (program_version)');
      checkVersion(p, i.program_version, 'program');
      const amount = i.awarded_cents ?? Number(a.requested_cents);
      if (amount > Number(a.requested_cents)) throw badRequest('An award cannot exceed the amount requested');
      if (a.currency !== p.currency) throw conflict('The application currency does not match the program currency');
      if (p.max_award_cents && amount > Number(p.max_award_cents)) throw unprocessable(`An award cannot exceed the program maximum of ${p.max_award_cents}`);
      const pu = await committed(c, p.id), ru = await committedRound(c, r.id);
      if (p.max_awards && pu.n + 1 > p.max_awards) throw conflict(`The program has reached its limit of ${p.max_awards} awards`);
      if (r.max_awards && ru.n + 1 > r.max_awards) throw conflict(`This round has reached its limit of ${r.max_awards} awards`);
      if (pu.cents + amount > Number(p.budget_cents)) throw conflict(`This award would exceed the program budget (${Number(p.budget_cents) - pu.cents} remaining)`);
      if (r.budget_cents != null && ru.cents + amount > Number(r.budget_cents)) throw conflict(`This award would exceed the round budget (${Number(r.budget_cents) - ru.cents} remaining)`);
      const dealUp = (await c.query(
        `INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, currency, starts_on, ends_on, proposed_by, objectives, visibility, program_id, round_id, application_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [sp.id, a.target_type, a.target_id, amount, p.currency, p.starts_on, p.ends_on, user.id, p.objective, a.target_type === 'athlete' ? 'private' : 'public', p.id, r.id, a.id])).rows[0];
      // the award is a one-off money line, so the recipient accepts an exact version and the existing obligation / payment flow applies
      const today = iso(new Date()), start = p.starts_on ? iso(p.starts_on) : null, end = p.ends_on ? iso(p.ends_on) : null;
      let due = start && start > today ? start : today;
      if (end && due > end) due = end;
      const line = { kind: 'money', label: `Award: ${p.name}`.slice(0, 160), currency: p.currency, total_cents: amount, cadence: 'once', first_due_on: due, terms: {} };
      buildSchedule([line], { starts_on: start, ends_on: end }); // fails loudly rather than store an unschedulable award
      await saveLines(c, dealUp.id, 1, [line]);
      await c.query("UPDATE sponsorships SET agreement_ref='SPA-'||upper(substr(id::text,1,8)) WHERE id=$1", [dealUp.id]);
      await logHistory(c, dealUp.id, 1, user.id, 'proposed', `Awarded from program ${p.name}`);
      const row = (await c.query("UPDATE sponsorship_applications SET status='awarded', awarded_cents=$2, decided_at=now(), decided_by=$3, decision_reason=$4, sponsorship_id=$5 WHERE id=$1 RETURNING *", [a.id, amount, user.id, i.reason ?? null, dealUp.id])).rows[0];
      await notify(c, a.applicant_id, { kind: 'sponsorship_offer', title: 'Your funding application was awarded', body: `${sp.name} awarded your application. Open the agreement to review and accept it.`, data: { sponsorship_id: dealUp.id, application_id: a.id } });
      await audit(c, user.id, 'award', 'sponsorship_applications', a.id);
      return { ...row, sponsorship: dealUp };
    });
  },
});

cap({
  name: 'export_program_awards', method: 'GET', path: '/sponsorship-programs/:id/awards-export', tag: 'Sponsors',
  summary: 'Brand manager/finance/auditor: CSV of a program\'s awards (round, applicant handle, target, amount, currency, the agreement and its status). No contact or personal data. The export is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
        const { p } = await programFor(user, i.id, 'export', pool);
    const rows = await many(
      `SELECT r.seq AS round, ap.handle AS applicant, a.target_type, a.awarded_cents AS amount_cents, a.currency, a.decided_at, s.id AS agreement_id, s.status AS agreement_status
         FROM sponsorship_applications a JOIN sponsorship_rounds r ON r.id=a.round_id JOIN users ap ON ap.id=a.applicant_id JOIN sponsorships s ON s.id=a.sponsorship_id
        WHERE a.program_id=$1 AND a.status='awarded' ORDER BY r.seq, a.decided_at, a.id`, [p.id]);
    await audit(null, user.id, 'export', 'sponsorship_programs', p.id);
    return { filename: `program-${p.id}-awards.csv`, rows: rows.length, csv: toCsv(['round', 'applicant', 'target_type', 'amount_cents', 'currency', 'decided_at', 'agreement_id', 'agreement_status'], rows) };
  },
});
