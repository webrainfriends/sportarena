import { z } from 'zod';
import { cap, capabilities, id, page } from '../registry.js';
import { invoke } from '../invoke.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, sportBySlugOrId } from '../helpers.js';
import { decrypt, encrypt, sha256 } from '../crypto.js';
import { toCsv } from '../csv.js';
import { askJson, aiConfigured, aiModel, AI_RULES, quoteData } from '../ai.js';
import { guardianLink, hasConsent, isYouth, requireConsent } from '../youth.js';
import { requireRelationship } from '../coaching.js';
import { PROFILE_SQL, build } from './player-insights.js';

// Source-linked athlete assistant (issue #337). It does not own any data and does not call a model for facts: every item is derived
// by plain rules from what the existing capabilities return (get_my_sport_schedule, get_my_development, get_my_insights /
// benchmarks, match_my_opportunities), each of which applies its own ownership and consent rules. A model, when configured, may only
// add a short "why" to items that already exist. The answer is a draft; the player resolves it, and only then does anything change.
const TAG = 'Player assistant';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const SOURCES = ['schedule', 'development', 'progress', 'opportunities'];
const TASKS = { overview: SOURCES, week: ['schedule', 'development'], focus: ['progress', 'development'], opportunities: ['opportunities', 'schedule'], feedback: ['development'], ask: SOURCES };
const STALE_MS = 24 * 3600 * 1000;
// Topics this assistant never answers, whatever the question: it has no medical, legal or money authority and decides nothing.
const OUT_OF_SCOPE = [
  ['medical', /\b(injur\w*|diagnos\w*|medic\w*|pain|physio\w*|rehab\w*|concussion|clear(ed)? to play|treatment|symptom\w*)\b/i],
  ['contract', /\b(contracts?|sign(ing)? (the|a|my)|accept(ing)? (the|an?|my) (offer|deal)|agreement)\b/i],
  ['payment', /\b(pay(ment|ing)?s?|refund\w*|invoice\w*|wallet|card details|bank|price|buy)\b/i],
];
const MEDICAL = OUT_OF_SCOPE[0][1];
const label = (s) => String(s ?? '').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const dayOf = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
// run through the capability's own input parsing and handler so its defaults, permission and consent rules apply unchanged
const through = (name, user, input) => invoke(capabilities.find((c) => c.name === name), user, input);

/** Who is being read, and under which right. Self always; otherwise a live guardian link or a live coaching relationship, with consent re-read every time. */
async function resolveSubject(user, athleteId, { consent = true } = {}) {
  if (!athleteId || athleteId === user.id) return { subject: user.id, viewer: 'self' };
  if (await guardianLink(user.id, athleteId)) {
    if (consent) await requireConsent(athleteId, 'coaching', 'viewing their assistant answer');
    return { subject: athleteId, viewer: 'guardian' };
  }
  try { await requireRelationship(user, athleteId); } catch { throw notFound('Athlete'); } // never reveal that the person exists
  if (consent && await isYouth(athleteId)) await requireConsent(athleteId, 'coaching', 'viewing their assistant answer');
  return { subject: athleteId, viewer: 'coach' };
}
// What each viewer may have read for them. Schedule and opportunities are the player's own, or a guardian's for a child (recruitment consent).
const ALLOWED = { self: SOURCES, guardian: ['development', 'progress', 'opportunities'], coach: ['progress'] };

/** Collects sources and limitations while the readers run; one source failing never fails the answer. */
function ledger() {
  const sources = [], limitations = [], used = new Set();
  const add = (kind, rec) => { const ref = `S${sources.length + 1}`; sources.push({ ref, kind, ...rec }); return ref; };
  return { sources, limitations, used, add, limit: (t) => { if (!limitations.includes(t)) limitations.push(t); } };
}
const safely = async (L, kind, fn) => {
  try { const r = await fn(); if (r !== false) L.used.add(kind); return r; } catch (e) {
    L.limit(e?.status === 403 || e?.status === 409 ? `${label(kind)} is not available: ${e.message}` : `${label(kind)} could not be read just now, so it is left out. Ask again to retry.`);
    return null;
  }
};

