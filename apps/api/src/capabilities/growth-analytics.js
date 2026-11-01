// Growth, participation & operator analytics (#73). This EXTENDS the governed KPI layer (kpi-layer.js): the new metrics (first completed activity,
// repeat participants, activation, vacancy fill, booking and payment failure, provider earnings) live in kpi/catalogue.js and are read with the
// existing /analytics/metrics capabilities, scope checks, drill-down, dashboards and exports. What this file adds is the part the KPI layer does not
// have: consent-aware telemetry with replay protection and reconciliation, first-touch attribution, feature-flag experiments with exposure records,
// and data-quality indicators. Referral codes stay in the loyalty engine; attribution here only labels how a person arrived.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { EVENTS, describeEvent } from '../growth/events.js';
import { OUTCOME_KEYS } from '../growth/outcomes.js';
import {
  EXPERIMENT_COLS, SOURCES, dataQuality, experimentResults, expose, getConsent, loadExperiment, mustBeOperator, outcomeCatalogue, recordAttribution, recordEvents, setConsent,
} from '../growth/service.js';

const TAG = 'Analytics';
const outcome = z.enum(OUTCOME_KEYS);
const variantsSchema = z.array(z.object({ key: z.string().regex(/^[a-z0-9_]{2,24}$/), weight: z.number().int().min(1).max(100) }).strict()).min(2).max(5)
  .refine((v) => new Set(v.map((x) => x.key)).size === v.length, 'Variant keys must be different')
  .describe('The first variant is the control (the unchanged experience); weights decide the share each variant gets');
const eventSchema = z.object({
  event_key: z.string().max(60), event_version: z.number().int().min(1).optional(),
  dedupe_key: z.string().min(8).max(80).describe('Unique per occurrence; send the same key when you retry so it is counted once'),
  occurred_at: z.string().datetime({ offset: true }), platform: z.enum(['web', 'ios', 'android']).optional(),
  entity_type: z.string().max(30).optional(), entity_id: id.optional(), sport_id: id.optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
}).strict();

// ---- consent & attribution (any signed-in person) ------------------------------------------------------------------------------------
cap({
  name: 'get_analytics_consent', method: 'GET', path: '/analytics/consent', tag: TAG,
  summary: 'Whether product analytics is switched on for you. Nothing is recorded about you until you choose "on", and it is never recorded for young people (`available: false`).',
  handler: ({ user }) => getConsent(user.id),
});
cap({
  name: 'set_analytics_consent', method: 'POST', status: 200, path: '/analytics/consent', tag: TAG,
  summary: 'Switch product analytics on or off for yourself. Switching off takes effect at once: what was recorded about you is de-identified and you drop out of experiments. Young people cannot switch it on.',
  input: z.object({ granted: z.boolean() }),
  async handler({ user }, i) {
    const out = await setConsent(user.id, i.granted);
    await audit(null, user.id, i.granted ? 'analytics_consent_granted' : 'analytics_consent_withdrawn', 'analytics_consents', user.id);
    return out;
  },
});
cap({
  name: 'record_attribution', method: 'POST', path: '/analytics/attribution', tag: TAG, status: 200,
  summary: 'Tell us how you found the app (first touch only: the first answer is kept and never overwritten). Recorded only if analytics is on for you. Being invited by a member is recorded by the referral code you used, not here.',
  input: z.object({ source: z.enum(SOURCES), campaign: z.string().trim().regex(/^[A-Za-z0-9_-]{1,60}$/, 'Letters, numbers, - and _ only').optional() }),
  handler: ({ user }, i) => recordAttribution(user.id, i),
});

// ---- telemetry ---------------------------------------------------------------------------------------------------------------------------
cap({
  name: 'list_analytics_event_definitions', method: 'GET', path: '/analytics/events/definitions', tag: TAG,
  summary: 'The versioned telemetry events the apps may send, the entity types each may refer to and the closed set of properties it carries. There is no event for health, clinical, insurance, legal or young-people records.',
  handler: () => EVENTS.map(describeEvent),
});
cap({
  name: 'record_analytics_events', method: 'POST', path: '/analytics/events', tag: TAG, status: 200,
  summary: 'Send up to 50 usage events. Each gets its own result: `accepted`, `duplicate` (the same dedupe_key was already counted, so retrying is safe) or `dropped` with a reason. Nothing is stored unless analytics is on for you. Events never change a governed KPI; they are checked against bookings, games and payments on record.',
  input: z.object({ events: z.array(eventSchema).min(1).max(50) }),
  handler: ({ user }, i) => recordEvents(user.id, i.events),
});

