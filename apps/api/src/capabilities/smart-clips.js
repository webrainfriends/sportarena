// AI highlights & smart clips (#505). One definition per action -> REST + OpenAPI + MCP. The UI only calls these.
// A clip is a governed mr_assets row; publishing goes through set_media_asset_status, so media rights, takedown and youth media consent cannot be bypassed here.
// AI only drafts: it never creates a scoring fact and never publishes. See src/smart-clips.js for the engine and docs/smart-clips.md for the design.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { pool, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { requireConsent, isYouth } from '../youth.js';
import { askJsonDetailed, aiConfigured, quoteData, AI_RULES } from '../ai.js';
import { eventOf, isOrganiserOf, assetState, ASSET_COLS, PLATFORMS } from '../media-rights.js';
import { viewerOf } from './media-rights-assets.js';
import { fixtureContext } from './match-tracking.js';
import { canScoreSession } from './live-scoring.js';
import {
  STATUSES, generateCandidates, requestProcessing, reviewCandidate, publishCandidate, withdrawCandidate, publicClip, publicReel, bumperBookingOk, addSubject,
  recordUsage, usageOf, momentLabel,
} from '../smart-clips.js';

const TAG = 'Smart clips';
const text = (n) => z.string().trim().max(n);
const dt = z.string().datetime({ offset: true });
const num = (min, max) => z.coerce.number().min(min).max(max);
const ver = z.coerce.number().int().min(1);

// ---------------------------------------------------------------- access
/** The caller may act on this recording (organiser, owning partner or the person who registered it). Anyone else gets a 404, never a hint it exists. */
async function manageSource(user, src) {
  const v = await viewerOf(user, src);
  if (!v.organiser && !v.owner) throw notFound('Recording');
  if (!v.ownerCanAct) throw forbidden('Your role cannot manage clips of this recording');
  return v;
}
const sourceAsset = async (aid, c = pool) => {
  const a = (await c.query(`SELECT ${ASSET_COLS} FROM mr_assets a WHERE a.id=$1`, [aid])).rows[0];
  if (!a) throw notFound('Recording');
  return a;
};
async function loadClip(user, cid, c = pool) {
  const cand = (await c.query('SELECT * FROM clip_candidates WHERE id=$1', [cid])).rows[0];
  if (!cand) throw notFound('Clip');
  const src = await sourceAsset(cand.source_asset_id, c);
  await manageSource(user, src);
  return { cand, src, ev: await eventOf(cand.event_id, c) };
}
const stale = (cand, v) => { if (cand.row_version !== v) throw conflict('Someone changed this clip; reload it', { code: 'stale_version' }); };

const shapeClip = async (cand, { withState = true } = {}) => {
  const asset = cand.asset_id ? (await pool.query(`SELECT ${ASSET_COLS} FROM mr_assets a WHERE a.id=$1`, [cand.asset_id])).rows[0] : null;
  const participants = (await pool.query(
    `SELECT p.user_id, p.origin, u.display_name FROM clip_participants p JOIN users u ON u.id=p.user_id WHERE p.candidate_id=$1 AND p.removed_at IS NULL ORDER BY p.added_at`, [cand.id])).rows;
  const subjects = asset ? (await pool.query('SELECT user_id FROM mr_asset_subjects WHERE asset_id=$1 AND removed_at IS NULL AND user_id IS NOT NULL', [asset.id])).rows : [];
  return {
    id: cand.id, event_id: cand.event_id, fixture_id: cand.fixture_id, session_id: cand.session_id, source_asset_id: cand.source_asset_id, asset_id: cand.asset_id,
    status: cand.status, moment_kind: cand.moment_kind, label: momentLabel(cand.moment_kind), sport_family: cand.sport_family, origin: cand.origin, priority: cand.priority,
    cites: cand.caption_facts?.cites ?? { kind: cand.source_kind, id: cand.source_ref }, media: { start_s: Number(cand.media_start_s), end_s: Number(cand.media_end_s) },
    title: cand.title, caption: { facts: cand.caption_facts, prose: cand.caption_prose, prose_by_ai: cand.prose_by_ai }, ai_note: cand.ai_note, review_note: cand.review_note, last_error: cand.last_error,
    participants, rights: asset ? { state: withState ? await assetState(asset, pool) : undefined, audience: asset.audience, asset_status: asset.status, row_version: asset.row_version, tagged: subjects.length } : null,
    link: asset?.external_url ?? null, reviewed_by: cand.reviewed_by, row_version: cand.row_version, created_at: cand.created_at,
  };
};

