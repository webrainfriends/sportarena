// Physio rehab tracking: the maths and queries behind outcome series, goal progress, home-exercise adherence, report snapshots and
// suggestions. Pure data logic with no authorisation: every capability that calls this has already checked the provider's verified
// credential and the patient's active full consent (or that the reader is the patient).
import { createHash } from 'node:crypto';
import { one, many } from './db.js';
import { decrypt } from './crypto.js';

export const REGIONS = ['neck', 'shoulder', 'elbow', 'wrist_hand', 'upper_back', 'lower_back', 'hip', 'knee', 'ankle_foot', 'core', 'full_body'];
/** `better` says which way is an improvement; `site` measures need a body region to mean anything. */
export const MEASURES = {
  pain: { label: 'Pain', unit: '/10', min: 0, max: 10, better: 'lower', site: false },
  range_of_motion: { label: 'Range of motion', unit: '°', min: 0, max: 360, better: 'higher', site: true },
  strength: { label: 'Strength', unit: 'kg', min: 0, max: 1000, better: 'higher', site: true },
  function_score: { label: 'Function score', unit: '%', min: 0, max: 100, better: 'higher', site: false },
  balance_hold: { label: 'Single-leg balance', unit: 's', min: 0, max: 600, better: 'higher', site: true },
  swelling: { label: 'Swelling (girth)', unit: 'cm', min: 0, max: 200, better: 'lower', site: true },
};
export const MEASURE_KEYS = Object.keys(MEASURES);

export const ctx = { outcomeNote: 'physio_outcomes.note', outcomeVoid: 'physio_outcomes.void', goalTitle: 'physio_goals.title', goalClosing: 'physio_goals.closing', adherenceNote: 'treatment_plan_adherence.note', reportNarrative: 'physio_reports.narrative', reportSnapshot: 'physio_report_versions.snapshot' };

export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5);
const round1 = (n) => Math.round(n * 10) / 10;
/** A Postgres `date` arrives as a Date at local midnight: read it back with local parts so the day never shifts. */
export const ymd = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d == null ? null : String(d).slice(0, 10));

/** A clinician's consented patients: active, unexpired, full-scope grants. SQL fragment on provider id `$1` (alias g). */
export const ACCESS = "SELECT g.athlete_id FROM medical_grants g WHERE g.provider_id=$1 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()) AND g.scope='full'";

// ------------------------------------------------------------------ outcome series
export const seriesKey = (r) => `${r.measure}|${r.body_region ?? ''}|${r.side ?? ''}`;

/** Live (not voided) readings, oldest first. `providerId` narrows to one clinician's own readings; `withNotes` decrypts the clinician note. */
export async function loadOutcomes(patientId, { providerId = null, to = null, withNotes = false } = {}) {
  const rows = await many(
    `SELECT o.id, o.measure, o.body_region, o.side, o.value, o.measured_at, o.encounter_id, o.plan_id, o.provider_id, o.note_enc FROM physio_outcomes o
      WHERE o.patient_id=$1 AND o.voided_at IS NULL AND ($2::uuid IS NULL OR o.provider_id=$2) AND ($3::date IS NULL OR o.measured_at < $3::date + 1) ORDER BY o.measured_at, o.created_at`, [patientId, providerId, to]);
  return rows.map(({ note_enc, ...r }) => ({ ...r, value: Number(r.value), ...(withNotes ? { note: note_enc ? decrypt(note_enc, ctx.outcomeNote) : null } : {}) }));
}

