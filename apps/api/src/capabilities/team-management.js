// Team management for owners / managers: roster availability and rates, invitations, who is selected for which
// event or match (squads), the team schedule, and a settlement ledger for fees owed to players and coaches.
// Recruiting (players or a coach from the wider community) goes through the billboard, with team_id set.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, mustFind, PUBLIC_USER } from '../helpers.js';
import { notify } from '../notify.js';
import { canManageTeam } from './teams.js';

const availability = z.enum(['available', 'tentative', 'unavailable', 'injured']);
const rateUnit = z.enum(['match', 'hour', 'month', 'season']);
const memberRole = z.enum(['captain', 'player', 'coach', 'manager', 'physio']);
const squadRole = z.enum(['player', 'captain', 'vice_captain', 'substitute', 'coach', 'manager', 'physio']);

/** owner, admin or a 'manager' member — money matters are not delegated to captains */
export async function canManageMoney(user, team) {
  if (isAdmin(user) || team.owner_id === user.id) return true;
  return !!(await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active' AND role='manager'", [team.id, user.id]));
}

const membership = (teamId, userId, client) => (client ?? { query }).query('SELECT * FROM team_members WHERE team_id=$1 AND user_id=$2', [teamId, userId]).then((r) => r.rows[0]);
const isActiveMember = async (teamId, userId) => (await membership(teamId, userId))?.status === 'active';

async function mustManage(user, teamId) {
  const t = await mustFind('teams', teamId);
  if (!(await canManageTeam(user, t))) throw forbidden('Only the team owner or managers can do this');
  return t;
}
async function mustBeMemberOrManager(user, teamId) {
  const t = await mustFind('teams', teamId);
  if (!(await canManageTeam(user, t)) && !(await isActiveMember(teamId, user.id))) throw forbidden('Team members only');
  return t;
}

// ------------------------------------------------------------------ roster

cap({
  name: 'get_team_roster', method: 'GET', path: '/teams/:id/roster', tag: 'Team management',
  summary: 'Roster with availability for team members. Owners/managers also see positions, notes, rates and pending invitations.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const t = await mustBeMemberOrManager(user, i.id);
    const manager = await canManageTeam(user, t);
    const money_ = await canManageMoney(user, t);
    const rows = await many(
      `SELECT ${PUBLIC_USER}, m.role AS team_role, m.status, m.jersey_no, m.position, m.availability, m.availability_note, m.availability_set_at, m.joined_at,
              m.notes, m.rate_cents, m.rate_unit
         FROM team_members m JOIN users u ON u.id=m.user_id
        WHERE m.team_id=$1 AND m.status IN ('active','invited') ORDER BY m.status, m.jersey_no NULLS LAST, u.display_name`, [i.id]);
    return {
      team_id: t.id, currency: t.currency, can_manage: manager, can_manage_money: money_,
      members: rows.map((r) => ({
        ...r, is_owner: r.id === t.owner_id,
        notes: manager ? r.notes : undefined,
        rate_cents: money_ || r.id === user.id ? r.rate_cents : undefined, rate_unit: money_ || r.id === user.id ? r.rate_unit : undefined,
        status: r.status,
      })).filter((r) => manager || r.status === 'active'),
    };
  },
});