const item = (o) => ({ tone: 'info', detail: null, why: null, ...o });

async function readSchedule(L, user, w, sport, items) {
  const s = await through('get_my_sport_schedule', user, { from: w.from, to: w.to, ...(sport ? { sport: sport.slug } : {}) });
  const needs = s.items.filter((x) => x.action_required);
  for (const x of needs.slice(0, 4)) {
    const ref = L.add('schedule', { id: `${x.source_type}:${x.source_id}`, label: x.title, at: x.starts_at, evidence: 'Your calendar', link: x.link ?? null });
    items.push(item({ basis: 'observed', tone: 'watch', title: `Needs your reply: ${x.title}`, detail: `${label(x.kind)} on ${dayOf(x.starts_at)}${x.context ? ` · ${x.context}` : ''}. Status: ${label(x.status)}.`, why: 'Open items on your calendar are listed first.', source_refs: [ref], action: x.link ? { kind: 'open', title: `Open ${x.title}`, link: x.link } : undefined }));
  }
  const clash = s.items.filter((x) => x.conflict);
  if (clash.length) {
    const refs = clash.slice(0, 4).map((x) => L.add('schedule', { id: `${x.source_type}:${x.source_id}`, label: x.title, at: x.starts_at, evidence: 'Your calendar', link: x.link ?? null }));
    items.push(item({ basis: 'observed', tone: 'watch', title: `${clash.length} calendar item${clash.length === 1 ? ' overlaps' : 's overlap'} another`, detail: clash.slice(0, 4).map((x) => `${x.title} (${dayOf(x.starts_at)})`).join('; '), why: 'Timed entries whose times intersect are flagged. Nothing was moved.', source_refs: refs }));
  }
  const upcoming = s.items.filter((x) => !x.action_required && x.status !== 'cancelled');
  if (!upcoming.length && !needs.length) L.limit(`Nothing is on your calendar between ${w.from} and ${w.to}.`);
  else if (upcoming.length) {
    const first = upcoming[0];
    const ref = L.add('schedule', { id: `${first.source_type}:${first.source_id}`, label: first.title, at: first.starts_at, evidence: 'Your calendar', link: first.link ?? null });
    items.push(item({ basis: 'observed', tone: 'info', title: `${upcoming.length} thing${upcoming.length === 1 ? '' : 's'} coming up`, detail: `Next: ${first.title} on ${dayOf(first.starts_at)}.`, why: `Counted from ${w.from} to ${w.to}.`, source_refs: [ref] }));
  }
}

async function readDevelopment(L, user, subject, viewer, items) {
  const d = await through('get_my_development', user, { athlete_id: viewer === 'self' ? undefined : subject, limit: 10 });
  if (!d.consent) { L.limit(d.note ?? 'Coaching sharing is switched off, so coach goals, plans and feedback are left out.'); return false; }
  const sec = d.sections ?? {};
  for (const a of (sec.next_actions?.items ?? []).filter((x) => ['overdue', 'needs_response', 'due_soon'].includes(x.urgency)).slice(0, 3)) {
    const ref = L.add('development', { id: `${a.provenance.source}:${a.id}`, label: a.title, at: a.due_at ?? a.provenance.at, evidence: `${a.provenance.source_label} · ${label(a.provenance.basis)}`, link: a.link ?? null });
    items.push(item({ basis: 'observed', tone: 'watch', title: a.title, detail: a.detail ?? null, why: `${label(a.urgency)}${a.due_at ? ` (${dayOf(a.due_at)})` : ''}; set by ${a.provenance.by ?? 'the record owner'}.`, source_refs: [ref], action: viewer === 'self' && a.link ? { kind: 'open', title: `Open ${a.title}`, link: a.link } : undefined }));
  }
  for (const f of (sec.feedback?.items ?? []).slice(0, 2)) {
    const ref = L.add('development', { id: `${f.provenance.source}:${f.id}`, label: f.title || f.provenance.source_label, at: f.at, evidence: `${f.provenance.source_label} · ${label(f.provenance.basis)}`, link: f.link ?? null });
    items.push(item({ basis: 'observed', tone: 'info', title: `Coach feedback: ${f.title || f.provenance.source_label}`, detail: String(f.text ?? '').slice(0, 280), why: `Shared by ${f.by ?? 'your coach'}${f.at ? ` on ${dayOf(f.at)}` : ''}.`, source_refs: [ref] }));
  }
  const active = (sec.my_goals?.items ?? []).filter((g) => g.status === 'active');
  if (viewer === 'self' && d.consent !== undefined && !active.length && !(sec.goals?.items ?? []).length) {
    items.push(item({ basis: 'suggestion', tone: 'info', title: 'Set a goal for the next few weeks', detail: 'You have no active personal or coach goal yet.', why: 'A goal makes progress measurable and gives the next review a date.', source_refs: [], action: { kind: 'goal', title: 'Set a goal to work on', goal: { category: 'technical', needs_title: true } } }));
  }
  if (!Object.values(sec).some((v) => v.items?.length) && d.consent) L.limit('No goals, plans, feedback or assessments have been shared with you yet.');
}

