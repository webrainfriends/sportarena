// Player career & membership timeline (issue #311): membership periods per club/team with season, position, competition level and
// verified affiliation evidence. Canonical teams / organisations / sports / org_seasons stay authoritative (sport_profiles.club is the
// legacy display value). Every change keeps a revision; stints are archived, never deleted; verification is by the club's own staff.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit, isAdmin, sportBySlugOrId } from '../helpers.js';
import { notify } from '../notify.js';
import { toCsv } from '../csv.js';
import { hasOrgGrant } from '../org-access.js';
import { isYouth, hasConsent, requireConsent, requireGuardian } from '../youth.js';
import { CAREER_VIEW_SQL, EVIDENCE_KINDS, LEVELS, extVisible, snapshot } from '../career.js';
import { canManageTeam } from './teams.js';

const TAG = 'Career';
const iso = z.string().date();
const STAFF_ORG_ROLES = ['owner', 'admin', 'coach'];

/** Whose timeline? Yourself, or a young person you are a verified guardian of. A young person writing for themselves needs a guardian's current consent. */
export async function subject(user, userId, { write = false, share = false } = {}, client) {
  const target = userId ?? user.id;
  if (target === user.id) {
    if (await isYouth(target, client)) {
      if (share) throw forbidden('A parent or guardian needs to export or share this for you');
      if (write) await requireConsent(target, 'participation', 'changing the career timeline', client);
    }
    return target;
  }
  if (isAdmin(user)) return target;
  await requireGuardian(user, target, client);
  return target;
}

/** May this user review (verify/reject) entries tied to this team or organisation? Never your own entry. */
async function canReview(user, m, client) {
  if (isAdmin(user)) return true;
  if (m.user_id === user.id) return false;
  if (m.team_id) {
    const t = await one('SELECT * FROM teams WHERE id=$1', [m.team_id]);
    if (t && (await canManageTeam(user, t))) return true;
  }
  const orgId = m.organisation_id ?? (m.team_id ? (await one('SELECT organisation_id FROM teams WHERE id=$1', [m.team_id]))?.organisation_id : null);
  return hasOrgGrant(user, orgId, STAFF_ORG_ROLES);
}

const withCounts = `, c.review_note, c.verified_by, c.archived_at, c.created_at, c.updated_at, c.user_id,
  (SELECT count(*)::int FROM career_membership_evidence e WHERE e.membership_id=c.id AND e.archived_at IS NULL) AS evidence_count,
  (SELECT count(*)::int FROM career_membership_revisions r WHERE r.membership_id=c.id) AS revisions,
  (SELECT count(*)::int FROM career_membership_revisions r WHERE r.membership_id=c.id AND r.action='corrected') AS corrections`;
const DETAIL = CAREER_VIEW_SQL.replace('c.row_version', `c.row_version${withCounts}`);
const one_ = (mid, client) => (client ? client.query(`${DETAIL} WHERE c.id=$1`, [mid]).then((r) => r.rows[0]) : one(`${DETAIL} WHERE c.id=$1`, [mid]));
const LOCK = 'SELECT *, starts_on::text AS starts_s, ends_on::text AS ends_s FROM career_memberships WHERE id=$1 FOR UPDATE';

const FIELDS = z.object({
  team_id: id.optional(), organisation_id: id.optional(), club_name: z.string().trim().min(2).max(120).optional(),
  org_season_id: id.optional(), season_label: z.string().trim().min(2).max(40).optional(),
  starts_on: iso, ends_on: iso.optional(), position: z.string().trim().min(1).max(60).optional(),
  competition_level: z.enum(LEVELS), jersey_no: z.number().int().min(0).max(999).optional(),
});

