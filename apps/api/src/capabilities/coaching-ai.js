import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, pool, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { sha256 } from '../crypto.js';
import { askJson, aiConfigured, aiModel, quoteData, AI_RULES } from '../ai.js';
import { hiddenYouth, requireRelationship } from '../coaching.js';
import { requireTeam, ownRecord, savePlan, block } from './coaching-journal.js';
import { authorise } from './coaching-goals.js';

// AI coaching copilot (issue #269, slice 3). The model only ever writes a DRAFT. It is shown the records the coach pointed it at (permission
// checked before anything is read), with people replaced by labels, and it has no tools: it cannot create or change anything. The coach
// accepts, edits or discards; only then does a normal capability write happen, with the coach's permissions checked again.
const TAG = 'Coaching copilot';
const COACH = ['coach'];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TASKS = ['plan_session', 'player_focus', 'summarise_session', 'player_progress', 'team_patterns', 'suggest_actions', 'match_debrief', 'ask'];
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MEDICAL = /\b(diagnos\w*|prescrib\w*|medicat\w*|dosage|injur\w*|rehab\w*|treatment|return[- ]to[- ]play|cleared (to|for) (play|train)|fit to play)\b/i;
const clip = (s, n) => String(s ?? '').slice(0, n);

const itemSchema = z.object({
  title: z.string().min(1).max(160), detail: z.string().max(800).optional(), why: z.string().max(500).optional(),
  basis: z.enum(['observed', 'suggestion']).default('suggestion'), source_refs: z.array(z.string().max(12)).max(8).default([]),
  block: z.object({ kind: z.string().max(30), duration_min: z.number().int().min(1).max(240).optional(), objective: z.string().max(300).optional() }).optional(),
  action: z.object({ player: z.string().max(40).optional(), title: z.string().max(160).optional() }).optional(),
});
const outSchema = z.object({ headline: z.string().max(400), items: z.array(itemSchema).max(12) });
const SHAPE = '{"headline": string, "items": [{"title": string, "detail": string, "why": string, "basis": "observed" | "suggestion", "source_refs": [source refs like "O1"], "block"?: {"kind": string, "duration_min": number, "objective": string}, "action"?: {"player": "Player A", "title": string}}]}';

const TASK_BRIEF = {
  plan_session: 'Draft the blocks of the next training session (warm-up, drills, game, review) that address the active goals and the recurring development notes. For each block give kind, duration_min and objective, and say why with source refs.',
  player_focus: 'Summarise what the coach should focus on with each player before the session: recent notes, open actions and active goals.',
  summarise_session: 'Draft a concise review of this session from the notes, attendance and plan. State only what the data shows.',
  player_progress: 'Describe recurring strengths and development themes over the period, with the source refs behind every claim. Mark claims taken straight from notes as basis "observed" and anything you infer as "suggestion".',
  team_patterns: 'Describe repeated themes across the team\'s notes and attendance. Do not rank players.',
  suggest_actions: 'Suggest follow-up actions the coach could assign, each tied to the notes that prompted it (action.player is a label like "Player A", or omit for the whole team).',
  match_debrief: 'Draft a post-match debrief from the coach\'s notes and the official result in the data: what went well, what to improve, lessons for training. Never change or question the official result.',
  ask: 'Answer the coach\'s question using only the records in the data. If the records do not answer it, say so.',
};