/** Group readings into series with baseline, latest and the change since the baseline. "improved" is only a statement about the numbers. */
export function buildSeries(rows, { from = null, keepPoints = 60 } = {}) {
  const groups = new Map();
  for (const r of rows) { const k = seriesKey(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  return [...groups.entries()].map(([key, list]) => {
    const def = MEASURES[list[0].measure], first = list[0], last = list.at(-1);
    const change = round1(last.value - first.value);
    const lowerIsBetter = def.better === 'lower';
    return {
      key, measure: list[0].measure, label: def.label, unit: def.unit, body_region: list[0].body_region ?? null, side: list[0].side ?? null, better: def.better, count: list.length,
      in_period: from ? list.filter((r) => new Date(r.measured_at) >= new Date(`${from}T00:00:00Z`)).length : list.length,
      baseline: { value: first.value, measured_at: first.measured_at }, latest: { value: last.value, measured_at: last.measured_at },
      change: list.length < 2 ? null : change, direction: list.length < 2 ? null : change === 0 ? 'unchanged' : (change < 0) === lowerIsBetter ? 'improved' : 'worse',
      points: list.slice(-keepPoints).map((r) => ({ id: r.id, value: r.value, measured_at: r.measured_at, ...(r.note !== undefined ? { note: r.note } : {}) })),
    };
  }).sort((a, b) => a.label.localeCompare(b.label) || String(a.body_region).localeCompare(String(b.body_region)));
}

// ------------------------------------------------------------------ goals
/** Goals with the newest reading of their own measure (since the goal was set), in one query. */
export const GOAL_SQL = `SELECT g.*, u.display_name AS patient_name, lr.value AS latest_value, lr.measured_at AS latest_at
  FROM physio_goals g JOIN users u ON u.id=g.patient_id
  LEFT JOIN LATERAL (SELECT o.value, o.measured_at FROM physio_outcomes o WHERE o.patient_id=g.patient_id AND o.voided_at IS NULL AND g.measure IS NOT NULL AND o.measure=g.measure
        AND o.body_region IS NOT DISTINCT FROM g.body_region AND o.side IS NOT DISTINCT FROM g.side AND o.measured_at >= g.created_at - interval '1 day' ORDER BY o.measured_at DESC, o.created_at DESC LIMIT 1) lr ON true`;

/** Progress from baseline to target (0-100) using the newest reading; the direction comes from baseline vs target. */
export function goalProgress(g) {
  if (!g.measure) return { tracked: false, latest: null, percent: null, met: false };
  if (g.latest_value == null) return { tracked: true, latest: null, percent: null, met: false };
  const base = Number(g.baseline), target = Number(g.target), cur = Number(g.latest_value);
  const met = target < base ? cur <= target : cur >= target;
  const percent = target === base ? (met ? 100 : 0) : Math.max(0, Math.min(100, Math.round((100 * (cur - base)) / (target - base))));
  return { tracked: true, latest: { value: cur, measured_at: g.latest_at }, percent, met };
}

export function shapeGoal(g, { forProvider }) {
  const { title_enc, closing_note_enc, latest_value, latest_at, patient_name, ...r } = g;
  return {
    id: r.id, patient_id: r.patient_id, patient_name, plan_id: r.plan_id, title: decrypt(title_enc, ctx.goalTitle), measure: r.measure, body_region: r.body_region, side: r.side,
    unit: r.measure ? MEASURES[r.measure].unit : null, baseline: r.baseline == null ? null : Number(r.baseline), target: r.target == null ? null : Number(r.target), target_date: ymd(r.target_date),
    status: r.status, closed_at: r.closed_at, created_at: r.created_at, row_version: r.row_version, progress: goalProgress(g),
    ...(forProvider ? { shared: r.shared, closing_note: closing_note_enc ? decrypt(closing_note_enc, ctx.goalClosing) : null } : { closing_note: null }),
  };
}

// ------------------------------------------------------------------ adherence
/** Days a week the clinician asked for: the busiest exercise in the published plan (3 when none says). */
export async function expectedPerWeek(planIds) {
  const rows = await many(`SELECT v.plan_id, max(i.times_per_week)::int AS n, min(v.published_at) AS first_published FROM treatment_plan_versions v LEFT JOIN treatment_plan_items i ON i.plan_version_id=v.id
      WHERE v.plan_id = ANY($1::uuid[]) AND v.status IN ('published','superseded') GROUP BY v.plan_id`, [planIds]);
  return new Map(rows.map((r) => [r.plan_id, { per_week: r.n ?? 3, first_published: r.first_published }]));
}

/** What the patient logged for the plan between two dates (latest entry per day). done = 1 day, partial = half a day. */
export async function adherenceFor(planIds, from, to) {
  if (!planIds.length) return new Map();
  const [exp, logs] = await Promise.all([
    expectedPerWeek(planIds),
    many(`SELECT DISTINCT ON (plan_id, done_on) plan_id, done_on, status, pain, effort FROM treatment_plan_adherence WHERE plan_id = ANY($1::uuid[]) AND done_on BETWEEN $2::date AND $3::date ORDER BY plan_id, done_on, created_at DESC`, [planIds, from, to]),
  ]);
  const out = new Map();
  for (const id of planIds) {
    const e = exp.get(id);
    const start = e?.first_published ? [from, new Date(e.first_published).toISOString().slice(0, 10)].sort().at(-1) : from;
    const days = Math.max(0, daysBetween(start, to) + 1);
    const mine = logs.filter((l) => l.plan_id === id && ymd(l.done_on) >= start);
    const done = mine.filter((l) => l.status === 'done').length, partial = mine.filter((l) => l.status === 'partial').length, skipped = mine.filter((l) => l.status === 'skipped').length;
    const expected = e ? Math.max(1, Math.round((e.per_week * days) / 7)) : 0;
    const avg = (k) => { const v = mine.map((l) => l[k]).filter((x) => x != null); return v.length ? round1(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    out.set(id, {
      from: start, to, expected_per_week: e?.per_week ?? null, expected_days: expected, days_done: done, days_partial: partial, days_skipped: skipped, days_logged: done + partial + skipped,
      percent: expected ? Math.min(100, Math.round((100 * (done + partial * 0.5)) / expected)) : null, avg_pain: avg('pain'), avg_effort: avg('effort'),
      last_logged_on: mine.length ? mine.map((l) => ymd(l.done_on)).sort().at(-1) : null,
    });
  }
  return out;
}

// ------------------------------------------------------------------ report snapshot
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** The frozen content of a report. Counts and dates only for sessions: note text never leaves the clinical note. */
export async function buildSnapshot(report, { providerName, patientName }) {
  const { provider_id: providerId, patient_id: patientId, plan_id: planId } = report;
  const from = ymd(report.period_from), to = ymd(report.period_to);
  const forPatient = report.audience === 'patient';
  const [notes, appts, outcomes, goals, plan] = await Promise.all([
    many("SELECT created_at, signed_at FROM clinical_encounters WHERE athlete_id=$1 AND provider_id=$2 AND kind='encounter' AND status='signed' AND signed_at >= $3::date AND signed_at < $4::date + 1 ORDER BY signed_at", [patientId, providerId, from, to]),
    one("SELECT count(*)::int AS n FROM appointments WHERE athlete_id=$1 AND provider_id=$2 AND status='completed' AND starts_at >= $3::date AND starts_at < $4::date + 1", [patientId, providerId, from, to]),
    loadOutcomes(patientId, { providerId, to }),
    many(`${GOAL_SQL} WHERE g.patient_id=$1 AND g.provider_id=$2 AND ($3::uuid IS NULL OR g.plan_id IS NULL OR g.plan_id = $3) AND ($4::boolean = false OR g.shared) ORDER BY g.created_at`, [patientId, providerId, planId, forPatient]),
    planId ? one(`SELECT p.id, p.title, p.status, v.version, v.review_date FROM treatment_plans p LEFT JOIN treatment_plan_versions v ON v.plan_id=p.id AND v.status='published' WHERE p.id=$1 AND p.provider_id=$2 AND p.patient_id=$3`, [planId, providerId, patientId]) : null,
  ]);
  const adherence = planId ? (await adherenceFor([planId], from, to)).get(planId) : null;
  return {
    kind: report.kind, title: report.title, audience: report.audience, period: { from, to }, generated_at: new Date().toISOString(),
    provider: { id: providerId, name: providerName }, patient: { id: patientId, name: patientName },
    plan: plan ? { id: plan.id, title: plan.title, status: plan.status, version: plan.version, review_date: plan.review_date } : null,
    sessions: { signed_notes: notes.length, appointments_completed: appts.n, dates: notes.map((n) => n.signed_at.toISOString().slice(0, 10)) },
    outcomes: buildSeries(outcomes, { from, keepPoints: 30 }).map(({ key, points, ...s }) => ({ ...s, points })),
    goals: goals.map((g) => { const s = shapeGoal(g, { forProvider: false }); return { id: s.id, title: s.title, measure: s.measure, body_region: s.body_region, side: s.side, unit: s.unit, baseline: s.baseline, target: s.target, target_date: s.target_date, status: s.status, progress: s.progress }; }),
    adherence,
    note: 'Built from the clinician\'s own records. Outcome changes describe the recorded numbers only; they are not a diagnosis or a promise of recovery.',
  };
}

// ------------------------------------------------------------------ suggestions
const RANK = { high: 0, medium: 1, low: 2 };

/**
 * Prompts built from the clinician's own records for their consented patients. Deterministic rules, each with its evidence;
 * nothing is generated by a model and nothing is acted on automatically. Snoozed prompts are left out.
 */
export async function buildSuggestions(providerId) {
  const t = today();
  const [plans, pain, goals, drafts, undocumented, lastOutcome, lastReport, snoozed, signedCounts] = await Promise.all([
    many(`SELECT p.id, p.title, p.patient_id, u.display_name AS patient_name, pub.review_date, pub.published_at, pub.acknowledged_at, pub.version
            FROM treatment_plans p JOIN users u ON u.id=p.patient_id JOIN treatment_plan_versions pub ON pub.plan_id=p.id AND pub.status='published'
           WHERE p.provider_id=$1 AND p.status='active' AND p.patient_id IN (${ACCESS})`, [providerId]),
    many(`SELECT o.patient_id, u.display_name AS patient_name, o.value, o.measured_at FROM physio_outcomes o JOIN users u ON u.id=o.patient_id
           WHERE o.provider_id=$1 AND o.voided_at IS NULL AND o.measure='pain' AND o.measured_at > now() - interval '60 days' AND o.patient_id IN (${ACCESS}) ORDER BY o.patient_id, o.measured_at`, [providerId]),
    many(`${GOAL_SQL} WHERE g.provider_id=$1 AND g.patient_id IN (${ACCESS})`, [providerId]),
    many(`SELECT e.id, e.athlete_id AS patient_id, u.display_name AS patient_name, e.status, e.updated_at FROM clinical_encounters e JOIN users u ON u.id=e.athlete_id
           WHERE e.provider_id=$1 AND e.status IN ('draft','ready') AND e.updated_at < now() - interval '1 day' AND e.athlete_id IN (${ACCESS}) ORDER BY e.updated_at`, [providerId]),
    many(`SELECT a.id, a.athlete_id AS patient_id, u.display_name AS patient_name, a.starts_at FROM appointments a JOIN users u ON u.id=a.athlete_id
           WHERE a.provider_id=$1 AND a.status IN ('confirmed','completed') AND a.starts_at < now() AND a.starts_at > now() - interval '14 days' AND a.athlete_id IN (${ACCESS})
             AND NOT EXISTS (SELECT 1 FROM clinical_encounters e WHERE e.appointment_id=a.id AND e.kind='encounter' AND e.status<>'voided') ORDER BY a.starts_at`, [providerId]),
    many('SELECT patient_id, max(measured_at) AS at FROM physio_outcomes WHERE provider_id=$1 AND voided_at IS NULL GROUP BY patient_id', [providerId]),
    many('SELECT r.patient_id, max(v.published_at) AS at FROM physio_reports r JOIN physio_report_versions v ON v.report_id=r.id WHERE r.provider_id=$1 GROUP BY r.patient_id', [providerId]),
    many("SELECT key FROM physio_suggestion_snoozes WHERE provider_id=$1 GROUP BY key HAVING max(until) > now()", [providerId]),
    many("SELECT athlete_id AS patient_id, count(*)::int AS n FROM clinical_encounters WHERE provider_id=$1 AND kind='encounter' AND status='signed' GROUP BY athlete_id", [providerId]),
  ]);
  const hidden = new Set(snoozed.map((s) => s.key));
  const out = [];
  const add = (s) => { if (!hidden.has(s.key)) out.push(s); };
  const ago = (d) => Math.max(0, Math.round((Date.now() - new Date(d)) / 864e5));
  const lastOut = new Map(lastOutcome.map((r) => [r.patient_id, r.at]));
  const lastRep = new Map(lastReport.map((r) => [r.patient_id, r.at]));
  const signed = new Map(signedCounts.map((r) => [r.patient_id, r.n]));
  const adh = await adherenceFor(plans.map((p) => p.id), addDays(t, -13), t);
  const homePain = await many(`SELECT DISTINCT ON (l.plan_id) l.plan_id, l.pain, l.done_on FROM treatment_plan_adherence l WHERE l.plan_id = ANY($1::uuid[]) AND l.pain >= 7 AND l.done_on >= $2::date ORDER BY l.plan_id, l.done_on DESC, l.created_at DESC`, [plans.map((p) => p.id), addDays(t, -7)]);
  for (const h of homePain) {
    const p = plans.find((x) => x.id === h.plan_id);
    add({ key: `home_pain:${h.plan_id}:${ymd(h.done_on)}`, kind: 'pain_reported_at_home', priority: 'high', patient_id: p.patient_id, patient_name: p.patient_name, plan_id: p.id, tab: 'plans', title: `Pain ${h.pain}/10 reported after home exercise`, reason: `Logged on ${ymd(h.done_on)} for "${p.title}". Patients are told this log is not monitored live, so you may want to get in touch.` });
  }

  for (const p of plans) {
    const who = { patient_id: p.patient_id, patient_name: p.patient_name, plan_id: p.id, tab: 'plans' };
    const published = ago(p.published_at);
    if (p.review_date) {
      const rd = ymd(p.review_date), left = daysBetween(t, rd);
      if (left <= 7) add({ key: `plan_review:${p.id}:${rd}`, kind: 'plan_review_due', priority: left < 0 ? 'high' : 'medium', ...who, title: left < 0 ? `Plan review is ${-left} day${left === -1 ? '' : 's'} overdue` : left === 0 ? 'Plan review is due today' : `Plan review due in ${left} day${left === 1 ? '' : 's'}`, reason: `"${p.title}" has a review date of ${rd}. Revise or complete it.` });
    }
    if (!p.acknowledged_at && published >= 3) add({ key: `plan_unread:${p.id}:${p.version}`, kind: 'plan_not_acknowledged', priority: 'low', ...who, title: 'Plan not yet confirmed as read', reason: `Version ${p.version} of "${p.title}" was published ${published} days ago and the patient has not confirmed reading it.` });
    const a = adh.get(p.id);
    if (published >= 7 && a && a.expected_days >= 2) {
      if (a.days_logged === 0) add({ key: `no_adherence:${p.id}`, kind: 'no_home_exercise_logged', priority: 'high', ...who, title: 'No home exercise logged', reason: `Nothing logged for "${p.title}" in the last ${Math.min(14, published)} days (about ${a.expected_days} expected). Check in with the patient.` });
      else if (a.percent != null && a.percent < 50) add({ key: `low_adherence:${p.id}`, kind: 'low_adherence', priority: 'medium', ...who, title: `Home exercise at ${a.percent}% of plan`, reason: `${a.days_done + a.days_partial} of about ${a.expected_days} expected days logged in the last two weeks.` });
    }
    const lo = lastOut.get(p.patient_id);
    if (published >= 14 && (!lo || ago(lo) > 28)) add({ key: `remeasure:${p.id}`, kind: 'outcome_not_measured', priority: 'low', ...who, tab: 'progress', title: lo ? `No outcome measured for ${ago(lo)} days` : 'No outcome measured yet', reason: 'Record a pain score, range of motion or function score so progress can be tracked.' });
    const rep = lastRep.get(p.patient_id);
    if ((signed.get(p.patient_id) ?? 0) >= 1 && published >= 21 && (!rep || ago(rep) > 30)) add({ key: `report_due:${p.id}`, kind: 'report_due', priority: 'low', ...who, tab: 'reports', title: rep ? `No progress report for ${ago(rep)} days` : 'No progress report sent yet', reason: 'A short report keeps the patient and any referrer informed.' });
  }

  const byPatient = new Map();
  for (const r of pain) { if (!byPatient.has(r.patient_id)) byPatient.set(r.patient_id, { name: r.patient_name, list: [] }); byPatient.get(r.patient_id).list.push(Number(r.value)); }
  for (const [pid, { name, list }] of byPatient) {
    if (list.length < 2) continue;
    const last = list.at(-1), prev = list.at(-2);
    if (last - prev >= 2) add({ key: `pain_up:${pid}:${list.length}`, kind: 'pain_rising', priority: 'high', patient_id: pid, patient_name: name, tab: 'progress', title: `Pain up ${last - prev} points`, reason: `Latest pain score ${last}/10, previous ${prev}/10. Consider re-assessing.` });
    else if (list.length >= 3 && last >= 4 && list.at(-3) <= prev && prev <= last) add({ key: `pain_flat:${pid}:${list.length}`, kind: 'pain_not_improving', priority: 'medium', patient_id: pid, patient_name: name, tab: 'progress', title: 'Pain not coming down', reason: `Last three pain scores: ${list.slice(-3).join(', ')} (out of 10). Review the plan.` });
  }

  const byGoalPatient = new Map();
  for (const g of goals) {
    if (!byGoalPatient.has(g.patient_id)) byGoalPatient.set(g.patient_id, []);
    byGoalPatient.get(g.patient_id).push(g);
    if (g.status !== 'active') continue;
    const title = decrypt(g.title_enc, ctx.goalTitle), pr = goalProgress(g);
    const who = { patient_id: g.patient_id, patient_name: g.patient_name, goal_id: g.id, tab: 'goals' };
    if (pr.met) { add({ key: `goal_met:${g.id}`, kind: 'goal_looks_met', priority: 'medium', ...who, title: 'A goal looks achieved', reason: `"${title}": latest ${pr.latest.value}${MEASURES[g.measure].unit} has reached the target of ${Number(g.target)}${MEASURES[g.measure].unit}. Confirm and close it.` }); continue; }
    if (g.target_date) {
      const td = ymd(g.target_date), left = daysBetween(t, td);
      if (left < 0) add({ key: `goal_overdue:${g.id}`, kind: 'goal_overdue', priority: 'high', ...who, title: `Goal ${-left} day${left === -1 ? '' : 's'} past its date`, reason: `"${title}" was aimed for ${td}${pr.percent != null ? ` and is at ${pr.percent}%` : ''}. Close it or set a new date.` });
      else if (left <= 7) add({ key: `goal_due:${g.id}`, kind: 'goal_due_soon', priority: 'medium', ...who, title: left === 0 ? 'Goal date is today' : `Goal date in ${left} day${left === 1 ? '' : 's'}`, reason: `"${title}"${pr.percent != null ? ` is at ${pr.percent}%` : ' has no reading yet'}.` });
    }
  }
  const planPatients = new Map(plans.map((p) => [p.patient_id, p]));
  for (const [pid, list] of byGoalPatient) {
    const p = planPatients.get(pid);
    if (p && list.length && list.every((g) => g.status === 'achieved')) add({ key: `all_goals_met:${p.id}`, kind: 'all_goals_achieved', priority: 'medium', patient_id: pid, patient_name: p.patient_name, plan_id: p.id, tab: 'plans', title: 'All goals achieved', reason: `Every goal for "${p.title}" is achieved. Consider completing or discharging the plan.` });
  }

  for (const d of drafts) add({ key: `note_open:${d.id}`, kind: 'note_unsigned', priority: 'medium', patient_id: d.patient_id, patient_name: d.patient_name, encounter_id: d.id, tab: 'sessions', title: 'Session note not signed', reason: `A ${d.status} note was last changed ${ago(d.updated_at)} days ago.` });
  for (const a of undocumented) add({ key: `note_missing:${a.id}`, kind: 'session_undocumented', priority: ago(a.starts_at) >= 2 ? 'high' : 'medium', patient_id: a.patient_id, patient_name: a.patient_name, appointment_id: a.id, tab: 'sessions', title: 'Session has no note', reason: `The appointment on ${a.starts_at.toISOString().slice(0, 10)} has no session note yet.` });

  return out.sort((x, y) => RANK[x.priority] - RANK[y.priority] || x.patient_name.localeCompare(y.patient_name) || x.key.localeCompare(y.key));
}