/** Resolve the canonical club: a team gives its sport and organisation; a season must belong to the organisation. Free-text is only for clubs not on the platform. */
async function resolveClub(i, sportInput) {
  let sport = sportInput ? await sportBySlugOrId(sportInput) : null;
  if (sportInput && !sport) throw notFound('Sport');
  let organisationId = i.organisation_id ?? null;
  if (i.team_id) {
    const t = await one('SELECT id, sport_id, organisation_id FROM teams WHERE id=$1', [i.team_id]);
    if (!t) throw notFound('Team');
    if (sport && sport.id !== t.sport_id) throw badRequest('That team plays a different sport');
    sport = sport ?? { id: t.sport_id };
    organisationId = organisationId ?? t.organisation_id;
  }
  if (i.organisation_id && !(await one('SELECT 1 FROM organisations WHERE id=$1', [i.organisation_id]))) throw notFound('Organisation');
  if (!sport) throw badRequest('Choose a sport');
  if (!i.team_id && !i.organisation_id && !i.club_name) throw badRequest('Pick a club or team, or enter its name if it is not listed');
  if ((i.team_id || i.organisation_id) && i.club_name) throw badRequest('Use either a listed club/team or a typed name, not both');
  if (i.org_season_id) {
    const s = await one('SELECT organisation_id FROM org_seasons WHERE id=$1', [i.org_season_id]);
    if (!s) throw notFound('Season');
    if (!organisationId || s.organisation_id !== organisationId) throw badRequest('That season belongs to a different organisation');
  }
  if (i.ends_on && i.ends_on < i.starts_on) throw badRequest('A stint cannot end before it starts');
  return { sportId: sport.id, organisationId: i.team_id ? null : organisationId };
}

const dupe = (e) => (e.code === '23505' && /career_memberships_no_dupe/.test(e.constraint ?? '') ? conflict('This membership is already on the timeline', { code: 'duplicate_membership' }) : e);
const stale = (cur) => conflict('This entry was changed elsewhere. Reload and try again.', { code: 'stale_version', row_version: cur.row_version });

cap({
  name: 'list_career', method: 'GET', path: '/me/career', tag: TAG,
  summary: 'Your career timeline: every club/team membership with season, position, competition level and verification status, newest first. Former and corrected memberships stay. A guardian can pass user_id for a young person.',
  input: z.object({ user_id: id.optional(), sport: z.string().optional(), include_archived: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const target = await subject(user, i.user_id);
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (target !== user.id) await audit(null, user.id, 'read_career', 'users', target);
    return many(`${DETAIL} WHERE c.user_id=$1 AND ($2::uuid IS NULL OR c.sport_id=$2) AND ($3::boolean OR c.archived_at IS NULL) AND ${extVisible()} ORDER BY c.starts_on DESC, c.id LIMIT $4 OFFSET $5`,
      [target, sport?.id ?? null, i.include_archived, i.limit, i.offset]);
  },
});

cap({
  name: 'add_career_entry', method: 'POST', path: '/me/career', tag: TAG, status: 201,
  summary: 'Add a club/team membership period. Pick the club or team from the platform (canonical); only type a name for a club that is not listed (it stays "unlisted" and cannot be club-verified). Send a unique idempotency_key so a retry never creates a second entry.',
  input: FIELDS.extend({ competition_level: z.enum(LEVELS).default('club'), user_id: id.optional(), sport: z.string().optional().describe('sport slug or id; implied by a team'), idempotency_key: z.string().min(8).max(80) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const target = await subject(user, i.user_id, { write: true }, c);
      const prior = await one('SELECT id FROM career_memberships WHERE created_by=$1 AND idempotency_key=$2', [user.id, i.idempotency_key]);
      if (prior) return { ...(await one_(prior.id)), replayed: true };
      const { sportId, organisationId } = await resolveClub(i, i.sport);
      let mid;
      try {
        mid = (await c.query(
          `INSERT INTO career_memberships(user_id, sport_id, team_id, organisation_id, club_name, org_season_id, season_label, starts_on, ends_on, position, competition_level, jersey_no, source, idempotency_key, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'self',$13,$14) RETURNING id`,
          [target, sportId, i.team_id ?? null, i.team_id ? null : organisationId, i.club_name ?? null, i.org_season_id ?? null, i.season_label ?? null, i.starts_on, i.ends_on ?? null, i.position ?? null, i.competition_level, i.jersey_no ?? null, i.idempotency_key, user.id])).rows[0].id;
      } catch (e) { throw dupe(e); }
      await snapshot(c, mid, 'created', user.id);
      if (target !== user.id) await audit(c, user.id, 'write_career', 'users', target);
      return one_(mid, c);
    });
  },
});

