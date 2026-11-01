// AI highlights & smart clips (#505): the engine behind the smart-clip capabilities.
//
// What is new here, and what is deliberately NOT: a finished clip is an ordinary governed mr_assets row (kind 'clip'), so rights, embargo, expiry, takedown,
// territory and youth media consent are decided by src/media-rights.js exactly as for every other asset. This module adds the things that did not exist:
//   * an explicit alignment between a recording's time and the time of play (placeOnMedia),
//   * candidate moments that always cite the canonical record that justifies them (detect*),
//   * the candidate -> processing -> review -> approved -> published | withdrawn workflow,
//   * reels, player links, and a usage ledger that the commercial entitlement engine (#504) can meter.
// AI never creates a scoring fact: it may only re-rank / title moments that already cite a real event, or nominate event ids that are checked against the log.
import { createHash } from 'node:crypto';
import { pool, one, tx } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { capabilities } from './registry.js';
import { enqueue, runJobs } from './jobs.js';
import { askJsonDetailed, aiConfigured, aiModel, quoteData, AI_RULES, z } from './ai.js';
import { consume } from './commercial/engine.js';
import { familyOf, FAMILIES } from './rankings/families.js';
import { loggedEvents, rulesetForEvent } from './scoring/state.js';
import { computeScore } from './scoring/engine.js';
import { assetState, evaluateRights, recordRightsCheck, logMr, ASSET_COLS } from './media-rights.js';
import { isYouth } from './youth.js';

export const METER_KEY = 'highlight_credits';           // the commercial meter premium highlight credits are counted on (#504)
export const STATUSES = ['candidate', 'processing', 'review', 'approved', 'published', 'withdrawn', 'rejected', 'failed'];
export const BUMPER_UNIT_KINDS = ['livestream_overlay', 'replay', 'scorecard'];
const PRE_S = 8, POST_S = 6, MAX_REPLAY_EVENTS = 800;

const MOMENT_LABELS = {
  goal: 'Goal', wicket: 'Wicket', six: 'Six', boundary: 'Boundary', set_won: 'Set won', match_won: 'Match won', win: 'Win', finish: 'Finish',
  bookmark: 'Bookmarked moment', score: 'Score',
};
export const momentLabel = (k) => MOMENT_LABELS[k] ?? k.replace(/_/g, ' ').replace(/^./, (m) => m.toUpperCase());

// ------------------------------------------------------------------ source alignment
/**
 * Where on the recording does a moment of play sit? Returns seconds into the media, or null when this alignment cannot place it
 * (for a game-clock alignment: another period, or an event without a game clock). Never guesses.
 */
export function placeOnMedia(al, at) {
  const rate = Number(al.rate ?? 1);
  if (al.method === 'wall_clock') {
    if (!at.at) return null;
    const dt = (new Date(at.at).getTime() - new Date(al.anchor_at).getTime()) / 1000;
    const t = Number(al.anchor_media_s) + (dt - Number(al.lag_s ?? 0)) * rate;
    return t < 0 ? null : Math.round(t * 100) / 100;
  }
  if (al.method === 'game_clock') {
    if (at.clock_seconds == null || at.period == null || Number(at.period) !== Number(al.anchor_period)) return null;
    const t = Number(al.anchor_media_s) + (Number(at.clock_seconds) - Number(al.anchor_clock_s)) * rate;
    return t < 0 ? null : Math.round(t * 100) / 100;
  }
  return null;
}

// ------------------------------------------------------------------ moment detection: one native model per sport family, from the canonical log only
const nameOf = (fx, side) => (side === 'home' ? fx.home_name : side === 'away' ? fx.away_name : null);
const mm = (s) => (s == null ? null : `${Math.floor(s / 60)}'`);

