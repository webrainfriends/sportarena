// Player recruitment pipeline (issue #314). Extends the Billboard application (billboard_responses, issue #67) with a staged flow:
// applied -> shortlisted -> trial -> evaluated -> offered -> accepted / declined, plus withdrawn. Offers are versioned with a deadline,
// every move is an immutable event, evidence links and evaluation notes are encrypted and audit-logged on read, and a young
// applicant is only visible to staff while a verified guardian's consent is current (checked live on every call).
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, pool, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit, mustFind } from '../helpers.js';
import { toCsv } from '../csv.js';
import { YOUTH_SQL } from '../youth.js';
import {
  CONSENT_PURPOSE, OPEN_STAGES, STAFF_MOVES, STAGES, acceptIntoTeam, applicantRole, badStage, consentOk, fillIfFull, isStaff, lockResponse,
  logEvent, notifyApplicant, replayed, setStage, stale, sweepExpired,
} from '../recruitment.js';
import { notify } from '../notify.js';

const TAG = 'Recruitment';
const key = z.string().min(8).max(80).describe('unique per attempt; a retry with the same key returns the first result');
const version = z.coerce.number().int().min(1).describe('row_version you last saw; a stale value is rejected with code stale_version');
const rateUnit = z.enum(['match', 'hour', 'month', 'season']);
const OFFER_KINDS = ['match_players', 'team_recruiting', 'coach_wanted'];
const VIEW = 'id, post_id, responder_id, status, stage, row_version, stage_changed_at, trial_at, trial_venue_id, trial_note, created_at';

const view = async (c, rid) => (await c.query(`SELECT ${VIEW} FROM billboard_responses WHERE id=$1`, [rid])).rows[0];

/** Run a staff mutation: staff check, replay of a retried key, stale-version check, open stage, live consent for young applicants. */
async function staffMutation(user, i, fn) {
  await tx((c) => sweepExpired(c, i.id));
  return tx(async (c) => {
    const first = (await c.query('SELECT * FROM billboard_responses WHERE id=$1', [i.id])).rows[0];
    if (!first) throw notFound('Application');
    const post = (await c.query('SELECT * FROM billboard_posts WHERE id=$1', [first.post_id])).rows[0];
    if (!(await isStaff(user, post))) throw forbidden();
    const resp = await lockResponse(c, i.id, null);
    if (await replayed(c, resp.id, i.idempotency_key)) return { ...(await view(c, resp.id)), replayed: true };
    if (resp.row_version !== i.row_version) throw stale(resp);
    if (!OPEN_STAGES.includes(resp.stage)) throw conflict(`This application is already ${resp.stage}`, { code: 'closed_application', stage: resp.stage });
    if (!(await consentOk(resp.responder_id, c))) throw conflict('A verified guardian has not given current consent for recruitment.', { code: 'guardian_consent_required', purpose: CONSENT_PURPOSE });
    return fn(c, resp, post);
  });
}

/** Run an applicant-side mutation (the applicant or a verified guardian). */
async function applicantMutation(user, i, { decide, pre }, fn) {
  await tx((c) => sweepExpired(c, i.id));
  return tx(async (c) => {
    const resp = await lockResponse(c, i.id, null);
    if (!resp) throw notFound('Application');
    const role = await applicantRole(user, resp, { decide: decide?.(i) ?? false }, c);
    if (await replayed(c, resp.id, i.idempotency_key)) return { ...(await view(c, resp.id)), replayed: true };
    await pre?.(c, resp);
    if (resp.row_version !== i.row_version) throw stale(resp);
    const post = (await c.query('SELECT * FROM billboard_posts WHERE id=$1 FOR UPDATE', [resp.post_id])).rows[0];
    return fn(c, resp, post, role);
  });
}

const closeOpenOffer = (c, rid, status, by) => c.query("UPDATE recruitment_offers SET status=$2, decided_by=$3, decided_at=now() WHERE response_id=$1 AND status='open'", [rid, status, by]);

/** Staff list rows: a young applicant without current guardian consent is shown as hidden (no identity, no message, no evidence). */
async function maskRows(rows) {
  return Promise.all(rows.map(async (r) => (r.is_youth && !(await consentOk(r.user_id))
    ? { response_id: r.response_id, stage: r.stage, row_version: r.row_version, created_at: r.created_at, stage_changed_at: r.stage_changed_at, hidden: true, is_youth: true, reason: 'guardian_consent_required' }
    : { ...r, hidden: false })));
}