/** Read what the model may see. Permission is checked before any record is queried, and only the coach's own records are read. */
async function gather(user, i) {
  const opts = { include_private_summaries: !!i.include_private_summaries };
  let athletes = [], team = null, rec = null;
  if (i.session_record_id) {
    rec = await ownRecord(user, i.session_record_id);
    athletes = (await many('SELECT athlete_id FROM coaching_session_participants WHERE session_record_id=$1 ORDER BY athlete_id', [rec.id])).map((r) => r.athlete_id);
    if (rec.team_id) team = rec.team_id;
  }
  if (i.athlete_id) { await requireRelationship(user, i.athlete_id); athletes = [i.athlete_id]; }
  if (i.team_id) {
    await requireTeam(user, i.team_id); team = i.team_id;
    if (!i.athlete_id && !i.session_record_id) athletes = (await many("SELECT user_id FROM team_members WHERE team_id=$1 AND status='active' AND role IN ('player','captain') ORDER BY user_id", [i.team_id])).map((r) => r.user_id);
  }
  if (!athletes.length && !team) throw badRequest('Name an athlete, a team or a session');
  if (athletes.length) { const hide = isAdmin(user) ? new Set() : await hiddenYouth(user, athletes); athletes = athletes.filter((a) => !hide.has(a)); }
  const people = athletes.length ? await many('SELECT id, display_name FROM users WHERE id = ANY($1::uuid[]) ORDER BY id', [athletes]) : [];
  const labelOf = new Map(people.map((p, n) => [p.id, `Player ${letters[n % 26]}${n >= 26 ? Math.floor(n / 26) : ''}`]));
  const names = people.map((p) => [p.display_name, labelOf.get(p.id)]).sort((a, b) => b[0].length - a[0].length);
  const scrub = (t) => { let s = quoteData(t, 400); for (const [n, l] of names) if (n) s = s.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), l); return s; };

  const from = i.from ?? new Date(Date.now() - 56 * 86400000).toISOString().slice(0, 10);
  const to = i.to ?? new Date().toISOString().slice(0, 10);
  if (to < from) throw badRequest('to is before from');
  const refs = [], counters = { O: 0, G: 0, A: 0, S: 0, T: 0 };
  const ref = (letter, type, rid, at, label) => { const r = `${letter}${++counters[letter]}`; refs.push({ ref: r, type, id: rid, at, label }); return r; };
  const params = [user.id, athletes, team, from, `${to}T23:59:59Z`];
  const obs = await many(
    `SELECT o.id, o.athlete_id, o.obs_type, o.skill_tag, o.note, o.follow_up, o.observed_at, o.score, o.dimension_key FROM coaching_observations o
      WHERE o.coach_id=$1 AND ((o.athlete_id = ANY($2::uuid[])) OR ($3::uuid IS NOT NULL AND o.team_id=$3 AND o.athlete_id IS NULL)) AND o.observed_at BETWEEN $4::timestamptz AND $5::timestamptz
      ORDER BY o.observed_at DESC, o.id LIMIT 60`, params);
  const goals = await many("SELECT g.id, g.athlete_id, g.title, g.category, g.criterion, g.status FROM coaching_goals g WHERE g.coach_id=$1 AND g.status IN ('planned','active') AND (g.athlete_id = ANY($2::uuid[]) OR ($3::uuid IS NOT NULL AND g.team_id=$3)) ORDER BY g.review_on NULLS LAST, g.id LIMIT 20", params.slice(0, 3));
  const actions = await many("SELECT a.id, a.athlete_id, a.title, a.due_at FROM coaching_actions a WHERE a.coach_id=$1 AND a.status IN ('open','in_progress') AND (a.athlete_id = ANY($2::uuid[]) OR ($3::uuid IS NOT NULL AND a.team_id=$3)) ORDER BY a.due_at NULLS LAST, a.id LIMIT 20", params.slice(0, 3));
  const att = athletes.length ? await many(
    `SELECT p.athlete_id, count(*) FILTER (WHERE p.attendance IN ('present','late','left_early'))::int AS attended, count(*) FILTER (WHERE p.attendance IN ('present','late','left_early','absent'))::int AS recorded, count(*) FILTER (WHERE p.attendance='expected')::int AS not_recorded
       FROM coaching_session_participants p JOIN coaching_session_records r ON r.id=p.session_record_id WHERE r.coach_id=$1 AND p.athlete_id = ANY($2::uuid[]) AND coalesce(r.started_at, r.scheduled_at, r.created_at) BETWEEN $3::timestamptz AND $4::timestamptz GROUP BY p.athlete_id ORDER BY p.athlete_id`, [user.id, athletes, from, `${to}T23:59:59Z`]) : [];

  const facts = { task_window: { from, to }, players: [...labelOf.values()] };
  facts.notes = obs.map((o) => ({ ref: ref('O', 'observation', o.id, o.observed_at, o.skill_tag ?? o.obs_type), player: o.athlete_id ? labelOf.get(o.athlete_id) ?? 'Player (hidden)' : 'Whole team', type: o.obs_type, skill: o.skill_tag, follow_up: o.follow_up, on: o.observed_at.toISOString().slice(0, 10), score: o.score != null ? Number(o.score) : undefined, text: scrub(o.note) }));
  facts.goals = goals.map((g) => ({ ref: ref('G', 'goal', g.id, null, g.title), player: g.athlete_id ? labelOf.get(g.athlete_id) : 'Whole team', title: scrub(g.title), category: g.category, success_criterion: scrub(g.criterion), status: g.status }));
  facts.open_actions = actions.map((a) => ({ ref: ref('A', 'action', a.id, a.due_at, a.title), player: a.athlete_id ? labelOf.get(a.athlete_id) : 'Whole team', title: scrub(a.title), due: a.due_at ? a.due_at.toISOString().slice(0, 10) : null }));
  facts.attendance = att.map((a) => ({ player: labelOf.get(a.athlete_id), attended: a.attended, recorded: a.recorded, not_recorded: a.not_recorded }));
  const limitations = [];
  if (rec) {
    const plan = (await one('SELECT version, blocks FROM coaching_session_plan_versions WHERE session_record_id=$1 AND version=$2', [rec.id, rec.plan_version]))?.blocks ?? [];
    facts.session = { ref: ref('S', 'session_record', rec.id, rec.started_at ?? rec.scheduled_at, rec.title), title: scrub(rec.title), objective: scrub(rec.objective), status: rec.status, plan: plan.map((b) => ({ kind: b.kind, title: scrub(b.title), minutes: b.duration_min, objective: scrub(b.objective) })), team_summary: scrub(rec.team_summary) };
    if (opts.include_private_summaries && rec.private_summary) facts.session.private_summary = scrub(rec.private_summary);
    if (rec.source_type === 'fixture') {
      const f = await one('SELECT status, home_score, away_score, home_team_id FROM fixtures WHERE id::text=$1', [rec.source_id]);
      if (f?.status === 'completed') facts.official_result = { provenance: 'official', score_for: f.home_team_id === rec.team_id ? f.home_score : f.away_score, score_against: f.home_team_id === rec.team_id ? f.away_score : f.home_score };
    }
  }
  if (!opts.include_private_summaries) limitations.push('Your private session summaries were not shared with the AI.');
  if (!obs.length) limitations.push('No notes of yours fall in this period, so there is little evidence to draw on.');
  for (const [pid, l] of labelOf) { const n = obs.filter((o) => o.athlete_id === pid).length; if (n < 3) limitations.push(`${l} has only ${n} note${n === 1 ? '' : 's'} in this period.`); }
  if (att.some((a) => a.not_recorded)) limitations.push('Some attendance was never recorded; it is not treated as absence.');
  if (!facts.official_result && i.task === 'match_debrief') limitations.push('No official result was available for this match.');
  limitations.push('Medical information is never shared with the AI and it cannot give medical advice.');
  return { facts, refs, limitations, labelOf, people, rec, athletes, team, from, to, opts };
}