cap({
  name: 'update_career_entry', method: 'PATCH', path: '/me/career/:id', tag: TAG,
  summary: 'Correct a membership period (dates, club/team, season, position, level, jersey) or end it by setting ends_on. Send the row_version you loaded; a stale version is refused. The old values stay in the revision history, and changing a verified entry sends it back to unverified.',
  input: FIELDS.partial().extend({ id, row_version: z.number().int().min(1), reason: z.string().trim().max(500).optional(), clear_ends_on: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query(LOCK, [i.id])).rows[0];
      if (!cur) throw notFound('Career entry');
      await subject(user, cur.user_id === user.id ? undefined : cur.user_id, { write: true }, c).catch((e) => { throw e.status === 403 ? notFound('Career entry') : e; });
      if (cur.archived_at) throw conflict('Restore this entry before editing it');
      if (cur.row_version !== i.row_version) throw stale(cur);
      const next = { ...cur, starts_on: cur.starts_s, ends_on: cur.ends_s };
      const changingClub = ['team_id', 'organisation_id', 'club_name'].some((k) => i[k] !== undefined);
      if (changingClub) Object.assign(next, { team_id: i.team_id ?? null, organisation_id: i.organisation_id ?? null, club_name: i.club_name ?? null, org_season_id: null });
      for (const k of ['org_season_id', 'season_label', 'starts_on', 'ends_on', 'position', 'competition_level', 'jersey_no']) if (i[k] !== undefined) next[k] = i[k];
      if (i.clear_ends_on) next.ends_on = null;
      const { organisationId } = await resolveClub(next, (await one('SELECT slug FROM sports WHERE id=$1', [cur.sport_id])).slug);
      const same = { starts_on: cur.starts_s, ends_on: cur.ends_s };
      const content = ['team_id', 'organisation_id', 'club_name', 'starts_on', 'ends_on'].some((k) => (same[k] ?? cur[k] ?? null) !== (k === 'organisation_id' ? (next.team_id ? null : organisationId) : next[k] ?? null));
      const verified = cur.verification_status === 'verified' || cur.verification_status === 'pending';
      let row;
      try {
        row = (await c.query(
          `UPDATE career_memberships SET team_id=$2, organisation_id=$3, club_name=$4, org_season_id=$5, season_label=$6, starts_on=$7, ends_on=$8, position=$9, competition_level=$10, jersey_no=$11,
                  verification_status=CASE WHEN $12 THEN 'unverified' ELSE verification_status END, verified_by=CASE WHEN $12 THEN NULL ELSE verified_by END, verified_at=CASE WHEN $12 THEN NULL ELSE verified_at END,
                  row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING id`,
          [i.id, next.team_id ?? null, next.team_id ? null : organisationId, next.club_name ?? null, next.org_season_id ?? null, next.season_label ?? null, next.starts_on, next.ends_on ?? null, next.position ?? null, next.competition_level, next.jersey_no ?? null, content && verified])).rows[0];
      } catch (e) { throw dupe(e); }
      await snapshot(c, row.id, 'corrected', user.id, i.reason);
      if (cur.user_id !== user.id) await audit(c, user.id, 'write_career', 'users', cur.user_id);
      return one_(row.id, c);
    });
  },
});

cap({
  name: 'archive_career_entry', method: 'POST', path: '/me/career/:id/archive', tag: TAG,
  summary: 'Hide a membership entry (archived, never deleted; evidence and history are kept) or restore it with archived=false.',
  input: z.object({ id, archived: z.boolean().default(true), row_version: z.number().int().min(1), reason: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query(LOCK, [i.id])).rows[0];
      if (!cur) throw notFound('Career entry');
      await subject(user, cur.user_id === user.id ? undefined : cur.user_id, { write: true }, c).catch((e) => { throw e.status === 403 ? notFound('Career entry') : e; });
      if (cur.row_version !== i.row_version) throw stale(cur);
      if (!!cur.archived_at === i.archived) return one_(cur.id, c);
      try {
        await c.query('UPDATE career_memberships SET archived_at=CASE WHEN $2 THEN now() END, row_version=row_version+1, updated_at=now() WHERE id=$1', [i.id, i.archived]);
      } catch (e) { throw dupe(e); }
      await snapshot(c, i.id, i.archived ? 'archived' : 'restored', user.id, i.reason);
      return one_(i.id, c);
    });
  },
});

cap({
  name: 'list_career_revisions', method: 'GET', path: '/me/career/:id/revisions', tag: TAG,
  summary: 'The full history of one membership entry: who changed what and when, with the values at each step (corrections are never overwritten).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const m = await one('SELECT user_id, team_id, organisation_id FROM career_memberships WHERE id=$1', [i.id]);
    if (!m) throw notFound('Career entry');
    if (m.user_id !== user.id && !(await canReview(user, m))) {
      await subject(user, m.user_id).catch(() => { throw notFound('Career entry'); });
    }
    if (m.user_id !== user.id) await audit(null, user.id, 'read_career', 'users', m.user_id);
    return many(`SELECT r.id, r.row_version, r.action, r.reason, r.snapshot, r.created_at, r.actor_id, u.display_name AS actor
                   FROM career_membership_revisions r LEFT JOIN users u ON u.id=r.actor_id WHERE r.membership_id=$1 ORDER BY r.created_at, r.id`, [i.id]);
  },
});