const CANDIDATE = `SELECT r.id AS response_id, r.stage, r.row_version, r.created_at, r.stage_changed_at, r.trial_at, r.message, (r.source_ref_enc IS NOT NULL) AS has_source, r.source_kind,
    ${YOUTH_SQL} AS is_youth, u.id AS user_id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color, u.avatar_url,
    o.version AS offer_version, o.status AS offer_status, o.deadline_at AS offer_deadline_at,
    (SELECT e.rating FROM recruitment_evaluations e WHERE e.response_id=r.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS rating
  FROM billboard_responses r JOIN users u ON u.id=r.responder_id
  LEFT JOIN LATERAL (SELECT version, status, deadline_at FROM recruitment_offers x WHERE x.response_id=r.id ORDER BY x.version DESC LIMIT 1) o ON true`;

async function staffPost(user, postId) {
  const p = await mustFind('billboard_posts', postId);
  if (!(await isStaff(user, p))) throw forbidden();
  return p;
}

cap({
  name: 'get_recruitment_pipeline', method: 'GET', path: '/billboard/:id/pipeline', tag: TAG,
  summary: 'The recruitment pipeline of a post you run (author, team managers, admins): counts per stage and the candidates, oldest application first. Optionally filter by stage. A young applicant without a guardian\'s current consent is listed as hidden.',
  input: z.object({ id, stage: z.enum(STAGES).optional(), ...page }),
  async handler({ user }, i) {
    const post = await staffPost(user, i.id);
    await tx((c) => sweepExpired(c));
    const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
    for (const r of await many('SELECT stage, count(*)::int AS n FROM billboard_responses WHERE post_id=$1 GROUP BY stage', [i.id])) counts[r.stage] = r.n;
    const rows = await many(`${CANDIDATE} WHERE r.post_id=$1 AND ($2::text IS NULL OR r.stage=$2) ORDER BY r.created_at, r.id LIMIT $3 OFFSET $4`, [i.id, i.stage ?? null, i.limit, i.offset]);
    return { post: { id: post.id, title: post.title, kind: post.kind, status: post.status, positions_needed: post.positions_needed }, counts, candidates: await maskRows(rows) };
  },
});

cap({
  name: 'get_recruitment_application', method: 'GET', path: '/billboard/responses/:id/application', tag: TAG,
  summary: 'One application with its full history: stage events, every offer version, and (staff only) evaluations and the applicant\'s evidence link. Readable by the applicant, a verified guardian, or the post\'s staff. Decrypting notes or the evidence link is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await tx((c) => sweepExpired(c, i.id));
    const r = await one('SELECT * FROM billboard_responses WHERE id=$1', [i.id]);
    if (!r) throw notFound('Application');
    const post = await mustFind('billboard_posts', r.post_id);
    const staff = await isStaff(user, post);
    if (staff) {
      if (!(await consentOk(r.responder_id))) throw conflict('A verified guardian has not given current consent for recruitment.', { code: 'guardian_consent_required', purpose: CONSENT_PURPOSE });
    } else {
      await applicantRole(user, r); // 403 for everyone else
    }
    const applicant = await one('SELECT id, handle, display_name, avatar_emoji, avatar_color FROM users WHERE id=$1', [r.responder_id]);
    const events = await many(`SELECT kind, from_stage, to_stage, actor_id, ${staff ? 'note,' : ''} created_at FROM recruitment_events WHERE response_id=$1 ORDER BY created_at, id`, [i.id]);
    const offers = await many('SELECT version, role, rate_cents, rate_unit, starts_on, note, deadline_at, status, created_at, decided_at FROM recruitment_offers WHERE response_id=$1 ORDER BY version', [i.id]);
    const out = { application: await view(pool, i.id), post: { id: post.id, title: post.title, kind: post.kind, status: post.status, team_id: post.team_id }, applicant, viewer: staff ? 'staff' : 'applicant', events, offers };
    if (staff) {
      const evals = await many('SELECT id, rating, notes_enc, trial_at, author_id, created_at FROM recruitment_evaluations WHERE response_id=$1 ORDER BY created_at, id', [i.id]);
      if (evals.some((e) => e.notes_enc)) await audit(null, user.id, 'read_recruitment_evaluation', 'billboard_responses', i.id);
      out.evaluations = evals.map(({ notes_enc, ...e }) => ({ ...e, notes: notes_enc ? decrypt(notes_enc, 'recruitment_evaluations.notes') : null }));
      out.message = r.message;
      if (r.source_ref_enc) {
        await audit(null, user.id, 'read_recruitment_source', 'billboard_responses', i.id);
        out.source = { kind: r.source_kind, url: decrypt(r.source_ref_enc, 'billboard_responses.source_ref') };
      }
    } else {
      out.has_source = !!r.source_ref_enc;
    }
    return out;
  },
});