/** Sports that have no scoring log a clip can cite (outcome / manual scoring) get bookmarks only: said plainly, never silently. */
export function momentsOfFixture(rs, events, fx) {
  const out = [];
  const live = events.filter((e) => !e.voided_at);
  const base = (e) => ({ source_kind: 'match_event', source_ref: e.id, seq: e.seq, at: { at: e.recorded_at, period: e.period, clock_seconds: e.clock_seconds }, player_id: e.player_id ?? null, team: nameOf(fx, e.side), period: e.period ?? null, minute: mm(e.clock_seconds) });
  if (rs.kind === 'cricket') {
    for (const e of live) {
      if (e.kind !== 'ball') continue;
      const p = e.payload ?? {};
      if (p.wicket) out.push({ ...base(e), moment_kind: 'wicket', priority: 88, facts: { how_out: p.wicket.how ?? null, runs: p.runs ?? 0 } });
      else if (!p.extra && p.runs === 6) out.push({ ...base(e), moment_kind: 'six', priority: 76, facts: { runs: 6 } });
      else if (!p.extra && p.runs === 4) out.push({ ...base(e), moment_kind: 'boundary', priority: 62, facts: { runs: 4 } });
    }
  } else if (rs.kind === 'points_events') {
    const scoring = new Map((rs.events ?? []).filter((x) => x.points > 0).map((x) => [x.kind, x]));
    for (const e of live) {
      const def = scoring.get(e.kind);
      if (def) out.push({ ...base(e), moment_kind: e.kind, priority: Math.min(95, 66 + def.points * 4), facts: { label: def.label, points: def.points } });
    }
  } else if (rs.kind === 'sets') {
    if (live.length <= MAX_REPLAY_EVENTS) {
      let prev = computeScore(rs, []);
      for (let i = 0; i < live.length; i++) {
        const e = live[i];
        if (e.kind !== 'point') continue;
        const now = computeScore(rs, live.slice(0, i + 1));
        const done = (s) => (Array.isArray(s.sets) ? s.sets.filter((x) => x.done !== false && x.winner).length : 0);
        if (now.over && !prev.over) out.push({ ...base(e), moment_kind: 'match_won', priority: 96, facts: { winner: nameOf(fx, now.winner) } });
        else if (done(now) > done(prev)) out.push({ ...base(e), moment_kind: 'set_won', priority: 74, facts: { sets_won: done(now) } });
        prev = now;
      }
    }
  }
  return out;
}

async function sessionMoments(c, sessionId) {
  const rows = (await c.query(
    `SELECT se.id, se.seq, se.kind, se.recorded_at, se.payload, se.entry_id, en.position, ep.user_id
       FROM session_events se LEFT JOIN event_session_entries en ON en.id=se.entry_id LEFT JOIN event_participants ep ON ep.id=en.participant_id
      WHERE se.session_id=$1 AND se.voided_at IS NULL AND se.kind='finish' ORDER BY se.seq`, [sessionId])).rows;
  return rows.map((r) => ({
    source_kind: 'session_event', source_ref: r.id, seq: r.seq, at: { at: r.recorded_at, period: null, clock_seconds: null }, player_id: r.user_id ?? null, team: null, period: null, minute: null,
    moment_kind: r.position === 1 ? 'win' : 'finish', priority: r.position === 1 ? 92 : 45, facts: { position: r.position ?? null, result: r.payload?.value ?? null },
  }));
}

// ------------------------------------------------------------------ usage ledger and metering (#504)
/**
 * Write one usage row (once per idempotency key) and, when a commercial meter for premium highlight credits exists, count it there too.
 * Throws 402 `limit_reached` / `not_entitled` BEFORE the work is kept, so a plan limit stops cost rather than reporting it afterwards.
 */
