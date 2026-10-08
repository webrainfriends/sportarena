import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, mustFind, PUBLIC_USER } from '../helpers.js';
import { roles as roleDefs, ROSTER_ROLES, TARGET_TYPES, vocabularies } from '../ontology/iptc.js';
import { validateAttributes, mergeAttributes } from '../ontology/fields.js';
import { loadTarget, canManageTarget } from './games.js';
import { hiddenYouth, requireConsent } from '../youth.js';

const role = z.enum(Object.keys(roleDefs));
const targetType = z.enum(TARGET_TYPES);

cap({
  name: 'associate_person', method: 'POST', path: '/associations', tag: 'Associations', status: 201,
  summary: 'Associate a person with a game, team, event or venue in a role (player, captain, coach, referee, physio, scorer, sponsor…). Managers of the target add people (they must accept an invitation, except team rosters which are added directly); people can request to join non-team targets themselves. The person must hold the matching profile (e.g. coach role needs a coach profile).',
  input: z.object({ user_id: id.optional().describe('defaults to you'), role, target_type: targetType, target_id: id, position: z.string().max(40).optional(), uniform_no: z.number().int().min(0).max(999).optional(), player_status: z.enum(vocabularies.playerStatus.terms).optional(), attributes: z.record(z.string(), z.any()).default({}) }),
  async handler({ user }, i) {
    const def = roleDefs[i.role];
    if (!def.targets.includes(i.target_type)) throw badRequest(`Role "${i.role}" cannot be attached to a ${i.target_type}; allowed: ${def.targets.join(', ')}`);
    const subjectId = i.user_id ?? user.id;
    const subject = await mustFind('users', subjectId, 'id, roles, handle');
    if (def.profile && !subject.roles.includes(def.profile)) throw conflict(`@${subject.handle} has no ${def.profile} profile, which the ${i.role} role needs`);
    await requireConsent(subjectId, 'participation', 'taking part');
    const target = await loadTarget(i.target_type, i.target_id);
    const manager = await canManageTarget(user, i.target_type, target);
    const self = subjectId === user.id;
    if (!manager && !self) throw forbidden('Only a manager of this ' + i.target_type + ' can associate other people with it');

    if (i.target_type === 'team') {
      if (!manager) throw forbidden('Ask a team manager to add you to the roster');
      if (!ROSTER_ROLES.includes(i.role)) throw badRequest(`Team rosters take: ${ROSTER_ROLES.join(', ')}`);
      const m = await one(
        `INSERT INTO team_members(team_id, user_id, role, jersey_no, status) VALUES ($1,$2,$3,$4,'active')
         ON CONFLICT (team_id, user_id) DO UPDATE SET role=EXCLUDED.role, jersey_no=coalesce(EXCLUDED.jersey_no, team_members.jersey_no), status='active' RETURNING *`,
        [target.id, subjectId, i.role, i.uniform_no ?? null]);
      return { association_id: null, user_id: m.user_id, role: m.role, target_type: 'team', target_id: m.team_id, status: m.status, uniform_no: m.jersey_no };
    }

    let attributes = {};
    if (Object.keys(i.attributes).length) {
      if (i.target_type !== 'game') throw badRequest('attributes are only supported on game associations');
      attributes = await validateAttributes(await one('SELECT * FROM sports WHERE id=$1', [target.sport_id]), 'association', i.attributes);
    }
    const status = manager && self ? 'active' : manager ? 'invited' : 'requested';
    return one(
      `INSERT INTO associations(user_id, role, target_type, target_id, status, position, uniform_no, player_status, attributes, invited_by, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $5='active' THEN now() END) RETURNING *`,
      [subjectId, i.role, i.target_type, i.target_id, status, i.position ?? null, i.uniform_no ?? null, i.player_status ?? null, attributes, manager ? user.id : null]);
  },
});