cap({
  name: 'add_career_evidence', method: 'POST', path: '/me/career/:id/evidence', tag: TAG, status: 201,
  summary: 'Attach affiliation evidence to a membership entry: a club letter, registration card number, roster listing or competition record. The reference (a letter number, registration id or link) is stored encrypted and only the player, their guardian and the club\'s staff reviewing it can read it.',
  input: z.object({ id, kind: z.enum(EVIDENCE_KINDS), label: z.string().trim().max(120).optional(), reference: z.string().trim().min(3).max(2000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m = (await c.query('SELECT * FROM career_memberships WHERE id=$1', [i.id])).rows[0];
      if (!m) throw notFound('Career entry');
      await subject(user, m.user_id === user.id ? undefined : m.user_id, { write: true }, c).catch((e) => { throw e.status === 403 ? notFound('Career entry') : e; });
      if (m.archived_at) throw conflict('Restore this entry before adding evidence');
      const row = (await c.query('INSERT INTO career_membership_evidence(membership_id, kind, label, reference_enc, added_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, kind, label, created_at',
        [i.id, i.kind, i.label ?? null, encrypt(i.reference, 'career_membership_evidence.reference'), user.id])).rows[0];
      return row;
    });
  },
});

cap({
  name: 'list_career_evidence', method: 'GET', path: '/me/career/:id/evidence', tag: TAG,
  summary: 'Evidence attached to a membership entry. Reading the references is audit-logged. Available to the player, a verified guardian, and the staff of the club/team the entry names.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const m = await one('SELECT * FROM career_memberships WHERE id=$1', [i.id]);
    if (!m) throw notFound('Career entry');
    if (m.user_id !== user.id) {
      const staff = await canReview(user, m);
      if (!staff || (await isYouth(m.user_id) && !(await hasConsent(m.user_id, 'participation')))) await subject(user, m.user_id).catch(() => { throw notFound('Career entry'); });
    }
    const rows = await many('SELECT id, kind, label, reference_enc, created_at FROM career_membership_evidence WHERE membership_id=$1 AND archived_at IS NULL ORDER BY created_at, id', [i.id]);
    await audit(null, user.id, 'read_career_evidence', 'career_memberships', i.id);
    return rows.map(({ reference_enc, ...r }) => ({ ...r, reference: decrypt(reference_enc, 'career_membership_evidence.reference') }));
  },
});

cap({
  name: 'request_career_verification', method: 'POST', path: '/me/career/:id/request-verification', tag: TAG,
  summary: 'Ask the club\'s staff to verify a membership entry. The entry must name a listed team or organisation and carry at least one piece of evidence. Entries for clubs that are not on the platform can only be verified by the platform team.',
  input: z.object({ id, row_version: z.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m = (await c.query(LOCK, [i.id])).rows[0];
      if (!m) throw notFound('Career entry');
      await subject(user, m.user_id === user.id ? undefined : m.user_id, { write: true }, c).catch((e) => { throw e.status === 403 ? notFound('Career entry') : e; });
      if (m.row_version !== i.row_version) throw stale(m);
      if (m.archived_at) throw conflict('Restore this entry first');
      if (!['unverified', 'rejected'].includes(m.verification_status)) return one_(m.id, c);
      if (!(await c.query('SELECT 1 FROM career_membership_evidence WHERE membership_id=$1 AND archived_at IS NULL', [i.id])).rowCount) throw badRequest('Add at least one piece of evidence first');
      await c.query("UPDATE career_memberships SET verification_status='pending', review_note=NULL, row_version=row_version+1, updated_at=now() WHERE id=$1", [i.id]);
      await snapshot(c, i.id, 'verification_requested', user.id);
      return one_(i.id, c);
    });
  },
});