export async function recordUsage(c, { eventId, candidateId = null, kind, processingS = 0, storageBytes = 0, usage = null, credits = 0, key, actorId = null }) {
  const ins = await c.query(
    `INSERT INTO clip_usage(event_id, candidate_id, kind, processing_s, storage_bytes, ai_input_tokens, ai_output_tokens, credits, idempotency_key, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [eventId, candidateId, kind, processingS, storageBytes, usage?.input_tokens ?? 0, usage?.output_tokens ?? 0, credits, key, actorId]);
  if (!ins.rowCount) return { replayed: true };
  if (credits > 0 && (await one('SELECT 1 FROM commercial_meters WHERE key=$1', [METER_KEY]))) {
    const r = await consume({ subjectType: 'event', subjectId: eventId, key: METER_KEY, quantity: credits, idempotencyKey: key, actorId });
    await c.query('UPDATE clip_usage SET metered=true WHERE id=$1', [ins.rows[0].id]);
    return { replayed: false, metered: true, ...r };
  }
  return { replayed: false, metered: false };
}

export async function usageOf(c, eventId) {
  const rows = (await c.query(
    `SELECT kind, count(*)::int AS n, coalesce(sum(processing_s),0)::float AS processing_s, coalesce(sum(storage_bytes),0)::bigint AS storage_bytes,
            coalesce(sum(ai_input_tokens),0)::int AS ai_input_tokens, coalesce(sum(ai_output_tokens),0)::int AS ai_output_tokens, coalesce(sum(credits),0)::float AS credits
       FROM clip_usage WHERE event_id=$1 GROUP BY kind ORDER BY kind`, [eventId])).rows;
  const total = rows.reduce((t, r) => ({ credits: t.credits + r.credits, processing_s: t.processing_s + r.processing_s, storage_bytes: t.storage_bytes + Number(r.storage_bytes), ai_input_tokens: t.ai_input_tokens + r.ai_input_tokens, ai_output_tokens: t.ai_output_tokens + r.ai_output_tokens }), { credits: 0, processing_s: 0, storage_bytes: 0, ai_input_tokens: 0, ai_output_tokens: 0 });
  const m = await one('SELECT 1 FROM commercial_meters WHERE key=$1', [METER_KEY]);
  return { meter_key: METER_KEY, metered: !!m, by_kind: rows.map((r) => ({ ...r, storage_bytes: Number(r.storage_bytes) })), total };
}

// ------------------------------------------------------------------ the render provider (a stub by default; swap with setClipRenderer)
let renderer = null;
export const setClipRenderer = (fn) => { renderer = fn; };
/**
 * Default: video stays where it is hosted, so a clip is the governed time window of its source link, expressed as a standard media-fragment URL.
 * A configured renderer may instead cut and host a real file and return { url, bytes }.
 */
async function render({ source, from, to, candidate }) {
  if (renderer) {
    const r = await renderer({ source_url: source.external_url, from, to, candidate_id: candidate.id });
    if (!r?.url || !/^https:\/\//.test(r.url)) throw new Error('The renderer returned no secure https link');
    return { url: r.url, bytes: Number(r.bytes ?? 0) };
  }
  const base = source.external_url.split('#')[0];
  return { url: `${base}#t=${from},${to}`, bytes: 0 };
}

// ------------------------------------------------------------------ candidates
const sportOf = async (c, eventId, sessionId) => {
  const row = sessionId
    ? (await c.query('SELECT s.id, s.slug, s.name, s.scoring, s.category FROM event_sessions es JOIN event_disciplines d ON d.id=es.discipline_id JOIN sports s ON s.id=d.sport_id WHERE es.id=$1', [sessionId])).rows[0]
    : (await c.query('SELECT s.id, s.slug, s.name, s.scoring, s.category FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id=$1', [eventId])).rows[0];
  if (!row) throw notFound('Sport');
  return row;
};
export const familyInfo = (sport) => { const family = familyOf(sport); return { family, native: !!FAMILIES[family]?.native, label: FAMILIES[family]?.label }; };

const defaultTitle = (m, fx) => {
  const t = fx?.home_name && fx?.away_name ? ` · ${fx.home_name} v ${fx.away_name}` : '';
  return `${momentLabel(m.moment_kind)}${m.minute ? ` ${m.minute}` : ''}${t}`.slice(0, 140);
};

const aiSchema = z.object({
  rank: z.array(z.object({ id: z.string().min(1).max(64), title: z.string().min(2).max(120).optional(), priority: z.number().int().min(0).max(100).optional() })).max(60).default([]),
  extra: z.array(z.object({ id: z.string().min(1).max(64), title: z.string().min(2).max(120).optional(), why: z.string().max(200).optional() })).max(10).default([]),
});

/**
 * Cut candidate moments for one recording of one game / session. Idempotent: a moment already cut from this recording is returned, not duplicated.
 * `useAi` lets the model re-rank, retitle and nominate extra event ids; every id it returns is checked against the real log and the rest are dropped.
 */
export async function generateCandidates(user, { source, alignment, fixtureId = null, sessionId = null, ev, pre = PRE_S, post = POST_S, max = 25, useAi = false, bookmarks = true }) {
  const sport = await sportOf(pool, ev.id, sessionId);
  const fam = familyInfo(sport);
  const out = { sport_family: fam.family, native: fam.native, created: [], existing: [], skipped: [], ai: { used: false, rejected_ids: 0, nominated: 0 }, notes: [] };
  let moments = [];
  let fx = null, events = [], rs = null;
  if (fixtureId) {
    fx = (await pool.query('SELECT f.id, h.name AS home_name, a.name AS away_name FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id=$1', [fixtureId])).rows[0];
    rs = (await rulesetForEvent(ev.id, pool, fixtureId)).ruleset;
    events = await loggedEvents(fixtureId, pool);
    moments = momentsOfFixture(rs, events, fx);
    if (rs.kind === 'manual') out.notes.push('This sport is scored by the referee entering totals, so there are no scoring events to cite. Use bookmarks to mark moments.');
  } else moments = await sessionMoments(pool, sessionId);
  if (bookmarks) {
    const bm = (await pool.query(`SELECT * FROM clip_bookmarks WHERE voided_at IS NULL AND ${fixtureId ? 'fixture_id' : 'session_id'}=$1`, [fixtureId ?? sessionId])).rows;
    for (const b of bm) moments.push({ source_kind: 'bookmark', source_ref: b.id, seq: 0, at: { at: b.occurred_at, period: b.period, clock_seconds: b.clock_seconds }, player_id: null, team: null, period: b.period, minute: mm(b.clock_seconds), moment_kind: 'bookmark', priority: 80, facts: { label: b.label ?? null }, origin: 'bookmark' });
  }
  // AI: nominate extra events, but only from ids we offer it; rank/title only candidates we built
  let aiPlan = null, aiUsage = null;
  const offered = new Map();
  if (useAi && aiConfigured() && fixtureId) {
    const taken = new Set(moments.map((m) => m.source_ref));
    for (const e of events.filter((x) => !x.voided_at && !taken.has(x.id) && !['note', 'period_start', 'period_end', 'lineup', 'server'].includes(x.kind)).slice(-60)) offered.set(e.id, e);
    const facts = { sport: sport.name, moments: moments.map((m) => ({ id: m.source_ref, kind: m.moment_kind, period: m.period, minute: m.minute, team: m.team })), other_events: [...offered.values()].map((e) => ({ id: e.id, kind: e.kind, period: e.period, minute: mm(e.clock_seconds) })) };
    const r = await askJsonDetailed({
      system: `You help pick highlight moments for a sports clip reel. ${AI_RULES} Only use ids that appear in the data. You may re-rank and retitle the listed moments, and nominate at most a few ids from other_events that would make a good clip. Never describe anything that is not in the data.`,
      user: `<data>${quoteData(JSON.stringify(facts), 8000)}</data>`, shape: '{"rank":[{"id":string,"title":string,"priority":0-100}],"extra":[{"id":string,"title":string,"why":string}]}', schema: aiSchema, maxTokens: 900,
    });
    if (r) { aiPlan = r.data; aiUsage = r.usage; out.ai.used = true; }
  }
  const byRef = new Map(moments.map((m) => [m.source_ref, m]));
  if (aiPlan) {
    for (const r of aiPlan.rank) {
      const m = byRef.get(r.id);
      if (!m) { out.ai.rejected_ids++; continue; }
      if (r.priority != null) m.priority = r.priority;
      if (r.title) { m.ai_title = quoteData(r.title, 120); }
    }
    for (const x of aiPlan.extra) {
      const e = offered.get(x.id);
      if (!e) { out.ai.rejected_ids++; continue; }
      const m = { source_kind: 'match_event', source_ref: e.id, seq: e.seq, at: { at: e.recorded_at, period: e.period, clock_seconds: e.clock_seconds }, player_id: e.player_id ?? null, team: nameOf(fx, e.side), period: e.period ?? null, minute: mm(e.clock_seconds), moment_kind: e.kind, priority: 50, facts: { label: e.kind }, origin: 'ai', ai_note: x.why ? quoteData(x.why, 280) : null, ai_title: x.title ? quoteData(x.title, 120) : null };
      moments.push(m); byRef.set(m.source_ref, m); out.ai.nominated++;
    }
  }
  moments.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  const keepN = max;
  for (const m of moments.slice(0, keepN)) {
    const t = placeOnMedia(alignment, m.at);
    if (t == null) { out.skipped.push({ source_ref: m.source_ref, moment_kind: m.moment_kind, reason: 'not_placeable' }); continue; }
    const start = Math.max(0, Math.round((t - pre) * 100) / 100), end = Math.round((t + post) * 100) / 100;
    const title = m.ai_title ?? defaultTitle(m, fx);
    const facts = { sport: sport.name, sport_family: fam.family, moment_kind: m.moment_kind, label: momentLabel(m.moment_kind), team: m.team, period: m.period, minute: m.minute, ...m.facts, cites: { kind: m.source_kind, id: m.source_ref, seq: m.seq || null }, fixture: fx ? `${fx.home_name ?? ''} v ${fx.away_name ?? ''}`.trim() : null };
    const row = await tx(async (cl) => {
      const ins = await cl.query(
        `INSERT INTO clip_candidates(event_id, fixture_id, session_id, source_asset_id, alignment_id, source_kind, source_ref, moment_kind, sport_family, origin, priority, media_start_s, media_end_s, title, caption_facts, ai_note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (source_asset_id, source_kind, source_ref) DO NOTHING RETURNING *`,
        [ev.id, fixtureId, sessionId, source.id, alignment.id, m.source_kind, m.source_ref, m.moment_kind, fam.family, m.origin ?? 'rule', m.priority, start, end, title, JSON.stringify(facts), m.ai_note ?? null, user.id]);
      if (!ins.rowCount) return { existing: (await cl.query('SELECT * FROM clip_candidates WHERE source_asset_id=$1 AND source_kind=$2 AND source_ref=$3', [source.id, m.source_kind, m.source_ref])).rows[0] };
      const cand = ins.rows[0];
      if (m.player_id) await cl.query("INSERT INTO clip_participants(candidate_id, user_id, origin, added_by) VALUES ($1,$2,'event',$3) ON CONFLICT DO NOTHING", [cand.id, m.player_id, user.id]);
      await logMr(cl, ev.id, 'asset', source.id, 'clip_candidate', { actor: user.id, detail: { candidate_id: cand.id, cites: facts.cites, origin: cand.origin } });
      return { created: cand };
    });
    if (row.created) out.created.push(row.created); else out.existing.push(row.existing);
  }
  // cost of this step: one credit when AI took part (idempotent per recording + log state), nothing for the deterministic rules
  if (out.ai.used) {
    const sig = createHash('sha256').update(JSON.stringify([source.id, moments.map((m) => m.source_ref), aiModel()])).digest('hex').slice(0, 24);
    await recordUsage(pool, { eventId: ev.id, kind: 'ai_rank', usage: aiUsage, credits: 1, key: `clip-ai-rank:${source.id}:${sig}`, actorId: user.id });
  }
  await recordUsage(pool, { eventId: ev.id, kind: 'generate', key: `clip-gen:${source.id}:${fixtureId ?? sessionId}:${out.created.length}:${out.created[0]?.id ?? 'none'}`, actorId: user.id });
  return out;
}

// ------------------------------------------------------------------ processing (queue -> governed clip asset in review)
/** Ask for a candidate to be cut. Charged once (idempotent); the render itself runs as a retry-safe background job. */
export async function requestProcessing(user, candId) {
  return tx(async (c) => {
    const cand = (await c.query('SELECT * FROM clip_candidates WHERE id=$1 FOR UPDATE', [candId])).rows[0];
    if (!cand) throw notFound('Clip');
    if (!['candidate', 'failed'].includes(cand.status)) {
      if (['processing', 'review', 'approved', 'published'].includes(cand.status)) return cand; // already on its way: a repeat request is harmless
      throw conflict(`A ${cand.status} clip cannot be processed`);
    }
    await recordUsage(c, { eventId: cand.event_id, candidateId: cand.id, kind: 'process', processingS: Number(cand.media_end_s) - Number(cand.media_start_s), credits: 1, key: `clip-process:${cand.id}`, actorId: user.id });
    const up = (await c.query("UPDATE clip_candidates SET status='processing', last_error=NULL, updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *", [cand.id])).rows[0];
    await enqueue(c, { category: 'smart_clips', kind: 'smart_clip_render', payload: { candidate_id: cand.id }, dedupeKey: `clip-render:${cand.id}:${up.row_version}` });
    return up;
  });
}

/** The job: cut the clip, register it as a draft governed asset cut from the recording, tag the people in it, move the candidate to review. Safe to run twice. */
export async function renderCandidate(candId, job = null) {
  const cand0 = (await pool.query('SELECT * FROM clip_candidates WHERE id=$1', [candId])).rows[0];
  if (!cand0) return;
  const src = (await pool.query(`SELECT ${ASSET_COLS} FROM mr_assets a WHERE a.id=$1`, [cand0.source_asset_id])).rows[0];
  let out;
  try {
    if (!src || ['withdrawn', 'taken_down'].includes(src.status) || src.source_blocked) throw new Error('The recording is no longer available');
    if (!src.external_url) throw new Error('The recording has no streamable link');
    out = cand0.status === 'processing' && !cand0.asset_id ? await render({ source: src, from: Number(cand0.media_start_s), to: Number(cand0.media_end_s), candidate: cand0 }) : null;
  } catch (e) {
    // the job retries with backoff while it has attempts left; only when it gives up is the clip marked failed (and can be processed again)
    const last = !job || job.attempts >= job.max_attempts;
    await pool.query(`UPDATE clip_candidates SET ${last ? "status='failed'," : ''} last_error=$2, updated_at=now() WHERE id=$1 AND status='processing'`, [candId, String(e.message).slice(0, 300)]);
    throw e;
  }
  const done = await tx(async (c) => {
    const cand = (await c.query('SELECT * FROM clip_candidates WHERE id=$1 FOR UPDATE', [candId])).rows[0];
    if (cand.status !== 'processing' || cand.asset_id) return null; // someone else finished it: nothing to add (this is what makes retries idempotent)
    const facts = cand.caption_facts ?? {};
    const caption = [facts.label, facts.team, facts.minute].filter(Boolean).join(' · ').slice(0, 500) || null;
    const a = (await c.query(
      `INSERT INTO mr_assets(event_id, fixture_id, parent_asset_id, kind, right_kind, title, caption, credit, creator_id, owner_kind, owner_partner_id, owner_name, source_kind, external_url, audience,
                             territory_mode, countries, platforms, embargo_until, expires_at)
       VALUES ($1,$2,$3,'clip','highlights',$4,$5,$6,$7,$8,$9,$10,'external_link',$11,'private',$12,$13,$14,$15,$16) RETURNING *`,
      [cand.event_id, cand.fixture_id ?? src.fixture_id ?? null, src.id, cand.title ?? 'Clip', cand.caption_prose ?? caption, src.credit, cand.created_by, src.owner_kind, src.owner_partner_id, src.owner_name, out.url,
        src.territory_mode, src.countries, src.platforms, src.embargo_until, src.expires_at])).rows[0];
    for (const p of (await c.query('SELECT user_id FROM clip_participants WHERE candidate_id=$1 AND removed_at IS NULL', [cand.id])).rows) await addSubject(c, a.id, p.user_id, cand.created_by);
    await c.query("UPDATE clip_candidates SET status='review', asset_id=$2, updated_at=now(), row_version=row_version+1 WHERE id=$1", [cand.id, a.id]);
    await recordUsage(c, { eventId: cand.event_id, candidateId: cand.id, kind: 'storage', storageBytes: out.bytes, key: `clip-storage:${cand.id}`, actorId: cand.created_by });
    await logMr(c, cand.event_id, 'asset', a.id, 'clip_processed', { actor: cand.created_by, detail: { candidate_id: cand.id, from: cand.media_start_s, to: cand.media_end_s, parent: src.id } });
    return { cand, asset: a };
  });
  if (done) await afterReview(done.cand.id);
}

/** A person in a clip is a subject of its asset, so guardian media consent for a young person applies to the clip itself, live, on every view. */
async function addSubject(c, assetId, userId, actor) {
  if ((await c.query('SELECT 1 FROM mr_asset_subjects WHERE asset_id=$1 AND user_id=$2 AND removed_at IS NULL', [assetId, userId])).rowCount) return;
  const youth = await isYouth(userId, c);
  await c.query('INSERT INTO mr_asset_subjects(asset_id, user_id, consent_kind, added_by) VALUES ($1,$2,$3,$4)', [assetId, userId, youth ? 'guardian_media' : 'not_required', actor]);
}
export { addSubject };

/** Under a 'trusted_auto' policy, clips cut from real scoring events are approved and published automatically, as the person who switched it on, through every rights check. */
async function afterReview(candId) {
  const cand = (await pool.query('SELECT * FROM clip_candidates WHERE id=$1', [candId])).rows[0];
  const pol = (await pool.query("SELECT * FROM clip_policies WHERE event_id=$1 AND mode='trusted_auto'", [cand.event_id])).rows[0];
  if (!pol || cand.origin === 'ai' || cand.status !== 'review') return;
  const u = (await pool.query('SELECT * FROM users WHERE id=$1', [pol.set_by])).rows[0];
  if (!u) return;
  try {
    await pool.query("UPDATE clip_candidates SET status='approved', reviewed_by=$2, reviewed_at=now(), review_note='Approved automatically by the event policy', updated_at=now(), row_version=row_version+1 WHERE id=$1 AND status='review'", [candId, u.id]);
    await publishCandidate(u, candId, { audience: pol.audience });
  } catch (e) {
    await pool.query("UPDATE clip_candidates SET review_note=$2, updated_at=now() WHERE id=$1", [candId, `Automatic publication stopped: ${String(e.message).slice(0, 200)}`]);
  }
}

export const runClipJobs = () => runJobs('smart_clips', { smart_clip_render: (p, job) => renderCandidate(p.candidate_id, job) });

// ------------------------------------------------------------------ workflow
const callCap = (name, user, input) => { const c = capabilities.find((x) => x.name === name); return c.handler({ user }, c.input.parse(input)); };

export async function reviewCandidate(user, candId, { decision, note }) {
  return tx(async (c) => {
    const cand = (await c.query('SELECT * FROM clip_candidates WHERE id=$1 FOR UPDATE', [candId])).rows[0];
    if (!cand) throw notFound('Clip');
    if (decision === 'approve') {
      if (cand.status !== 'review') throw conflict('Only a clip in review can be approved');
      if (!cand.title) throw badRequest('Give the clip a title before approving it');
      return (await c.query("UPDATE clip_candidates SET status='approved', reviewed_by=$2, reviewed_at=now(), review_note=$3, updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *", [candId, user.id, note ?? null])).rows[0];
    }
    if (!['candidate', 'review', 'approved', 'failed'].includes(cand.status)) throw conflict(`A ${cand.status} clip cannot be rejected`);
    return (await c.query("UPDATE clip_candidates SET status='rejected', reviewed_by=$2, reviewed_at=now(), review_note=$3, updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *", [candId, user.id, note ?? null])).rows[0];
  });
}

/** Publish an approved clip. Every check is the media-rights one: the same code path as publishing any asset, so there is no way around consent, expiry or takedown. */
export async function publishCandidate(user, candId, { audience = 'public' } = {}) {
  const cand = (await pool.query('SELECT * FROM clip_candidates WHERE id=$1', [candId])).rows[0];
  if (!cand) throw notFound('Clip');
  if (cand.status !== 'approved') throw conflict('A clip must be reviewed and approved by a person before it is published', { code: 'review_required' });
  let a = (await pool.query('SELECT * FROM mr_assets WHERE id=$1', [cand.asset_id])).rows[0];
  if (a.audience !== audience) a = await callCap('update_media_asset_rights', user, { id: a.id, row_version: a.row_version, audience });
  await callCap('set_media_asset_status', user, { id: cand.asset_id, action: 'publish', row_version: a.row_version });
  return (await pool.query("UPDATE clip_candidates SET status='published', updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *", [candId])).rows[0];
}

export async function withdrawCandidate(user, candId, reason) {
  const cand = (await pool.query('SELECT * FROM clip_candidates WHERE id=$1', [candId])).rows[0];
  if (!cand) throw notFound('Clip');
  if (cand.status !== 'published') throw conflict('Only a published clip can be withdrawn');
  const a = (await pool.query('SELECT row_version FROM mr_assets WHERE id=$1', [cand.asset_id])).rows[0];
  await callCap('set_media_asset_status', user, { id: cand.asset_id, action: 'withdraw', reason, row_version: a.row_version });
  return (await pool.query("UPDATE clip_candidates SET status='withdrawn', updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *", [candId])).rows[0];
}

// ------------------------------------------------------------------ public playback: re-checked on every request
const PUBLIC_VIEWER = { organiser: false, owner: false, ownerCanAct: false, ents: [], inColl: [] };

/** The clip a member of the public may play right now, or null (-> 404). Rights window, takedown, source, visibility and live youth media consent are all re-read here. */
export async function publicClip(candId, { country = null, platform = null } = {}) {
  const cand = (await pool.query('SELECT cc.*, e.name AS event_name FROM clip_candidates cc JOIN events e ON e.id=cc.event_id WHERE cc.id=$1', [candId])).rows[0];
  if (!cand || cand.status !== 'published' || !cand.asset_id) return null;
  const a = (await pool.query(`SELECT ${ASSET_COLS} FROM mr_assets a WHERE a.id=$1`, [cand.asset_id])).rows[0];
  if (!a || a.audience !== 'public') return null;
  if ((await assetState(a, pool)) !== 'live') return null;
  const raw = await evaluateRights(pool, a, { purpose: 'export', viewer: PUBLIC_VIEWER, platform, country });
  // a publicly released clip needs no partner licence; every other rule (status, source, consent, expiry, embargo, schedule, platform, territory) still has to pass
  const check = { ...raw, allowed: raw.rules.every((r) => r.ok || (r.rule === 'licence' && a.audience === 'public')) };
  await recordRightsCheck(pool, a, { user: null, purpose: 'export', platform, country, result: check }).catch(() => {});
  if (!check.allowed) return null;
  const f = cand.fixture_id ? (await pool.query('SELECT f.status, f.home_score, f.away_score, h.name AS home_name, a.name AS away_name FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id=$1', [cand.fixture_id])).rows[0] : null;
  return {
    id: cand.id, title: cand.title, event: { id: cand.event_id, name: cand.event_name }, moment_kind: cand.moment_kind, sport_family: cand.sport_family,
    caption: { facts: cand.caption_facts, prose: cand.caption_prose, prose_by_ai: cand.prose_by_ai }, link: a.external_url, window: { start_s: Number(cand.media_start_s), end_s: Number(cand.media_end_s) },
    credit: a.credit, scorecard: f && f.status === 'completed' ? { home: f.home_name, away: f.away_name, home_score: f.home_score, away_score: f.away_score } : null,
  };
}

/** A clip shown on a passport / gallery: live state included so the owner sees why something is hidden. */
export async function liveStateOfAsset(assetId, c = pool) {
  const a = (await c.query(`SELECT ${ASSET_COLS} FROM mr_assets a WHERE a.id=$1`, [assetId])).rows[0];
  return a ? assetState(a, c) : 'missing';
}

// ------------------------------------------------------------------ reels
/** Is this booking an actual, current, confirmed sponsor inventory slot of the event that can carry a bumper? */
export async function bumperBookingOk(c, eventId, bookingId) {
  const b = (await c.query(
    `SELECT b.id, b.status, (current_date BETWEEN b.starts_on AND b.ends_on) AS running, u.kind, u.target_type, u.target_id, u.name, s.id AS sponsorship_id, s.status AS deal_status
       FROM sponsor_inventory_bookings b JOIN sponsor_inventory_units u ON u.id=b.unit_id JOIN sponsorships s ON s.id=b.sponsorship_id WHERE b.id=$1`, [bookingId])).rows[0];
  if (!b) return { ok: false, reason: 'No such sponsor booking' };
  if (b.status !== 'confirmed') return { ok: false, reason: 'That sponsor booking has been released' };
  if (b.deal_status !== 'active') return { ok: false, reason: 'The sponsorship behind that booking is not active' };
  if (!BUMPER_UNIT_KINDS.includes(b.kind)) return { ok: false, reason: 'That booking is not for an overlay, replay or scorecard placement' };
  if (!(b.target_type === 'event' && b.target_id === eventId)) return { ok: false, reason: 'That booking belongs to another event' };
  if (!b.running) return { ok: false, reason: 'That sponsor booking is not running today' };
  return { ok: true, booking: b };
}

/** The public face of a reel: every item is re-checked now, and what fails (withdrawn clip, lapsed consent, released sponsor) is left out, not shown. */
export async function publicReel(reelId, { country = null, platform = null } = {}) {
  const reel = (await pool.query('SELECT r.*, e.name AS event_name FROM clip_reels r JOIN events e ON e.id=r.event_id WHERE r.id=$1', [reelId])).rows[0];
  if (!reel || reel.status !== 'published') return null;
  const items = (await pool.query('SELECT * FROM clip_reel_items WHERE reel_id=$1 AND removed_at IS NULL ORDER BY position', [reelId])).rows;
  const out = []; let hidden = 0;
  for (const it of items) {
    if (it.kind === 'clip') { const clip = await publicClip(it.candidate_id, { country, platform }); if (clip) out.push({ position: it.position, kind: 'clip', clip }); else hidden++; }
    else if (it.kind === 'sponsor_bumper') {
      const ok = await bumperBookingOk(pool, reel.event_id, it.inventory_booking_id);
      if (!ok.ok) { hidden++; continue; }
      const sp = (await pool.query('SELECT sp.name FROM sponsor_inventory_bookings b JOIN sponsorships s ON s.id=b.sponsorship_id JOIN sponsors sp ON sp.id=s.sponsor_id WHERE b.id=$1', [it.inventory_booking_id]).catch(() => ({ rows: [] }))).rows[0];
      out.push({ position: it.position, kind: 'sponsor_bumper', label: it.label ?? ok.booking.name, sponsor: sp?.name ?? null });
    } else out.push({ position: it.position, kind: it.kind, label: it.label ?? null });
  }
  let scorecard = null;
  if (reel.fixture_id) {
    const f = (await pool.query('SELECT f.status, f.home_score, f.away_score, h.name AS home_name, a.name AS away_name FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id=$1', [reel.fixture_id])).rows[0];
    if (f?.status === 'completed') scorecard = { home: f.home_name, away: f.away_name, home_score: f.home_score, away_score: f.away_score };
  }
  return { id: reel.id, title: reel.title, kind: reel.kind, event: { id: reel.event_id, name: reel.event_name }, items: out, hidden, scorecard };
}