// ---- experiments ---------------------------------------------------------------------------------------------------------------------------
cap({
  name: 'expose_experiment', method: 'POST', path: '/analytics/experiments/:key/exposure', tag: TAG, status: 200,
  summary: 'Ask which variant of an experiment you are in and note that you were shown it. The answer never changes for you. The exposure is recorded once and only if analytics is on for you; young people always get the standard experience. A stopped or unknown-to-you experiment returns the control with `active: false`.',
  input: z.object({ key: z.string().regex(/^[a-z0-9_]{3,40}$/) }),
  handler: ({ user }, i) => expose(user.id, i.key),
});
cap({
  name: 'list_experiment_outcomes', method: 'GET', path: '/analytics/experiments/outcomes', tag: TAG, auth: ['admin'],
  summary: 'The outcomes an experiment can use as its success or guardrail measure, each decided from the records on file and saying whether higher or lower is better.',
  handler: () => outcomeCatalogue(),
});
cap({
  name: 'create_experiment', method: 'POST', path: '/analytics/experiments', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Define a feature-flag experiment before it runs: a hypothesis in words, the variants (first is the control), one success measure and the guardrail measures that must not get worse. It starts as a draft.',
  input: z.object({
    key: z.string().regex(/^[a-z0-9_]{3,40}$/), name: z.string().trim().min(3).max(120), hypothesis: z.string().trim().min(10).max(600).describe('What you expect to happen and why'),
    variants: variantsSchema, success_metric: outcome, guardrails: z.array(outcome).max(3).default([]),
    min_sample: z.number().int().min(10).max(100000).default(100).describe('People per variant who must finish the window before a difference is called'),
    window_days: z.number().int().min(1).max(90).default(14).describe('How many days after first seeing it a person is followed'),
  }).refine((v) => !v.guardrails.includes(v.success_metric), 'The success measure cannot also be a guardrail').refine((v) => new Set(v.guardrails).size === v.guardrails.length, 'Each guardrail once'),
  async handler({ user }, i) {
    mustBeOperator(user);
    const row = await one(`INSERT INTO experiments(key, name, hypothesis, variants, success_metric, guardrails, min_sample, window_days, owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (key) DO NOTHING RETURNING ${EXPERIMENT_COLS}`, [i.key, i.name, i.hypothesis, JSON.stringify(i.variants), i.success_metric, i.guardrails, i.min_sample, i.window_days, user.id]);
    if (!row) throw conflict('An experiment with that key already exists');
    return row;
  },
});
cap({
  name: 'list_experiments', method: 'GET', path: '/analytics/experiments', tag: TAG, auth: ['admin'],
  summary: 'Experiments, newest first, with how many people have been exposed to each.',
  input: z.object({ status: z.enum(['draft', 'running', 'stopped', 'concluded']).optional(), ...page }),
  async handler({ user }, i) {
    mustBeOperator(user);
    return many(`SELECT ${EXPERIMENT_COLS.split(', ').map((c) => `e.${c}`).join(', ')}, (SELECT count(*)::int FROM experiment_exposures x WHERE x.experiment_id=e.id) AS exposed
      FROM experiments e WHERE ($1::text IS NULL OR e.status=$1) ORDER BY e.created_at DESC, e.id LIMIT $2 OFFSET $3`, [i.status ?? null, i.limit, i.offset]);
  },
});
cap({
  name: 'get_experiment', method: 'GET', path: '/analytics/experiments/:id', tag: TAG, auth: ['admin'],
  summary: 'One experiment with its definition and exposure count.',
  input: z.object({ id }),
  async handler({ user }, i) {
    mustBeOperator(user);
    const e = await loadExperiment(i.id);
    if (!e) throw notFound('Experiment');
    return { ...e, exposed: Number((await one('SELECT count(*) AS n FROM experiment_exposures WHERE experiment_id=$1', [e.id])).n) };
  },
});
const NEXT = { draft: ['running'], running: ['stopped', 'concluded'], stopped: ['running', 'concluded'], concluded: [] };
cap({
  name: 'update_experiment', method: 'PATCH', path: '/analytics/experiments/:id', tag: TAG, auth: ['admin'],
  summary: 'Move an experiment on (draft → running → stopped or concluded; a stopped one can resume) or, while it is still a draft, edit its name, hypothesis, variants and measures. Concluding needs a written conclusion. `row_version` guards against two people editing at once. An experiment is never deleted.',
  input: z.object({ id, row_version: z.number().int().min(1), status: z.enum(['running', 'stopped', 'concluded']).optional(), conclusion: z.string().trim().min(10).max(600).optional(),
    name: z.string().trim().min(3).max(120).optional(), hypothesis: z.string().trim().min(10).max(600).optional(), variants: variantsSchema.optional(), success_metric: outcome.optional(), guardrails: z.array(outcome).max(3).optional(),
    min_sample: z.number().int().min(10).max(100000).optional(), window_days: z.number().int().min(1).max(90).optional() }),
  async handler({ user }, i) {
    mustBeOperator(user);
    const out = await tx(async (c) => {
      const e = (await c.query('SELECT * FROM experiments WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!e) throw notFound('Experiment');
      if (e.row_version !== i.row_version) throw conflict('Someone else changed this experiment. Reload it and try again.', { row_version: e.row_version });
      const design = ['name', 'hypothesis', 'variants', 'success_metric', 'guardrails', 'min_sample', 'window_days'].filter((k) => i[k] !== undefined);
      if (design.length && e.status !== 'draft') throw conflict('Only a draft can be redesigned. Exposure records and results would no longer match the definition.');
      const sets = [], args = [];
      for (const k of design) { args.push(k === 'variants' ? JSON.stringify(i[k]) : i[k]); sets.push(`${k}=$${args.length + 1}`); }
      const nextGuard = i.guardrails ?? e.guardrails, nextSuccess = i.success_metric ?? e.success_metric;
      if (nextGuard.includes(nextSuccess)) throw badRequest('The success measure cannot also be a guardrail');
      if (i.status) {
        if (!NEXT[e.status].includes(i.status)) throw conflict(`A ${e.status} experiment cannot become ${i.status}`);
        if (i.status === 'concluded' && !i.conclusion) throw badRequest('Write down what you concluded before closing the experiment');
        args.push(i.status); sets.push(`status=$${args.length + 1}`);
        if (i.status === 'running' && !e.started_at) sets.push('started_at=now()');
        if (i.status !== 'running') sets.push('ended_at=now()'); else sets.push('ended_at=NULL');
        if (i.conclusion) { args.push(i.conclusion); sets.push(`conclusion=$${args.length + 1}`); }
      }
      if (!sets.length) throw badRequest('Nothing to change');
      return (await c.query(`UPDATE experiments SET ${sets.join(', ')}, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING ${EXPERIMENT_COLS}`, [i.id, ...args])).rows[0];
    });
    await audit(null, user.id, 'experiment_update', 'experiments', out.id);
    return out;
  },
});
cap({
  name: 'get_experiment_results', method: 'GET', path: '/analytics/experiments/:id/results', tag: TAG, auth: ['admin'],
  summary: 'How each variant is doing on the success measure and the guardrails, with 95% intervals, only counting people who switched analytics on and finished their window. It says plainly when there is not enough data to call a difference.',
  input: z.object({ id }),
  async handler({ user }, i) {
    mustBeOperator(user);
    const e = await loadExperiment(i.id);
    if (!e) throw notFound('Experiment');
    return experimentResults(e);
  },
});
cap({
  name: 'export_experiment_results', method: 'GET', path: '/analytics/experiments/:id/export', tag: TAG, auth: ['admin'],
  summary: 'The experiment results as a CSV file (one row per variant and measure). Aggregates only; no person is listed. The export is recorded in the audit log.',
  input: z.object({ id }),
  async handler({ user }, i) {
    mustBeOperator(user);
    const e = await loadExperiment(i.id);
    if (!e) throw notFound('Experiment');
    const r = await experimentResults(e);
    const rows = [['experiment', 'variant', 'control', 'measure', 'role', 'exposed', 'finished_window', 'people_meeting_measure', 'rate_percent', 'low_percent', 'high_percent']];
    for (const v of r.variants) for (const [m, o] of Object.entries(v.outcomes)) rows.push([e.key, v.key, v.control, m, m === e.success_metric ? 'success' : 'guardrail', v.exposed, v.mature, o.successes, o.rate ?? '', o.low ?? '', o.high ?? '']);
    const csv = rows.map((row) => row.map((x) => `"${String(x).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    await audit(null, user.id, 'experiment_export', 'experiments', e.id);
    return { filename: `experiment-${e.key}.csv`, content_type: 'text/csv', encoding: 'utf8', content: csv };
  },
});

// ---- data quality ---------------------------------------------------------------------------------------------------------------------------
cap({
  name: 'get_growth_data_quality', method: 'GET', path: '/analytics/growth/quality', tag: TAG, auth: ['admin'],
  summary: 'How trustworthy the growth data is: telemetry freshness, how many replayed deliveries were ignored, how many events match a booking, game or payment on record, consent coverage and the retention rule. Counts only; no person is identified.',
  async handler({ user }) {
    mustBeOperator(user);
    return dataQuality();
  },
});