// ---------------------------------------------------------------- source alignment
cap({
  name: 'set_clip_alignment', method: 'POST', path: '/media/assets/:id/clip-alignment', tag: TAG, status: 201,
  summary: 'Say how a recording lines up with the game: which second of the video is a known instant of play. method wall_clock: the video second `anchor_media_s` is the wall-clock instant `anchor_at` (works for every sport, including heats and field events). method game_clock: it is the game clock `anchor_clock_s` of period `anchor_period` (games with a clock). `rate` corrects a recording that runs fast or slow; `lag_s` is how many seconds after the action the scorer typically logged it. A new alignment replaces the old one, which is kept as history. Moments that the alignment cannot place are skipped, never guessed.',
  input: z.object({ id, fixture_id: id.optional(), session_id: id.optional(), method: z.enum(['wall_clock', 'game_clock']), anchor_media_s: num(0, 86400), anchor_at: dt.optional(), anchor_period: z.coerce.number().int().min(0).max(12).optional(), anchor_clock_s: z.coerce.number().int().min(0).max(14400).optional(), rate: num(0.5, 2).default(1), lag_s: num(0, 120).default(0), note: text(300).optional() })
    .refine((i) => !!i.fixture_id !== !!i.session_id, 'Name the game or the session this recording shows')
    .refine((i) => i.method === 'wall_clock' ? !!i.anchor_at : i.anchor_period != null && i.anchor_clock_s != null && !!i.fixture_id, 'A wall_clock alignment needs anchor_at; a game_clock alignment needs a game with anchor_period and anchor_clock_s'),
  handler: ({ user }, i) => tx(async (c) => {
    await c.query('SELECT id FROM mr_assets WHERE id=$1 FOR UPDATE', [i.id]);
    const src = await sourceAsset(i.id, c);
    await manageSource(user, src);
    if (src.kind !== 'video' || src.source_kind !== 'external_link') throw badRequest('Align a video recording that has a streamable https link');
    if (['withdrawn', 'taken_down'].includes(src.status)) throw conflict('That recording has been withdrawn');
    if (i.fixture_id) {
      const f = (await c.query('SELECT event_id FROM fixtures WHERE id=$1', [i.fixture_id])).rows[0];
      if (!f || f.event_id !== src.event_id) throw badRequest('Choose a game of this event');
      if (src.fixture_id && src.fixture_id !== i.fixture_id) throw badRequest('This recording is registered against another game');
    } else if (!(await c.query('SELECT 1 FROM event_sessions WHERE id=$1 AND event_id=$2', [i.session_id, src.event_id])).rowCount) throw badRequest('Choose a session of this event');
    await c.query('UPDATE clip_alignments SET superseded_at=now() WHERE source_asset_id=$1 AND superseded_at IS NULL', [src.id]);
    const r = (await c.query(
      `INSERT INTO clip_alignments(event_id, fixture_id, session_id, source_asset_id, method, anchor_media_s, anchor_at, anchor_period, anchor_clock_s, rate, lag_s, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [src.event_id, i.fixture_id ?? null, i.session_id ?? null, src.id, i.method, i.anchor_media_s, i.anchor_at ?? null, i.anchor_period ?? null, i.anchor_clock_s ?? null, i.rate, i.lag_s, i.note ?? null, user.id])).rows[0];
    return r;
  }),
});

cap({
  name: 'get_clip_alignment', method: 'GET', path: '/media/assets/:id/clip-alignment', tag: TAG,
  summary: 'The current alignment of a recording with its game or session (null when it has none yet), and how many earlier alignments are kept as history.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const src = await sourceAsset(i.id);
    await manageSource(user, src);
    const cur = (await pool.query('SELECT * FROM clip_alignments WHERE source_asset_id=$1 AND superseded_at IS NULL', [src.id])).rows[0] ?? null;
    const history = (await pool.query('SELECT count(*)::int AS n FROM clip_alignments WHERE source_asset_id=$1 AND superseded_at IS NOT NULL', [src.id])).rows[0].n;
    return { current: cur, history };
  },
});

cap({
  name: 'bookmark_moment', method: 'POST', path: '/clip-bookmarks', tag: TAG, status: 201,
  summary: 'Scorers and organisers bookmark "something worth clipping happened now" in a game or session. It is a pointer to a moment, never a scoring fact. `client_key` makes an offline retry safe. A bookmark can later be turned into a clip candidate.',
  input: z.object({ fixture_id: id.optional(), session_id: id.optional(), period: z.coerce.number().int().min(0).max(12).optional(), clock_seconds: z.coerce.number().int().min(0).max(14400).optional(), occurred_at: dt.optional(), label: text(120).optional(), client_key: text(80).optional() })
    .refine((i) => !!i.fixture_id !== !!i.session_id, 'Name a game or a session'),
  async handler({ user }, i) {
    let eventId;
    if (i.fixture_id) { const x = await fixtureContext(user, i.fixture_id); if (!x.canScore) throw forbidden('Only the organiser or the match officials can bookmark a moment'); eventId = x.f.event_id; }
    else { if (!(await canScoreSession(user, i.session_id))) throw forbidden('Only the organiser or the session officials can bookmark a moment'); eventId = (await one('SELECT event_id FROM event_sessions WHERE id=$1', [i.session_id])).event_id; }
    const row = (await pool.query(
      `INSERT INTO clip_bookmarks(event_id, fixture_id, session_id, period, clock_seconds, occurred_at, label, client_key, created_by) VALUES ($1,$2,$3,$4,$5,coalesce($6, now()),$7,$8,$9)
       ON CONFLICT (created_by, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING *`,
      [eventId, i.fixture_id ?? null, i.session_id ?? null, i.period ?? null, i.clock_seconds ?? null, i.occurred_at ?? null, i.label ?? null, i.client_key ?? null, user.id])).rows[0];
    return row ?? (await one('SELECT * FROM clip_bookmarks WHERE created_by=$1 AND client_key=$2', [user.id, i.client_key]));
  },
});

// ---------------------------------------------------------------- candidates
cap({
  name: 'generate_clip_candidates', method: 'POST', path: '/media/assets/:id/clip-candidates', tag: TAG, status: 201,
  summary: 'Cut candidate clips from a recording that has an alignment. Candidates come from the canonical scoring record of the sport (cricket wickets, sixes and boundaries; goals; set and match wins in racket and set sports; wins and finishes in heats) plus scorer bookmarks, each citing the event and its place on the video. Sports scored as plain totals have nothing to cite and use bookmarks (said in `notes`). Optional `use_ai` lets the model re-rank, retitle and nominate extra events: every id it returns is checked against the real log and invented ones are dropped. Running it again returns the moments already cut, never duplicates.',
  input: z.object({ id, pre_s: num(0, 30).default(8), post_s: num(1, 60).default(6), max: z.coerce.number().int().min(1).max(60).default(25), use_ai: z.coerce.boolean().default(false), include_bookmarks: z.coerce.boolean().default(true) }),
  async handler({ user }, i) {
    const src = await sourceAsset(i.id);
    await manageSource(user, src);
    if (['withdrawn', 'taken_down'].includes(src.status) || src.source_blocked) throw conflict('That recording has been withdrawn');
    const al = (await pool.query('SELECT * FROM clip_alignments WHERE source_asset_id=$1 AND superseded_at IS NULL', [src.id])).rows[0];
    if (!al) throw conflict('Align the recording with the game first', { code: 'alignment_required' });
    const ev = await eventOf(src.event_id);
    const r = await generateCandidates(user, { source: src, alignment: al, fixtureId: al.fixture_id, sessionId: al.session_id, ev, pre: i.pre_s, post: i.post_s, max: i.max, useAi: i.use_ai, bookmarks: i.include_bookmarks });
    return { sport_family: r.sport_family, native_model: r.native, notes: r.notes, ai: r.ai, skipped: r.skipped, created: await Promise.all(r.created.map((x) => shapeClip(x))), existing: await Promise.all(r.existing.map((x) => shapeClip(x))) };
  },
});

cap({
  name: 'list_clip_queue', method: 'GET', path: '/events/:id/clips', tag: TAG,
  summary: 'The clip review queue of an event, most valuable first, with each clip\'s status, the event it cites, its place on the video and its live rights state. The organiser sees every clip; a media partner sees clips cut from recordings it owns. Also returns the event\'s publication policy and how many clips are in each status.',
  input: z.object({ id, status: z.enum(STATUSES).optional(), fixture_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const ev = await eventOf(i.id);
    const organiser = await isOrganiserOf(user, ev);
    const rows = (await pool.query(
      `SELECT * FROM clip_candidates WHERE event_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::uuid IS NULL OR fixture_id=$3) ORDER BY (status IN ('review','candidate')) DESC, priority DESC, created_at LIMIT 500`, [i.id, i.status ?? null, i.fixture_id ?? null])).rows;
    const mine = [];
    for (const r of rows) {
      if (!organiser) { const v = await viewerOf(user, await sourceAsset(r.source_asset_id)); if (!v.owner) continue; }
      mine.push(r);
    }
    if (!organiser && !mine.length && !(await pool.query('SELECT 1 FROM mr_assets WHERE event_id=$1 AND (creator_id=$2 OR owner_partner_id IS NOT NULL)', [i.id, user.id])).rowCount) throw notFound('Event');
    const counts = {};
    for (const r of mine) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const policy = (await pool.query('SELECT mode, audience, set_by, updated_at FROM clip_policies WHERE event_id=$1', [i.id])).rows[0] ?? { mode: 'manual', audience: 'public' };
    const items = [];
    for (const r of mine.slice(i.offset, i.offset + i.limit)) items.push(await shapeClip(r));
    return { total: mine.length, counts, policy, can: { manage: organiser }, items };
  },
});

cap({
  name: 'get_clip', method: 'GET', path: '/clips/:id', tag: TAG,
  summary: 'One clip for the people who manage it: the cited event, the window on the recording, caption facts kept apart from the prose (and whether the prose was machine-drafted), the people in it with live consent status, and its rights state.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { cand } = await loadClip(user, i.id);
    const out = await shapeClip(cand);
    out.participants = await Promise.all(out.participants.map(async (p) => ({ ...p, youth: await isYouth(p.user_id) })));
    return out;
  },
});

cap({
  name: 'update_clip', method: 'POST', path: '/clips/:id', tag: TAG,
  summary: 'Edit a clip: trim its in/out points, change the title or caption, and tag who is in it. Tagged people become subjects of the clip\'s asset, so guardian media consent applies. Editing the prose makes it human-owned. Changing the window of a clip already cut sends it back to review. A published clip must be withdrawn before it is edited.',
  input: z.object({ id, row_version: ver, title: text(140).min(2).optional(), caption_prose: text(500).nullish(), media_start_s: num(0, 86400).optional(), media_end_s: num(0.5, 86400).optional(), participants: z.array(id).max(30).optional() }),
  handler: async ({ user }, i) => shapeClip(await tx(async (c) => {
    await c.query('SELECT id FROM clip_candidates WHERE id=$1 FOR UPDATE', [i.id]);
    const { cand, src } = await loadClip(user, i.id, c);
    stale(cand, i.row_version);
    if (['published', 'processing'].includes(cand.status)) throw conflict(cand.status === 'published' ? 'Withdraw the clip before editing it' : 'The clip is being cut; try again in a moment');
    const start = i.media_start_s ?? Number(cand.media_start_s), end = i.media_end_s ?? Number(cand.media_end_s);
    if (end <= start) throw badRequest('The clip must end after it starts');
    if (end - start > 180) throw badRequest('A highlight clip is at most 3 minutes');
    const trimmed = start !== Number(cand.media_start_s) || end !== Number(cand.media_end_s);
    let status = cand.status;
    if (cand.asset_id && trimmed) {
      const url = `${src.external_url.split('#')[0]}#t=${start},${end}`;
      await c.query("UPDATE mr_assets SET external_url=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 AND status='draft'", [cand.asset_id, url]);
      status = 'review';
    }
    const prose = i.caption_prose === undefined ? cand.caption_prose : i.caption_prose;
    const row = (await c.query(
      `UPDATE clip_candidates SET title=$2, caption_prose=$3, prose_by_ai=CASE WHEN $4 THEN false ELSE prose_by_ai END, media_start_s=$5, media_end_s=$6, status=$7, reviewed_by=CASE WHEN $7<>status THEN NULL ELSE reviewed_by END,
              updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *`, [cand.id, i.title ?? cand.title, prose, i.caption_prose !== undefined, start, end, status])).rows[0];
    if (cand.asset_id) await c.query("UPDATE mr_assets SET title=coalesce($2,title), caption=$3, updated_at=now() WHERE id=$1 AND status='draft'", [cand.asset_id, i.title ?? null, prose ?? null]);
    if (i.participants) {
      const keep = new Set(i.participants);
      for (const uid of keep) {
        if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [uid])).rowCount) throw notFound('Person');
        await c.query("INSERT INTO clip_participants(candidate_id, user_id, origin, added_by) VALUES ($1,$2,'reviewer',$3) ON CONFLICT (candidate_id, user_id) DO UPDATE SET removed_at=NULL", [cand.id, uid, user.id]);
        if (cand.asset_id) await addSubject(c, cand.asset_id, uid, user.id);
      }
      for (const p of (await c.query('SELECT user_id FROM clip_participants WHERE candidate_id=$1 AND removed_at IS NULL', [cand.id])).rows.filter((p) => !keep.has(p.user_id)) ) {
        await c.query('UPDATE clip_participants SET removed_at=now() WHERE candidate_id=$1 AND user_id=$2', [cand.id, p.user_id]);
        if (cand.asset_id) await c.query('UPDATE mr_asset_subjects SET removed_at=now() WHERE asset_id=$1 AND user_id=$2 AND removed_at IS NULL', [cand.asset_id, p.user_id]);
      }
    }
    return row;
  })),
});