cap({
  name: 'update_team_member', method: 'PATCH', path: '/teams/:id/members/:user_id', tag: 'Team management',
  summary: 'Change a member\'s role, jersey, position, notes or agreed rate. Rates need the owner or a manager; only the owner can make someone a manager.',
  input: z.object({
    id, user_id: id, role: memberRole.optional(), jersey_no: z.number().int().min(0).max(999).nullable().optional(), position: z.string().max(40).nullable().optional(),
    notes: z.string().max(500).nullable().optional(), rate_cents: money.nullable().optional(), rate_unit: rateUnit.optional(),
  }),
  async handler({ user }, i) {
    const t = await mustManage(user, i.id);
    const m = await membership(i.id, i.user_id);
    if (!m || m.status === 'left') throw notFound('Member');
    if ((i.role === 'manager' || (m.role === 'manager' && i.role)) && t.owner_id !== user.id && !isAdmin(user)) throw forbidden('Only the owner can grant or change the manager role');
    if (i.user_id === t.owner_id && i.role && i.role !== 'manager') throw conflict('The owner stays a manager');
    if ((i.rate_cents !== undefined || i.rate_unit) && !(await canManageMoney(user, t))) throw forbidden('Only the owner or a manager can set rates');
    const sets = [], vals = [i.id, i.user_id];
    for (const k of ['role', 'jersey_no', 'position', 'notes', 'rate_cents', 'rate_unit']) if (i[k] !== undefined) { vals.push(i[k]); sets.push(`${k}=$${vals.length}`); }
    if (!sets.length) throw badRequest('Nothing to update');
    return one(`UPDATE team_members SET ${sets.join(', ')} WHERE team_id=$1 AND user_id=$2 RETURNING team_id, user_id, role, jersey_no, position, notes, rate_cents, rate_unit, status`, vals);
  },
});

cap({
  name: 'set_member_availability', method: 'PATCH', path: '/teams/:id/members/:user_id/availability', tag: 'Team management',
  summary: 'Set whether a player is available, tentative, unavailable or injured. Players set their own; owners/managers can set anyone\'s.',
  input: z.object({ id, user_id: id, availability, note: z.string().max(200).nullable().optional() }),
  async handler({ user }, i) {
    const t = await mustFind('teams', i.id);
    if (i.user_id !== user.id && !(await canManageTeam(user, t))) throw forbidden();
    const r = await one("UPDATE team_members SET availability=$3, availability_note=$4, availability_set_at=now() WHERE team_id=$1 AND user_id=$2 AND status='active' RETURNING user_id, availability, availability_note, availability_set_at", [i.id, i.user_id, i.availability, i.note ?? null]);
    if (!r) throw notFound('Active member');
    return r;
  },
});

// ------------------------------------------------------------------ invitations (people and coaches from the wider community)

cap({
  name: 'invite_team_member', method: 'POST', path: '/teams/:id/invitations', tag: 'Team management', status: 201,
  summary: 'Invite a player, coach or physio from the community (find them with search_people / list_coaches). They join once they accept. You may offer a rate.',
  input: z.object({ id, user_id: id, role: memberRole.default('player'), jersey_no: z.number().int().min(0).max(999).optional(), rate_cents: money.optional(), rate_unit: rateUnit.default('match'), message: z.string().max(300).optional() }),
  async handler({ user }, i) {
    const t = await mustManage(user, i.id);
    if (i.role === 'manager' && t.owner_id !== user.id && !isAdmin(user)) throw forbidden('Only the owner can invite a manager');
    if (i.rate_cents !== undefined && !(await canManageMoney(user, t))) throw forbidden('Only the owner or a manager can offer a rate');
    await mustFind('users', i.user_id, 'id');
    const prior = await membership(i.id, i.user_id);
    if (prior?.status === 'active') throw conflict('Already on the team');
    const row = await one(
      `INSERT INTO team_members(team_id, user_id, role, jersey_no, status, rate_cents, rate_unit, invited_by) VALUES ($1,$2,$3,$4,'invited',$5,$6,$7)
       ON CONFLICT (team_id, user_id) DO UPDATE SET role=EXCLUDED.role, jersey_no=EXCLUDED.jersey_no, status='invited', rate_cents=EXCLUDED.rate_cents, rate_unit=EXCLUDED.rate_unit, invited_by=EXCLUDED.invited_by
       RETURNING team_id, user_id, role, status, rate_cents, rate_unit`,
      [i.id, i.user_id, i.role, i.jersey_no ?? null, i.rate_cents ?? null, i.rate_unit, user.id]);
    await notify(null, i.user_id, { kind: 'team_invite', title: `${t.name} invited you as ${i.role}`, body: i.message ?? 'Open the team to accept or decline.', data: { team_id: t.id } });
    return row;
  },
});