cap({
  name: 'move_recruitment_stage', method: 'POST', path: '/billboard/responses/:id/stage', tag: TAG,
  summary: 'Shortlist or decline an application (staff). Trials, evaluations and offers have their own capabilities. Needs the row_version you saw and an idempotency_key.',
  input: z.object({ id, to: z.enum(['shortlisted', 'declined']), row_version: version, idempotency_key: key, note: z.string().max(500).optional() }),
  handler: ({ user }, i) => staffMutation(user, i, async (c, resp, post) => {
    if (!STAFF_MOVES[resp.stage]?.includes(i.to)) throw badStage(resp.stage, i.to);
    if (i.to === 'declined') await closeOpenOffer(c, resp.id, 'withdrawn', user.id);
    const row = await setStage(c, resp, i.to, { actor: user.id, note: i.note, key: i.idempotency_key });
    await notifyApplicant(c, resp, post, `recruitment_${i.to}`, i.to === 'shortlisted' ? 'You were shortlisted' : 'Application update', i.to === 'shortlisted' ? `You were shortlisted for "${post.title}".` : `Your application for "${post.title}" was not taken forward.`, `${i.to}:${row.row_version}`);
    return view(c, row.id);
  }),
});

cap({
  name: 'schedule_recruitment_trial', method: 'POST', path: '/billboard/responses/:id/trial', tag: TAG,
  summary: 'Invite a shortlisted (or evaluated) candidate to a trial, or reschedule one. Pick the venue from the platform; the time must be in the future.',
  input: z.object({ id, trial_at: z.string().datetime(), venue_id: id.optional(), note: z.string().max(200).optional(), row_version: version, idempotency_key: key }),
  handler: ({ user }, i) => staffMutation(user, i, async (c, resp, post) => {
    if (!['shortlisted', 'trial', 'evaluated'].includes(resp.stage)) throw badStage(resp.stage, 'trial');
    if (new Date(i.trial_at) <= new Date()) throw badRequest('Choose a trial time in the future');
    if (i.venue_id) await mustFind('venues', i.venue_id, 'id', c);
    const row = await setStage(c, resp, 'trial', { kind: 'trial', actor: user.id, note: i.note, key: i.idempotency_key, set: ', trial_at=$4, trial_venue_id=$5, trial_note=$6', params: [i.trial_at, i.venue_id ?? null, i.note ?? null] });
    await notifyApplicant(c, resp, post, 'recruitment_trial', 'Trial scheduled', `A trial was scheduled for your application to "${post.title}". Open the app for the details.`, `trial:${row.row_version}`);
    return view(c, row.id);
  }),
});

cap({
  name: 'record_recruitment_evaluation', method: 'POST', path: '/billboard/responses/:id/evaluation', tag: TAG, status: 201,
  summary: 'Record the evaluation after a trial (1-5 rating and private notes) and move the candidate to "evaluated". Only after the trial time has passed. Notes are encrypted; the candidate never sees them.',
  input: z.object({ id, rating: z.coerce.number().int().min(1).max(5), notes: z.string().max(1000).optional(), row_version: version, idempotency_key: key }),
  handler: ({ user }, i) => staffMutation(user, i, async (c, resp) => {
    if (resp.stage !== 'trial') throw badStage(resp.stage, 'evaluated');
    if (!resp.trial_at || new Date(resp.trial_at) > new Date()) throw conflict('The trial has not happened yet', { code: 'trial_not_held' });
    await c.query('INSERT INTO recruitment_evaluations(response_id, rating, notes_enc, trial_at, author_id) VALUES ($1,$2,$3,$4,$5)',
      [resp.id, i.rating, i.notes ? encrypt(i.notes, 'recruitment_evaluations.notes') : null, resp.trial_at, user.id]);
    const row = await setStage(c, resp, 'evaluated', { kind: 'evaluation', actor: user.id, key: i.idempotency_key });
    return view(c, row.id);
  }),
});