cap({
  name: 'process_clip', method: 'POST', path: '/clips/:id/process', tag: TAG,
  summary: 'Cut a candidate into a draft clip. The cut runs as a retry-safe background job and is counted once as a highlight credit (a plan limit stops it with 402). A repeat request is harmless and never makes a second clip. The result lands in review.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await loadClip(user, i.id);
    return shapeClip(await requestProcessing(user, i.id));
  },
});

cap({
  name: 'review_clip', method: 'POST', path: '/clips/:id/review', tag: TAG,
  summary: 'The human review step: approve a clip in review, or reject a clip. Approval is required before publication unless the event has switched on trusted automation.',
  input: z.object({ id, decision: z.enum(['approve', 'reject']), note: text(300).optional(), row_version: ver }),
  async handler({ user }, i) {
    const { cand } = await loadClip(user, i.id);
    stale(cand, i.row_version);
    return shapeClip(await reviewCandidate(user, i.id, i));
  },
});

cap({
  name: 'publish_clip', method: 'POST', path: '/clips/:id/publish', tag: TAG,
  summary: 'Publish an approved clip to `public` or `licensed` audiences. This is the ordinary media-asset publish: current guardian media consent for every young person in it, a live source, the rights window and the owner are all checked, and a block is recorded. A clip a person has not approved cannot be published.',
  input: z.object({ id, audience: z.enum(['licensed', 'public']).default('public') }),
  async handler({ user }, i) {
    await loadClip(user, i.id);
    return shapeClip(await publishCandidate(user, i.id, { audience: i.audience }));
  },
});