cap({
  name: 'list_my_team_invites', method: 'GET', path: '/me/team-invites', tag: 'Team management', summary: 'Teams that invited you and are waiting for your answer.', input: z.object({}),
  handler: ({ user }) => many(
    `SELECT t.id AS team_id, t.name, t.emoji, t.color, t.city, s.name AS sport, s.emoji AS sport_emoji, m.role, m.rate_cents, m.rate_unit, t.currency, m.joined_at AS invited_at
       FROM team_members m JOIN teams t ON t.id=m.team_id JOIN sports s ON s.id=t.sport_id WHERE m.user_id=$1 AND m.status='invited' ORDER BY m.joined_at DESC`, [user.id]),
});

cap({
  name: 'respond_to_team_invite', method: 'POST', path: '/teams/:id/invitations/respond', tag: 'Team management',
  summary: 'Accept (you join the roster) or decline a team invitation addressed to you.', input: z.object({ id, accept: z.boolean() }),
  async handler({ user }, i) {
    const t = await mustFind('teams', i.id);
    const r = await one("UPDATE team_members SET status=$3, joined_at=CASE WHEN $3='active' THEN now() ELSE joined_at END WHERE team_id=$1 AND user_id=$2 AND status='invited' RETURNING team_id, user_id, role, status", [i.id, user.id, i.accept ? 'active' : 'left']);
    if (!r) throw notFound('Invitation');
    await notify(null, t.owner_id, { kind: 'team_invite_reply', title: `${user.display_name} ${i.accept ? 'accepted' : 'declined'} your invitation to ${t.name}`, body: '', data: { team_id: t.id } });
    return r;
  },
});

// ------------------------------------------------------------------ squads: who plays which event / match, in what role

/** exactly one of event_id / fixture_id; returns { event_id, fixture_id } with the event filled in for a fixture, after checking the team takes part */
async function squadScope(c, team, i) {
  if (!!i.event_id === !!i.fixture_id) throw badRequest('Give either event_id or fixture_id');
  if (i.fixture_id) {
    const f = (await c.query('SELECT * FROM fixtures WHERE id=$1', [i.fixture_id])).rows[0];
    if (!f) throw notFound('Fixture');
    if (f.home_team_id !== team.id && f.away_team_id !== team.id) throw badRequest('Your team is not playing in that fixture');
    if (['completed', 'cancelled'].includes(f.status)) throw conflict(`Fixture is ${f.status}`);
    return { event_id: f.event_id, fixture_id: f.id };
  }
  const e = (await c.query("SELECT 1 FROM event_entries WHERE event_id=$1 AND team_id=$2 AND status IN ('pending','accepted')", [i.event_id, team.id])).rows[0];
  if (!e) throw badRequest('Your team is not entered in that event');
  return { event_id: i.event_id, fixture_id: null };
}

const SQUAD_SELECT = `SELECT q.id AS squad_id, q.team_id, q.event_id, q.fixture_id, q.role, q.position, q.status, q.responded_at, ${PUBLIC_USER}, m.jersey_no, m.availability, m.availability_note
  FROM team_squads q JOIN users u ON u.id=q.user_id LEFT JOIN team_members m ON m.team_id=q.team_id AND m.user_id=q.user_id`;

