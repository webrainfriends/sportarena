import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isSupportedCurrency } from '../currency.js';
import { isAdmin, mustFind, mustOwn, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { hiddenYouth, requireConsent } from '../youth.js';
import { hasOrgGrant } from '../org-access.js';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** owner, a member with captain/manager role, or an owner/admin/coach of the team's organisation */
export async function canManageTeam(user, team) {
  if (isAdmin(user) || team.owner_id === user.id) return true;
  if (await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active' AND role IN ('captain','manager')", [team.id, user.id])) return true;
  return hasOrgGrant(user, team.organisation_id, ['owner', 'admin', 'coach']); // delegated by the team's organisation
}

cap({
  name: 'create_team', method: 'POST', path: '/teams', tag: 'Teams', status: 201,
  summary: 'Create a team. You become its owner and manager.',
  input: z.object({ name: z.string().min(2).max(60), sport: z.string(), emoji: z.string().max(8).optional(), color: color.optional(), city: z.string().max(80).optional(), currency: z.string().length(3).toUpperCase().optional().describe('settlement currency, default INR') }),
  async handler({ user }, i) {
    if (i.currency && !isSupportedCurrency(i.currency)) throw badRequest('Unsupported currency');
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    const t = await one('INSERT INTO teams(name, sport_id, owner_id, emoji, color, city, currency) VALUES ($1,$2,$3,coalesce($4,\'🔥\'),coalesce($5,\'#7C4DFF\'),$6,coalesce($7,\'INR\')) RETURNING *', [i.name, sport.id, user.id, i.emoji, i.color, i.city, i.currency]);
    await query("INSERT INTO team_members(team_id, user_id, role) VALUES ($1,$2,'manager')", [t.id, user.id]);
    return t;
  },
});

cap({
  name: 'list_teams', method: 'GET', path: '/teams', tag: 'Teams', auth: 'public', summary: 'Browse teams.',
  input: z.object({ sport: z.string().optional(), q: z.string().optional(), mine: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    return many(
      `SELECT t.*, s.name AS sport, s.emoji AS sport_emoji, (SELECT count(*)::int FROM team_members m WHERE m.team_id=t.id AND m.status='active') AS members
         FROM teams t JOIN sports s ON s.id=t.sport_id
        WHERE ($1::uuid IS NULL OR t.sport_id=$1) AND ($2::text IS NULL OR t.name ILIKE '%'||$2||'%')
          AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$3 AND m.status='active'))
        ORDER BY t.created_at DESC LIMIT $4 OFFSET $5`,
      [sport?.id ?? null, i.q ?? null, i.mine && user ? user.id : null, i.limit, i.offset],
    );
  },
});

cap({
  name: 'get_team', method: 'GET', path: '/teams/:id', tag: 'Teams', auth: 'public',
  summary: 'Team page: roster, trophy cabinet, rating.', input: z.object({ id }),
  async handler({ user }, i) {
    const t = await one('SELECT t.*, s.name AS sport, s.emoji AS sport_emoji FROM teams t JOIN sports s ON s.id=t.sport_id WHERE t.id=$1', [i.id]);
    if (!t) throw notFound('Team');
    const [members, awards, rating] = await Promise.all([
      many(`SELECT ${PUBLIC_USER}, m.role AS team_role, m.jersey_no FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND m.status='active' ORDER BY m.jersey_no NULLS LAST, u.display_name`, [i.id]),
      many('SELECT id, name, kind, awarded_at FROM awards WHERE team_id=$1 ORDER BY awarded_at DESC', [i.id]),
      one("SELECT round(avg(rating),2) AS avg, count(*)::int AS n FROM testimonials WHERE subject_type='team' AND subject_id=$1", [i.id]),
    ]);
    const mine = user ? await one('SELECT role, status, availability FROM team_members WHERE team_id=$1 AND user_id=$2', [i.id, user.id]) : null;
    // young members are only listed for people who may see them (themselves, their guardians, the team's managers)
    const hidden = await hiddenYouth(user, members.map((m) => m.id));
    return { ...t, members: members.filter((m) => !hidden.has(m.id)), members_restricted: hidden.size, awards, rating, can_manage: !!user && (await canManageTeam(user, t)), my_membership: mine };
  },
});

cap({
  name: 'update_team', method: 'PATCH', path: '/teams/:id', tag: 'Teams', summary: 'Edit team branding.',
  input: z.object({ id, name: z.string().min(2).max(60).optional(), emoji: z.string().max(8).optional(), color: color.optional(), city: z.string().max(80).optional() }),
  async handler({ user }, i) {
    const t = await mustFind('teams', i.id);
    if (!(await canManageTeam(user, t))) throw forbidden();
    return one('UPDATE teams SET name=coalesce($2,name), emoji=coalesce($3,emoji), color=coalesce($4,color), city=coalesce($5,city) WHERE id=$1 RETURNING *', [i.id, i.name, i.emoji, i.color, i.city]);
  },
});

cap({
  name: 'add_team_member', method: 'POST', path: '/teams/:id/members', tag: 'Teams', status: 201,
  summary: 'Add a person to a team roster (owner/captain/manager).',
  input: z.object({ id, user_id: id, role: z.enum(['captain', 'player', 'coach', 'manager', 'physio']).default('player'), jersey_no: z.number().int().min(0).max(999).optional() }),
  async handler({ user }, i) {
    const t = await mustFind('teams', i.id);
    if (!(await canManageTeam(user, t))) throw forbidden('Only team managers can edit the roster');
    await mustFind('users', i.user_id, 'id');
    if (!(await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [i.id, i.user_id]))) await requireConsent(i.user_id, 'participation', 'joining a team');
    return one(
      `INSERT INTO team_members(team_id, user_id, role, jersey_no, status) VALUES ($1,$2,$3,$4,'active')
       ON CONFLICT (team_id, user_id) DO UPDATE SET role=EXCLUDED.role, jersey_no=EXCLUDED.jersey_no, status='active' RETURNING *`,
      [i.id, i.user_id, i.role, i.jersey_no ?? null],
    );
  },
});

cap({
  name: 'leave_team', method: 'DELETE', path: '/teams/:id/members/:user_id', tag: 'Teams',
  summary: 'Leave a team, or remove a member if you manage it.', input: z.object({ id, user_id: id }),
  async handler({ user }, i) {
    const t = await mustFind('teams', i.id);
    if (i.user_id !== user.id && !(await canManageTeam(user, t))) throw forbidden();
    if (i.user_id === t.owner_id) throw conflict('The owner cannot leave their own team');
    const r = await query("UPDATE team_members SET status='left' WHERE team_id=$1 AND user_id=$2 AND status<>'left'", [i.id, i.user_id]);
    if (!r.rowCount) throw notFound('Membership');
    return { ok: true };
  },
});