async function readProgress(L, user, subject, viewer, sport, items) {
  const profile = await one(PROFILE_SQL, [subject, sport?.profile_id ?? null]);
  if (!profile) { L.limit('Add a sport card to get a progress read-out.'); return false; }
  const out = await build(subject, profile, { evidence: 'self_reported' });
  if (!out.ready) { L.limit(`Progress: ${out.reason}`); return false; }
  const gaps = out.scopes.find((s) => s.available);
  const cmp = (gaps?.comparisons ?? []).filter((c) => c.status === 'ranked' && c.key !== 'matches');
  const weak = [...cmp].sort((a, b) => a.percentile - b.percentile)[0];
  const strong = [...cmp].sort((a, b) => b.percentile - a.percentile)[0];
  const evidence = `${out.evidence_label} · ${out.me.matches} matches`;
  if (weak && weak.percentile <= 35) {
    const ref = L.add('progress', { id: `insights:${profile.id}:${weak.key}`, label: `${weak.label} (${profile.sport})`, at: null, evidence, link: { screen: 'MyDevelopment', params: {} } });
    items.push(item({ basis: 'observed', tone: 'watch', title: `${weak.label} is the clearest gap`, detail: `Ahead of ${weak.percentile}% of ${gaps.label} (${weak.mine} against a typical ${weak.cohort_median}).`, why: `Lowest percentile of ${cmp.length} compared metrics, from aggregates only.`, source_refs: [ref], action: viewer === 'self' ? { kind: 'goal', title: `Work on ${weak.label.toLowerCase()}`, goal: { category: 'technical', measure: `${weak.label} per match`, target_value: Number(weak.cohort_median) || undefined, unit: weak.unit && weak.unit !== '%' ? weak.unit : weak.unit === '%' ? 'percent' : 'per match' } } : undefined }));
  }
  if (strong && strong.percentile >= 75) {
    const ref = L.add('progress', { id: `insights:${profile.id}:${strong.key}`, label: `${strong.label} (${profile.sport})`, at: null, evidence, link: { screen: 'MyDevelopment', params: {} } });
    items.push(item({ basis: 'observed', tone: 'good', title: `${strong.label} is a strength`, detail: `Ahead of ${strong.percentile}% of ${gaps.label}.`, why: 'Highest percentile of the compared metrics.', source_refs: [ref] }));
  }
  if (!items.some((x) => x.source_refs.some((r) => r.startsWith('S')) && x.title.includes('gap')) && !strong) L.limit('Your numbers sit close to the middle of the group, so no single strength or gap stands out.');
  L.limit('Progress uses matches players logged themselves, not official results, and only totals and averages of other players.');
}