cap({
  name: 'set_squad', method: 'POST', path: '/teams/:id/squad', tag: 'Team management',
  summary: 'Pick the players and staff (with roles) for an event or a single match. The list you send becomes the squad: others are dropped, new people are notified and can confirm or decline. Unavailable/injured players are refused unless allow_unavailable.',
  input: z.object({
    id, event_id: id.optional(), fixture_id: id.optional(), allow_unavailable: z.boolean().default(false),
    members: z.array(z.object({ user_id: id, role: squadRole.default('player'), position: z.string().max(40).optional() })).max(80),
  }),
  async handler({ user }, i) {
    const team = await mustManage(user, i.id);
    return tx(async (c) => {
      const scope = await squadScope(c, team, i);
      const ids = i.members.map((m) => m.user_id);
      if (new Set(ids).size !== ids.length) throw badRequest('A person appears twice in the squad');
      const roster = new Map((await c.query("SELECT user_id, availability FROM team_members WHERE team_id=$1 AND status='active'", [team.id])).rows.map((r) => [r.user_id, r]));
      const strangers = ids.filter((u) => !roster.has(u));
      if (strangers.length) throw badRequest('Only active team members can be selected', { user_ids: strangers });
      if (!i.allow_unavailable) {
        const out = ids.filter((u) => ['unavailable', 'injured'].includes(roster.get(u).availability));
        if (out.length) throw conflict('Some selected people are marked unavailable or injured', { user_ids: out });
      }
      const where = 'team_id=$1 AND event_id IS NOT DISTINCT FROM $2 AND fixture_id IS NOT DISTINCT FROM $3';
      const sc = [team.id, scope.event_id, scope.fixture_id];
      const before = new Map((await c.query(`SELECT user_id, status FROM team_squads WHERE ${where}`, sc)).rows.map((r) => [r.user_id, r.status]));
      await c.query(`UPDATE team_squads SET status='dropped', responded_at=NULL WHERE ${where} AND status<>'dropped' AND NOT (user_id = ANY($4::uuid[]))`, [...sc, ids]);
      const newly = [];
      for (const m of i.members) {
        const prev = before.get(m.user_id);
        await c.query(
          `INSERT INTO team_squads(team_id, event_id, fixture_id, user_id, role, position, selected_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (team_id, event_id, fixture_id, user_id) DO UPDATE SET role=EXCLUDED.role, position=EXCLUDED.position, selected_by=EXCLUDED.selected_by,
             status=CASE WHEN team_squads.status IN ('dropped','declined') THEN 'selected' ELSE team_squads.status END,
             responded_at=CASE WHEN team_squads.status IN ('dropped','declined') THEN NULL ELSE team_squads.responded_at END`,
          [...sc, m.user_id, m.role, m.position ?? null, user.id]);
        if (!prev || ['dropped', 'declined'].includes(prev)) newly.push(m.user_id);
      }
      const label = scope.fixture_id
        ? (await c.query("SELECT coalesce(e.name,'match') AS n, f.scheduled_at FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1", [scope.fixture_id])).rows[0]
        : (await c.query('SELECT name AS n FROM events WHERE id=$1', [scope.event_id])).rows[0];
      for (const u of newly) if (u !== user.id) await notify(c, u, { kind: 'team_selection', title: `${team.name}: you are selected for ${label.n}`, body: 'Open the team to confirm or decline.', data: { team_id: team.id, event_id: scope.event_id, fixture_id: scope.fixture_id } });
      return (await c.query(`${SQUAD_SELECT} WHERE q.team_id=$1 AND q.event_id IS NOT DISTINCT FROM $2 AND q.fixture_id IS NOT DISTINCT FROM $3 AND q.status<>'dropped' ORDER BY q.role, u.display_name`, sc)).rows;
    });
  },
});

cap({
  name: 'get_squad', method: 'GET', path: '/teams/:id/squad', tag: 'Team management', summary: 'The selected squad for an event or match, with each person\'s response.',
  input: z.object({ id, event_id: id.optional(), fixture_id: id.optional() }),
  async handler({ user }, i) {
    await mustBeMemberOrManager(user, i.id);
    if (!!i.event_id === !!i.fixture_id) throw badRequest('Give either event_id or fixture_id');
    return many(`${SQUAD_SELECT} WHERE q.team_id=$1 AND q.status<>'dropped' AND ${i.fixture_id ? 'q.fixture_id=$2' : 'q.event_id=$2 AND q.fixture_id IS NULL'} ORDER BY q.role, u.display_name`, [i.id, i.fixture_id ?? i.event_id]);
  },
});