cap({
  name: 'withdraw_clip', method: 'POST', path: '/clips/:id/withdraw', tag: TAG,
  summary: 'Withdraw a published clip. Future views and downloads are refused at once; the record and its audit trail are kept. (A takedown by the organiser, an expired right or lapsed consent also hide the clip, without this step.)',
  input: z.object({ id, reason: text(500).min(2) }),
  async handler({ user }, i) {
    await loadClip(user, i.id);
    return shapeClip(await withdrawCandidate(user, i.id, i.reason));
  },
});

// ---------------------------------------------------------------- AI captions
const capSchema = z.object({ title: z.string().min(2).max(120), prose: z.string().min(2).max(400) });
cap({
  name: 'draft_clip_caption', method: 'POST', path: '/clips/:id/caption-draft', tag: TAG,
  summary: 'Draft a title and caption for a clip. The facts come only from the canonical scoring record and are kept apart from the prose; the prose is marked machine-drafted until a person edits it, and is never published without review. Without AI configured a plain factual line is written instead. Counts as one highlight credit.',
  input: z.object({ id, row_version: ver }),
  handler: async ({ user }, i) => {
    const { cand, ev } = await loadClip(user, i.id);
    stale(cand, i.row_version);
    if (['published', 'processing'].includes(cand.status)) throw conflict('Withdraw the clip before redrafting it');
    const f = cand.caption_facts ?? {};
    const facts = { sport: f.sport, moment: f.label, team: f.team, period: f.period, minute: f.minute, fixture: f.fixture, runs: f.runs, how_out: f.how_out, points: f.points, position: f.position };
    const plain = [f.label, f.team ? `for ${f.team}` : null, f.minute ? `at ${f.minute}` : null, f.fixture ? `· ${f.fixture}` : null].filter(Boolean).join(' ');
    let title = cand.title, prose = plain, byAi = false, usage = null;
    if (aiConfigured()) {
      const r = await askJsonDetailed({
        system: `You write short sports highlight captions. ${AI_RULES} Use only the facts in the data: never add scores, names, records or events that are not there. At most 40 words.`,
        user: `<data>${quoteData(JSON.stringify(facts), 2000)}</data>`, shape: '{"title":string,"prose":string}', schema: capSchema, maxTokens: 400,
      });
      if (r) { title = quoteData(r.data.title, 120); prose = quoteData(r.data.prose, 400); byAi = true; usage = r.usage; }
    }
    const row = await tx(async (c) => {
      await recordUsage(c, { eventId: cand.event_id, candidateId: cand.id, kind: 'ai_caption', usage, credits: byAi ? 1 : 0, key: `clip-caption:${cand.id}:${cand.row_version}`, actorId: user.id });
      const row = (await c.query('UPDATE clip_candidates SET title=coalesce($2,title), caption_prose=$3, prose_by_ai=$4, updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *', [cand.id, title, prose, byAi])).rows[0];
      if (cand.asset_id) await c.query("UPDATE mr_assets SET title=coalesce($2,title), caption=$3, updated_at=now() WHERE id=$1 AND status='draft'", [cand.asset_id, title, prose]);
      if (byAi) await audit(c, user.id, 'ai_clip_caption', 'clip_candidates', cand.id);
      return row;
    });
    return { ...(await shapeClip(row)), ai: byAi };
  },
});