async function readOpportunities(L, user, subject, viewer, sport, items) {
  const r = await through('match_my_opportunities', user, { limit: 5, offset: 0, sport_profile_id: sport?.profile_id ?? undefined, on_behalf_of: viewer === 'guardian' ? subject : undefined });
  for (const g of r.profile_gaps ?? []) L.limit(g.detail);
  for (const m of r.items.slice(0, 3)) {
    const o = m.opportunity;
    const ref = L.add('opportunities', { id: `${o.kind}:${o.id}`, label: o.title, at: o.deadline_at ?? o.date ?? null, evidence: `Rule check · ${label(m.fit)}`, link: o.link ?? { screen: 'OpportunityMatches', params: {} } });
    const unknown = m.rules.filter((x) => x.status === 'unknown').map((x) => x.rule);
    const mism = m.rules.filter((x) => x.status === 'mismatch').map((x) => x.rule);
    items.push(item({ basis: 'suggestion', tone: m.fit === 'strong' ? 'good' : 'info', title: `${o.title} · ${label(m.fit)} fit`, detail: [m.rules.filter((x) => x.status === 'match').length ? `Matches: ${m.rules.filter((x) => x.status === 'match').map((x) => x.rule).join(', ')}.` : null, mism.length ? `Does not match: ${mism.join(', ')}.` : null, unknown.length ? `Unknown, not counted as a match: ${unknown.join(', ')}.` : null].filter(Boolean).join(' '), why: 'Ranked by the opportunity rule check (fit, score, soonest date). Nothing was applied for.', source_refs: [ref], action: viewer === 'self' ? { kind: 'open', title: `Open ${o.title}`, link: o.link ?? { screen: 'OpportunityMatches', params: {} } } : undefined }));
  }
  if (!r.items.length) L.limit('No open opportunities match your sport card right now.');
}

async function narrate(user, subject, task, question, items, headline) {
  if (!aiConfigured()) return null;
  const facts = { task, question: question ? quoteData(question, 400) : undefined, items: items.map((x) => ({ id: x.id, title: x.title, detail: x.detail, basis: x.basis, refs: x.source_refs })) };
  const hash = sha256(JSON.stringify({ facts, model: aiModel() }));
  const hit = await one("SELECT id, output FROM ai_outputs WHERE kind='player_assistant' AND subject_id=$1 AND input_hash=$2", [subject, hash]);
  if (hit) return { ...hit.output, ai_output_id: hit.id };
  await audit(null, user.id, 'ai_player_assistant', 'users', subject);
  const schema = z.object({ headline: z.string().min(3).max(160), whys: z.array(z.object({ id: z.string(), why: z.string().min(2).max(240) })).max(12) });
  const out = await askJson({
    system: `You help one athlete read their own records. Reword the headline and add one short plain-language "why" per item id, using only the facts given. Never diagnose, never advise on injuries, contracts or payments, never invent facts. ${AI_RULES}`,
    user: `<data>${JSON.stringify(facts)}</data>`, schema, shape: '{"headline": string, "whys": [{"id": string, "why": string}]}', maxTokens: 900,
  });
  if (!out) return null;
  const row = await one("INSERT INTO ai_outputs(kind, subject_id, input_hash, model, output, created_by) VALUES ('player_assistant',$1,$2,$3,$4,$5) ON CONFLICT (kind, subject_id, input_hash) DO UPDATE SET model=ai_outputs.model RETURNING id", [subject, hash, aiModel(), JSON.stringify(out), user.id]);
  return { ...out, ai_output_id: row.id };
}

const SHOW = (r) => ({ ...r, question: undefined, question_enc: undefined });

/** The answer as the viewer may see it NOW: consent withdrawn since it was made hides its content at once (the row itself is kept). */
async function visible(r, user) {
  const youth = await isYouth(r.subject_id);
  const gone = youth && ((r.source_kinds.some((k) => ['development', 'progress'].includes(k)) && !(await hasConsent(r.subject_id, 'coaching')))
    || (r.source_kinds.includes('opportunities') && !(await hasConsent(r.subject_id, 'recruitment'))));
  const question = r.question_enc ? decrypt(r.question_enc, 'player_assistant_answers.question') : null;
  if (gone) return { ...SHOW(r), question: null, output: null, sources: [], limitations: [], hidden: 'consent_withdrawn', note: 'A guardian has withdrawn consent for some of the records this answer used, so it is hidden. Ask again after consent is restored.' };
  return { ...SHOW(r), question, hidden: null, stale: r.status === 'draft' && Date.now() - new Date(r.created_at).getTime() > STALE_MS };
}