cap({
  name: 'respond_to_selection', method: 'PATCH', path: '/squads/:squad_id', tag: 'Team management',
  summary: 'Confirm or decline your selection for an event or match. The team owner is told.', input: z.object({ squad_id: id, status: z.enum(['confirmed', 'declined']) }),
  async handler({ user }, i) {
    const q = await mustFind('team_squads', i.squad_id);
    if (q.user_id !== user.id) throw forbidden('This selection is not yours');
    if (q.status === 'dropped') throw conflict('You are no longer in this squad');
    const r = await one('UPDATE team_squads SET status=$2, responded_at=now() WHERE id=$1 RETURNING id AS squad_id, status, responded_at', [i.squad_id, i.status]);
    const t = await mustFind('teams', q.team_id);
    await notify(null, t.owner_id, { kind: 'team_selection_reply', title: `${user.display_name} ${i.status} their selection for ${t.name}`, body: '', data: { team_id: t.id, event_id: q.event_id, fixture_id: q.fixture_id } });
    return r;
  },
});

cap({
  name: 'list_my_selections', method: 'GET', path: '/me/selections', tag: 'Team management', summary: 'Upcoming events and matches you are selected for, across all your teams.', input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT q.id AS squad_id, q.team_id, t.name AS team_name, t.emoji AS team_emoji, q.event_id, e.name AS event_name, q.fixture_id, f.scheduled_at, f.round, q.role, q.position, q.status
       FROM team_squads q JOIN teams t ON t.id=q.team_id LEFT JOIN events e ON e.id=q.event_id LEFT JOIN fixtures f ON f.id=q.fixture_id
      WHERE q.user_id=$1 AND q.status<>'dropped' AND (f.id IS NULL OR f.scheduled_at >= now() - interval '1 day') AND (e.id IS NULL OR e.status NOT IN ('completed','cancelled'))
      ORDER BY f.scheduled_at NULLS LAST, q.created_at LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'get_team_schedule', method: 'GET', path: '/teams/:id/schedule', tag: 'Team management',
  summary: 'The team\'s upcoming matches and the events it has entered, each with how many people are selected / confirmed.', input: z.object({ id, include_past: z.coerce.boolean().optional() }),
  async handler({ user }, i) {
    await mustBeMemberOrManager(user, i.id);
    const counts = (col) => `(SELECT json_build_object('selected', count(*) FILTER (WHERE q.status IN ('selected','confirmed')), 'confirmed', count(*) FILTER (WHERE q.status='confirmed'), 'declined', count(*) FILTER (WHERE q.status='declined'))
                               FROM team_squads q WHERE q.team_id=$1 AND ${col})`;
    const [fixtures, events] = await Promise.all([
      many(`SELECT f.id AS fixture_id, f.event_id, e.name AS event_name, f.round, f.scheduled_at, f.status, f.home_team_id, f.away_team_id, th.name AS home_name, ta.name AS away_name, f.home_score, f.away_score,
                   ${counts('q.fixture_id=f.id')} AS squad
              FROM fixtures f JOIN events e ON e.id=f.event_id LEFT JOIN teams th ON th.id=f.home_team_id LEFT JOIN teams ta ON ta.id=f.away_team_id
             WHERE (f.home_team_id=$1 OR f.away_team_id=$1) AND f.status<>'cancelled' AND ($2::boolean OR f.scheduled_at >= now() - interval '1 day')
             ORDER BY f.scheduled_at LIMIT 100`, [i.id, !!i.include_past]),
      many(`SELECT e.id AS event_id, e.name, e.kind, e.status, e.starts_on, e.ends_on, en.status AS entry_status, ${counts('q.event_id=e.id AND q.fixture_id IS NULL')} AS squad
              FROM event_entries en JOIN events e ON e.id=en.event_id WHERE en.team_id=$1 AND en.status IN ('pending','accepted') AND ($2::boolean OR e.status NOT IN ('completed','cancelled'))
             ORDER BY e.starts_on NULLS LAST LIMIT 100`, [i.id, !!i.include_past]),
    ]);
    return { fixtures, events };
  },
});

// ------------------------------------------------------------------ settlement ledger

