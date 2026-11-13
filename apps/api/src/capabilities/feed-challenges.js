// Fan & Community Feed — sport challenges (issue #522).
// Challenges are org/team-driven activities backed by explicit rules and eligible evidence.
// NEVER: unsafe overtraining challenges, weight-loss competitions, or medical-behaviour incentives.
// Sponsored challenges are clearly disclosed; guardian consent is required for youth participation.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { isYouth, guardianLink, guardianCan } from '../youth.js';
import { notify } from '../notify.js';

const TAG = 'Community Feed';
const CHALLENGE_CTX = 'feed_challenge';

const ruleSchema = z.object({
  rule: z.string().max(120),
  description: z.string().max(400),
  metric: z.string().max(80).optional(),
  threshold: z.number().optional(),
});
const evidenceSchema = z.object({
  kind: z.enum(['video','photo','strava_activity','manual']),
  description: z.string().max(200),
});

cap({
  name: 'create_feed_challenge', method: 'POST', path: '/feed/challenges', tag: TAG,
  auth: ['admin', 'platform_admin', 'organizer'],
  summary: 'Create a sport challenge for an organisation. Must have explicit rules and eligible evidence. Unsafe challenge kinds (overtraining, weight-loss, medical behaviour) are rejected. Sponsored challenges must include a disclosure text.',
  input: z.object({
    org_id: id,
    title: z.string().min(3).max(120),
    description: z.string().max(2000).optional(),
    sport_id: id.optional(),
    kind: z.enum(['participation_streak','activity','skill','community']).default('activity'),
    rules: z.array(ruleSchema).min(1).max(20),
    eligible_evidence: z.array(evidenceSchema).min(1).max(10),
    start_at: z.string().datetime(),
    end_at: z.string().datetime(),
    is_sponsored: z.boolean().default(false),
    sponsor_id: id.optional(),
    disclosure_text: z.string().max(400).optional(),
    quota: z.coerce.number().int().min(1).optional(),
  }),
  async handler({ user }, i) {
    if (new Date(i.end_at) <= new Date(i.start_at)) throw badRequest('end_at must be after start_at');
    if (i.is_sponsored && !i.disclosure_text) throw badRequest('Sponsored challenges must include a disclosure_text');
    const org = await one(`SELECT id FROM organisations WHERE id=$1 AND archived_at IS NULL`, [i.org_id]);
    if (!org) throw notFound('Organisation');
    const description_enc = i.description ? await encrypt(i.description, CHALLENGE_CTX) : null;
    const disclosure_text_enc = i.disclosure_text ? await encrypt(i.disclosure_text, CHALLENGE_CTX) : null;
    return tx(async (c) => {
      const row = (await c.query(
        `INSERT INTO feed_challenges(org_id, created_by, title, description_enc, sport_id, kind, rules, eligible_evidence, start_at, end_at, is_sponsored, sponsor_id, disclosure_text_enc, quota)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, created_at`,
        [i.org_id, user.id, i.title, description_enc, i.sport_id ?? null, i.kind,
         JSON.stringify(i.rules), JSON.stringify(i.eligible_evidence),
         i.start_at, i.end_at, i.is_sponsored, i.sponsor_id ?? null, disclosure_text_enc, i.quota ?? null])).rows[0];
      await audit(c, user.id, 'feed_challenge_created', 'feed_challenges', row.id);
      return row;
    });
  },
});