cap({
  name: 'ask_player_assistant', method: 'POST', path: '/me/assistant/answers', tag: TAG, status: 201,
  summary: 'Ask the athlete assistant a question (or pick a preset: overview, week, focus, opportunities, feedback). It reads only records you may already see - your calendar, development workspace (goals, plans, coach feedback), progress benchmarks and matched opportunities - re-checking guardian consent on every ask, and returns a DRAFT: items marked observed (traceable to a source) or suggestion, a list of the exact records used with links, the data limits, and suggested actions. It never answers medical, contract or payment questions, ranks nobody, and changes nothing until you resolve the draft. Without an AI provider the answer is built by plain rules. A guardian (young person, with coaching consent) or a coach with a live relationship may pass athlete_id for a read-only answer limited to what they may see; those reads are audit-logged. A retried request with the same client_key returns the original.',
  input: z.object({
    task: z.enum(['overview', 'week', 'focus', 'opportunities', 'feedback', 'ask']).default('overview'),
    question: z.string().trim().min(2).max(400).optional(),
    athlete_id: id.optional(), sport: z.string().max(80).optional().describe('sport slug or id; limits calendar and progress to that sport'),
    from: day.optional(), to: day.optional(), sources: z.array(z.enum(SOURCES)).min(1).max(4).optional(),
    client_key: z.string().trim().min(8).max(80).optional().describe('idempotency key'),
  }),
  async handler({ user }, i) {
    if (i.task === 'ask' && !i.question) throw badRequest('Type the question to ask');
    const from = i.from ?? new Date().toISOString().slice(0, 10);
    const to = i.to ?? new Date(Date.parse(from) + 14 * 86400000).toISOString().slice(0, 10);
    if (to < from) throw badRequest('The end date is before the start date');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92) throw badRequest('The period is limited to 92 days');
    if (i.client_key) { const prev = await one('SELECT * FROM player_assistant_answers WHERE asked_by=$1 AND client_key=$2', [user.id, i.client_key]); if (prev) return visible(prev, user); }
    const { subject, viewer } = await resolveSubject(user, i.athlete_id);
    if (viewer !== 'self') await audit(null, user.id, 'read_athlete_assistant', 'users', subject);
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    if (sport) { const p = await one("SELECT id FROM active_sport_profiles WHERE user_id=$1 AND role='athlete' AND sport_id=$2 ORDER BY is_default DESC LIMIT 1", [subject, sport.id]); sport.profile_id = p?.id ?? null; }
    const chosen = (i.sources ?? TASKS[i.task]).filter((k, n, a) => a.indexOf(k) === n);
    const L = ledger();
    const readable = chosen.filter((k) => ALLOWED[viewer].includes(k));
    for (const k of chosen) if (!readable.includes(k)) L.limit(`${label(k)} is not shared with ${viewer === 'guardian' ? 'a guardian' : 'a coach'}, so it is left out.`);
    const w = { from, to };
    const text = `${i.question ?? ''}`;
    const out = OUT_OF_SCOPE.find(([, rx]) => rx.test(text));
    const items = [];
    let declined = null;
    if (out) {
      declined = out[0];
      L.limit(`I cannot help with ${out[0]} questions. ${out[0] === 'medical' ? 'Please ask a qualified clinician.' : out[0] === 'contract' ? 'Contracts and offers are always read and decided by you in the offer itself.' : 'Payments are made only in the payment screens.'}`);
    } else {
      if (readable.includes('schedule')) await safely(L, 'schedule', () => readSchedule(L, user, w, sport, items));
      if (readable.includes('development')) await safely(L, 'development', () => readDevelopment(L, user, subject, viewer, items));
      if (readable.includes('progress')) await safely(L, 'progress', () => readProgress(L, user, subject, viewer, sport, items));
      if (readable.includes('opportunities')) await safely(L, 'opportunities', () => readOpportunities(L, user, subject, viewer, sport, items));
    }
    // stable ids, and any claim without a source can only be a suggestion
    items.forEach((x, n) => { x.id = `i${n + 1}`; if (x.basis === 'observed' && !x.source_refs.length) x.basis = 'suggestion'; });
    let headline = declined ? 'This is outside what the assistant can help with' : items.length ? `${items.length} thing${items.length === 1 ? '' : 's'} worth your attention` : 'Nothing to report from the records you chose';
    let ai = false, model = null, aiOutputId = null;
    if (!declined && items.length) {
      const n = await narrate(user, subject, i.task, i.question, items, headline);
      if (n) {
        const known = new Set(items.map((x) => x.id));
        for (const wy of n.whys) if (known.has(wy.id) && !MEDICAL.test(wy.why)) items.find((x) => x.id === wy.id).why = wy.why;
        if (!MEDICAL.test(n.headline)) headline = n.headline;
        ai = true; model = aiModel(); aiOutputId = n.ai_output_id;
      } else if (aiConfigured()) L.limit('The AI did not answer, so this is a plain read-out of your records.');
    }
    if (!aiConfigured()) L.limit('The AI is switched off, so this is a plain read-out of your records.');
    const row = await one(
      `INSERT INTO player_assistant_answers(asked_by, subject_id, viewer, task, sport_id, window_from, window_to, source_kinds, question_enc, sources, limitations, output, ai, model, ai_output_id, client_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (asked_by, client_key) WHERE client_key IS NOT NULL DO UPDATE SET client_key=player_assistant_answers.client_key RETURNING *`,
      [user.id, subject, viewer, i.task, sport?.id ?? null, from, to, [...L.used], encrypt(i.question, 'player_assistant_answers.question'), JSON.stringify(L.sources), JSON.stringify(L.limitations), JSON.stringify({ headline, declined, items }), ai, model, aiOutputId, i.client_key ?? null]);
    return visible(row, user);
  },
});

