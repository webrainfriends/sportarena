// Academic and sporting pathway planning (issue #335): sport and academic goals, trial/application deadlines, scholarships and their evidence,
// offer comparison, outcome history, and a revocable share with the coaches who work with the athlete.
// It extends the study bucket list (targets: institutions, programmes and teams); trials, enquiries, evidence and credentials are read where they live.
// A verified guardian can do everything for a young person (pass athlete_id); a young person acting alone needs a guardian's current consent to accept an offer.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { toCsv } from '../csv.js';
import { coachesAthlete } from '../passport-sections.js';
import { notify } from '../notify.js';
import { goalOptionsFor, ACADEMIC } from '../pathway-goals.js';
import {
  SCOPES, EVIDENCE_TYPES, OPEN_STAGES, seal, open, stale, actingFor, youthGate, logEvent, ownBucket, advanceBucket, evidenceOf, goalsOf, scholarshipsOf, offersOf,
  compareOffers, deadlinesOf, outcomesOf, liveShare, sharedView, auditSharedRead, exportRows, EXPORT_COLS, guardiansOf,
} from '../pathway.js';

const TAG = 'Pathway';
const rv = z.number().int().min(1).describe('the row_version you last saw; a stale one is refused (409)');
const note = (n) => z.string().trim().max(n);
const athlete = { athlete_id: id.optional().describe('your child\'s id, for a verified guardian acting for a young person') };
const date = z.string().date();
const cur = z.string().regex(/^[A-Z]{3}$/).describe('ISO currency code, e.g. INR');

const sportId = async (slug) => {
  if (!slug) return null;
  const s = await one('SELECT id FROM sports WHERE slug=$1', [slug]);
  if (!s) throw notFound('Sport');
  return s.id;
};