// ---------------------------------------------------------------- policy and usage
cap({
  name: 'set_clip_policy', method: 'POST', path: '/events/:id/clip-policy', tag: TAG,
  summary: 'Organiser only. mode manual (default): a person reviews, approves and publishes every clip. mode trusted_auto: clips cut from real scoring events (never AI-nominated ones) are approved and published automatically in your name, still through every rights and consent check; anything that fails stays unpublished with the reason on the clip.',
  input: z.object({ id, mode: z.enum(['manual', 'trusted_auto']), audience: z.enum(['licensed', 'public']).default('public') }),
  async handler({ user }, i) {
    const ev = await eventOf(i.id);
    if (!(await isOrganiserOf(user, ev))) throw forbidden('Only the organiser can set the clip policy');
    return one(`INSERT INTO clip_policies(event_id, mode, audience, set_by) VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO UPDATE SET mode=$2, audience=$3, set_by=$4, updated_at=now() RETURNING *`, [i.id, i.mode, i.audience, user.id]);
  },
});

cap({
  name: 'get_clip_usage', method: 'GET', path: '/events/:id/clip-usage', tag: TAG,
  summary: 'What the highlight pipeline used for an event: processing seconds, storage, AI tokens and highlight credits, per step, and whether the commercial meter `highlight_credits` counts them (#504).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await eventOf(i.id);
    if (!(await isOrganiserOf(user, ev))) throw forbidden('Only the organiser can see usage');
    return { event_id: i.id, ...(await usageOf(pool, i.id)) };
  },
});