const mine = async (user, answerId) => {
  const r = await one('SELECT * FROM player_assistant_answers WHERE id=$1 AND asked_by=$2', [answerId, user.id]);
  if (!r) throw notFound('Answer');
  if (r.viewer !== 'self') await resolveSubject(user, r.subject_id, { consent: false }).catch(() => { throw notFound('Answer'); }); // the live link is re-checked on every read; consent is applied by visible()
  return r;
};

cap({
  name: 'get_player_assistant_answer', method: 'GET', path: '/me/assistant/answers/:id', tag: TAG,
  summary: 'One of your assistant answers with its sources, limits and status. Consent is re-read: if a guardian has withdrawn consent for the records it used, the content is hidden (not deleted) until restored; a guardian or coach read re-checks the live link and is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await mine(user, i.id);
    if (r.viewer !== 'self') await audit(null, user.id, 'read_athlete_assistant', 'users', r.subject_id);
    return visible(r, user);
  },
});

cap({
  name: 'list_player_assistant_answers', method: 'GET', path: '/me/assistant/answers', tag: TAG,
  summary: 'Your assistant answers, newest first (stable order), without their content. Filter by status.',
  input: z.object({ status: z.enum(['draft', 'accepted', 'edited', 'discarded']).optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT id, task, viewer, subject_id, status, ai, created_at, resolved_at, output->>'headline' AS headline
       FROM player_assistant_answers WHERE asked_by=$1 AND viewer='self' AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`, [user.id, i.status ?? null, i.limit, i.offset]),
});

cap({
  name: 'resolve_player_assistant_answer', method: 'POST', path: '/me/assistant/answers/:id/resolve', tag: TAG,
  summary: 'Discard a draft, or accept it. Accepting is the only way an answer changes anything: each action you choose is created as your own record (a goal, via the same rules as create_player_goal - editable here before saving); "open" actions only take you to the existing screen. Nothing is applied for, accepted, signed or paid. Permissions and consent are checked again; a draft older than a day, or already resolved, or changed since you loaded it (row_version) is refused so you can ask again. Retrying is safe: goals are created once per action.',
  input: z.object({
    id, decision: z.enum(['accept', 'discard']), row_version: z.number().int().min(1).optional().describe('the version you loaded; a different one means the draft changed'),
    actions: z.array(z.object({ item_id: z.string().max(10), title: z.string().trim().min(2).max(160).optional(), why: z.string().trim().max(1000).optional(), target_value: z.number().finite().optional(), unit: z.string().trim().min(1).max(20).optional(), review_on: day.optional() })).max(8).optional(),
  }),
  async handler({ user }, i) {
    const a = await mine(user, i.id);
    if (a.viewer !== 'self') throw forbidden('Only the athlete can accept actions from their own answer');
    if (a.status !== 'draft') throw conflict('This answer was already resolved');
    if (i.row_version && i.row_version !== a.row_version) throw conflict('This answer changed since you opened it. Reload it.', { code: 'stale_version' });
    const close = (status, resolution) => one("UPDATE player_assistant_answers SET status=$2, resolution=$3, resolved_at=now(), row_version=row_version+1 WHERE id=$1 AND status='draft' RETURNING *", [a.id, status, JSON.stringify(resolution)]).then((r) => { if (!r) throw conflict('This answer was already resolved'); return visible(r, user); });
    if (i.decision === 'discard') return close('discarded', {});
    if (Date.now() - new Date(a.created_at).getTime() > STALE_MS) throw conflict('This answer is more than a day old and your records may have changed. Ask again.', { code: 'stale_answer' });
    const v = await visible(a, user);
    if (v.hidden) throw conflict(v.note, { code: 'guardian_consent_required' });
    const chosen = i.actions ?? [];
    if (!chosen.length) throw badRequest('Choose at least one action to add, or discard the answer');
    const byId = new Map(a.output.items.map((x) => [x.id, x]));
    const created = [], opened = [];
    let edited = false;
    for (const c of chosen) {
      const it = byId.get(c.item_id);
      if (!it?.action) throw badRequest(`Item ${c.item_id} has no action to add`);
      if (it.action.kind === 'open') { opened.push(c.item_id); continue; }
      const g = it.action.goal ?? {};
      if (g.needs_title && !c.title) throw badRequest('Write your goal in your own words before adding it');
      const title = c.title ?? it.action.title;
      edited = edited || title !== it.action.title || c.target_value !== undefined || c.unit !== undefined;
      const sportRow = a.sport_id ? await one('SELECT slug FROM sports WHERE id=$1', [a.sport_id]) : null;
      const goal = await through('create_player_goal', user, {
        title, category: g.category ?? 'technical', why: c.why ?? it.why ?? undefined, measure: g.measure,
        target_value: c.target_value ?? g.target_value, unit: (c.target_value ?? g.target_value) !== undefined ? (c.unit ?? g.unit ?? 'per match') : undefined,
        review_on: c.review_on, sport: sportRow?.slug, client_key: `asst-${a.id}-${c.item_id}`,
      });
      created.push({ item_id: c.item_id, goal_id: goal.id });
    }
    return close(edited ? 'edited' : 'accepted', { goals: created, opened });
  },
});

cap({
  name: 'export_player_assistant_answer', method: 'GET', path: '/me/assistant/answers/:id/export', tag: TAG,
  summary: 'CSV of one answer: each item, whether it is observed or a suggestion, and the exact source records with their evidence label. Same access checks as get_player_assistant_answer (hidden content exports nothing); audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await mine(user, i.id);
    const v = await visible(r, user);
    if (v.hidden) throw conflict(v.note, { code: 'guardian_consent_required' });
    await audit(null, user.id, 'export_player_assistant_answer', 'users', r.subject_id);
    const src = new Map(r.sources.map((s) => [s.ref, s]));
    const rows = r.output.items.map((x) => ({ item: x.title, basis: x.basis, detail: x.detail ?? '', why: x.why ?? '', sources: x.source_refs.map((ref) => { const s = src.get(ref); return s ? `${s.label} (${s.evidence}${s.at ? `, ${dayOf(s.at)}` : ''})` : ref; }).join('; ') }));
    return { filename: 'assistant-answer.csv', rows: rows.length, csv: toCsv(['item', 'basis', 'detail', 'why', 'sources'], rows) };
  },
});
