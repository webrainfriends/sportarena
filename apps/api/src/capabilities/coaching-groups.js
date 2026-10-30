import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { PUBLIC_USER, isAdmin, sportBySlugOrId } from '../helpers.js';
import { RELATIONSHIP_SQL, hiddenYouth, requireRelationship } from '../coaching.js';
import { ownRecord, requireTeam } from './coaching-journal.js';

// Saved player groups (issue #580): a coach's own named, reusable sets of people they coach ("U14 defenders", "Batters"). A group only saves
// typing: it grants no access, and every time it is used each person's relationship (and, for a young person, the guardian's allowance) is checked
// again. People are removed softly (removed_at) and groups are archived, never deleted.
const TAG = 'Coaching groups';
const COACH = ['coach'];
const MAX_MEMBERS = 60;

/** Members of the groups with whether the coach still has a current relationship with each one. Young people the coach may not see are left out. */
async function withMembers(user, groups) {
  if (!groups.length) return [];
  const rows = await many(
    `SELECT m.group_id, ${PUBLIC_USER} FROM coaching_player_group_members m JOIN users u ON u.id=m.athlete_id
      WHERE m.group_id = ANY($1) AND m.removed_at IS NULL ORDER BY u.display_name, u.id`, [groups.map((g) => g.id)]);
  const ids = [...new Set(rows.map((r) => r.id))];
  const live = new Set((await many(`SELECT DISTINCT athlete_id FROM (${RELATIONSHIP_SQL}) r WHERE coach_id=$1 AND athlete_id = ANY($2)`, [user.id, ids])).map((r) => r.athlete_id));
  const hidden = isAdmin(user) ? new Set() : await hiddenYouth(user, ids);
  return groups.map((g) => {
    const members = rows.filter((r) => r.group_id === g.id && !hidden.has(r.id)).map(({ group_id, ...p }) => ({ ...p, current: live.has(p.id) }));
    return { ...g, members, member_count: members.length };
  });
}

const SELECT = `SELECT g.id, g.name, g.team_id, t.name AS team_name, s.slug AS sport_slug, s.name AS sport, g.row_version, g.created_at, g.updated_at
                  FROM coaching_player_groups g LEFT JOIN teams t ON t.id=g.team_id LEFT JOIN sports s ON s.id=g.sport_id`;

cap({
  name: 'save_coaching_player_group', method: 'POST', path: '/coaching/groups', tag: TAG, auth: COACH, status: 201,
  summary: 'Create a saved player group, or change one (send id and the row_version you loaded). The members you send become the group; anyone left out is kept as removed, not deleted. Everyone must be someone you currently coach, and for a team group an active player of that team.',
  input: z.object({
    id: id.optional(), row_version: z.number().int().min(1).optional(), name: z.string().trim().min(1).max(40),
    team_id: id.nullable().optional(), sport: z.string().max(80).nullable().optional().describe('sport slug or id; optional'),
    athlete_ids: z.array(id).min(1).max(MAX_MEMBERS),
  }),
  async handler({ user }, i) {
    const athletes = [...new Set(i.athlete_ids)];
    if (i.id && !i.row_version) throw badRequest('Send the row_version you loaded');
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    if (i.team_id) await requireTeam(user, i.team_id);
    for (const a of athletes) {
      await requireRelationship(user, a);
      if (i.team_id && !(await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active' AND role IN ('player','captain')", [i.team_id, a]))) throw badRequest('Everyone in a team group must be an active player of that team');
    }
    try {
      const g = await tx(async (c) => {
        let row;
        if (i.id) {
          row = (await c.query(
            `UPDATE coaching_player_groups SET name=$4, team_id=$5, sport_id=$6, row_version=row_version+1, updated_at=now()
              WHERE id=$1 AND coach_id=$2 AND row_version=$3 AND archived_at IS NULL RETURNING id`,
            [i.id, user.id, i.row_version, i.name, i.team_id ?? null, sport?.id ?? null])).rows[0];
          if (!row) {
            if (!(await c.query('SELECT 1 FROM coaching_player_groups WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL', [i.id, user.id])).rows.length) throw notFound('Group');
            throw conflict('This group was changed elsewhere - reload it first');
          }
          await c.query('UPDATE coaching_player_group_members SET removed_at=now() WHERE group_id=$1 AND removed_at IS NULL AND NOT (athlete_id = ANY($2))', [row.id, athletes]);
        } else {
          row = (await c.query('INSERT INTO coaching_player_groups(coach_id, team_id, sport_id, name) VALUES ($1,$2,$3,$4) RETURNING id', [user.id, i.team_id ?? null, sport?.id ?? null, i.name])).rows[0];
        }
        for (const a of athletes) await c.query('INSERT INTO coaching_player_group_members(group_id, athlete_id) VALUES ($1,$2) ON CONFLICT (group_id, athlete_id) DO UPDATE SET removed_at=NULL, added_at=CASE WHEN coaching_player_group_members.removed_at IS NULL THEN coaching_player_group_members.added_at ELSE now() END', [row.id, a]);
        return row;
      });
      const [full] = await withMembers(user, await many(`${SELECT} WHERE g.id=$1`, [g.id]));
      return full;
    } catch (e) {
      if (e.code === '23505') throw conflict('You already have a group with that name');
      throw e;
    }
  },
});

cap({
  name: 'list_coaching_player_groups', method: 'GET', path: '/coaching/groups', tag: TAG, auth: COACH,
  summary: 'Your saved player groups with their members, A to Z. Filter by team, sport or a name search. "current" says whether you still coach that person; people you may no longer see are left out.',
  input: z.object({ team_id: id.optional(), sport: z.string().max(80).optional(), q: z.string().trim().max(60).optional(), ...page }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) return [];
    const groups = await many(
      `${SELECT} WHERE g.coach_id=$1 AND g.archived_at IS NULL AND ($2::uuid IS NULL OR g.team_id=$2) AND ($3::uuid IS NULL OR g.sport_id=$3) AND ($4::text IS NULL OR g.name ILIKE '%'||$4||'%')
        ORDER BY lower(g.name), g.id LIMIT $5 OFFSET $6`, [user.id, i.team_id ?? null, sport?.id ?? null, i.q ?? null, i.limit, i.offset]);
    return withMembers(user, groups);
  },
});

cap({
  name: 'archive_coaching_player_group', method: 'DELETE', path: '/coaching/groups/:id', tag: TAG, auth: COACH,
  summary: 'Archive a saved group (kept, hidden from the list). Sessions that already used it keep their groups.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE coaching_player_groups SET archived_at=now(), updated_at=now() WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL RETURNING id, archived_at', [i.id, user.id]);
    if (!r) throw notFound('Group');
    return r;
  },
});

