import { z } from 'zod';
import { encrypt } from '../crypto.js';
import { OPEN_STAGES, CONSENT_PURPOSE, acceptIntoTeam, fillIfFull, isStaff, logEvent, setStage, sweepExpired } from '../recruitment.js';
import { YOUTH_SQL, hasConsent, requireConsent, requireGuardian } from '../youth.js';
import { cap, id, page, money } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { hasRole, isAdmin, mustFind, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { notify } from '../notify.js';
import { canManageTeam } from './teams.js';

const httpsUrl = z.string().url().max(500).refine((u) => u.startsWith('https://'), 'Use an https link');

const kinds = ['match_players', 'team_recruiting', 'coach_wanted', 'sponsorship_wanted', 'sponsor_call'];
const rateUnit = z.enum(['match', 'hour', 'month', 'season']);
const POST_COLS = `b.id, b.kind, b.title, b.body, b.city, b.starts_at, b.positions_needed, b.budget_cents, b.rate_unit, b.status, b.created_at, b.team_id,
  s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji, t.name AS team_name, t.emoji AS team_emoji,
  u.id AS author_id, u.handle AS author_handle, u.display_name AS author_name, u.avatar_emoji AS author_emoji, u.avatar_color AS author_color, u.avatar_url AS author_avatar_url,
  (SELECT count(*)::int FROM billboard_responses r WHERE r.post_id=b.id AND r.status='accepted') AS accepted`;
const FROM = 'FROM billboard_posts b JOIN users u ON u.id=b.author_id LEFT JOIN sports s ON s.id=b.sport_id LEFT JOIN teams t ON t.id=b.team_id';

cap({
  name: 'create_billboard_post', method: 'POST', path: '/billboard', tag: 'Billboard', status: 201,
  summary: 'Post a demand on the billboard: players wanted for a match, a team recruiting, an athlete/team seeking a sponsor, or a sponsor calling for athletes (sponsors only).',
  input: z.object({
    kind: z.enum(kinds), title: z.string().min(3).max(100), body: z.string().max(1000).optional(), sport: z.string().optional(), team_id: id.optional(),
    city: z.string().max(80).optional(), starts_at: z.string().datetime({ offset: true }).optional(), positions_needed: z.number().int().min(1).max(200).default(1), budget_cents: money.optional(), rate_unit: rateUnit.optional().describe('what the budget pays per, e.g. per match — for team_recruiting / coach_wanted'),
  }),
  async handler({ user }, i) {
    if (i.kind === 'sponsor_call' && !hasRole(user, 'sponsor')) throw forbidden('Only sponsors can post sponsor calls');
    if (i.kind === 'coach_wanted' && !i.team_id) throw badRequest('Pick the team you need a coach for');
    if (i.team_id && !(await canManageTeam(user, await mustFind('teams', i.team_id)))) throw forbidden('You do not manage that team');
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    return one('INSERT INTO billboard_posts(author_id, kind, sport_id, team_id, title, body, city, starts_at, positions_needed, budget_cents, rate_unit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, kind, title, status',
      [user.id, i.kind, sport?.id ?? null, i.team_id ?? null, i.title, i.body, i.city, i.starts_at, i.positions_needed, i.budget_cents, i.rate_unit]);
  },
});

cap({
  name: 'list_billboard', method: 'GET', path: '/billboard', tag: 'Billboard', auth: 'public',
  summary: 'Browse the billboard (open posts by default). When signed in, each post says whether you already responded and whether it is yours.',
  input: z.object({ kind: z.enum(kinds).optional(), sport: z.string().optional(), q: z.string().optional(), mine: z.coerce.boolean().optional(), include_closed: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    return many(
      `SELECT ${POST_COLS}, (b.author_id = $1) AS is_mine, (SELECT r.status FROM billboard_responses r WHERE r.post_id=b.id AND r.responder_id=$1) AS my_response
         ${FROM}
        WHERE ($2::text IS NULL OR b.kind=$2) AND ($3::uuid IS NULL OR b.sport_id=$3) AND ($4::text IS NULL OR b.title ILIKE '%'||$4||'%' OR b.body ILIKE '%'||$4||'%')
          AND (coalesce($5,false) = false OR b.author_id=$1) AND (coalesce($6,false) OR b.status='open')
        ORDER BY b.created_at DESC LIMIT $7 OFFSET $8`,
      [user?.id ?? null, i.kind ?? null, sport?.id ?? null, i.q ?? null, i.mine ?? null, i.include_closed ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'close_billboard_post', method: 'POST', path: '/billboard/:id/close', tag: 'Billboard', summary: 'Take your post down.', input: z.object({ id }),
  async handler({ user }, i) {
    const p = await mustFind('billboard_posts', i.id);
    if (p.author_id !== user.id && !isAdmin(user)) throw forbidden();
    await query("UPDATE billboard_posts SET status='closed' WHERE id=$1", [i.id]);
    return { ok: true };
  },
});

cap({
  name: 'respond_to_post', method: 'POST', path: '/billboard/:id/responses', tag: 'Billboard', status: 201,
  summary: 'Answer a post: offer to play, apply to join a team, or (as a sponsor) offer sponsorship. One response per person per post. It starts at the "applied" stage of the recruitment pipeline. Add a source_url (https) as evidence; a guardian can apply for a young person with on_behalf_of. Send an idempotency_key so a retry never creates a second application.',
  input: z.object({ id, message: z.string().max(500).optional(), source_url: httpsUrl.optional(), source_kind: z.enum(['passport', 'video', 'profile', 'other']).default('other'), on_behalf_of: id.optional(), idempotency_key: z.string().min(8).max(80).optional() }),
  async handler({ user }, i) {
    const p = await mustFind('billboard_posts', i.id);
    const subject = i.on_behalf_of ?? user.id;
    if (subject !== user.id) await requireGuardian(user, subject);
    if (p.status !== 'open') throw conflict('This post is no longer open');
    if (p.author_id === subject) throw badRequest('You cannot respond to your own post');
    if (p.kind === 'sponsorship_wanted' && !hasRole(user, 'sponsor')) throw forbidden('Only sponsors can respond to a sponsorship request');
    try {
      return await tx(async (c) => {
        await requireConsent(subject, CONSENT_PURPOSE, 'applying through the Billboard', c);
        const out = (await c.query(
          `INSERT INTO billboard_responses(post_id, responder_id, message, source_kind, source_ref_enc, applied_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, post_id, status, stage, row_version`,
          [i.id, subject, i.message, i.source_url ? i.source_kind : null, i.source_url ? encrypt(i.source_url, 'billboard_responses.source_ref') : null, subject === user.id ? null : user.id, i.idempotency_key ?? null])).rows[0];
        await logEvent(c, out, 'applied', { to: 'applied', actor: user.id, key: null });
        // generic wording only: the applicant's message stays in the authenticated app
        const data = { post_id: p.id, response_id: out.id };
        await notify(c, p.author_id, { kind: 'billboard_response', title: 'New response to your post', body: `Someone responded to "${p.title}". Open the app to review it.`, data, dedupe_key: `billboard_response:${out.id}:owner` });
        await notify(c, subject, { kind: 'billboard_response_sent', title: 'Response sent', body: `Your response to "${p.title}" was sent. You will be notified when the poster decides.`, data, dedupe_key: `billboard_response:${out.id}:applicant` });
        return out;
      });
    } catch (e) {
      if (e.code === '23505') {
        const prior = i.idempotency_key && (await one('SELECT id, post_id, status, stage, row_version FROM billboard_responses WHERE post_id=$1 AND responder_id=$2 AND idempotency_key=$3', [i.id, subject, i.idempotency_key]));
        if (prior) return { ...prior, replayed: true };
        throw conflict('You already responded to this post');
      }
      throw e;
    }
  },
});

cap({
  name: 'list_post_responses', method: 'GET', path: '/billboard/:id/responses', tag: 'Billboard', summary: 'Responses to your post (the post author, platform admins and people who manage its team), with their recruitment stage. A young applicant without a guardian\'s current consent shows as hidden.', input: z.object({ id }),
  async handler({ user }, i) {
    const p = await mustFind('billboard_posts', i.id);
    if (!(await isStaff(user, p))) throw forbidden();
    const rows = await many(`SELECT r.id AS response_id, r.message, r.status, r.stage, r.row_version, r.created_at, (r.source_ref_enc IS NOT NULL) AS has_source, ${YOUTH_SQL} AS is_youth, ${PUBLIC_USER} FROM billboard_responses r JOIN users u ON u.id=r.responder_id WHERE r.post_id=$1 ORDER BY r.created_at, r.id`, [i.id]);
    return Promise.all(rows.map(async (r) => (r.is_youth && !(await hasConsent(r.id, CONSENT_PURPOSE))
      ? { response_id: r.response_id, status: r.status, stage: r.stage, row_version: r.row_version, created_at: r.created_at, hidden: true, is_youth: true, reason: 'guardian_consent_required' }
      : { ...r, hidden: false })));
  },
});

cap({
  name: 'decide_response', method: 'PATCH', path: '/billboard/responses/:id', tag: 'Billboard',
  summary: 'Accept or decline a response to your post directly. Accepting for a team post adds the person to the team roster; the post is marked filled once all positions are taken. For the staged flow (shortlist, trial, evaluation, versioned offer) use the recruitment pipeline capabilities.',
  input: z.object({ id, status: z.enum(['accepted', 'declined']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM billboard_responses WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Response');
      const p = (await c.query('SELECT * FROM billboard_posts WHERE id=$1 FOR UPDATE', [r.post_id])).rows[0];
      if (!(await isStaff(user, p))) throw forbidden();
      if (!OPEN_STAGES.includes(r.stage)) throw conflict(`Already ${r.status}`);
      await requireConsent(r.responder_id, CONSENT_PURPOSE, 'this application', c);
      if (i.status === 'accepted') await acceptIntoTeam(c, p, r);
      await c.query("UPDATE recruitment_offers SET status='withdrawn', decided_by=$2, decided_at=now() WHERE response_id=$1 AND status='open'", [r.id, user.id]);
      const out = await setStage(c, r, i.status, { kind: 'legacy_decision', actor: user.id });
      if (i.status === 'accepted') await fillIfFull(c, p);
      await notify(c, r.responder_id, { kind: `billboard_response_${i.status}`, title: i.status === 'accepted' ? 'Your response was accepted' : 'Your response was declined', body: `The poster ${i.status} your response to "${p.title}".`, data: { post_id: p.id, response_id: r.id }, dedupe_key: `billboard_response:${r.id}:${i.status}` });
      return { id: out.id, post_id: out.post_id, status: out.status, stage: out.stage, row_version: out.row_version };
    });
  },
});

cap({
  name: 'list_my_responses', method: 'GET', path: '/me/billboard-responses', tag: 'Billboard', summary: 'Posts you responded to, with the outcome, recruitment stage, trial time and the latest offer. A guardian can pass user_id for a young person.', input: z.object({ user_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const target = i.user_id ?? user.id;
    if (target !== user.id) await requireGuardian(user, target);
    await tx((c) => sweepExpired(c));
    return many(
      `SELECT r.id AS response_id, r.status AS response_status, r.stage, r.row_version, r.trial_at, (SELECT v.name FROM venues v WHERE v.id=r.trial_venue_id) AS trial_venue_name, (SELECT v.city FROM venues v WHERE v.id=r.trial_venue_id) AS trial_venue_city, r.message, r.created_at AS responded_at, ${POST_COLS}, (b.author_id = $1) AS is_mine,
              CASE WHEN o.version IS NULL THEN NULL ELSE row_to_json(o) END AS latest_offer
         FROM billboard_responses r JOIN billboard_posts b ON b.id=r.post_id JOIN users u ON u.id=b.author_id LEFT JOIN sports s ON s.id=b.sport_id LEFT JOIN teams t ON t.id=b.team_id
         LEFT JOIN LATERAL (SELECT version, role, rate_cents, rate_unit, starts_on, deadline_at, status, note FROM recruitment_offers x WHERE x.response_id=r.id ORDER BY x.version DESC LIMIT 1) o ON true
        WHERE r.responder_id=$1 ORDER BY r.created_at DESC, r.id LIMIT $2 OFFSET $3`, [target, i.limit, i.offset]);
  },
});