cap({
  name: 'list_associations', method: 'GET', path: '/associations', tag: 'Associations', auth: 'public',
  summary: 'Who is associated with what. By target (`target_type`+`target_id`: the roster/crew of a game, team, event or venue) or by person (`user_id`: everything they play, coach or officiate). Public callers see active associations only; pending ones (invited/requested/…) are visible to the person and to the target\'s managers. `mine` lists all of yours.',
  input: z.object({ user_id: id.optional(), target_type: targetType.optional(), target_id: id.optional(), role: role.optional(), status: z.enum(vocabularies.membershipStatus.terms).default('active'), mine: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    const who = i.mine && user ? user.id : i.user_id ?? null;
    if (!who && !(i.target_type && i.target_id)) throw badRequest('Give user_id, or target_type and target_id');
    if (i.status !== 'active' && !isAdmin(user)) {
      if (!user) throw forbidden('Sign in to see pending associations');
      if (who !== user.id) {
        if (!(i.target_type && i.target_id)) throw forbidden();
        if (!(await canManageTarget(user, i.target_type, await loadTarget(i.target_type, i.target_id)))) throw forbidden();
      }
    }
    const rows = await many(
      `SELECT a.id AS association_id, a.role, a.target_type, a.target_id, a.status, a.position, a.uniform_no, a.player_status, a.attributes, a.started_at, a.ended_at, ${PUBLIC_USER},
              CASE a.target_type WHEN 'game' THEN (SELECT title FROM games WHERE id=a.target_id) WHEN 'team' THEN (SELECT name FROM teams WHERE id=a.target_id)
                                 WHEN 'event' THEN (SELECT name FROM events WHERE id=a.target_id) WHEN 'venue' THEN (SELECT name FROM venues WHERE id=a.target_id) END AS target_name
         FROM person_associations a JOIN users u ON u.id=a.user_id
        WHERE ($1::uuid IS NULL OR a.user_id=$1) AND ($2::text IS NULL OR a.target_type=$2) AND ($3::uuid IS NULL OR a.target_id=$3)
          AND ($4::text IS NULL OR a.role=$4) AND a.status=$5
        ORDER BY a.target_type, a.role, u.display_name LIMIT $6 OFFSET $7`,
      [who, i.target_type ?? null, i.target_id ?? null, i.role ?? null, i.status, i.limit, i.offset]);
    const hidden = await hiddenYouth(user, rows.map((r) => r.id));
    return rows.filter((r) => !hidden.has(r.id));
  },
});

cap({
  name: 'respond_association', method: 'POST', path: '/associations/:id/respond', tag: 'Associations',
  summary: 'Accept or decline: the invited person answers an invitation; a manager of the target answers a join request.',
  input: z.object({ id, decision: z.enum(['accept', 'decline']) }),
  async handler({ user }, i) {
    const a = await mustFind('associations', i.id);
    if (a.status === 'invited') { if (a.user_id !== user.id) throw forbidden('Only the invited person can answer'); }
    else if (a.status === 'requested') { if (!(await canManageTarget(user, a.target_type, await loadTarget(a.target_type, a.target_id)))) throw forbidden('Only a manager of the target can answer a request'); }
    else throw conflict(`Nothing to answer: association is ${a.status}`);
    return one("UPDATE associations SET status=$2, started_at=CASE WHEN $2='active' THEN now() END WHERE id=$1 RETURNING *", [a.id, i.decision === 'accept' ? 'active' : 'declined']);
  },
});

cap({
  name: 'update_association', method: 'PATCH', path: '/associations/:id', tag: 'Associations',
  summary: 'Set position, jersey number, line-up status or per-game stats (attributes, keys from get_game_fields scope association). Target manager, or an active referee/scorer of the game for attributes.',
  input: z.object({ id, position: z.string().max(40).nullable().optional(), uniform_no: z.number().int().min(0).max(999).nullable().optional(), player_status: z.enum(vocabularies.playerStatus.terms).nullable().optional(), attributes: z.record(z.string(), z.any()).optional() }),
  async handler({ user }, i) {
    const a = await mustFind('associations', i.id);
    if (a.status !== 'active') throw conflict('Only active associations can be edited');
    const target = await loadTarget(a.target_type, a.target_id);
    const manager = await canManageTarget(user, a.target_type, target);
    const official = !manager && a.target_type === 'game' && !!(await one("SELECT 1 FROM associations WHERE target_type='game' AND target_id=$1 AND user_id=$2 AND status='active' AND role IN ('referee','umpire','linesman','scorer')", [a.target_id, user.id]));
    if (!manager && !official) throw forbidden();
    if (official && (i.position !== undefined || i.uniform_no !== undefined || i.player_status !== undefined)) throw forbidden('Officials can only record stats');
    let attributes = a.attributes;
    if (i.attributes) {
      if (a.target_type !== 'game') throw badRequest('attributes are only supported on game associations');
      attributes = mergeAttributes(a.attributes, i.attributes, await validateAttributes(await one('SELECT * FROM sports WHERE id=$1', [target.sport_id]), 'association', i.attributes, { partial: true }));
    }
    const pick = (k) => (i[k] === undefined ? a[k] : i[k]);
    return one('UPDATE associations SET position=$2, uniform_no=$3, player_status=$4, attributes=$5 WHERE id=$1 RETURNING *', [a.id, pick('position'), pick('uniform_no'), pick('player_status'), attributes]);
  },
});

cap({
  name: 'end_association', method: 'DELETE', path: '/associations/:id', tag: 'Associations',
  summary: 'End an association (the person themselves, or a manager of the target). For team rosters use leave_team.', input: z.object({ id }),
  async handler({ user }, i) {
    const a = await mustFind('associations', i.id);
    if (a.user_id !== user.id && !(await canManageTarget(user, a.target_type, await loadTarget(a.target_type, a.target_id)))) throw forbidden();
    if (['ended', 'declined'].includes(a.status)) throw notFound('Active association');
    return one("UPDATE associations SET status='ended', ended_at=now() WHERE id=$1 RETURNING *", [a.id]);
  },
});
