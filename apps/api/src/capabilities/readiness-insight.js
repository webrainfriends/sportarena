import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { guardianLink } from '../youth.js';
import { shareBlock, reasonText, shareEvent } from '../wellness-sharing.js';
import { effective, settingsView } from '../readiness-config.js';
import { DEFAULT_CONFIG, BOUNDS, FORMULA, configProblems, explain, history, normaliseConfig } from '../readiness.js';

// Transparency over the readiness score and workload ratio (#329): what went in, how much of it was logged, which formula and settings
// produced it, how it changed over time, and what it cannot tell you. Settings can be adjusted by a qualified coach or clinician only
// through a live wellness share that includes readiness; every change is a new version and the athlete can reset to the standard.

const TAG = 'Athlete health';
const day = z.string().date();
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const notFuture = (d) => { if (d > plusDays(today(), 1)) throw badRequest('That date is in the future'); return d; };
const num = (min, max) => z.number().min(min).max(max);

const configInput = z.object({
  weights: z.object({ sleep: num(0, 1), soreness: num(0, 1), mood: num(0, 1) }).describe('shares of the score; must add up to 1 and each stay within 0.1-0.7'),
  bands: z.object({ ready_min: num(0, 100), moderate_min: num(0, 100) }).describe('lowest score for "ready" (50-90) and for "take it steady" (20-60)'),
  workload: z.object({
    low_below: num(0, 3), optimal_max: num(0, 3), caution_max: num(0, 3),
    caution_penalty: num(0, 100), high_penalty: num(0, 100), min_span_days: z.number().int().min(1).max(100),
  }).describe('acute:chronic thresholds, the points taken off the score in the caution and high bands, and the days of logs needed before the ratio is trusted'),
});

const LOADS = (c, athleteId, from, to) => c.query('SELECT session_date::text AS session_date, load FROM session_loads WHERE user_id=$1 AND archived_at IS NULL AND session_date BETWEEN $2 AND $3', [athleteId, from, to]).then((r) => r.rows);

/** Logs and settings for one athlete and day, then the explanation. `c` is a client or the pool-backed query. */
async function explainFor(c, athleteId, date, { shown = null, eff } = {}) {
  const e = eff ?? await effective(c, athleteId);
  // one after another: inside a transaction these share a single connection
  const wellness = (await c.query('SELECT sleep_hours, sleep_quality, soreness, mood FROM wellness_logs WHERE user_id=$1 AND log_date=$2', [athleteId, date])).rows[0] ?? null;
  const pain = (await c.query('SELECT DISTINCT ON (region, side, kind) severity FROM body_pain_logs WHERE user_id=$1 AND resolved_at IS NULL ORDER BY region, side, kind, created_at DESC', [athleteId])).rows;
  const loads = await LOADS(c, athleteId, plusDays(date, -90), date);
  const counts = (await c.query(`SELECT count(*) FILTER (WHERE log_date > $2::date - 7)::int AS d7, count(*)::int AS d28 FROM wellness_logs WHERE user_id=$1 AND log_date BETWEEN $2::date - 27 AND $2`, [athleteId, date])).rows[0];
  const out = explain({ date, wellness, pain, loads, config: e.config, daysLogged: counts, shown });
  return { ...out, settings: settingsView(e) };
}


/** Yourself, or a verified guardian of a young athlete. Anyone else learns nothing. */
async function ownerOf(user, athleteId) {
  if (!athleteId || user.id === athleteId || isAdmin(user)) return athleteId ?? user.id;
  if (await guardianLink(user.id, athleteId)) return athleteId;
  throw notFound('Athlete');
}

// ---------- athlete ----------

cap({
  name: 'explain_readiness', method: 'GET', path: '/me/readiness/explanation', tag: TAG,
  summary: 'Why your readiness score is what it is: each input with its weight, where it came from (daily log or body map) and the points it adds; what is missing and how to add it; how much of the formula your logs cover; the workload basis and whether it counted; the formula version and settings in force (and who set them); and the limits. Guidance only, not a diagnosis or clearance.',
  input: z.object({ date: day.optional() }),
  handler: ({ user }, i) => explainFor({ query }, user.id, notFuture(i.date ?? today())),
});

cap({
  name: 'get_readiness_history', method: 'GET', path: '/me/readiness/history', tag: TAG,
  summary: 'Your readiness day by day (default last 28 days, at most 90) computed from the same logs and the settings in force now, with how many inputs each day had. Days with nothing logged have a null score; nothing is filled in.',
  input: z.object({ from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    const to = notFuture(i.to ?? today()), from = i.from ?? plusDays(to, -27);
    if (to < from) throw badRequest('to is before from');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 89) throw badRequest('History is limited to 90 days at a time');
    const c = { query };
    const eff = await effective(c, user.id);
    const [wellnessRows, painRows, loads] = await Promise.all([
      many('SELECT log_date::text AS log_date, sleep_hours, sleep_quality, soreness, mood FROM wellness_logs WHERE user_id=$1 AND log_date BETWEEN $2 AND $3', [user.id, from, to]),
      many('SELECT region, side, kind, severity, created_at, resolved_at FROM body_pain_logs WHERE user_id=$1 AND created_at < $2::date + 1', [user.id, to]),
      LOADS(c, user.id, plusDays(from, -90), to),
    ]);
    const days = history({ from, to, wellnessRows, painRows, loads, config: eff.config });
    return {
      from, to, days, formula: FORMULA, settings: settingsView(eff),
      note: 'Recomputed from your logs with the settings in force now, so a change of settings also changes past days. Days with no log have no score.',
      summary: { days_scored: days.filter((d) => d.score !== null).length, days_total: days.length },
    };
  },
});