cap({
  name: 'list_career_review_queue', method: 'GET', path: '/career/review-queue', tag: TAG,
  summary: 'Membership entries waiting for verification at teams and organisations you manage (team owner/captain/manager, or organisation owner/admin/coach). Platform team sees all, including clubs that are not listed. Young people\'s entries only appear while a guardian currently consents to participation.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `${DETAIL} JOIN users pu ON pu.id = c.user_id
      WHERE c.verification_status='pending' AND c.archived_at IS NULL
        AND (NOT (pu.youth_until IS NOT NULL AND pu.youth_until > current_date) OR EXISTS (SELECT 1 FROM youth_consents yc WHERE yc.child_id=c.user_id AND yc.purpose='participation' AND yc.revoked_at IS NULL AND yc.expires_at > now()
              AND EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=yc.granted_by AND l.child_id=yc.child_id AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()))))
        AND c.user_id <> $1
        AND ($2::boolean OR EXISTS (SELECT 1 FROM teams t WHERE t.id=c.team_id AND (t.owner_id=$1
              OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$1 AND m.status='active' AND m.role IN ('captain','manager'))
              OR EXISTS (SELECT 1 FROM organisation_members om JOIN organisations og ON og.id=om.organisation_id WHERE om.organisation_id=t.organisation_id AND om.user_id=$1 AND om.status='active' AND og.status='active' AND om.role = ANY($3))))
          OR EXISTS (SELECT 1 FROM organisation_members om JOIN organisations og ON og.id=om.organisation_id WHERE om.organisation_id=c.organisation_id AND om.user_id=$1 AND om.status='active' AND og.status='active' AND om.role = ANY($3)))
      ORDER BY c.updated_at, c.id LIMIT $4 OFFSET $5`,
    [user.id, !!isAdmin(user), STAFF_ORG_ROLES, i.limit, i.offset]),
});

cap({
  name: 'review_career_entry', method: 'POST', path: '/career/:id/review', tag: TAG,
  summary: 'Verify or reject a pending membership entry as the club\'s staff, with a note the player can read. You cannot review your own entry. The decision is recorded in the entry\'s history and the player is told.',
  input: z.object({ id, decision: z.enum(['verify', 'reject']), note: z.string().trim().max(500).optional(), row_version: z.number().int().min(1) }),
  async handler({ user }, i) {
    if (i.decision === 'reject' && !i.note) throw badRequest('Say why it was rejected so the player can fix it');
    return tx(async (c) => {
      const m = (await c.query(LOCK, [i.id])).rows[0];
      if (!m || !(await canReview(user, m, c))) throw notFound('Career entry');
      if (!m.team_id && !m.organisation_id && !isAdmin(user)) throw forbidden('Only the platform team can verify a club that is not listed');
      if (await isYouth(m.user_id, c) && !(await hasConsent(m.user_id, 'participation', c))) throw conflict('A guardian has not given current consent for participation', { code: 'guardian_consent_required' });
      if (m.verification_status !== 'pending') throw conflict('This entry is not waiting for review', { code: 'not_pending' });
      if (m.row_version !== i.row_version) throw stale(m);
      const ok = i.decision === 'verify';
      await c.query(`UPDATE career_memberships SET verification_status=$2, verified_by=$3, verified_at=now(), review_note=$4, row_version=row_version+1, updated_at=now() WHERE id=$1`,
        [i.id, ok ? 'verified' : 'rejected', user.id, i.note ?? null]);
      await snapshot(c, i.id, ok ? 'verified' : 'rejected', user.id, i.note);
      await audit(c, user.id, `career_${i.decision}`, 'career_memberships', i.id);
      await notify(c, m.user_id, { kind: ok ? 'career_verified' : 'career_rejected', title: ok ? 'A club verified your membership' : 'A club could not verify your membership', body: i.note ?? 'Open your career timeline to see it.', data: { career_entry_id: i.id } });
      return one_(i.id, c);
    });
  },
});

cap({
  name: 'export_my_career', method: 'GET', path: '/me/career/export', tag: TAG,
  summary: 'Export your career timeline as CSV (club, sport, season, dates, position, level, verification status). Evidence references and review notes are never included. A young person\'s export is made by a verified guardian (pass user_id).',
  input: z.object({ user_id: id.optional() }),
  async handler({ user }, i) {
    const target = await subject(user, i.user_id, { share: true });
    const rows = await many(`${CAREER_VIEW_SQL} WHERE c.user_id=$1 AND c.archived_at IS NULL AND ${extVisible()} ORDER BY c.starts_on DESC, c.id`, [target]);
    await audit(null, user.id, 'export_career', 'users', target);
    const cols = ['sport', 'club', 'unlisted', 'season_label', 'starts_on', 'ends_on', 'position', 'competition_level', 'jersey_no', 'verification_status', 'verified_at', 'verified_via', 'external_source'];
    return { filename: 'career-timeline.csv', rows: rows.length, csv: toCsv(cols, rows) };
  },
});