const PAYOUT_COLS = `p.id, p.team_id, p.user_id, p.squad_id, p.event_id, p.fixture_id, p.kind, p.amount_cents, p.currency, p.status, p.note, p.due_on, p.paid_at, p.created_at, u.display_name, u.handle`;

cap({
  name: 'create_team_payout', method: 'POST', path: '/teams/:id/payouts', tag: 'Team settlement', status: 201,
  summary: 'Record an amount the team owes a player, coach or staff member (match fee, coaching fee, bonus, expense…). Owner or manager only. Amounts are in the team currency.',
  input: z.object({ id, user_id: id, kind: z.enum(['match_fee', 'coach_fee', 'session_fee', 'bonus', 'expense', 'other']).default('match_fee'), amount_cents: money, event_id: id.optional(), fixture_id: id.optional(), note: z.string().max(200).optional(), due_on: z.string().date().optional() }),
  async handler({ user }, i) {
    const t = await mustFind('teams', i.id);
    if (!(await canManageMoney(user, t))) throw forbidden('Only the owner or a manager can record payouts');
    const m = await membership(i.id, i.user_id);
    if (!m) throw badRequest('That person has never been on this team');
    return one('INSERT INTO team_payouts(team_id, user_id, event_id, fixture_id, kind, amount_cents, currency, note, due_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [i.id, i.user_id, i.event_id ?? null, i.fixture_id ?? null, i.kind, i.amount_cents, t.currency, i.note ?? null, i.due_on ?? null, user.id]);
  },
});

cap({
  name: 'create_squad_payouts', method: 'POST', path: '/teams/:id/payouts/from-squad', tag: 'Team settlement', status: 201,
  summary: 'Create the per-match fees for an event or match squad from each member\'s agreed rate (only rates set "per match"). Safe to repeat: existing fees are skipped.',
  input: z.object({ id, event_id: id.optional(), fixture_id: id.optional() }),
  async handler({ user }, i) {
    const t = await mustFind('teams', i.id);
    if (!(await canManageMoney(user, t))) throw forbidden('Only the owner or a manager can record payouts');
    if (!!i.event_id === !!i.fixture_id) throw badRequest('Give either event_id or fixture_id');
    return tx(async (c) => {
      const { rows } = await c.query(
        `SELECT q.id, q.user_id, q.role, q.event_id, q.fixture_id, m.rate_cents, m.rate_unit FROM team_squads q JOIN team_members m ON m.team_id=q.team_id AND m.user_id=q.user_id
          WHERE q.team_id=$1 AND q.status IN ('selected','confirmed') AND ${i.fixture_id ? 'q.fixture_id=$2' : 'q.event_id=$2 AND q.fixture_id IS NULL'}`, [i.id, i.fixture_id ?? i.event_id]);
      const created = [], skipped = [];
      for (const q of rows) {
        if (!q.rate_cents || q.rate_unit !== 'match') { skipped.push({ user_id: q.user_id, reason: q.rate_cents ? `rate is per ${q.rate_unit}, record it manually` : 'no rate set' }); continue; }
        const r = await c.query(
          `INSERT INTO team_payouts(team_id, user_id, squad_id, event_id, fixture_id, kind, amount_cents, currency, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (squad_id, kind) WHERE squad_id IS NOT NULL AND status <> 'cancelled' DO NOTHING RETURNING id, user_id, amount_cents`,
          [i.id, q.user_id, q.id, q.event_id, q.fixture_id, q.role === 'coach' ? 'coach_fee' : 'match_fee', q.rate_cents, t.currency, user.id]);
        if (r.rows[0]) created.push(r.rows[0]); else skipped.push({ user_id: q.user_id, reason: 'already recorded' });
      }
      return { created, skipped };
    });
  },
});

cap({
  name: 'list_team_payouts', method: 'GET', path: '/teams/:id/payouts', tag: 'Team settlement',
  summary: 'The settlement ledger. Owners/managers see everyone; other members see only their own entries.',
  input: z.object({ id, user_id: id.optional(), status: z.enum(['due', 'paid', 'cancelled']).optional(), ...page }),
  async handler({ user }, i) {
    const t = await mustBeMemberOrManager(user, i.id);
    const all = await canManageMoney(user, t);
    return many(`SELECT ${PAYOUT_COLS} FROM team_payouts p JOIN users u ON u.id=p.user_id WHERE p.team_id=$1 AND ($2::uuid IS NULL OR p.user_id=$2) AND ($3::text IS NULL OR p.status=$3) AND ($4 OR p.user_id=$5)
                  ORDER BY p.status='due' DESC, p.created_at DESC LIMIT $6 OFFSET $7`, [i.id, i.user_id ?? null, i.status ?? null, all, user.id, i.limit, i.offset]);
  },
});

cap({
  name: 'update_team_payout', method: 'PATCH', path: '/team-payouts/:id', tag: 'Team settlement',
  summary: 'Mark a payout paid, cancel it (kept in the ledger), or correct the amount / note while it is still due. The payee is notified when it is paid.',
  input: z.object({ id, status: z.enum(['paid', 'cancelled']).optional(), amount_cents: money.optional(), note: z.string().max(200).nullable().optional() }),
  async handler({ user }, i) {
    const p = await mustFind('team_payouts', i.id);
    const t = await mustFind('teams', p.team_id);
    if (!(await canManageMoney(user, t))) throw forbidden();
    if (p.status !== 'due') throw conflict(`Already ${p.status}`);
    if (i.status === undefined && i.amount_cents === undefined && i.note === undefined) throw badRequest('Nothing to update');
    const r = await one(`UPDATE team_payouts SET status=coalesce($2,status), amount_cents=coalesce($3,amount_cents), note=CASE WHEN $4::boolean THEN $5 ELSE note END,
                           paid_at=CASE WHEN $2='paid' THEN now() ELSE paid_at END, paid_by=CASE WHEN $2='paid' THEN $6::uuid ELSE paid_by END WHERE id=$1 RETURNING *`,
      [i.id, i.status ?? null, i.amount_cents ?? null, i.note !== undefined, i.note ?? null, user.id]);
    if (i.status === 'paid') await notify(null, p.user_id, { kind: 'team_payout_paid', title: `${t.name} marked a payment to you as paid`, body: `${r.amount_cents} ${r.currency} (minor units)`, data: { team_id: t.id, payout_id: r.id } });
    return r;
  },
});

cap({
  name: 'get_team_settlement', method: 'GET', path: '/teams/:id/settlement', tag: 'Team settlement',
  summary: 'Per-person totals: rate, what is still due and what has been paid. Owner or manager only.', input: z.object({ id }),
  async handler({ user }, i) {
    const t = await mustFind('teams', i.id);
    if (!(await canManageMoney(user, t))) throw forbidden();
    const people = await many(
      `SELECT ${PUBLIC_USER}, m.role AS team_role, m.status AS membership, m.rate_cents, m.rate_unit,
              coalesce(sum(p.amount_cents) FILTER (WHERE p.status='due'),0)::bigint AS due_cents, coalesce(sum(p.amount_cents) FILTER (WHERE p.status='paid'),0)::bigint AS paid_cents,
              count(p.id) FILTER (WHERE p.status='due')::int AS due_count
         FROM team_members m JOIN users u ON u.id=m.user_id LEFT JOIN team_payouts p ON p.team_id=m.team_id AND p.user_id=m.user_id
        WHERE m.team_id=$1 AND (m.status='active' OR EXISTS (SELECT 1 FROM team_payouts x WHERE x.team_id=m.team_id AND x.user_id=m.user_id))
        GROUP BY u.id, m.team_id, m.user_id ORDER BY due_cents DESC, u.display_name`, [i.id]);
    const sum = (k) => people.reduce((s, p) => s + Number(p[k]), 0);
    return { currency: t.currency, total_due_cents: sum('due_cents'), total_paid_cents: sum('paid_cents'), people: people.map((p) => ({ ...p, due_cents: Number(p.due_cents), paid_cents: Number(p.paid_cents) })) };
  },
});