async function versionsOf(athleteId, limit, offset) {
  return many(`SELECT r.version, r.source, r.config, r.rationale_enc, r.set_by_kind, r.created_at, u.display_name AS set_by_name
    FROM readiness_configs r JOIN users u ON u.id=r.set_by WHERE r.athlete_id=$1 ORDER BY r.version DESC LIMIT $2 OFFSET $3`, [athleteId, limit, offset]);
}

cap({
  name: 'get_readiness_config', method: 'GET', path: '/me/readiness/config', tag: TAG,
  summary: 'The weights and thresholds behind your readiness and workload bands: the standard values, the allowed ranges, what is in force now (standard, custom, or paused because the person who set it can no longer see your data), and the full version history with who changed what and why. A verified guardian can read this for a young athlete. Reading reasons is audit-logged.',
  input: z.object({ athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const athlete = await ownerOf(user, i.athlete_id);
    const [eff, rows] = await Promise.all([effective({ query }, athlete), versionsOf(athlete, i.limit, i.offset)]);
    if (rows.some((r) => r.rationale_enc)) await audit(null, user.id, 'read_readiness_config', 'readiness_configs', null);
    return {
      formula: FORMULA, standard: DEFAULT_CONFIG, bounds: BOUNDS, current: settingsView(eff),
      versions: rows.map(({ rationale_enc, ...r }) => ({ ...r, reason: decrypt(rationale_enc, 'readiness_configs.rationale') })),
    };
  },
});

cap({
  name: 'reset_readiness_config', method: 'POST', path: '/me/readiness/config/reset', tag: TAG,
  summary: 'Go back to the standard weights and thresholds. Recorded as a new version (nothing is deleted). Send the `version` you last saw; a stale one is a 409. Repeating it when already on the standard is harmless. A verified guardian can do this for a young athlete.',
  input: z.object({ athlete_id: id.optional(), version: z.number().int().min(0) }),
  async handler({ user }, i) {
    const athlete = await ownerOf(user, i.athlete_id);
    return tx(async (c) => {
      await c.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [athlete]);
      const latest = (await c.query('SELECT version, source FROM readiness_configs WHERE athlete_id=$1 ORDER BY version DESC LIMIT 1', [athlete])).rows[0];
      const current = latest?.version ?? 0;
      if (!latest || latest.source === 'reset') return { version: current, source: 'standard', changed: false };
      if (current !== i.version) throw conflict('Your settings changed since you opened them. Reload and try again.', { code: 'stale_version', version: current });
      const r = (await c.query(`INSERT INTO readiness_configs(athlete_id, version, source, config, set_by, set_by_kind) VALUES ($1,$2,'reset',$3,$4,$5) RETURNING version, created_at`,
        [athlete, current + 1, DEFAULT_CONFIG, user.id, athlete === user.id ? 'athlete' : 'guardian'])).rows[0];
      await audit(c, user.id, 'reset_readiness_config', 'readiness_configs', null);
      return { version: r.version, source: 'standard', changed: true, at: r.created_at };
    });
  },
});

// ---------- coach / clinician, through a live share ----------

/** The share must be mine, live right now (relationship / grant / credential / guardian consent re-checked) and include readiness. */
async function readinessShare(c, user, shareId, lock) {
  const s = (await c.query(`SELECT * FROM wellness_shares WHERE id=$1 AND recipient_id=$2 ${lock}`, [shareId, user.id])).rows[0];
  if (!s) throw notFound('Share');
  const block = await shareBlock(c, s);
  if (block) throw forbidden(reasonText(block));
  if (!s.fields.includes('readiness')) throw forbidden('The athlete has not shared their readiness score with you');
  return s;
}