// ---------------------------------------------------------------- player passport links
cap({
  name: 'propose_clip_player_link', method: 'POST', path: '/clips/:id/player-links', tag: TAG, status: 201,
  summary: 'Offer a clip for a player\'s passport. The player must be tagged in the clip, and the clip must be cut and not rejected. The link points at the governed clip (never a copy) and only shows on the passport once the player accepts and while the clip is live and publicly released.',
  input: z.object({ id, user_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const { cand, ev } = await loadClip(user, i.id, c);
    if (!cand.asset_id || ['rejected', 'failed', 'candidate', 'processing', 'withdrawn'].includes(cand.status)) throw conflict('Only a clip that has been cut and is in review, approved or published can go on a passport');
    if (!(await c.query('SELECT 1 FROM clip_participants WHERE candidate_id=$1 AND user_id=$2 AND removed_at IS NULL', [cand.id, i.user_id])).rowCount) throw badRequest('That person is not tagged in this clip');
    const dup = (await c.query("SELECT * FROM clip_player_links WHERE asset_id=$1 AND user_id=$2 AND status IN ('proposed','accepted')", [cand.asset_id, i.user_id])).rows[0];
    if (dup) return dup;
    const row = (await c.query('INSERT INTO clip_player_links(asset_id, candidate_id, user_id, sport_id, proposed_by) VALUES ($1,$2,$3,(SELECT sport_id FROM events WHERE id=$4),$5) RETURNING *', [cand.asset_id, cand.id, i.user_id, ev.id, user.id])).rows[0];
    await notify(c, i.user_id, { kind: 'clip_player_link', title: 'A clip for your passport', body: `${cand.title ?? 'A clip'} · ${ev.name}`, data: { link_id: row.id, clip_id: cand.id }, dedupe_key: `clip-link:${row.id}` });
    return row;
  }),
});