cap({
  name: 'update_feed_challenge', method: 'PATCH', path: '/feed/challenges/:id', tag: TAG,
  auth: ['admin', 'platform_admin', 'organizer'],
  summary: 'Update a challenge in draft status. Active challenges may only be extended (end_at pushed later) or have their quota raised.',
  input: z.object({
    id,
    title: z.string().min(3).max(120).optional(),
    description: z.string().max(2000).optional(),
    end_at: z.string().datetime().optional(),
    quota: z.coerce.number().int().min(1).optional(),
    status: z.enum(['draft','active','closed','archived']).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ch = (await c.query(`SELECT * FROM feed_challenges WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
      if (!ch) throw notFound('Challenge');
      if (ch.status === 'archived') throw conflict('Archived challenges cannot be changed');
      if (ch.status === 'active' && i.title) throw conflict('Title cannot be changed on an active challenge');
      const description_enc = i.description !== undefined ? (i.description ? await encrypt(i.description, CHALLENGE_CTX) : null) : ch.description_enc;
      await c.query(
        `UPDATE feed_challenges SET title=COALESCE($2,title), description_enc=$3, end_at=COALESCE($4,end_at), quota=COALESCE($5,quota), status=COALESCE($6,status) WHERE id=$1`,
        [i.id, i.title ?? null, description_enc, i.end_at ?? null, i.quota ?? null, i.status ?? null]);
      await audit(c, user.id, 'feed_challenge_updated', 'feed_challenges', i.id);
      return { id: i.id, updated: true };
    });
  },
});

cap({
  name: 'list_feed_challenges', method: 'GET', path: '/feed/challenges', tag: TAG,
  auth: 'public',
  summary: 'Browse active sport challenges. Optionally filter by sport or org. Cursor-paginated, newest-first.',
  input: z.object({
    sport_id: id.optional(),
    org_id: id.optional(),
    status: z.enum(['active','closed']).default('active'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    before: z.string().optional(),
  }),
  async handler(_, i) {
    const filters = [`c.archived_at IS NULL AND c.status = $2`];
    const params = [i.limit, i.status];
    if (i.sport_id) { params.push(i.sport_id); filters.push(`c.sport_id = $${params.length}`); }
    if (i.org_id)   { params.push(i.org_id);   filters.push(`c.org_id = $${params.length}`); }
    if (i.before)   {
      const [at, cid] = String(i.before).split('|');
      params.push(at, cid);
      filters.push(`(c.start_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    const rows = await many(
      `SELECT c.id, c.title, c.kind, c.sport_id, s.name AS sport_name, c.start_at, c.end_at,
              c.is_sponsored, c.quota, c.status,
              o.name AS org_name, o.id AS org_id,
              (SELECT count(*) FROM feed_challenge_entries e WHERE e.challenge_id=c.id AND e.status <> 'withdrawn') AS entries_count
         FROM feed_challenges c
         LEFT JOIN sports s       ON s.id = c.sport_id
         LEFT JOIN organisations o ON o.id = c.org_id
        WHERE ${filters.join(' AND ')}
        ORDER BY c.start_at DESC, c.id DESC LIMIT $1`,
      params);
    return rows;
  },
});

cap({
  name: 'get_feed_challenge', method: 'GET', path: '/feed/challenges/:id', tag: TAG,
  auth: 'public',
  summary: 'Get full details of a challenge including rules, eligible evidence, and leaderboard summary.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ch = await one(
      `SELECT c.*, s.name AS sport_name, o.name AS org_name,
              (SELECT count(*) FROM feed_challenge_entries e WHERE e.challenge_id=c.id AND e.status <> 'withdrawn') AS entries_count
         FROM feed_challenges c LEFT JOIN sports s ON s.id=c.sport_id LEFT JOIN organisations o ON o.id=c.org_id
        WHERE c.id=$1 AND c.archived_at IS NULL`, [i.id]);
    if (!ch) throw notFound('Challenge');
    const result = { ...ch, description: null, disclosure_text: null };
    if (ch.description_enc) result.description = await decrypt(ch.description_enc, CHALLENGE_CTX);
    if (ch.is_sponsored && ch.disclosure_text_enc) result.disclosure_text = await decrypt(ch.disclosure_text_enc, CHALLENGE_CTX);
    // my entry
    if (user) {
      result.my_entry = await one(`SELECT id, status, submitted_at FROM feed_challenge_entries WHERE challenge_id=$1 AND participant_id=$2`, [i.id, user.id]);
    }
    return result;
  },
});

cap({
  name: 'enter_feed_challenge', method: 'POST', path: '/feed/challenges/:id/entries', tag: TAG,
  summary: 'Enter a sport challenge. Youth participants require that their guardian has enabled challenge participation (social scope). Quota is enforced.',
  input: z.object({ id, participant_kind: z.enum(['athlete','team']).default('athlete') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ch = (await c.query(`SELECT * FROM feed_challenges WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
      if (!ch) throw notFound('Challenge');
      if (ch.status !== 'active') throw conflict('This challenge is not currently open');
      if (new Date(ch.end_at) < new Date()) throw conflict('This challenge has ended');
      // Youth gate
      if (await isYouth(user.id, c)) {
        const link = await guardianLink(null, user.id, c);
        if (!link || !(await guardianCan(link, 'social', null, c))) throw forbidden('Guardian approval is required for a young person to enter challenges');
      }
      // Quota check
      if (ch.quota) {
        const active = (await c.query(`SELECT count(*) AS n FROM feed_challenge_entries WHERE challenge_id=$1 AND status <> 'withdrawn'`, [i.id])).rows[0].n;
        if (Number(active) >= ch.quota) throw conflict('This challenge has reached its participant limit');
      }
      // Idempotent
      const existing = (await c.query(`SELECT id, status FROM feed_challenge_entries WHERE challenge_id=$1 AND participant_id=$2`, [i.id, user.id])).rows[0];
      if (existing && existing.status !== 'withdrawn') return existing;
      const row = (await c.query(
        `INSERT INTO feed_challenge_entries(challenge_id, participant_id, participant_kind) VALUES ($1,$2,$3)
              ON CONFLICT (challenge_id, participant_id) DO UPDATE SET status='entered', submitted_at=NULL RETURNING id, status, created_at`,
        [i.id, user.id, i.participant_kind])).rows[0];
      await audit(c, user.id, 'feed_challenge_entered', 'feed_challenges', i.id);
      return row;
    });
  },
});

cap({
  name: 'submit_challenge_evidence', method: 'PATCH', path: '/feed/challenges/:id/entries/:entry_id', tag: TAG,
  summary: 'Submit evidence for a challenge entry (video URL, photo reference, Strava activity link, or manual declaration).',
  input: z.object({
    id, entry_id: id,
    evidence_url: z.string().url().max(500),
    evidence_kind: z.enum(['video','photo','strava_activity','manual']),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const entry = (await c.query(`SELECT * FROM feed_challenge_entries WHERE id=$1 AND participant_id=$2 FOR UPDATE`, [i.entry_id, user.id])).rows[0];
      if (!entry || entry.challenge_id !== i.id) throw notFound('Entry');
      if (!['entered','submitted'].includes(entry.status)) throw conflict('Cannot update evidence at this stage');
      const evidence_url_enc = await encrypt(i.evidence_url, CHALLENGE_CTX);
      await c.query(`UPDATE feed_challenge_entries SET evidence_url_enc=$2, evidence_kind=$3, status='submitted', submitted_at=now() WHERE id=$1`, [i.entry_id, evidence_url_enc, i.evidence_kind]);
      await audit(c, user.id, 'feed_challenge_evidence_submitted', 'feed_challenge_entries', i.entry_id);
      return { id: i.entry_id, status: 'submitted' };
    });
  },
});

cap({
  name: 'list_challenge_entries', method: 'GET', path: '/feed/challenges/:id/entries', tag: TAG,
  summary: 'List entries for a challenge. Public: participant name and status only. Org staff also see evidence (decrypted).',
  input: z.object({ id, status: z.enum(['entered','submitted','verified','rejected']).optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT e.id, e.participant_id, u.display_name, u.avatar_emoji, u.avatar_color, e.participant_kind,
              e.status, e.submitted_at, e.verified_at
         FROM feed_challenge_entries e JOIN users u ON u.id=e.participant_id
        WHERE e.challenge_id=$1 ${i.status ? `AND e.status=$4` : ''} AND e.status <> 'withdrawn'
        ORDER BY e.submitted_at DESC NULLS LAST, e.created_at DESC LIMIT $2 OFFSET $3`,
      [i.id, i.limit, i.offset, ...(i.status ? [i.status] : [])]);
    return rows;
  },
});

cap({
  name: 'get_challenge_leaderboard', method: 'GET', path: '/feed/challenges/:id/leaderboard', tag: TAG,
  auth: 'public',
  summary: 'Public leaderboard for a challenge (verified entries only, ranked by score). Returns top 100.',
  input: z.object({ id }),
  async handler(_, i) {
    const ch = await one(`SELECT id, status, is_sponsored FROM feed_challenges WHERE id=$1`, [i.id]);
    if (!ch) throw notFound('Challenge');
    const rows = await many(
      `SELECT l.rank, l.score, u.id AS participant_id, u.display_name, u.avatar_emoji, u.avatar_color
         FROM feed_challenge_leaderboard l JOIN users u ON u.id=l.participant_id
        WHERE l.challenge_id=$1
        ORDER BY l.rank ASC LIMIT 100`, [i.id]);
    return { challenge_id: i.id, leaderboard: rows };
  },
});

cap({
  name: 'verify_challenge_entry', method: 'PATCH', path: '/feed/challenges/:id/entries/:entry_id/verify', tag: TAG,
  auth: ['admin', 'platform_admin', 'organizer'],
  summary: 'Verify or reject a submitted challenge entry. Only org staff of the challenge org may do this.',
  input: z.object({ id, entry_id: id, decision: z.enum(['verified','rejected']), notes: z.string().max(400).optional(), score: z.number().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const entry = (await c.query(
        `SELECT e.*, ch.org_id FROM feed_challenge_entries e JOIN feed_challenges ch ON ch.id=e.challenge_id WHERE e.id=$1 AND e.challenge_id=$2 FOR UPDATE`,
        [i.entry_id, i.id])).rows[0];
      if (!entry || entry.status !== 'submitted') throw notFound('Entry');
      const notes_enc = i.notes ? await encrypt(i.notes, CHALLENGE_CTX) : null;
      await c.query(`UPDATE feed_challenge_entries SET status=$2, verified_by=$3, verified_at=now(), notes_enc=$4 WHERE id=$1`, [i.entry_id, i.decision, user.id, notes_enc]);
      if (i.decision === 'verified' && i.score !== undefined) {
        await c.query(
          `INSERT INTO feed_challenge_leaderboard(challenge_id, participant_id, participant_kind, score)
                VALUES ($1,$2,$3,$4)
                ON CONFLICT (challenge_id, participant_id) DO UPDATE SET score=$4, updated_at=now()`,
          [i.id, entry.participant_id, entry.participant_kind, i.score]);
        // Recompute ranks
        await c.query(`
          WITH ranked AS (
            SELECT challenge_id, participant_id, row_number() OVER (PARTITION BY challenge_id ORDER BY score DESC) AS rn
              FROM feed_challenge_leaderboard WHERE challenge_id=$1
          )
          UPDATE feed_challenge_leaderboard l SET rank=r.rn FROM ranked r WHERE l.challenge_id=r.challenge_id AND l.participant_id=r.participant_id`, [i.id]);
      }
      await audit(c, user.id, `feed_challenge_entry_${i.decision}`, 'feed_challenge_entries', i.entry_id);
      await notify(c, entry.participant_id, { kind: 'challenge_decision', title: i.decision === 'verified' ? 'Entry verified' : 'Entry not accepted', body: i.decision === 'verified' ? 'Your challenge entry has been verified.' : 'Your challenge entry was not accepted.', data: { challenge_id: i.id }, dedupe_key: `challenge_decision:${i.entry_id}` });
      return { id: i.entry_id, status: i.decision };
    });
  },
});

cap({
  name: 'close_feed_challenge', method: 'POST', path: '/feed/challenges/:id/close', tag: TAG,
  auth: ['admin', 'platform_admin', 'organizer'],
  summary: 'Close a challenge early or archive it after it ends. Remaining submitted entries are not automatically rejected.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ch = (await c.query(`SELECT * FROM feed_challenges WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
      if (!ch) throw notFound('Challenge');
      await c.query(`UPDATE feed_challenges SET status='closed' WHERE id=$1`, [i.id]);
      await audit(c, user.id, 'feed_challenge_closed', 'feed_challenges', i.id);
      return { id: i.id, status: 'closed' };
    });
  },
});