cap({
  name: 'get_shared_readiness', method: 'GET', path: '/wellness-shared/:id/readiness', tag: TAG,
  summary: 'Coach / clinician: how an athlete\'s readiness is built, through a share that includes readiness. Same explanation the athlete sees, but raw values appear only for the fields they chose to share (sleep, soreness, mood, workload); the rest still show their weight and that they counted. Includes the settings in force, the allowed ranges and whether you can adjust them. Access is re-checked on every call and each view is visible to the athlete.',
  input: z.object({ id, date: day.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await readinessShare(c, user, i.id, 'FOR SHARE');
    const date = i.date ?? today();
    if (date > today() || date < plusDays(today(), -(s.history_days - 1))) throw badRequest(`Pick a day within the ${s.history_days} days shared with you`);
    const shown = new Set(['sleep', 'soreness', 'mood', 'workload'].filter((f) => s.fields.includes(f)));
    const out = await explainFor(c, s.athlete_id, date, { shown });
    await shareEvent(c, s, user.id, 'viewed', { what: 'readiness_explanation', date });
    await audit(c, user.id, 'read_wellness_shared', 'wellness_shares', s.id);
    const athlete = (await c.query('SELECT id, display_name, handle FROM users WHERE id=$1', [s.athlete_id])).rows[0];
    // the day-by-day trend over the shared window (at most 28 days): scores and how many inputs each had, never the raw logs
    const from = plusDays(today(), -(Math.min(s.history_days, 28) - 1));
    const wellnessRows = (await c.query('SELECT log_date::text AS log_date, sleep_hours, sleep_quality, soreness, mood FROM wellness_logs WHERE user_id=$1 AND log_date BETWEEN $2 AND $3', [s.athlete_id, from, today()])).rows;
    const painRows = (await c.query('SELECT region, side, kind, severity, created_at, resolved_at FROM body_pain_logs WHERE user_id=$1 AND created_at < $2::date + 1', [s.athlete_id, today()])).rows;
    const loads = await LOADS(c, s.athlete_id, plusDays(from, -90), today());
    const trend = history({ from, to: today(), wellnessRows, painRows, loads, config: (await effective(c, s.athlete_id)).config })
      .map((d) => ({ date: d.date, score: d.score, band: d.band, inputs_logged: d.inputs_logged, logged: d.logged }));
    return { athlete, history: trend, share: { id: s.id, purpose: s.purpose, fields: s.fields, history_days: s.history_days, expires_at: s.expires_at }, ...out, standard: DEFAULT_CONFIG, bounds: BOUNDS, can_configure: true, basis: 'self_reported' };
  }),
});

cap({
  name: 'set_shared_readiness_config', method: 'POST', path: '/wellness-shared/:id/readiness-config', tag: TAG,
  summary: 'Coach / clinician: adjust the readiness weights and workload thresholds for an athlete who shared readiness with you. Needs a written reason and the `version` you last saw (a stale one is a 409). Values must stay inside the allowed ranges and the weights add up to 1. It is a new version, shown to the athlete (who is notified and can reset to the standard), and it applies only while your share stays live. Repeating the identical request is harmless.',
  input: z.object({ id, version: z.number().int().min(0), reason: z.string().trim().min(10).max(500).describe('why these settings suit this athlete; encrypted at rest'), ...configInput.shape }),
  async handler({ user }, i) {
    const cfg = normaliseConfig({ weights: i.weights, bands: i.bands, workload: i.workload });
    const problems = configProblems(cfg);
    if (problems.length) throw badRequest(problems.join('. '), { code: 'invalid_config', problems });
    return tx(async (c) => {
      const probe = (await c.query('SELECT athlete_id FROM wellness_shares WHERE id=$1 AND recipient_id=$2', [i.id, user.id])).rows[0];
      if (!probe) throw notFound('Share');
      await c.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [probe.athlete_id]); // serialises version numbers for this athlete
      const s = await readinessShare(c, user, i.id, 'FOR SHARE');
      const latest = (await c.query('SELECT * FROM readiness_configs WHERE athlete_id=$1 ORDER BY version DESC LIMIT 1', [s.athlete_id])).rows[0];
      const current = latest?.version ?? 0;
      const same = latest && latest.source === 'staff' && latest.set_by === user.id && latest.share_id === s.id && JSON.stringify(normaliseConfig(latest.config)) === JSON.stringify(cfg);
      if (same && (i.version === current || i.version === current - 1)) return { version: current, changed: false, settings: cfg }; // a retry of the same request
      if (i.version !== current) throw conflict('These settings changed since you opened them. Reload and try again.', { code: 'stale_version', version: current });
      const r = (await c.query(`INSERT INTO readiness_configs(athlete_id, version, source, config, rationale_enc, set_by, set_by_kind, share_id) VALUES ($1,$2,'staff',$3,$4,$5,$6,$7) RETURNING id, version, created_at`,
        [s.athlete_id, current + 1, cfg, encrypt(i.reason, 'readiness_configs.rationale'), user.id, s.recipient_kind, s.id])).rows[0];
      await shareEvent(c, s, user.id, 'updated', { what: 'readiness_config', version: r.version });
      await audit(c, user.id, 'set_readiness_config', 'readiness_configs', r.id);
      await notify(c, s.athlete_id, { kind: 'readiness_config_changed', title: 'Your readiness settings were adjusted', body: 'A coach or clinician you share with changed how readiness is weighted. See the details and reset any time under Health → Recovery.', data: { screen: 'Health' }, dedupe_key: `readiness_config:${r.id}` });
      return { version: r.version, changed: true, at: r.created_at, settings: cfg };
    });
  },
});