cap({
  name: 'respond_clip_player_link', method: 'POST', path: '/clip-player-links/:id', tag: TAG,
  summary: 'The player (or, for a young player, their own account with current guardian media consent) accepts or declines a clip for their passport, or later withdraws it. The organiser can also withdraw a link. Withdrawal hides the clip from the passport at once; nothing is deleted.',
  input: z.object({ id, action: z.enum(['accept', 'decline', 'withdraw']) }),
  handler: ({ user }, i) => tx(async (c) => {
    const l = (await c.query('SELECT * FROM clip_player_links WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!l) throw notFound('Clip link');
    const isPlayer = l.user_id === user.id;
    let organiser = false;
    if (!isPlayer) { const a = (await c.query('SELECT event_id FROM mr_assets WHERE id=$1', [l.asset_id])).rows[0]; organiser = await isOrganiserOf(user, await eventOf(a.event_id, c), c); if (!organiser) throw notFound('Clip link'); }
    if (organiser && i.action !== 'withdraw') throw forbidden('Only the player can accept or decline');
    if (i.action === 'accept') {
      if (l.status !== 'proposed') throw conflict('This link is not waiting for an answer');
      await requireConsent(l.user_id, 'media', 'a clip on the passport', c);
    }
    if (i.action === 'decline' && l.status !== 'proposed') throw conflict('This link is not waiting for an answer');
    if (i.action === 'withdraw' && !['proposed', 'accepted'].includes(l.status)) throw conflict('This link is already closed');
    const to = { accept: 'accepted', decline: 'declined', withdraw: 'withdrawn' }[i.action];
    return (await c.query('UPDATE clip_player_links SET status=$2, decided_by=$3, decided_at=now(), updated_at=now() WHERE id=$1 RETURNING *', [l.id, to, user.id])).rows[0];
  }),
});

cap({
  name: 'get_person_clips', method: 'GET', path: '/people/:id/clips', tag: TAG, auth: 'public',
  summary: 'A player\'s approved-clips gallery. Everyone sees accepted clips that are live, publicly released and covered by their rights window, re-checked now (a takedown, expiry or lapsed youth consent removes a clip from the gallery at once). The player sees every link addressed to them, including those waiting for an answer, with why one is hidden.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const own = user?.id === i.id;
    const rows = (await pool.query(
      `SELECT l.*, cc.title, cc.moment_kind, cc.caption_facts, cc.caption_prose, cc.prose_by_ai, cc.id AS clip_id, cc.status AS clip_status, e.name AS event_name
         FROM clip_player_links l JOIN clip_candidates cc ON cc.id=l.candidate_id JOIN events e ON e.id=cc.event_id
        WHERE l.user_id=$1 AND ($2 OR l.status='accepted') AND l.status <> 'declined' ORDER BY l.created_at DESC LIMIT 100`, [i.id, own])).rows;
    const items = [];
    for (const r of rows) {
      const a = (await pool.query(`SELECT ${ASSET_COLS} FROM mr_assets a WHERE a.id=$1`, [r.asset_id])).rows[0];
      const state = await assetState(a, pool);
      if (!own) {
        const clip = r.status === 'accepted' && r.clip_status === 'published' ? await publicClip(r.clip_id) : null;
        if (clip) items.push({ link_id: r.id, status: r.status, clip });
      } else items.push({ link_id: r.id, status: r.status, clip_id: r.clip_id, title: r.title, moment_kind: r.moment_kind, event: r.event_name, state, caption: { facts: r.caption_facts, prose: r.caption_prose, prose_by_ai: r.prose_by_ai }, link: state === 'live' ? a.external_url : null });
    }
    return { total: items.length, items: items.slice(i.offset, i.offset + i.limit) };
  },
});

// ---------------------------------------------------------------- reels
const reelItem = z.object({ kind: z.enum(['clip', 'intro', 'outro', 'scorecard', 'sponsor_bumper']), candidate_id: id.optional(), inventory_booking_id: id.optional(), label: text(120).optional() })
  .refine((x) => (x.kind === 'clip') === !!x.candidate_id, 'A clip item names the clip; other items do not')
  .refine((x) => (x.kind === 'sponsor_bumper') === !!x.inventory_booking_id, 'A sponsor bumper names the sponsor booking that pays for it');

async function putReelItems(c, reel, items) {
  const seen = new Set();
  let bumpers = 0;
  for (const it of items) {
    if (it.kind === 'clip') {
      if (seen.has(it.candidate_id)) throw badRequest('A clip can appear once in a reel');
      seen.add(it.candidate_id);
      const cc = (await c.query('SELECT status, event_id, fixture_id, team_id FROM (SELECT cc.status, cc.event_id, cc.fixture_id, NULL::uuid AS team_id FROM clip_candidates cc WHERE cc.id=$1) x', [it.candidate_id])).rows[0];
      if (!cc || cc.event_id !== reel.event_id) throw badRequest('Choose clips of this event');
      if (!['approved', 'published'].includes(cc.status)) throw badRequest('Only approved or published clips can go in a reel');
      if (reel.fixture_id && cc.fixture_id !== reel.fixture_id) throw badRequest('A match reel only holds clips of that game');
    }
    if (it.kind === 'sponsor_bumper') {
      bumpers++;
      const ok = await bumperBookingOk(c, reel.event_id, it.inventory_booking_id);
      if (!ok.ok) throw conflict(ok.reason, { code: 'sponsor_inventory_required' });
    }
  }
  await c.query('UPDATE clip_reel_items SET removed_at=now() WHERE reel_id=$1 AND removed_at IS NULL', [reel.id]);
  let pos = 0;
  for (const it of items) await c.query('INSERT INTO clip_reel_items(reel_id, position, kind, candidate_id, inventory_booking_id, label) VALUES ($1,$2,$3,$4,$5,$6)', [reel.id, pos++, it.kind, it.candidate_id ?? null, it.inventory_booking_id ?? null, it.label ?? null]);
  return bumpers;
}
const reelOf = async (user, rid, c = pool) => {
  const r = (await c.query('SELECT * FROM clip_reels WHERE id=$1', [rid])).rows[0];
  if (!r) throw notFound('Reel');
  const ev = await eventOf(r.event_id, c);
  if (!(await isOrganiserOf(user, ev, c))) throw notFound('Reel');
  return r;
};
const shapeReel = async (r, c = pool) => ({
  ...r, items: (await c.query(
    `SELECT i.position, i.kind, i.candidate_id, i.inventory_booking_id, i.label, cc.title AS clip_title, cc.status AS clip_status FROM clip_reel_items i LEFT JOIN clip_candidates cc ON cc.id=i.candidate_id WHERE i.reel_id=$1 AND i.removed_at IS NULL ORDER BY i.position`, [r.id])).rows,
});

cap({
  name: 'create_reel', method: 'POST', path: '/events/:id/reels', tag: TAG, status: 201,
  summary: 'Organiser only. Start a recap reel for a game (match), the whole event, or a team. Items are approved clips in your order, plus intro, outro and scorecard cards and sponsor bumpers; a bumper is only accepted when it names an actual, confirmed sponsor inventory booking of the event (overlay, replay or scorecard placement) that is running today.',
  input: z.object({ id, kind: z.enum(['match', 'event', 'team']), fixture_id: id.optional(), team_id: id.optional(), title: text(140).min(2), items: z.array(reelItem).max(60).default([]) })
    .refine((i) => (i.kind === 'match') === !!i.fixture_id && (i.kind === 'team') === !!i.team_id, 'A match reel names the game, a team reel names the team'),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await eventOf(i.id, c);
    if (!(await isOrganiserOf(user, ev, c))) throw forbidden('Only the organiser can build a reel');
    if (i.fixture_id && !(await c.query('SELECT 1 FROM fixtures WHERE id=$1 AND event_id=$2', [i.fixture_id, i.id])).rowCount) throw badRequest('Choose a game of this event');
    if (i.team_id && !(await c.query('SELECT 1 FROM teams WHERE id=$1', [i.team_id])).rowCount) throw notFound('Team');
    const r = (await c.query('INSERT INTO clip_reels(event_id, fixture_id, team_id, kind, title, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [i.id, i.fixture_id ?? null, i.team_id ?? null, i.kind, i.title, user.id])).rows[0];
    await putReelItems(c, r, i.items);
    return shapeReel(r, c);
  }),
});

cap({
  name: 'update_reel', method: 'POST', path: '/reels/:id', tag: TAG,
  summary: 'Reorder or replace a draft reel\'s items, or retitle it. The same checks as when it was built apply (approved clips only; sponsor bumpers need a real booking).',
  input: z.object({ id, row_version: ver, title: text(140).min(2).optional(), items: z.array(reelItem).max(60).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await c.query('SELECT id FROM clip_reels WHERE id=$1 FOR UPDATE', [i.id]);
    const r = await reelOf(user, i.id, c);
    if (r.row_version !== i.row_version) throw conflict('Someone changed this reel; reload it', { code: 'stale_version' });
    if (r.status === 'published') throw conflict('Withdraw the reel before changing it');
    if (i.items) await putReelItems(c, r, i.items);
    const row = (await c.query('UPDATE clip_reels SET title=coalesce($2,title), updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *', [r.id, i.title ?? null])).rows[0];
    return shapeReel(row, c);
  }),
});

cap({
  name: 'set_reel_status', method: 'POST', path: '/reels/:id/status', tag: TAG,
  summary: 'Publish or withdraw a reel. Publishing needs at least one clip, every clip in it already published, and every sponsor bumper still backed by a confirmed booking. After that each item is re-checked on every view, so a withdrawn clip or a released sponsor drops out of the public reel at once.',
  input: z.object({ id, action: z.enum(['publish', 'withdraw']), row_version: ver }),
  handler: ({ user }, i) => tx(async (c) => {
    await c.query('SELECT id FROM clip_reels WHERE id=$1 FOR UPDATE', [i.id]);
    const r = await reelOf(user, i.id, c);
    if (r.row_version !== i.row_version) throw conflict('Someone changed this reel; reload it', { code: 'stale_version' });
    if (i.action === 'publish') {
      if (r.status === 'published') throw conflict('Already published');
      const items = (await c.query("SELECT i.*, cc.status AS clip_status FROM clip_reel_items i LEFT JOIN clip_candidates cc ON cc.id=i.candidate_id WHERE i.reel_id=$1 AND i.removed_at IS NULL", [r.id])).rows;
      if (!items.some((x) => x.kind === 'clip')) throw badRequest('Add at least one clip');
      for (const x of items) {
        if (x.kind === 'clip' && x.clip_status !== 'published') throw conflict('Publish every clip in the reel first', { code: 'clip_not_published' });
        if (x.kind === 'sponsor_bumper') { const ok = await bumperBookingOk(c, r.event_id, x.inventory_booking_id); if (!ok.ok) throw conflict(ok.reason, { code: 'sponsor_inventory_required' }); }
      }
    } else if (r.status !== 'published') throw conflict('Only a published reel can be withdrawn');
    const row = (await c.query('UPDATE clip_reels SET status=$2, updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *', [r.id, i.action === 'publish' ? 'published' : 'withdrawn'])).rows[0];
    return shapeReel(row, c);
  }),
});

cap({
  name: 'list_reels', method: 'GET', path: '/events/:id/reels', tag: TAG,
  summary: 'The reels of an event with their items (organiser only).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await eventOf(i.id);
    if (!(await isOrganiserOf(user, ev))) throw notFound('Event');
    const rows = (await pool.query('SELECT * FROM clip_reels WHERE event_id=$1 ORDER BY created_at DESC LIMIT 100', [i.id])).rows;
    return { total: rows.length, items: await Promise.all(rows.map((r) => shapeReel(r))) };
  },
});