/** What we can say without a model: grouped, source-linked, strictly observed. */
function fallback(task, g) {
  const items = [];
  const bySkill = new Map();
  for (const n of g.facts.notes) { const k = n.skill ?? n.type; if (!bySkill.has(k)) bySkill.set(k, []); bySkill.get(k).push(n); }
  for (const [k, ns] of [...bySkill].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
    items.push({ title: `${String(k).replace(/_/g, ' ')} (${ns.length} note${ns.length === 1 ? '' : 's'})`, detail: ns.slice(0, 3).map((n) => `${n.player}: ${n.text}`).join(' · '), basis: 'observed', source_refs: ns.slice(0, 8).map((n) => n.ref) });
  }
  for (const a of g.facts.open_actions.slice(0, 4)) items.push({ title: `Open action: ${a.title}`, detail: a.player, basis: 'observed', source_refs: [a.ref] });
  const att = g.facts.attendance.map((a) => `${a.player} ${a.attended}/${a.recorded}`).join(', ');
  return { headline: `${g.facts.notes.length} note${g.facts.notes.length === 1 ? '' : 's'}, ${g.facts.goals.length} active goal${g.facts.goals.length === 1 ? '' : 's'} and ${g.facts.open_actions.length} open action${g.facts.open_actions.length === 1 ? '' : 's'} in this period.${att ? ` Attendance (attended/recorded): ${att}.` : ''}`, items };
}