// ------------------------------------------------------------------------------------------------ the plan at a glance
cap({
  name: 'get_my_pathway', method: 'GET', path: '/me/pathway', tag: TAG,
  summary: 'Your pathway plan at a glance: how many targets are at each stage, the next deadlines (including your trial bookings and offer replies), goal progress and open offers. Pass athlete_id as a verified guardian.',
  input: z.object({ ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    const [out, deadlines, goals, offers, shares] = await Promise.all([outcomesOf(a, { limit: 5 }), deadlinesOf(a, { limit: 5 }), goalsOf(a), offersOf(a), many('SELECT 1 FROM pathway_shares WHERE athlete_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())', [a])]);
    return {
      athlete_id: a, stages: out.counts, targets: out.targets.length, next_deadlines: deadlines,
      goals: { active: goals.filter((g) => g.status === 'active').length, achieved: goals.filter((g) => g.status === 'achieved').length },
      offers: { open: offers.filter((o) => o.status === 'open').length, total: offers.length }, shared_with: shares.length,
    };
  },
});

// ------------------------------------------------------------------------------------------------ goals
const goalFields = {
  kind: z.enum(['sporting', 'academic']), sport_slug: z.string().max(60).nullish(), bucket_id: id.nullish().describe('the target this goal is for'),
  metric_key: z.string().regex(/^[a-z0-9_]{1,60}$/).nullish().describe('a metric from get_pathway_goal_options for the sport'),
  academic_measure: z.enum(ACADEMIC.map((a) => a.key)).nullish().describe('an academic measure from get_pathway_goal_options'),
  milestone: note(120).min(2).nullish().describe('a yes/no milestone (pick one of the offered milestones, or your own)'),
  baseline: z.number().finite().nullish(), target: z.number().finite().nullish(), current: z.number().finite().nullish(), target_date: date.nullish(), notes: note(1000).nullish(),
};

cap({
  name: 'get_pathway_goal_options', method: 'GET', path: '/me/pathway/goal-options', tag: TAG,
  summary: 'What you can pick when setting a goal. Without a sport: your sports, the academic measures with their real scales and a few milestones. With sport_slug: that sport\'s metrics (governed result metrics and per-match figures), each with unit, which direction is better, valid range, step, YOUR current value and where it comes from (approved competition result or self-logged, never blended), and suggested targets (beat your best by a few percent; reach a cohort median when at least five comparable players exist). Pass athlete_id as a verified guardian.',
  input: z.object({ sport_slug: z.string().max(60).optional(), ...athlete }),
  async handler({ user }, i) { return goalOptionsFor(await actingFor(user, i.athlete_id), i.sport_slug); },
});

cap({
  name: 'list_pathway_goals', method: 'GET', path: '/me/pathway/goals', tag: TAG,
  summary: 'Your sport and academic goals with progress (0 to 1) computed from baseline, current and target. Active goals first.',
  input: z.object({ ...athlete }),
  async handler({ user }, i) { return goalsOf(await actingFor(user, i.athlete_id)); },
});

cap({
  name: 'add_pathway_goal', method: 'POST', path: '/me/pathway/goals', tag: TAG, status: 201,
  summary: 'Add a goal built from the options (get_pathway_goal_options): a sport metric (unit, direction and range come from the catalogue, the start is your current value), an academic measure (bounded by its real scale) or a yes/no milestone. A goal that follows a sport result metric tracks your best figure by itself. Adding the same goal again returns the existing one.',
  input: z.object({ ...goalFields, ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    let title, unit = null, measure = 'number', metric = null, evidence = null, academic = null, baseline = i.baseline ?? null, range = null;
    if (i.kind === 'sporting' && i.metric_key) {
      if (!i.sport_slug) throw badRequest('Pick the sport first');
      metric = (await goalOptionsFor(a, i.sport_slug)).metrics.find((m) => m.key === i.metric_key);
      if (!metric) throw badRequest('That metric is not available for this sport');
      title = metric.label; unit = metric.unit; evidence = metric.evidence ?? 'self_reported'; range = metric; baseline = baseline ?? metric.current;
    } else if (i.kind === 'academic' && i.academic_measure) {
      academic = ACADEMIC.find((m) => m.key === i.academic_measure); title = academic.label; unit = academic.unit; range = academic;
    } else if (i.milestone) {
      title = i.milestone; measure = 'yes_no';
    } else throw badRequest(i.kind === 'academic' ? 'Pick an academic measure or a milestone' : 'Pick a metric or a milestone');
    if (measure === 'number') {
      if (i.target === undefined || i.target === null) throw badRequest('Set the number you are aiming for');
      for (const [k, v] of [['target', i.target], ['baseline', baseline], ['current', i.current]]) if (v != null && (v < range.min || v > range.max)) throw badRequest(`The ${k} must be between ${range.min} and ${range.max} ${unit}`);
      if (range.integer && [i.target, baseline, i.current].some((v) => v != null && !Number.isInteger(v))) throw badRequest('This metric is counted in whole numbers');
    }
    const render = await tx(async (c) => {
      if (i.bucket_id) await ownBucket(c, a, i.bucket_id);
      const sid = await sportId(i.sport_slug);
      const dup = (await c.query("SELECT id FROM pathway_goals WHERE user_id=$1 AND kind=$2 AND lower(btrim(title))=lower(btrim($3)) AND coalesce(sport_id,'00000000-0000-0000-0000-000000000000'::uuid)=coalesce($4,'00000000-0000-0000-0000-000000000000'::uuid) AND removed_at IS NULL", [a, i.kind, title, sid])).rows[0];
      if (dup) return async () => ({ ...(await goalsOf(a)).find((g) => g.id === dup.id), replay: true });
      const row = (await c.query(
        `INSERT INTO pathway_goals(user_id, kind, sport_id, bucket_id, title, metric_key, evidence, academic_measure, measure, unit, baseline, target, current, target_date, notes_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [a, i.kind, sid, i.bucket_id ?? null, title, metric?.key ?? null, evidence, academic?.key ?? null, measure, unit, baseline, i.target ?? null, i.current ?? metric?.current ?? null, i.target_date ?? null, seal(i.notes, 'goal_notes')])).rows[0];
      await logEvent(c, { userId: a, bucketId: i.bucket_id ?? null, kind: 'goal', to: 'active', detail: title.slice(0, 120), actorId: user.id });
      return async () => (await goalsOf(a)).find((g) => g.id === row.id);
    });
    return render();
  },
});

cap({
  name: 'update_pathway_goal', method: 'PATCH', path: '/me/pathway/goals/:id', tag: TAG,
  summary: 'Update progress (current), target, date, notes or status (active, achieved, paused, dropped) of a goal, or remove it (kept, hidden). Send row_version; a stale edit is refused (409).',
  input: z.object({ id, row_version: rv, current: z.number().finite().nullable().optional(), target: z.number().finite().optional(), target_date: date.nullable().optional(), notes: note(1000).nullable().optional(),
    status: z.enum(['active', 'achieved', 'paused', 'dropped']).optional(), remove: z.boolean().optional(), ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    const render = await tx(async (c) => {
      const g = (await c.query('SELECT * FROM pathway_goals WHERE id=$1 AND user_id=$2 AND removed_at IS NULL FOR UPDATE', [i.id, a])).rows[0];
      if (!g) throw notFound('Goal');
      if (g.row_version !== i.row_version) throw stale();
      const status = i.status ?? g.status;
      await c.query(
        `UPDATE pathway_goals SET current=CASE WHEN $2::boolean THEN $3::numeric ELSE current END, target=coalesce($4, target), target_date=CASE WHEN $5::boolean THEN $6::date ELSE target_date END,
                notes_enc=CASE WHEN $7::boolean THEN $8 ELSE notes_enc END, status=$9, achieved_at=CASE WHEN $9='achieved' THEN coalesce(achieved_at, now()) ELSE NULL END,
                removed_at=CASE WHEN $10::boolean THEN now() ELSE removed_at END, row_version=row_version+1, updated_at=now() WHERE id=$1`,
        [g.id, i.current !== undefined, i.current ?? null, i.target ?? null, i.target_date !== undefined, i.target_date ?? null, i.notes !== undefined, seal(i.notes, 'goal_notes'), status, i.remove === true]);
      if (status !== g.status) await logEvent(c, { userId: a, bucketId: g.bucket_id, kind: 'goal', from: g.status, to: status, detail: g.title.slice(0, 120), actorId: user.id });
      return async () => (await goalsOf(a)).find((x) => x.id === g.id) ?? { id: g.id, removed: true };
    });
    return render();
  },
});

// ------------------------------------------------------------------------------------------------ deadlines
cap({
  name: 'list_pathway_deadlines', method: 'GET', path: '/me/pathway/deadlines', tag: TAG,
  summary: 'Every deadline in one list, soonest first: the ones you added, application dates on your targets, your trial bookings, offer reply dates and scholarship dates. Each says where it comes from. Finished and past items drop off unless include_past is set; overdue items you have not finished stay on top until done.',
  input: z.object({ include_past: z.coerce.boolean().default(false), ...athlete, ...page }),
  async handler({ user }, i) { return deadlinesOf(await actingFor(user, i.athlete_id), { includePast: i.include_past, limit: i.limit, offset: i.offset }); },
});

cap({
  name: 'add_pathway_deadline', method: 'POST', path: '/me/pathway/deadlines', tag: TAG, status: 201,
  summary: 'Add a deadline (application, trial, scholarship, documents or other) for a target, with a reminder some days before. Adding the same one again returns the existing one.',
  input: z.object({ kind: z.enum(['application', 'trial', 'scholarship', 'documents', 'other']), due_on: date, bucket_id: id.nullish(), title: note(120).min(2).nullish(), remind_days: z.number().int().min(0).max(60).default(7), ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    if (i.kind === 'other' && !i.title) throw badRequest('Say what the deadline is for');
    return tx(async (c) => {
      if (i.bucket_id) await ownBucket(c, a, i.bucket_id);
      const dup = (await c.query("SELECT * FROM pathway_deadlines WHERE user_id=$1 AND kind=$2 AND due_on=$3 AND coalesce(bucket_id,'00000000-0000-0000-0000-000000000000'::uuid)=coalesce($4,'00000000-0000-0000-0000-000000000000'::uuid) AND coalesce(lower(btrim(title)),'')=coalesce(lower(btrim($5)),'') AND removed_at IS NULL", [a, i.kind, i.due_on, i.bucket_id ?? null, i.title ?? null])).rows[0];
      if (dup) return { ...dup, replay: true };
      return (await c.query('INSERT INTO pathway_deadlines(user_id, bucket_id, kind, title, due_on, remind_days) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [a, i.bucket_id ?? null, i.kind, i.title ?? null, i.due_on, i.remind_days])).rows[0];
    });
  },
});

cap({
  name: 'update_pathway_deadline', method: 'PATCH', path: '/me/pathway/deadlines/:id', tag: TAG,
  summary: 'Move a deadline you added, change its reminder, mark it done (or not done), or remove it (kept, hidden). Send row_version; a stale edit is refused (409). Trial bookings, offer replies and target dates are changed where they live.',
  input: z.object({ id, row_version: rv, due_on: date.optional(), remind_days: z.number().int().min(0).max(60).optional(), done: z.boolean().optional(), remove: z.boolean().optional(), ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    return tx(async (c) => {
      const d = (await c.query('SELECT * FROM pathway_deadlines WHERE id=$1 AND user_id=$2 AND removed_at IS NULL FOR UPDATE', [i.id, a])).rows[0];
      if (!d) throw notFound('Deadline');
      if (d.row_version !== i.row_version) throw stale();
      return (await c.query(
        `UPDATE pathway_deadlines SET due_on=coalesce($2, due_on), remind_days=coalesce($3, remind_days), reminded_at=CASE WHEN $2::date IS NOT NULL AND $2::date <> due_on THEN NULL ELSE reminded_at END,
                done_at=CASE WHEN $4::boolean IS NULL THEN done_at WHEN $4 THEN coalesce(done_at, now()) ELSE NULL END, removed_at=CASE WHEN $5::boolean THEN now() ELSE removed_at END,
                row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [d.id, i.due_on ?? null, i.remind_days ?? null, i.done ?? null, i.remove === true])).rows[0];
    });
  },
});

// ------------------------------------------------------------------------------------------------ scholarships and their evidence
cap({
  name: 'list_pathway_scholarships', method: 'GET', path: '/me/pathway/scholarships', tag: TAG,
  summary: 'The scholarships you are chasing, each with its requirements and which are met by evidence you attached (academic records, credentials, approved references and videos, results). Every attached item says whether it is self-reported or issued/approved by someone else.',
  input: z.object({ ...athlete }),
  async handler({ user }, i) { return scholarshipsOf(await actingFor(user, i.athlete_id)); },
});

cap({
  name: 'add_pathway_scholarship', method: 'POST', path: '/me/pathway/scholarships', tag: TAG, status: 201,
  summary: 'Track a scholarship for one of your targets, with the value (amount and currency together), a due date and the evidence it asks for. Adding the same one again returns the existing one.',
  input: z.object({ bucket_id: id, name: note(120).min(2), amount_minor: money.optional(), currency: cur.optional(), period: z.enum(['per_year', 'total']).default('per_year'), due_on: date.nullish(), notes: note(1000).nullish(),
    requirements: z.array(note(120).min(2)).max(12).default([]), ...athlete })
    .refine((v) => (v.amount_minor === undefined) === (v.currency === undefined), { message: 'Give the amount together with its currency' }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    const render = await tx(async (c) => {
      await ownBucket(c, a, i.bucket_id);
      let sc = (await c.query('SELECT id FROM pathway_scholarships WHERE bucket_id=$1 AND lower(btrim(name))=lower(btrim($2)) AND removed_at IS NULL', [i.bucket_id, i.name])).rows[0];
      const replay = !!sc;
      if (!sc) {
        sc = (await c.query('INSERT INTO pathway_scholarships(user_id, bucket_id, name, amount_minor, currency, period, due_on, notes_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
          [a, i.bucket_id, i.name, i.amount_minor ?? null, i.currency ?? null, i.period, i.due_on ?? null, seal(i.notes, 'scholarship_notes')])).rows[0];
        await logEvent(c, { userId: a, bucketId: i.bucket_id, kind: 'scholarship', to: 'exploring', detail: i.name.slice(0, 120), actorId: user.id });
      }
      for (const r of new Set(i.requirements)) await c.query('INSERT INTO pathway_scholarship_items(scholarship_id, requirement) VALUES ($1,$2) ON CONFLICT DO NOTHING', [sc.id, r]);
      return async () => ({ ...(await scholarshipsOf(a)).find((s) => s.id === sc.id), ...(replay ? { replay: true } : {}) });
    });
    return render();
  },
});

cap({
  name: 'update_pathway_scholarship', method: 'PATCH', path: '/me/pathway/scholarships/:id', tag: TAG,
  summary: 'Update a scholarship: status (exploring, applied, awarded, declined, withdrawn), value, due date or notes, or remove it (kept, hidden). Send row_version; a stale edit is refused (409).',
  input: z.object({ id, row_version: rv, status: z.enum(['exploring', 'applied', 'awarded', 'declined', 'withdrawn']).optional(), amount_minor: money.optional(), currency: cur.optional(), due_on: date.nullable().optional(), notes: note(1000).nullable().optional(), remove: z.boolean().optional(), ...athlete })
    .refine((v) => (v.amount_minor === undefined) === (v.currency === undefined), { message: 'Give the amount together with its currency' }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    const render = await tx(async (c) => {
      const s = (await c.query('SELECT * FROM pathway_scholarships WHERE id=$1 AND user_id=$2 AND removed_at IS NULL FOR UPDATE', [i.id, a])).rows[0];
      if (!s) throw notFound('Scholarship');
      if (s.row_version !== i.row_version) throw stale();
      if (i.status === 'awarded' && (i.amount_minor ?? s.amount_minor) == null) throw badRequest('Add the amount that was awarded');
      await c.query(
        `UPDATE pathway_scholarships SET status=coalesce($2,status), amount_minor=coalesce($3,amount_minor), currency=coalesce($4,currency), due_on=CASE WHEN $5::boolean THEN $6::date ELSE due_on END,
                notes_enc=CASE WHEN $7::boolean THEN $8 ELSE notes_enc END, removed_at=CASE WHEN $9::boolean THEN now() ELSE removed_at END, row_version=row_version+1, updated_at=now() WHERE id=$1`,
        [s.id, i.status ?? null, i.amount_minor ?? null, i.currency ?? null, i.due_on !== undefined, i.due_on ?? null, i.notes !== undefined, seal(i.notes, 'scholarship_notes'), i.remove === true]);
      if (i.status && i.status !== s.status) await logEvent(c, { userId: a, bucketId: s.bucket_id, kind: 'scholarship', from: s.status, to: i.status, detail: s.name.slice(0, 120), actorId: user.id });
      return async () => (await scholarshipsOf(a)).find((x) => x.id === s.id) ?? { id: s.id, removed: true };
    });
    return render();
  },
});

cap({
  name: 'add_scholarship_requirement', method: 'POST', path: '/me/pathway/scholarships/:id/requirements', tag: TAG, status: 201,
  summary: 'Add something the scholarship asks for (for example "Latest transcript"). Adding the same one again changes nothing.',
  input: z.object({ id, requirement: note(120).min(2), ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    const s = await one('SELECT id FROM pathway_scholarships WHERE id=$1 AND user_id=$2 AND removed_at IS NULL', [i.id, a]);
    if (!s) throw notFound('Scholarship');
    const n = (await one('SELECT count(*)::int AS n FROM pathway_scholarship_items WHERE scholarship_id=$1 AND removed_at IS NULL', [s.id])).n;
    if (n >= 20) throw conflict('A scholarship can list up to 20 requirements');
    await one('INSERT INTO pathway_scholarship_items(scholarship_id, requirement) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [s.id, i.requirement]);
    return (await scholarshipsOf(a)).find((x) => x.id === s.id);
  },
});

cap({
  name: 'remove_scholarship_requirement', method: 'DELETE', path: '/me/pathway/scholarship-items/:id', tag: TAG,
  summary: 'Remove a requirement from a scholarship (kept, hidden). Any evidence stays where it lives.', input: z.object({ id, ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    const it = await one('UPDATE pathway_scholarship_items i SET removed_at=coalesce(removed_at, now()) FROM pathway_scholarships s WHERE i.id=$1 AND s.id=i.scholarship_id AND s.user_id=$2 RETURNING i.id, i.scholarship_id', [i.id, a]);
    if (!it) throw notFound('Requirement');
    return (await scholarshipsOf(a)).find((x) => x.id === it.scholarship_id);
  },
});

cap({
  name: 'attach_scholarship_evidence', method: 'POST', path: '/me/pathway/scholarship-items/:id/evidence', tag: TAG,
  summary: 'Meet a requirement with evidence you already hold: an academic record, an issued credential, an approved coach reference or video, or a result. It is linked, not copied; if you later remove it, the requirement shows as not met. Only its title and where it came from are ever shared.',
  input: z.object({ id, source_type: z.enum(EVIDENCE_TYPES), source_id: id, ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    const render = await tx(async (c) => {
      const it = (await c.query('SELECT i.*, s.user_id FROM pathway_scholarship_items i JOIN pathway_scholarships s ON s.id=i.scholarship_id WHERE i.id=$1 AND s.user_id=$2 AND s.removed_at IS NULL AND i.removed_at IS NULL FOR UPDATE OF i', [i.id, a])).rows[0];
      if (!it) throw notFound('Requirement');
      await evidenceOf(c, a, i.source_type, i.source_id);
      if (it.source_type !== i.source_type || it.source_id !== i.source_id) await c.query('UPDATE pathway_scholarship_items SET source_type=$2, source_id=$3, attached_at=now() WHERE id=$1', [it.id, i.source_type, i.source_id]);
      return async () => (await scholarshipsOf(a)).find((x) => x.id === it.scholarship_id);
    });
    return render();
  },
});

cap({
  name: 'detach_scholarship_evidence', method: 'DELETE', path: '/me/pathway/scholarship-items/:id/evidence', tag: TAG,
  summary: 'Unlink the evidence from a requirement (the evidence itself is untouched). The requirement shows as not met again.', input: z.object({ id, ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    const it = await one('UPDATE pathway_scholarship_items i SET source_type=NULL, source_id=NULL, attached_at=NULL FROM pathway_scholarships s WHERE i.id=$1 AND s.id=i.scholarship_id AND s.user_id=$2 AND i.removed_at IS NULL RETURNING i.scholarship_id', [i.id, a]);
    if (!it) throw notFound('Requirement');
    return (await scholarshipsOf(a)).find((x) => x.id === it.scholarship_id);
  },
});

// ------------------------------------------------------------------------------------------------ offers
cap({
  name: 'list_pathway_offers', method: 'GET', path: '/me/pathway/offers', tag: TAG,
  summary: 'Offers you recorded (a place, a scholarship place, a team spot), newest first, each with net cost (tuition + other costs - scholarship), reply date and where it stands. They are labelled as entered by you, not verified by the institution.',
  input: z.object({ ...athlete }),
  async handler({ user }, i) { return offersOf(await actingFor(user, i.athlete_id)); },
});

cap({
  name: 'add_pathway_offer', method: 'POST', path: '/me/pathway/offers', tag: TAG, status: 201,
  summary: 'Record an offer you received for one of your targets: costs and any scholarship in one currency (minor units), the date you must reply by, and its conditions. The target moves to Offered if it was earlier in the process. Adding the same offer again returns the existing one.',
  input: z.object({ bucket_id: id, title: note(120).min(2), tuition_minor: money.default(0), other_minor: money.default(0), scholarship_minor: money.optional(), currency: cur, period: z.enum(['per_year', 'total']).default('per_year'),
    scholarship_id: id.nullish().describe('an awarded scholarship of this target to take the amount from'), reply_by: date.nullish(), starts_on: date.nullish(), conditions: note(1000).nullish(), ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    const render = await tx(async (c) => {
      const b = await ownBucket(c, a, i.bucket_id);
      const dup = (await c.query('SELECT id FROM pathway_offers WHERE bucket_id=$1 AND lower(btrim(title))=lower(btrim($2)) AND removed_at IS NULL', [b.id, i.title])).rows[0];
      if (dup) return async () => ({ ...(await offersOf(a, { ids: [dup.id] }))[0], replay: true });
      let schol = i.scholarship_minor ?? 0;
      if (i.scholarship_id) {
        const s = (await c.query("SELECT * FROM pathway_scholarships WHERE id=$1 AND user_id=$2 AND bucket_id=$3 AND status='awarded' AND removed_at IS NULL", [i.scholarship_id, a, b.id])).rows[0];
        if (!s) throw notFound('Awarded scholarship for this target');
        if (s.currency !== i.currency || s.period !== i.period) throw conflict('The scholarship is in a different currency or period; enter the amount yourself');
        if (i.scholarship_minor === undefined) schol = Number(s.amount_minor);
      }
      const row = (await c.query(
        `INSERT INTO pathway_offers(user_id, bucket_id, scholarship_id, title, tuition_minor, other_minor, scholarship_minor, currency, period, reply_by, starts_on, conditions_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [a, b.id, i.scholarship_id ?? null, i.title, i.tuition_minor, i.other_minor, schol, i.currency, i.period, i.reply_by ?? null, i.starts_on ?? null, seal(i.conditions, 'offer_conditions')])).rows[0];
      await logEvent(c, { userId: a, bucketId: b.id, kind: 'offer_added', to: 'open', detail: i.title.slice(0, 120), actorId: user.id });
      if (OPEN_STAGES.includes(b.status)) await advanceBucket(c, b, 'offered', user.id, i.title.slice(0, 120));
      return async () => (await offersOf(a, { ids: [row.id] }))[0];
    });
    return render();
  },
});

cap({
  name: 'update_pathway_offer', method: 'PATCH', path: '/me/pathway/offers/:id', tag: TAG,
  summary: 'Correct an offer that is still open (amounts, reply date, start date, conditions), or remove it (kept, hidden). Send row_version; a stale edit is refused (409).',
  input: z.object({ id, row_version: rv, tuition_minor: money.optional(), other_minor: money.optional(), scholarship_minor: money.optional(), reply_by: date.nullable().optional(), starts_on: date.nullable().optional(), conditions: note(1000).nullable().optional(), remove: z.boolean().optional(), ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    const render = await tx(async (c) => {
      const o = (await c.query('SELECT * FROM pathway_offers WHERE id=$1 AND user_id=$2 AND removed_at IS NULL FOR UPDATE', [i.id, a])).rows[0];
      if (!o) throw notFound('Offer');
      if (o.row_version !== i.row_version) throw stale();
      if (o.status !== 'open' && !i.remove) throw conflict('A decided offer cannot be edited; remove it or record a new one');
      if (i.remove && o.status === 'accepted') throw conflict('Change your decision before removing an accepted offer');
      await c.query(
        `UPDATE pathway_offers SET tuition_minor=coalesce($2,tuition_minor), other_minor=coalesce($3,other_minor), scholarship_minor=coalesce($4,scholarship_minor), reply_by=CASE WHEN $5::boolean THEN $6::date ELSE reply_by END,
                starts_on=CASE WHEN $7::boolean THEN $8::date ELSE starts_on END, conditions_enc=CASE WHEN $9::boolean THEN $10 ELSE conditions_enc END, removed_at=CASE WHEN $11::boolean THEN now() ELSE removed_at END,
                row_version=row_version+1, updated_at=now() WHERE id=$1`,
        [o.id, i.tuition_minor ?? null, i.other_minor ?? null, i.scholarship_minor ?? null, i.reply_by !== undefined, i.reply_by ?? null, i.starts_on !== undefined, i.starts_on ?? null, i.conditions !== undefined, seal(i.conditions, 'offer_conditions'), i.remove === true]);
      return async () => (await offersOf(a, { ids: [o.id] }))[0] ?? { id: o.id, removed: true };
    });
    return render();
  },
});

cap({
  name: 'compare_pathway_offers', method: 'GET', path: '/me/pathway/offers/compare', tag: TAG,
  summary: 'Offers side by side. Amounts are never converted between currencies (or between yearly and total): each currency/period is its own table, the lowest net cost in a table is flagged, and reply dates and conditions are alongside. Declined offers are left out. Pass ids to compare chosen ones.',
  input: z.object({ ids: z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(id).max(20).optional()), ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    const offers = await offersOf(a, { ids: i.ids?.length ? i.ids : null });
    if (i.ids?.length && offers.length !== new Set(i.ids).size) throw notFound('Offer');
    return compareOffers(offers);
  },
});

cap({
  name: 'decide_pathway_offer', method: 'POST', path: '/me/pathway/offers/:id/decision', tag: TAG,
  summary: 'Accept, decline or defer an offer (deferring can set a new reply date). Accepting moves the target to Accepted; declining the last live offer of a target moves it to Declined. A young person needs a guardian\'s current consent to accept; a verified guardian can decide for them. Repeating the same decision changes nothing; changing your mind is allowed and logged.',
  input: z.object({ id, row_version: rv, decision: z.enum(['accept', 'decline', 'defer']), note: note(500).nullish(), reply_by: date.nullish(), ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    const out = await tx(async (c) => {
      const o = (await c.query('SELECT * FROM pathway_offers WHERE id=$1 AND user_id=$2 AND removed_at IS NULL FOR UPDATE', [i.id, a])).rows[0];
      if (!o) throw notFound('Offer');
      const status = { accept: 'accepted', decline: 'declined', defer: 'deferred' }[i.decision];
      if (o.status === status && (i.decision !== 'defer' || !i.reply_by)) return { row: o, same: true };
      if (o.row_version !== i.row_version) throw stale();
      if (i.decision === 'accept') {
        await youthGate(c, user.id, a, 'recruitment', 'accepting an offer');
        const other = (await c.query("SELECT 1 FROM pathway_offers WHERE bucket_id=$1 AND status='accepted' AND id<>$2 AND removed_at IS NULL", [o.bucket_id, o.id])).rows[0];
        if (other) throw conflict('Another offer for this target is already accepted; change that decision first');
      }
      const row = (await c.query(
        `UPDATE pathway_offers SET status=$2, decided_by=$3, decided_at=now(), decision_note_enc=$4, reply_by=coalesce($5, reply_by), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [o.id, status, user.id, seal(i.note, 'offer_decision'), i.decision === 'defer' ? i.reply_by ?? null : null])).rows[0];
      await logEvent(c, { userId: a, bucketId: o.bucket_id, kind: 'offer_decided', from: o.status, to: status, detail: o.title.slice(0, 120), actorId: user.id });
      const b = (await c.query('SELECT * FROM study_bucket WHERE id=$1 FOR UPDATE', [o.bucket_id])).rows[0];
      if (b && !b.removed_at) {
        if (status === 'accepted') await advanceBucket(c, b, 'accepted', user.id, o.title.slice(0, 120));
        else {
          const live = (await c.query("SELECT 1 FROM pathway_offers WHERE bucket_id=$1 AND status IN ('open','deferred','accepted') AND id<>$2 AND removed_at IS NULL", [o.bucket_id, o.id])).rows[0];
          if (!live && status === 'declined') await advanceBucket(c, b, 'declined', user.id, o.title.slice(0, 120));
          else if (b.status === 'accepted' && o.status === 'accepted') await advanceBucket(c, b, 'offered', user.id, 'Acceptance changed');
        }
      }
      if (user.id !== a) for (const uid of new Set([a, ...(await guardiansOf(a, c))].filter((x) => x !== user.id))) await notify(c, uid, { kind: 'pathway_offer_decision', title: 'An offer decision was recorded', body: 'A decision on a pathway offer was recorded. Open the plan to review it.', data: { offer_id: o.id } });
      return { row };
    });
    return { ...(await offersOf(a, { ids: [out.row.id] }))[0], ...(out.same ? { replay: true } : {}) };
  },
});

// ------------------------------------------------------------------------------------------------ outcomes
cap({
  name: 'get_pathway_outcomes', method: 'GET', path: '/me/pathway/outcomes', tag: TAG,
  summary: 'Where each target stands (stage, and the status of your enquiry at a listed institution) with counts per stage and the full history of stage changes, offers, scholarships and goals, newest first. Nothing in the history is ever deleted.',
  input: z.object({ ...athlete, ...page }),
  async handler({ user }, i) { return outcomesOf(await actingFor(user, i.athlete_id), { limit: i.limit, offset: i.offset }); },
});

// ------------------------------------------------------------------------------------------------ sharing with a coach, and export
cap({
  name: 'share_pathway', method: 'POST', path: '/me/pathway/shares', tag: TAG, status: 201,
  summary: 'Share chosen parts of your plan (targets, goals, deadlines, scholarships, offers, outcomes) with a coach who currently works with you. Sharing again with the same coach changes what they see. You, a verified guardian, or the coach can end it at any time; it also ends by itself if the coaching relationship ends or, for a young person, a guardian withdraws sharing consent.',
  input: z.object({ recipient_id: id, scopes: z.array(z.enum(SCOPES)).min(1).max(6), expires_on: date.nullish(), ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    if (i.recipient_id === a) throw badRequest('Choose someone else');
    return tx(async (c) => {
      await youthGate(c, a, a, 'recruitment_sharing', 'sharing the pathway'); // reads need the guardian's current consent, so a share without it would never work
      if (!(await coachesAthlete(i.recipient_id, a))) throw conflict('That person does not currently coach you. Share with a coach of your team or a coach you work with.');
      const scopes = [...new Set(i.scopes)];
      const row = (await c.query(
        `INSERT INTO pathway_shares(athlete_id, recipient_id, scopes, created_by, expires_at) VALUES ($1,$2,$3,$4,$5::date) ON CONFLICT (athlete_id, recipient_id) WHERE revoked_at IS NULL
         DO UPDATE SET scopes=$3, expires_at=$5::date, row_version=pathway_shares.row_version+1 RETURNING *`, [a, i.recipient_id, scopes, user.id, i.expires_on ?? null])).rows[0];
      await notify(c, i.recipient_id, { kind: 'pathway_shared', title: 'A pathway plan was shared with you', body: 'An athlete you coach shared parts of their pathway plan. Open Athletes\' plans to read it.', data: { athlete_id: a }, dedupe_key: `pathway_share:${row.id}:${row.row_version}` });
      return row;
    });
  },
});

cap({
  name: 'list_pathway_shares', method: 'GET', path: '/me/pathway/shares', tag: TAG,
  summary: 'Who currently has access to your plan and which parts, with when it ends. Pass athlete_id as a verified guardian.',
  input: z.object({ ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    return many(
      `SELECT s.id, s.recipient_id, u.display_name AS recipient_name, u.handle AS recipient_handle, s.scopes, s.expires_at, s.created_at, s.row_version
         FROM pathway_shares s JOIN users u ON u.id=s.recipient_id WHERE s.athlete_id=$1 AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now()) ORDER BY s.created_at, s.id`, [a]);
  },
});

cap({
  name: 'revoke_pathway_share', method: 'POST', path: '/me/pathway/shares/:id/revoke', tag: TAG,
  summary: 'End a share now. The athlete, a verified guardian of a young athlete, or the coach it was shared with can do it. The coach loses access immediately, including to anything they already opened by link or export request. Repeating it does nothing.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await one('SELECT * FROM pathway_shares WHERE id=$1', [i.id]);
    if (!s) throw notFound('Share');
    if (s.recipient_id !== user.id) await actingFor(user, s.athlete_id).catch(() => { throw notFound('Share'); });
    return one('UPDATE pathway_shares SET revoked_at=coalesce(revoked_at, now()), revoked_by=coalesce(revoked_by, $2), row_version=row_version+1 WHERE id=$1 RETURNING id, revoked_at', [s.id, user.id]);
  },
});

cap({
  name: 'list_shared_pathways', method: 'GET', path: '/pathway/shared', tag: TAG,
  summary: 'Coach: the athletes whose pathway plan is shared with you right now, and which parts. People whose share was revoked, expired, whose coaching relationship ended, or (for a young person) whose guardian withdrew consent do not appear.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT s.id, s.athlete_id, u.display_name AS athlete_name, u.handle AS athlete_handle, u.avatar_emoji, s.scopes, s.expires_at, s.created_at
         FROM pathway_shares s JOIN users u ON u.id=s.athlete_id WHERE s.recipient_id=$1 AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now()) ORDER BY u.display_name, s.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    const live = [];
    for (const r of rows) { try { await liveShare(user, r.athlete_id); live.push(r); } catch { /* no longer valid: hidden */ } }
    return live;
  },
});

cap({
  name: 'get_shared_pathway', method: 'GET', path: '/pathway/shared/:athlete_id', tag: TAG,
  summary: 'Coach: read the parts of an athlete\'s pathway plan they shared with you. Only the athlete\'s titles, dates, stages and amounts are shown - never private notes, evidence content or enquiry messages - and each read is audit-logged. Anything not shared, revoked or no longer allowed is "not found".',
  input: z.object({ athlete_id: id }),
  async handler({ user }, i) {
    const s = await liveShare(user, i.athlete_id);
    const view = await sharedView(i.athlete_id, s.scopes);
    await auditSharedRead(user, s);
    const a = await one('SELECT id, display_name, handle, avatar_emoji FROM users WHERE id=$1', [i.athlete_id]);
    return { athlete: a, scopes: s.scopes, expires_at: s.expires_at, ...view };
  },
});

cap({
  name: 'export_pathway', method: 'GET', path: '/me/pathway/export', tag: TAG,
  summary: 'Download your whole plan (targets, goals, deadlines, scholarships, offers, outcomes) as CSV. Amounts keep their own currency. Pass athlete_id as a verified guardian.',
  input: z.object({ ...athlete }),
  async handler({ user }, i) {
    const a = await actingFor(user, i.athlete_id);
    const view = await sharedView(a, SCOPES);
    const rows = exportRows(view);
    await audit(null, user.id, 'export_pathway', 'users', a);
    return { filename: 'pathway-plan.csv', rows: rows.length, csv: toCsv(EXPORT_COLS, rows) };
  },
});

cap({
  name: 'export_shared_pathway', method: 'GET', path: '/pathway/shared/:athlete_id/export', tag: TAG,
  summary: 'Coach: export only the parts shared with you as CSV. Re-checked like every read: if the share ended, you get "not found". Audit-logged.',
  input: z.object({ athlete_id: id }),
  async handler({ user }, i) {
    const s = await liveShare(user, i.athlete_id);
    const rows = exportRows(await sharedView(i.athlete_id, s.scopes));
    await audit(null, user.id, 'export_pathway', 'pathway_shares', s.id);
    return { filename: 'shared-pathway.csv', rows: rows.length, csv: toCsv(EXPORT_COLS, rows) };
  },
});