cap({
  name: 'send_recruitment_offer', method: 'POST', path: '/billboard/responses/:id/offers', tag: TAG, status: 201,
  summary: 'Send an offer (version 1), or a revised offer that supersedes the open one (version n+1). A deadline is required and must be in the future. Allowed once shortlisted or evaluated.',
  input: z.object({ id, role: z.enum(['player', 'coach']).optional(), rate_cents: money.optional(), rate_unit: rateUnit.optional(), starts_on: z.string().date().optional(), deadline_at: z.string().datetime(), note: z.string().max(500).optional(), row_version: version, idempotency_key: key }),
  handler: ({ user }, i) => staffMutation(user, i, async (c, resp, post) => {
    if (!['shortlisted', 'evaluated', 'offered'].includes(resp.stage)) throw badStage(resp.stage, 'offered');
    if (!OFFER_KINDS.includes(post.kind)) throw conflict('Offers are for player and coach posts');
    if (post.status !== 'open') throw conflict('This post is no longer open');
    if (new Date(i.deadline_at) <= new Date()) throw badRequest('The offer deadline must be in the future');
    const role = post.kind === 'coach_wanted' ? 'coach' : (i.role ?? 'player');
    if (post.kind === 'coach_wanted' ? role !== 'coach' : role !== 'player') throw badRequest(`This post is for a ${post.kind === 'coach_wanted' ? 'coach' : 'player'}`);
    if (i.rate_cents != null && !i.rate_unit) throw badRequest('Say what the rate is per (match, hour, month or season)');
    const v = ((await c.query('SELECT coalesce(max(version),0)::int AS v FROM recruitment_offers WHERE response_id=$1', [resp.id])).rows[0].v) + 1;
    await c.query("UPDATE recruitment_offers SET status='superseded', decided_at=now() WHERE response_id=$1 AND status='open'", [resp.id]);
    await c.query('INSERT INTO recruitment_offers(response_id, version, role, rate_cents, rate_unit, starts_on, note, deadline_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [resp.id, v, role, i.rate_cents ?? null, i.rate_cents != null ? i.rate_unit : null, i.starts_on ?? null, i.note ?? null, i.deadline_at, user.id]);
    const row = await setStage(c, resp, 'offered', { kind: 'offer', actor: user.id, note: `Offer v${v}`, key: i.idempotency_key });
    await notifyApplicant(c, resp, post, 'recruitment_offer', v === 1 ? 'You have an offer' : 'Your offer was updated', `There is ${v === 1 ? 'an offer' : 'a new version of your offer'} for "${post.title}". Open the app to review it before the deadline.`, `offer:${v}`);
    return { ...(await view(c, row.id)), offer_version: v };
  }),
});

cap({
  name: 'respond_recruitment_offer', method: 'POST', path: '/billboard/responses/:id/offer-response', tag: TAG,
  summary: 'Accept or decline the open offer (the applicant, or a verified guardian for a young person; a young person cannot accept alone). Accepting joins the team roster at the offered terms and fills the post when all positions are taken. A lapsed offer answers with code offer_expired.',
  input: z.object({ id, accept: z.coerce.boolean(), row_version: version, idempotency_key: key }),
  handler: ({ user }, i) => applicantMutation(user, i, {
    decide: (x) => x.accept,
    // a lapsed offer moves the application on (new row_version), so say "expired" rather than "changed elsewhere"
    pre: async (c, resp) => {
      if (resp.stage === 'offered') return;
      const last = (await c.query('SELECT status FROM recruitment_offers WHERE response_id=$1 ORDER BY version DESC LIMIT 1', [resp.id])).rows[0];
      if (last?.status === 'expired') throw conflict('This offer has expired. Ask the team to send a new one.', { code: 'offer_expired' });
    },
  }, async (c, resp, post) => {
    if (resp.stage !== 'offered') {
      const last = (await c.query('SELECT status FROM recruitment_offers WHERE response_id=$1 ORDER BY version DESC LIMIT 1', [resp.id])).rows[0];
      if (last?.status === 'expired') throw conflict('This offer has expired. Ask the team to send a new one.', { code: 'offer_expired' });
      throw badStage(resp.stage, i.accept ? 'accepted' : 'declined');
    }
    const offer = (await c.query("SELECT * FROM recruitment_offers WHERE response_id=$1 AND status='open' FOR UPDATE", [resp.id])).rows[0];
    if (!offer) throw conflict('There is no open offer', { code: 'no_open_offer' });
    if (new Date(offer.deadline_at) <= new Date()) throw conflict('This offer has expired. Ask the team to send a new one.', { code: 'offer_expired' });
    const status = i.accept ? 'accepted' : 'declined';
    if (i.accept) {
      const taken = (await c.query("SELECT count(*)::int AS n FROM billboard_responses WHERE post_id=$1 AND stage='accepted'", [post.id])).rows[0].n;
      if (taken >= post.positions_needed) throw conflict('All positions have been filled', { code: 'positions_filled' });
      await acceptIntoTeam(c, post, resp, { role: offer.role, rate_cents: offer.rate_cents, rate_unit: offer.rate_unit });
    }
    await c.query('UPDATE recruitment_offers SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1', [offer.id, status, user.id]);
    const row = await setStage(c, resp, status, { kind: 'offer_response', actor: user.id, note: `Offer v${offer.version}`, key: i.idempotency_key });
    if (i.accept) await fillIfFull(c, post);
    await notify(c, post.author_id, { kind: `recruitment_offer_${status}`, title: i.accept ? 'An offer was accepted' : 'An offer was declined', body: `An offer for "${post.title}" was ${status}. Open the app for the pipeline.`, data: { post_id: post.id, response_id: resp.id }, dedupe_key: `recruit:${resp.id}:offer:${offer.version}:${status}` });
    return view(c, row.id);
  }),
});

cap({
  name: 'withdraw_recruitment_application', method: 'POST', path: '/billboard/responses/:id/withdraw', tag: TAG,
  summary: 'Withdraw your application (or a young person\'s, as their guardian) at any open stage. An open offer is withdrawn with it; the history stays.',
  input: z.object({ id, row_version: version, idempotency_key: key, note: z.string().max(500).optional() }),
  handler: ({ user }, i) => applicantMutation(user, i, {}, async (c, resp, post) => {
    if (!OPEN_STAGES.includes(resp.stage)) throw conflict(`This application is already ${resp.stage}`, { code: 'closed_application', stage: resp.stage });
    await closeOpenOffer(c, resp.id, 'withdrawn', user.id);
    const row = await setStage(c, resp, 'withdrawn', { kind: 'withdrawn', actor: user.id, note: i.note, key: i.idempotency_key });
    await notify(c, post.author_id, { kind: 'recruitment_withdrawn', title: 'An application was withdrawn', body: `An application to "${post.title}" was withdrawn.`, data: { post_id: post.id, response_id: resp.id }, dedupe_key: `recruit:${resp.id}:withdrawn` });
    return view(c, row.id);
  }),
});

cap({
  name: 'export_recruitment_pipeline', method: 'GET', path: '/billboard/:id/pipeline/export', tag: TAG,
  summary: 'CSV of the pipeline for a post you run: stage, dates, offer status and trial rating per candidate. Young applicants without a guardian\'s current consent are left out (and counted as withheld). Evidence links and notes are never exported. Audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await staffPost(user, i.id);
    await tx((c) => sweepExpired(c));
    const rows = await many(`${CANDIDATE} WHERE r.post_id=$1 ORDER BY r.created_at, r.id`, [i.id]);
    const ok = [];
    for (const r of rows) if (!r.is_youth || (await consentOk(r.user_id))) ok.push(r);
    await audit(null, user.id, 'export_recruitment_pipeline', 'billboard_posts', i.id);
    const cols = ['display_name', 'handle', 'stage', 'created_at', 'stage_changed_at', 'trial_at', 'offer_version', 'offer_status', 'offer_deadline_at', 'rating'];
    return { filename: 'recruitment-pipeline.csv', rows: ok.length, withheld: rows.length - ok.length, csv: toCsv(cols, ok) };
  },
});