/** Keep only what is safe to show: known source refs, no medical-sounding items, bounded size. */
function clean(out, g) {
  const known = new Set(g.refs.map((r) => r.ref)), labels = new Set(g.labelOf.values());
  let dropped = 0;
  const items = [];
  for (const it of out.items) {
    if (MEDICAL.test(`${it.title} ${it.detail ?? ''} ${it.why ?? ''} ${it.action?.title ?? ''}`)) { dropped++; continue; }
    const source_refs = it.source_refs.filter((r) => known.has(r));
    const basis = it.basis === 'observed' && source_refs.length ? 'observed' : 'suggestion'; // a claim with no source is a suggestion, not a fact
    const action = it.action?.title ? { title: it.action.title, player: labels.has(it.action.player) ? it.action.player : undefined } : undefined;
    items.push({ ...it, basis, source_refs, action });
  }
  return { headline: MEDICAL.test(out.headline) ? 'Summary withheld: it contained medical wording, which this tool does not produce.' : out.headline, items, dropped };
}

const reveal = (text, g) => { let s = text; for (const p of g.people) s = s.split(g.labelOf.get(p.id)).join(p.display_name); return s; };

cap({
  name: 'draft_ai_coaching_assist', method: 'POST', path: '/coaching/ai/drafts', tag: TAG, auth: COACH, status: 201,
  summary: 'Ask the copilot for a DRAFT (next-session plan, player focus, session summary, player/team patterns, suggested actions, match debrief, or a question about your own notes). It reads only your own records for the athlete, team or session you name, after checking you may act on them; people are replaced by labels and medical data is never read. The draft lists the records it used, its limitations, and which statements are observed vs suggested. It changes nothing until you resolve it. Without an AI provider you get a plain, source-linked summary instead.',
  input: z.object({
    task: z.enum(TASKS), athlete_id: id.optional(), team_id: id.optional(), session_record_id: id.optional(), from: day.optional(), to: day.optional(),
    include_private_summaries: z.boolean().default(false).describe('also share your private session summaries with the AI'), question: z.string().max(400).optional(),
  }),
  async handler({ user }, i) {
    if (i.task === 'ask' && !i.question) throw badRequest('Ask a question');
    if (i.task === 'summarise_session' && !i.session_record_id) throw badRequest('session_record_id is required to summarise a session');
    if (i.task === 'plan_session' && !i.session_record_id) throw badRequest('Open the session record you are planning (session_record_id)');
    const g = await gather(user, i);
    let out = null, aiOutputId = null, model = null;
    if (aiConfigured()) {
      const payload = { task: i.task, question: i.question ? quoteData(i.question, 400) : undefined, facts: g.facts, sources: g.refs.map((r) => r.ref) };
      const hash = sha256(JSON.stringify({ payload, model: aiModel() }));
      const hit = await one("SELECT id, output FROM ai_outputs WHERE kind='coaching_assist' AND subject_id=$1 AND input_hash=$2", [user.id, hash]);
      if (hit) { out = hit.output; aiOutputId = hit.id; model = aiModel(); } else {
        await audit(null, user.id, 'ai_coaching_assist', 'coaching_draft', null);
        out = await askJson({
          system: `You are a careful assistant to a sports coach. ${TASK_BRIEF[i.task]} Players appear only as labels such as "Player A"; keep using the labels. Cite the source refs (e.g. O1, G2) that support each item. Separate what the coach observed (basis "observed", needs a source ref) from your own suggestion (basis "suggestion"). Never diagnose, never mention injuries or treatment, never clear anyone to play, and never rank or compare players. Keep it short and practical. ${AI_RULES}`,
          user: `<data>${JSON.stringify(payload)}</data>`, schema: outSchema, shape: SHAPE, maxTokens: 1400,
        });
        if (out) {
          model = aiModel();
          aiOutputId = (await one("INSERT INTO ai_outputs(kind, subject_id, input_hash, model, output, created_by) VALUES ('coaching_assist',$1,$2,$3,$4,$1) ON CONFLICT (kind, subject_id, input_hash) DO UPDATE SET model=ai_outputs.model RETURNING id", [user.id, hash, model, JSON.stringify(out)])).id;
        }
      }
    }
    const limitations = [...g.limitations];
    let cleaned;
    if (out) { cleaned = clean(out, g); if (cleaned.dropped) limitations.push(`${cleaned.dropped} suggestion${cleaned.dropped === 1 ? ' was' : 's were'} removed because ${cleaned.dropped === 1 ? 'it' : 'they'} sounded medical.`); } else {
      cleaned = clean(fallback(i.task, g), g);
      limitations.push(aiConfigured() ? 'The AI did not answer, so this is a plain summary of your own records.' : 'The AI is not available, so this is a plain summary of your own records.');
    }
    const items = cleaned.items.map((it, n) => ({ ...it, id: `i${n + 1}`, title: reveal(it.title, g), detail: it.detail && reveal(it.detail, g), why: it.why && reveal(it.why, g), action: it.action && { title: reveal(it.action.title, g), athlete_id: it.action.player ? [...g.labelOf].find(([, l]) => l === it.action.player)?.[0] : undefined } }));
    const output = { headline: reveal(cleaned.headline, g), items };
    return one(
      `INSERT INTO coaching_ai_drafts(coach_id, task, athlete_id, team_id, session_record_id, window_from, window_to, options, sources, limitations, output, ai, model, ai_output_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [user.id, i.task, i.athlete_id ?? null, i.team_id ?? null, i.session_record_id ?? null, g.from, g.to, JSON.stringify(g.opts), JSON.stringify(g.refs), JSON.stringify(limitations), JSON.stringify(output), !!out, model, aiOutputId]);
  },
});

cap({
  name: 'get_ai_coaching_draft', method: 'GET', path: '/coaching/ai/drafts/:id', tag: TAG, auth: COACH,
  summary: 'One of your drafts with its sources, limitations and current status.', input: z.object({ id }),
  async handler({ user }, i) {
    const d = await one('SELECT * FROM coaching_ai_drafts WHERE id=$1 AND coach_id=$2', [i.id, user.id]);
    if (!d) throw notFound('Draft');
    return d;
  },
});

cap({
  name: 'list_ai_coaching_drafts', method: 'GET', path: '/coaching/ai/drafts', tag: TAG, auth: COACH,
  summary: 'Your drafts, newest first.', input: z.object({ status: z.enum(['draft', 'accepted', 'edited', 'discarded']).optional(), ...page }),
  handler: ({ user }, i) => many('SELECT id, task, athlete_id, team_id, session_record_id, ai, status, created_at, resolved_at, output->>\'headline\' AS headline FROM coaching_ai_drafts WHERE coach_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC, id LIMIT $3 OFFSET $4', [user.id, i.status ?? null, i.limit, i.offset]),
});

cap({
  name: 'resolve_ai_coaching_draft', method: 'POST', path: '/coaching/ai/drafts/:id/resolve', tag: TAG, auth: COACH,
  summary: 'Discard a draft, or accept it. Accepting is the only way a draft changes anything, and your permissions are checked again: a plan draft is saved as the next plan version of its session (send edited blocks to change them), and chosen action suggestions become real actions. Other drafts are simply marked accepted. A draft can be resolved once.',
  input: z.object({
    id, decision: z.enum(['accept', 'discard']),
    plan_blocks: z.array(block).max(30).optional().describe('plan_session: the blocks to save; defaults to the draft\'s own blocks'),
    actions: z.array(z.object({ title: z.string().trim().min(2).max(160), athlete_id: id.optional(), detail: z.string().max(1000).optional(), due_at: z.string().datetime({ offset: true }).optional() })).max(12).optional().describe('suggest_actions: the actions to create (the coach picks and may edit them)'),
    summary_text: z.string().max(4000).optional().describe('summarise_session: the text to file as your private summary'),
  }),
  async handler({ user }, i) {
    const d = await one('SELECT * FROM coaching_ai_drafts WHERE id=$1 AND coach_id=$2', [i.id, user.id]);
    if (!d) throw notFound('Draft');
    if (d.status !== 'draft') throw conflict('This draft was already resolved');
    const close = (status, resolution) => one("UPDATE coaching_ai_drafts SET status=$2, resolution=$3, resolved_at=now() WHERE id=$1 AND status='draft' RETURNING *", [d.id, status, JSON.stringify(resolution)]);
    if (i.decision === 'discard') return close('discarded', {});
    const resolution = {};
    let edited = false;
    if (d.task === 'plan_session') {
      if (!d.session_record_id) throw badRequest('This plan draft has no session');
      const own = d.output.items.filter((x) => x.block).map((x) => ({ kind: ['arrival', 'warm_up', 'skill_drill', 'tactical_drill', 'conditioned_game', 'match_play', 'conditioning', 'recovery', 'review', 'custom'].includes(x.block.kind) ? x.block.kind : 'custom', title: x.title, objective: x.block.objective ?? x.why, duration_min: x.block.duration_min, cues: [], tags: [] }));
      const blocks = i.plan_blocks ?? own;
      edited = !!i.plan_blocks && JSON.stringify(i.plan_blocks.map((b) => [b.title, b.duration_min])) !== JSON.stringify(own.map((b) => [b.title, b.duration_min]));
      if (!blocks.length) throw badRequest('There are no blocks to save');
      const saved = await savePlan(user, d.session_record_id, blocks);
      resolution.plan_version = saved.plan.version; resolution.session_record_id = d.session_record_id;
    } else if (d.task === 'suggest_actions') {
      const chosen = i.actions ?? [];
      if (!chosen.length) throw badRequest('Choose at least one action to create, or discard the draft');
      const suggested = new Set(d.output.items.map((x) => x.action?.title).filter(Boolean));
      edited = chosen.some((a) => !suggested.has(a.title));
      const created = [];
      for (const a of chosen) {
        const athlete_id = a.athlete_id ?? d.athlete_id ?? undefined;
        const team_id = athlete_id ? undefined : d.team_id ?? undefined;
        if (!athlete_id && !team_id) throw badRequest('Each action needs an athlete or a team');
        await authorise(user, { athlete_id, team_id });
        const row = await one(
          `INSERT INTO coaching_actions(coach_id, athlete_id, team_id, owner_id, title, detail, due_at, session_record_id, client_key) VALUES ($1,$2,$3,$1,$4,$5,$6,$7,$8)
           ON CONFLICT (coach_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING id`, [user.id, athlete_id ?? null, team_id ?? null, a.title, a.detail, a.due_at ?? null, d.session_record_id, `ai-${d.id}-${sha256(a.title + (athlete_id ?? '')).slice(0, 12)}`]);
        if (row) created.push(row.id);
      }
      resolution.action_ids = created;
    } else if (d.task === 'summarise_session' && i.summary_text) {
      if (!d.session_record_id) throw badRequest('This draft has no session');
      const rec = await ownRecord(user, d.session_record_id);
      await pool.query('UPDATE coaching_session_records SET private_summary=$2, row_version=row_version+1, updated_at=now() WHERE id=$1', [rec.id, i.summary_text]);
      edited = i.summary_text !== d.output.headline;
      resolution.session_record_id = rec.id;
    }
    resolution.wrote = Object.keys(resolution).length > 0;
    return close(edited ? 'edited' : 'accepted', resolution);
  },
});