cap({
  name: 'use_coaching_player_group', method: 'POST', path: '/coaching/sessions/:id/use-group', tag: TAG, auth: COACH,
  summary: 'Put a saved group on a session: its people join the roster as "expected" (anyone already there is untouched) and the group becomes one of the session\'s named groups, so blocks can be aimed at it. People you no longer coach, or may not see, are skipped and reported - never added. A completed session cannot be changed.',
  input: z.object({ id, group_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const rec = await ownRecord(user, i.id, c);
      if (rec.status === 'completed') throw conflict('A completed session\'s roster and groups cannot be changed');
      const g = (await c.query('SELECT * FROM coaching_player_groups WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL', [i.group_id, user.id])).rows[0];
      if (!g) throw notFound('Group');
      if (g.team_id && rec.team_id && g.team_id !== rec.team_id) throw badRequest('This group belongs to a different team than the session');
      const members = (await c.query('SELECT athlete_id FROM coaching_player_group_members WHERE group_id=$1 AND removed_at IS NULL ORDER BY athlete_id', [g.id])).rows.map((r) => r.athlete_id);
      const live = new Set((await c.query(`SELECT DISTINCT athlete_id FROM (${RELATIONSHIP_SQL}) r WHERE coach_id=$1 AND athlete_id = ANY($2)`, [user.id, members])).rows.map((r) => r.athlete_id));
      const hidden = isAdmin(user) ? new Set() : await hiddenYouth(user, members);
      const ok = members.filter((m) => live.has(m) && !hidden.has(m)), skipped = members.filter((m) => !ok.includes(m));
      if (!ok.length) throw badRequest('You no longer coach anyone in this group');
      for (const a of ok) await c.query('INSERT INTO coaching_session_participants(session_record_id, athlete_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rec.id, a]);
      const others = (rec.groups ?? []).filter((x) => x.name.toLowerCase() !== g.name.toLowerCase());
      if (others.length >= 8) throw badRequest('A session can have at most 8 groups');
      const groups = [...others, { name: g.name, athlete_ids: ok }];
      await c.query('UPDATE coaching_session_records SET groups=$2, row_version=row_version+1, updated_at=now() WHERE id=$1', [rec.id, JSON.stringify(groups)]);
      return { session_record_id: rec.id, group: { id: g.id, name: g.name }, added: ok.length, skipped: skipped.length, groups };
    });
  },
});
