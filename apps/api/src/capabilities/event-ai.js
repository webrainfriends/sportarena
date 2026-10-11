import { z } from 'zod';
import { cap, capabilities, id } from '../registry.js';
import { many, one, pool } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { sha256 } from '../crypto.js';
import { ask, askJson, aiConfigured, aiModel, quoteData, AI_RULES } from '../ai.js';
import { eventForOrganizer } from './events.js';
import { DEPARTMENT_KINDS } from './event-departments.js';
import { fixtureContext } from './match-tracking.js';
import { liveState, loggedEvents, rulesetForEvent } from '../scoring/state.js';
import { sheetAnomalies } from '../scoring/checks.js';
import { computeScore } from '../scoring/engine.js';

const TAG = 'Event AI';
/** Call another capability the way the API does: parse its input first so defaults and limits apply. */
const call = (name, user, input) => { const c = capabilities.find((x) => x.name === name); return c.handler({ user }, c.input.parse(input)); };
const kinds = Object.keys(DEPARTMENT_KINDS);

/** One generation: return the cached answer for these exact facts, else ask the model, else use the deterministic fallback. */
async function generate({ kind, subjectId, entity, user, facts, system, prompt, schema, shape, fallback, maxTokens }) {
  const hash = sha256(JSON.stringify({ facts, model: aiModel() }));
  const hit = await one('SELECT output FROM ai_outputs WHERE kind=$1 AND subject_id=$2 AND input_hash=$3', [kind, subjectId, hash]);
  if (hit) return { ...hit.output, ai: true, cached: true };
  let out = null;
  if (aiConfigured()) {
    await audit(null, user.id, `ai_${kind}`, entity, subjectId);
    out = await askJson({ system: `${system} ${AI_RULES}`, user: prompt, schema, shape, maxTokens });
  }
  if (!out) return { ...fallback(), ai: false, cached: false };
  await pool.query('INSERT INTO ai_outputs(kind, subject_id, input_hash, model, output, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [kind, subjectId, hash, aiModel(), JSON.stringify(out), user.id]);
  return { ...out, ai: true, cached: false };
}
const data = (facts) => `<data>${JSON.stringify(facts)}</data>`;

cap({
  name: 'ai_status', method: 'GET', path: '/ai/status', tag: TAG,
  summary: 'Whether AI assistance is switched on for this installation and which model it uses. Without it every AI feature still works with built-in rules.', input: z.object({}),
  handler: async () => ({ configured: aiConfigured(), model: aiConfigured() ? aiModel() : null }),
});

// ------------------------------------------------------------------ plan the event
const STARTERS = {
  operations: [['Agree the run-of-show with every department', 'high', -7], ['Walk the venue: gates, courts, control room, first-aid points', 'normal', -3], ['Daily briefing for all department leads', 'normal', 0], ['Wrap-up meeting and incident review', 'normal', 1]],
  officials: [['Assign referees, umpires and scorers to every fixture', 'urgent', -7], ['Brief officials on the rules and the score sheet', 'high', -1], ['Confirm the score sheet approval chain', 'normal', -2]],
  medical: [['Confirm doctor and ambulance cover for every session', 'urgent', -7], ['Stock a first-aid point at each court', 'high', -2], ['Brief medics on the emergency action plan', 'high', -1]],
  volunteers: [['Open volunteer shifts and confirm the roster', 'high', -10], ['Volunteer briefing and kit handout', 'normal', -1]],
  media: [['Shot list for opening, finals and podium', 'normal', -5], ['Set up the live scores and highlights channel', 'normal', -3]],
  hospitality: [['Plan water, food and rest areas for teams', 'high', -5], ['Brief the team liaison staff', 'normal', -1]],
  security: [['Agree access control and crowd flow with the venue', 'high', -7], ['Brief security on accreditation zones', 'normal', -1]],
  logistics: [['Confirm equipment, kit and transport lists', 'high', -7], ['Load-in check of courts and equipment', 'normal', -1]],
  tech: [['Test scoreboards, live scores and streaming', 'high', -3], ['Dry-run the live match console with a test game', 'normal', -5]],
  ceremonies: [['Script the opening and the podium moments', 'normal', -7], ['Rehearse the medal ceremony', 'normal', -1]],
  custom: [],
};
const planSchema = z.object({ departments: z.array(z.object({
  name: z.string().min(2).max(80), kind: z.enum(kinds), why: z.string().max(240).default(''),
  cards: z.array(z.object({ title: z.string().min(2).max(160), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'), offset_days: z.number().int().min(-120).max(30) })).max(10).default([]),
})).min(1).max(10) });
const NAMES = { operations: 'Operations', officials: 'Officials', medical: 'Medical', volunteers: 'Volunteers', media: 'Media', hospitality: 'Hospitality', security: 'Security', logistics: 'Logistics', tech: 'Tech & scoring', ceremonies: 'Ceremonies' };

function fallbackPlan(f) {
  const want = ['operations', 'officials', 'medical', 'volunteers'];
  const multi = f.sports.length > 1, days = f.days ?? 1;
  if (multi || f.capacity > 200 || f.seeking_sponsors) want.push('media');
  if (f.capacity > 100 || days > 1) want.push('hospitality');
  if (f.capacity > 300) want.push('security');
  if (multi || days > 1) want.push('logistics');
  if (multi || ['tournament', 'league'].includes(f.kind)) want.push('tech');
  if (multi && f.kind === 'tournament') want.push('ceremonies');
  const why = { operations: 'Someone has to run the day end to end', officials: 'Every game needs a referee and a scorer', medical: 'Cover for injuries is a must at any event', volunteers: 'Marshals and helpers keep it smooth',
    media: 'Live scores, photos and highlights', hospitality: 'Looking after teams over a long day', security: 'A crowd needs access control', logistics: 'Kit, equipment and transport', tech: 'Scoreboards, streaming and the live match console', ceremonies: 'Opening and medal moments' };
  return { departments: want.filter((k) => !f.existing_kinds.includes(k)).map((k) => ({ name: NAMES[k], kind: k, why: why[k], cards: STARTERS[k].map(([title, priority, offset_days]) => ({ title, priority, offset_days })) })) };
}

cap({
  name: 'ai_plan_event', method: 'POST', path: '/events/:id/ai/plan', tag: TAG,
  summary: 'Suggest the departments an event needs and starter tasks for each, with due dates relative to day one (organiser). Uses Claude when configured, built-in rules otherwise. It only suggests: nothing is created until you send the plan to apply_event_plan.',
  input: z.object({ id, notes: z.string().max(600).optional().describe('anything the organiser wants considered, e.g. "outdoor, monsoon season"') }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    const [sports, existing] = await Promise.all([
      many("SELECT s.name FROM event_disciplines d JOIN sports s ON s.id=d.sport_id WHERE d.event_id=$1 ORDER BY s.name", [i.id]),
      many("SELECT kind FROM event_departments WHERE event_id=$1 AND status='active'", [i.id]),
    ]);
    const base = (await one('SELECT name FROM sports WHERE id=$1', [ev.sport_id]))?.name;
    const win = await one('SELECT starts_on::text AS s, ends_on::text AS e, (ends_on - starts_on + 1) AS days FROM events WHERE id=$1', [i.id]);
    const facts = { name: quoteData(ev.name, 100), kind: ev.kind, sports: sports.length ? sports.map((s) => s.name) : [base], city: quoteData(ev.city, 80), capacity: ev.capacity ?? null, days: win.days ?? null, starts_on: win.s, seeking_sponsors: !!ev.seeking_sponsors,
      existing_kinds: existing.map((e) => e.kind), notes: quoteData(i.notes, 600) };
    const plan = await generate({
      kind: 'plan', subjectId: i.id, entity: 'events', user, facts, schema: planSchema, maxTokens: 2500,
      shape: `{"departments":[{"name":string,"kind":one of ${kinds.join('|')},"why":string,"cards":[{"title":string,"priority":"low"|"normal"|"high"|"urgent","offset_days":integer}]}]}`,
      system: `You help organise multi-department sports events in the style of the Asian Games and Olympics. Suggest the departments this event needs (skip kinds already present) and 2-5 concrete starter tasks each. Department kind must be one of: ${kinds.join(', ')}. offset_days is days from the first day of the event (negative = before).`,
      prompt: `Event facts and organiser notes: ${data(facts)}`, fallback: () => fallbackPlan(facts),
    });
    plan.departments = plan.departments.filter((d) => !facts.existing_kinds.includes(d.kind));
    return { starts_on: win.s, ...plan };
  },
});

cap({
  name: 'apply_event_plan', method: 'POST', path: '/events/:id/ai/plan/apply', tag: TAG, status: 201,
  summary: 'Create the departments, a plan board per department and the starter cards from a suggested plan (organiser). Departments that already exist keep their data; cards whose title is already on the plan are skipped. Review and edit the suggestion first.',
  input: z.object({ id, departments: planSchema.shape.departments }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    const start = (await one('SELECT starts_on::text AS s FROM events WHERE id=$1', [i.id])).s;
    const out = { departments: 0, plans: 0, cards: 0, skipped_cards: 0 };
    for (const d of i.departments) {
      let dept;
      try { dept = await call('create_department', user, { id: i.id, name: d.name, kind: d.kind, description: d.why || undefined }); out.departments++; }
      catch (e) { if (e.status !== 409) throw e; dept = await one("SELECT * FROM event_departments WHERE event_id=$1 AND lower(name)=lower($2) AND status='active'", [i.id, d.name]); }
      let plan = await one("SELECT * FROM event_plans WHERE department_id=$1 AND status='active' ORDER BY created_at LIMIT 1", [dept.id]);
      if (!plan) { plan = await call('create_event_plan', user, { id: dept.id, title: `${d.name} plan` }); out.plans++; }
      const have = new Set((await many("SELECT lower(title) AS t FROM event_cards WHERE plan_id=$1 AND status='active'", [plan.id])).map((r) => r.t));
      for (const c of d.cards) {
        if (have.has(c.title.toLowerCase())) { out.skipped_cards++; continue; }
        const due = start ? (await one("SELECT ($1::date + $2::int)::text AS d", [start, c.offset_days])).d : undefined;
        await call('create_event_card', user, { id: plan.id, title: c.title, priority: c.priority, due_on: due });
        out.cards++;
      }
    }
    return { event_id: ev.id, ...out };
  },
});

// ------------------------------------------------------------------ review a score sheet
const reviewSchema = z.object({ summary: z.string().min(1).max(700), concerns: z.array(z.object({ severity: z.enum(['error', 'warn', 'info']), text: z.string().max(240) })).max(6).default([]), questions: z.array(z.string().max(200)).max(5).default([]) });

cap({
  name: 'ai_review_score_sheet', method: 'POST', path: '/score-sheets/:id/ai/review', tag: TAG,
  summary: 'Second pair of eyes on a score sheet (organiser or match official): the built-in checks always run, and Claude explains them in plain language, spots oddities in the match log and suggests questions to put to the referee. Advice only; it never changes the sheet.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await one('SELECT * FROM score_sheets WHERE id=$1', [i.id]);
    if (!s) throw notFound('Score sheet');
    const x = await fixtureContext(user, s.fixture_id);
    if (!x.canScore) throw forbidden('Only the organiser or the match officials can request a review');
    const { ruleset } = await rulesetForEvent(s.event_id);
    const events = await loggedEvents(s.fixture_id);
    const anomalies = sheetAnomalies(ruleset, events, s, x.f);
    const live = events.filter((e) => !e.voided_at);
    const computed = ruleset.kind === 'manual' ? null : computeScore(ruleset, live);
    const minutes = x.f.started_at && x.f.finished_at ? Math.round((new Date(x.f.finished_at) - new Date(x.f.started_at)) / 60000) : null;
    const facts = { sport_rules: ruleset.label, rules_kind: ruleset.kind, sheet: { home: s.home_score, away: s.away_score, status: s.status, source: s.source, adjusted_reason: quoteData(s.adjusted_reason, 200) || null },
      log: computed ? { home: computed.home, away: computed.away, sets: computed.sets, periods: computed.periods, stats: computed.stats, events: live.length, voided: events.length - live.length } : null, minutes_played: minutes, checks: anomalies };
    const fb = () => {
      const bits = [`Sheet says ${s.home_score ?? '?'}–${s.away_score ?? '?'} under ${ruleset.label} rules.`];
      if (computed) bits.push(`The match log adds up to ${computed.home}–${computed.away} from ${live.length} events${events.length > live.length ? ` (${events.length - live.length} voided)` : ''}.`);
      bits.push(anomalies.length ? `${anomalies.length} point(s) to look at.` : 'No problems found.');
      return { summary: bits.join(' '), concerns: anomalies.map((a) => ({ severity: a.severity, text: a.message })), questions: anomalies.filter((a) => a.severity !== 'info').map((a) => `Can you explain: ${a.message}?`).slice(0, 5) };
    };
    const review = await generate({
      kind: 'review', subjectId: s.id, entity: 'score_sheets', user, facts, schema: reviewSchema, maxTokens: 900, fallback: fb,
      shape: '{"summary":string (max 80 words),"concerns":[{"severity":"error"|"warn"|"info","text":string}],"questions":[string]}',
      system: 'You review sports score sheets for an organiser. Using only the data, summarise whether the sheet is consistent with the match log and the rules, flag anything odd (very few events for the score, many voids, lopsided stats, implausibly short match) and suggest short questions for the referee. The built-in checks in the data are authoritative; do not contradict them.',
      prompt: `Score sheet facts: ${data(facts)}`,
    });
    return { sheet_id: s.id, checks: anomalies, ...review };
  },
});

// ------------------------------------------------------------------ recap
const recapSchema = z.object({ headline: z.string().min(1).max(110), body: z.string().min(1).max(900), hashtags: z.array(z.string().max(32)).max(6).default([]) });
const clock = (s) => (s == null ? null : `${Math.floor(s / 60)}'`);

cap({
  name: 'ai_match_recap', method: 'POST', path: '/fixtures/:id/ai/recap', tag: TAG,
  summary: 'A shareable recap of a game: headline, short story and hashtags, built from the match log and result (no player names). Organiser, match officials and team managers; anyone signed in once the result is published. tone: hype (Gen-Z), neutral or formal.',
  input: z.object({ id, tone: z.enum(['hype', 'neutral', 'formal']).default('hype') }),
  async handler({ user }, i) {
    const x = await fixtureContext(user, i.id);
    const published = await one("SELECT * FROM score_sheets WHERE fixture_id=$1 AND status='published'", [i.id]);
    if (!x.canScore && !x.side && !published) throw forbidden('A recap is available to the people involved, or to everyone once the result is published');
    if (!['finished', 'completed', 'live', 'paused'].includes(x.f.status)) throw conflict('The game has not started yet');
    const st = await liveState(i.id, null, { limit: 500 });
    const home = st.fixture.home?.name, away = st.fixture.away?.name;
    const final = published ? { home: published.home_score, away: published.away_score } : { home: st.score.home, away: st.score.away };
    const name = (side) => (side === 'home' ? home : side === 'away' ? away : null);
    const moments = st.events.filter((e) => !['note', 'period_start', 'period_end'].includes(e.kind) && ((st.ruleset.events ?? []).some((r) => r.kind === e.kind) || e.kind === 'point')).slice(-40)
      .map((e) => ({ team: name(e.side), what: e.kind, period: e.period, minute: clock(e.clock_seconds) }));
    const facts = { sport_rules: st.ruleset.label, home, away, final, official: !!published, sets: st.score.sets ?? null, periods: st.score.periods ?? null, moments, status: st.fixture.status, tone: i.tone };
    const lead = final.home === final.away ? `${home} and ${away} share the spoils at ${final.home}–${final.away}` : `${final.home > final.away ? home : away} beat ${final.home > final.away ? away : home} ${Math.max(final.home, final.away)}–${Math.min(final.home, final.away)}`;
    const recap = await generate({
      kind: `recap_${i.tone}`, subjectId: i.id, entity: 'fixtures', user, facts, schema: recapSchema, maxTokens: 900,
      shape: '{"headline":string (max 100 characters),"body":string (max 120 words),"hashtags":[string] (max 5)}',
      fallback: () => ({ headline: lead, body: `${lead} in ${st.ruleset.label}.${st.score.sets?.length ? ` Sets: ${st.score.sets.map((s) => `${s.home}–${s.away}`).join(', ')}.` : ''}${published ? '' : ' (Not official until the score sheet is published.)'}`, hashtags: ['#SportArena'] }),
      system: `You write short sports match recaps. Tone: ${{ hype: 'energetic and fun for Gen Z, punchy lines, a few emojis, never cringe', neutral: 'clear and friendly', formal: 'formal press-release style' }[i.tone]}. Use only the teams, score and moments in the data; never invent player names, stats or quotes. Keep the body under 120 words.`,
      prompt: `Match facts: ${data(facts)}`,
    });
    return { fixture_id: i.id, tone: i.tone, official: !!published, ...recap };
  },
});

// ------------------------------------------------------------------ schedule advice
const adviceSchema = z.object({ advice: z.string().min(1).max(900) });

cap({
  name: 'ai_schedule_suggest', method: 'POST', path: '/events/:id/ai/schedule-fix', tag: TAG,
  summary: 'Turn schedule clashes into fixes (organiser): for each clash the later game gets a proposed new start that clears it, plus plain-language advice. Proposals are not applied; move games yourself and re-run check_schedule_clashes.',
  input: z.object({ id, min_rest_min: z.number().int().min(0).max(600).default(30) }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.id);
    const check = await call('check_schedule_clashes', user, { id: i.id, min_rest_min: i.min_rest_min });
    if (check.ok) return { ok: true, clashes: [], proposals: [], advice: 'No clashes: the schedule is clean.', ai: false };
    const fx = new Map((await many('SELECT id, scheduled_at, duration_min FROM fixtures WHERE event_id=$1', [i.id])).map((f) => [f.id, f]));
    const best = new Map();
    for (const c of check.clashes) {
      const [a, b] = c.fixture_ids.map((x) => fx.get(x));
      const [early, late] = new Date(a.scheduled_at) <= new Date(b.scheduled_at) ? [a, b] : [b, a];
      const gap = ['team_rest', 'team_overlap'].includes(c.kind) ? i.min_rest_min : 0;
      const to = new Date(new Date(early.scheduled_at).getTime() + (early.duration_min + gap) * 60_000);
      if (!best.has(late.id) || to > best.get(late.id).move_to) best.set(late.id, { fixture_id: late.id, move_to: to, because: c.kind, clears_clash_with: early.id });
    }
    const proposals = [...best.values()].map((p) => ({ ...p, move_to: p.move_to.toISOString() }));
    const facts = { clashes: check.clashes.map((c) => ({ kind: c.kind, games: c.fixture_ids.length })), proposals: proposals.map((p) => ({ because: p.because, shift_minutes: Math.round((new Date(p.move_to) - new Date(fx.get(p.fixture_id).scheduled_at)) / 60000) })), min_rest_min: i.min_rest_min };
    const text = await ask({ system: `You advise sports event schedulers. ${AI_RULES} Explain in under 90 words, in plain language, how to resolve these clashes and what to double-check after moving games (a move can create a new clash).`, user: `Clashes and proposed shifts: ${data(facts)}`, maxTokens: 400 });
    const advice = text ?? `${check.clashes.length} clash(es) found. Moving ${proposals.length} later game(s) to the proposed times clears them; re-run the clash check afterwards because a move can create a new one.`;
    if (text) await audit(null, user.id, 'ai_schedule', 'events', i.id);
    return { ok: false, clashes: check.clashes, proposals, advice, ai: !!text };
  },
});