// ---------------------------------------------------------------- public playback (rights re-checked on every request)
const country = z.string().regex(/^[A-Z]{2}$/).optional();
cap({
  name: 'get_public_clip', method: 'GET', path: '/public/clips/:id', tag: TAG, auth: 'public',
  summary: 'Play a published clip. The rights window, territory, takedown, the source recording, visibility and every tagged young person\'s CURRENT guardian media consent are re-checked on every request and recorded; anything that fails is a plain 404. Share this link only after publication.',
  input: z.object({ id, country, platform: z.enum(PLATFORMS).optional() }),
  async handler(_ctx, i) {
    const clip = await publicClip(i.id, { country: i.country ?? null, platform: i.platform ?? null });
    if (!clip) throw notFound('Clip');
    return clip;
  },
});

cap({
  name: 'list_public_event_clips', method: 'GET', path: '/public/events/:id/clips', tag: TAG, auth: 'public',
  summary: 'The published clips and reels of an event, each re-checked now; what is withdrawn, expired, taken down or lacks consent is simply absent.',
  input: z.object({ id, fixture_id: id.optional(), ...page }),
  async handler(_ctx, i) {
    const ev = await eventOf(i.id);
    if (ev.status === 'draft') throw notFound('Event');
    const rows = (await pool.query("SELECT id FROM clip_candidates WHERE event_id=$1 AND status='published' AND ($2::uuid IS NULL OR fixture_id=$2) ORDER BY priority DESC, updated_at DESC LIMIT 200", [i.id, i.fixture_id ?? null])).rows;
    const clips = [];
    for (const r of rows) { const c = await publicClip(r.id); if (c) clips.push(c); }
    const reels = [];
    for (const r of (await pool.query("SELECT id FROM clip_reels WHERE event_id=$1 AND status='published' ORDER BY updated_at DESC LIMIT 20", [i.id])).rows) { const x = await publicReel(r.id); if (x) reels.push(x); }
    return { total: clips.length, items: clips.slice(i.offset, i.offset + i.limit), reels };
  },
});

cap({
  name: 'get_public_reel', method: 'GET', path: '/public/reels/:id', tag: TAG, auth: 'public',
  summary: 'Play a published reel: its clips in order with intro, outro, scorecard and sponsor bumper cards. Each clip and each sponsor booking is re-checked on every request; items that fail are left out and counted in `hidden`.',
  input: z.object({ id, country }),
  async handler(_ctx, i) {
    const r = await publicReel(i.id, { country: i.country ?? null });
    if (!r) throw notFound('Reel');
    return r;
  },
});

