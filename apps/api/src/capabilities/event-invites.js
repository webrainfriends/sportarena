// Tournament invitations: rank candidates from past results, apply organiser rules, invite teams or individuals, seed the field.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { pool, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isAdmin, mustFind, standings } from '../helpers.js';
import { canManageTeam } from './teams.js';
import { eventForOrganizer } from './events.js';
import { notify } from '../notify.js';
import { loadTeamRatings, ratingOf, acceptedTeams } from '../tournament/data.js';

const dt = z.string().datetime({ offset: true });

// ---------------------------------------------------------------- rules (data, evaluated here)
const RULE_PARAMS = {
  invite_top_n: z.object({ n: z.number().int().min(1).max(500) }),
  min_rating: z.object({ value: z.number() }),
  min_games: z.object({ n: z.number().int().min(0).max(1000) }),
  city: z.object({ city: z.string().min(1).max(80) }),
  exclude_team: z.object({ team_id: id }),
  seeding: z.object({ method: z.enum(['rating', 'standings']) }),
  note: z.object({ text: z.string().min(1).max(500) }),
};

const loadRules = (c, eventId) => c.query('SELECT * FROM event_rules WHERE event_id=$1 AND removed_at IS NULL ORDER BY position, created_at', [eventId]).then((r) => r.rows);

/** Apply the enforceable rules to rated candidates (best first). `note` rules are informational. */
export function applyRules(candidates, rules) {
  let out = candidates.slice();
  for (const r of rules) {
    const p = r.params;
    if (r.kind === 'min_rating') out = out.filter((x) => x.rating >= p.value);
    else if (r.kind === 'min_games') out = out.filter((x) => x.played >= p.n);
    else if (r.kind === 'city') out = out.filter((x) => x.city && x.city.toLowerCase() === p.city.toLowerCase());
    else if (r.kind === 'exclude_team') out = out.filter((x) => x.team_id !== p.team_id);
  }
  const top = rules.find((r) => r.kind === 'invite_top_n');
  return top ? out.slice(0, top.params.n) : out;
}

cap({
  name: 'set_event_rules', method: 'POST', path: '/events/:id/rules', tag: 'Tournament',
  summary: 'Replace the event’s invitation/seeding rules (invite_top_n, min_rating, min_games, city, exclude_team, seeding, note). Earlier rules are kept as removed history.',
  input: z.object({ id, rules: z.array(z.object({ kind: z.enum(Object.keys(RULE_PARAMS)), params: z.record(z.string(), z.any()).default({}) })).max(30) }),
  async handler({ user }, i) {
    const parsed = i.rules.map((r) => {
      const ok = RULE_PARAMS[r.kind].safeParse(r.params);
      if (!ok.success) throw badRequest(`Rule ${r.kind}: ${ok.error.issues.map((x) => `${x.path.join('.') || 'params'} ${x.message}`).join('; ')}`);
      return { kind: r.kind, params: ok.data };
    });
    return tx(async (c) => {
      await eventForOrganizer(user, i.id, c);
      await c.query('UPDATE event_rules SET removed_at=now() WHERE event_id=$1 AND removed_at IS NULL', [i.id]);
      for (const [pos, r] of parsed.entries()) await c.query('INSERT INTO event_rules(event_id, kind, params, position, created_by) VALUES ($1,$2,$3,$4,$5)', [i.id, r.kind, r.params, pos, user.id]);
      return loadRules(c, i.id);
    });
  },
});

cap({
  name: 'list_event_rules', method: 'GET', path: '/events/:id/rules', tag: 'Tournament', auth: 'public', summary: 'The invitation/seeding rules an organiser published for this event.',
  input: z.object({ id }),
  async handler(_, i) { await mustFind('events', i.id, 'id'); return loadRules(pool, i.id); },
});

// ---------------------------------------------------------------- suggestions
cap({
  name: 'suggest_event_invitees', method: 'GET', path: '/events/:id/suggestions', tag: 'Tournament',
  summary: 'Rank teams (or individuals) of the event’s sport for invitation from past results — recency-weighted points and goal difference, shrunk for small samples — then apply the event rules. Already entered/invited teams are left out.',
  input: z.object({ id, target: z.enum(['teams', 'individuals']).default('teams'), city: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(30) }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    const rules = await loadRules(pool, ev.id);
    if (i.target === 'individuals') {
      const rows = await many(
        `SELECT u.id AS user_id, u.handle, u.display_name, coalesce(sum(p.points),0)::float AS rating, count(p.id)::int AS played
           FROM sport_profiles sp JOIN users u ON u.id=sp.user_id LEFT JOIN performances p ON p.user_id=u.id AND p.sport_id=sp.sport_id
          WHERE sp.sport_id=$1 AND sp.role='athlete'
            AND NOT EXISTS (SELECT 1 FROM event_entries e WHERE e.event_id=$2 AND e.user_id=u.id AND e.status <> 'withdrawn')
            AND NOT EXISTS (SELECT 1 FROM event_invitations n WHERE n.event_id=$2 AND n.user_id=u.id AND n.status='invited')
          GROUP BY u.id ORDER BY rating DESC, u.display_name LIMIT $3`, [ev.sport_id, ev.id, i.limit]);
      return { items: rows.map((r, k) => ({ rank: k + 1, ...r })), rules };
    }
    const ratings = await loadTeamRatings(pool, ev.sport_id);
    const teams = await many(
      `SELECT t.id AS team_id, t.name, t.emoji, t.city, t.owner_id FROM teams t
        WHERE t.sport_id=$1 AND ($3::text IS NULL OR lower(t.city)=lower($3))
          AND NOT EXISTS (SELECT 1 FROM event_entries e WHERE e.event_id=$2 AND e.team_id=t.id AND e.status <> 'withdrawn')
          AND NOT EXISTS (SELECT 1 FROM event_invitations n WHERE n.event_id=$2 AND n.team_id=t.id AND n.status='invited')`, [ev.sport_id, ev.id, i.city ?? null]);
    const rated = teams.map((t) => ({ ...t, ...ratingOf(ratings, t.team_id) })).sort((a, b) => b.rating - a.rating || b.played - a.played || a.name.localeCompare(b.name));
    const items = applyRules(rated, rules).slice(0, i.limit).map((t, k) => ({ rank: k + 1, ...t }));
    return { items, rules, field_average: ratings.mean ?? 0 };
  },
});

// ---------------------------------------------------------------- invitations
cap({
  name: 'invite_to_event', method: 'POST', path: '/events/:id/invitations', tag: 'Tournament', status: 201,
  summary: 'Invite teams and/or individuals to the event (organiser). Invitees are notified and accept or decline; accepting registers them (capacity respected). source=ranking marks invitations that came from suggest_event_invitees.',
  input: z.object({
    id, invitees: z.array(z.object({ team_id: id.optional(), user_id: id.optional(), seed_hint: z.number().int().min(1).optional() })).min(1).max(100),
    message: z.string().max(500).optional(), expires_at: dt.optional(), source: z.enum(['manual', 'ranking', 'rule']).default('manual'),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await eventForOrganizer(user, i.id, c);
      if (!['draft', 'open'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
      if (i.expires_at && new Date(i.expires_at) < new Date()) throw badRequest('expires_at is in the past');
      const ratings = await loadTeamRatings(c, ev.sport_id);
      const out = [];
      for (const v of i.invitees) {
        if (!!v.team_id === !!v.user_id) throw badRequest('Each invitee needs exactly one of team_id or user_id');
        let who;
        if (v.team_id) {
          const t = await mustFind('teams', v.team_id, '*', c);
          if (t.sport_id !== ev.sport_id) throw badRequest(`${t.name} plays a different sport`);
          who = t.owner_id;
        } else { await mustFind('users', v.user_id, 'id', c); who = v.user_id; }
        const entered = (await c.query("SELECT 1 FROM event_entries WHERE event_id=$1 AND team_id IS NOT DISTINCT FROM $2 AND user_id IS NOT DISTINCT FROM $3 AND status NOT IN ('withdrawn','rejected')", [ev.id, v.team_id ?? null, v.user_id ?? null])).rowCount;
        if (entered) throw conflict('Already registered for this event');
        const row = (await c.query(
          `INSERT INTO event_invitations(event_id, team_id, user_id, source, rating, seed_hint, message, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (event_id, coalesce(team_id, user_id)) WHERE status = 'invited' DO NOTHING RETURNING *`,
          [ev.id, v.team_id ?? null, v.user_id ?? null, i.source, v.team_id ? ratingOf(ratings, v.team_id).rating : null, v.seed_hint ?? null, i.message ?? null, user.id, i.expires_at ?? null])).rows[0];
        if (!row) throw conflict('That invitee already has an open invitation');
        await notify(c, who, { kind: 'event_invitation', title: `Invitation: ${ev.name}`, body: i.message || `You are invited to ${ev.name}. Open it to accept or decline.`, data: { event_id: ev.id, invitation_id: row.id } });
        out.push(row);
      }
      return { created: out.length, invitations: out };
    });
  },
});

const invitationView = `SELECT n.*, t.name AS team_name, t.emoji AS team_emoji, u.display_name AS user_name, e.name AS event_name, e.starts_on, e.ends_on
  FROM event_invitations n JOIN events e ON e.id=n.event_id LEFT JOIN teams t ON t.id=n.team_id LEFT JOIN users u ON u.id=n.user_id`;

cap({
  name: 'list_event_invitations', method: 'GET', path: '/events/:id/invitations', tag: 'Tournament', summary: 'Invitations sent for an event (organiser).',
  input: z.object({ id, status: z.enum(['invited', 'accepted', 'declined', 'withdrawn', 'expired']).optional() }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.id);
    return many(`${invitationView} WHERE n.event_id=$1 AND ($2::text IS NULL OR n.status=$2) ORDER BY n.created_at`, [i.id, i.status ?? null]);
  },
});

cap({
  name: 'list_my_event_invitations', method: 'GET', path: '/me/event-invitations', tag: 'Tournament', summary: 'Open invitations addressed to you or to teams you manage.',
  input: z.object({ status: z.enum(['invited', 'accepted', 'declined', 'withdrawn', 'expired']).default('invited'), ...page }),
  async handler({ user }, i) {
    return many(
      `${invitationView} WHERE n.status=$2 AND (n.user_id=$1 OR t.owner_id=$1 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=n.team_id AND m.user_id=$1 AND m.role IN ('captain','manager') AND m.status='active'))
         AND (n.status <> 'invited' OR n.expires_at IS NULL OR n.expires_at > now()) ORDER BY n.created_at DESC LIMIT $3 OFFSET $4`, [user.id, i.status, i.limit, i.offset]);
  },
});

async function inviteeAccess(c, user, inv) {
  if (inv.team_id) {
    const t = await mustFind('teams', inv.team_id, '*', c);
    if (!(await canManageTeam(user, t))) throw notFound('Invitation'); // do not leak existence to outsiders
    return t;
  }
  if (inv.user_id !== user.id && !isAdmin(user)) throw notFound('Invitation');
  return null;
}

cap({
  name: 'respond_event_invitation', method: 'POST', path: '/event-invitations/:id/respond', tag: 'Tournament',
  summary: 'Accept or decline an invitation (invited individual, or a manager of the invited team). Accepting registers the entrant as accepted unless the event is full.',
  input: z.object({ id, accept: z.boolean() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const inv0 = await mustFind('event_invitations', i.id, '*', c);
      const ev = (await c.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [inv0.event_id])).rows[0];
      const inv = (await c.query('SELECT * FROM event_invitations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      await inviteeAccess(c, user, inv);
      if (inv.status !== 'invited') throw conflict(`Invitation is already ${inv.status}`);
      if (inv.expires_at && inv.expires_at < new Date()) {
        await c.query("UPDATE event_invitations SET status='expired', responded_at=now() WHERE id=$1", [inv.id]);
        throw conflict('This invitation has expired');
      }
      let entry = null;
      if (i.accept) {
        if (!['draft', 'open'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
        const used = (await c.query("SELECT count(*)::int AS n FROM event_entries WHERE event_id=$1 AND status IN ('accepted','pending')", [ev.id])).rows[0].n;
        const prior = (await c.query('SELECT * FROM event_entries WHERE event_id=$1 AND team_id IS NOT DISTINCT FROM $2 AND user_id IS NOT DISTINCT FROM $3', [ev.id, inv.team_id, inv.user_id])).rows[0];
        if (prior && ['accepted', 'pending'].includes(prior.status)) {
          entry = (await c.query("UPDATE event_entries SET status='accepted', updated_at=now() WHERE id=$1 RETURNING *", [prior.id])).rows[0]; // a pending self-registration is simply confirmed
        } else {
          if (ev.capacity && used >= ev.capacity) throw conflict('Event is full; capacity reached');
          if (prior) entry = (await c.query("UPDATE event_entries SET status='accepted', withdrawn_at=NULL, updated_at=now(), created_at=now() WHERE id=$1 RETURNING *", [prior.id])).rows[0];
          else entry = (await c.query("INSERT INTO event_entries(event_id, team_id, user_id, status) VALUES ($1,$2,$3,'accepted') RETURNING *", [ev.id, inv.team_id, inv.user_id])).rows[0];
        }
        if (inv.seed_hint && inv.team_id) {
          await c.query(`INSERT INTO event_seeds(event_id, team_id, seed, source, rating, set_by) VALUES ($1,$2,$3,'manual',$4,$5)
                         ON CONFLICT (event_id, team_id) DO NOTHING`, [ev.id, inv.team_id, inv.seed_hint, inv.rating, inv.invited_by]);
        }
      }
      const out = (await c.query('UPDATE event_invitations SET status=$2, responded_at=now(), entry_id=$3 WHERE id=$1 RETURNING *', [inv.id, i.accept ? 'accepted' : 'declined', entry?.id ?? null])).rows[0];
      await notify(c, inv.invited_by, { kind: 'event_invitation', title: `Invitation ${out.status}`, body: `${ev.name}: an invitation was ${out.status}.`, data: { event_id: ev.id, invitation_id: inv.id } });
      return { invitation: out, entry };
    });
  },
});

cap({
  name: 'withdraw_event_invitation', method: 'POST', path: '/event-invitations/:id/withdraw', tag: 'Tournament',
  summary: 'Withdraw an open invitation (organiser). The record is kept as withdrawn.', input: z.object({ id, reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const inv = (await c.query('SELECT * FROM event_invitations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!inv) throw notFound('Invitation');
      await eventForOrganizer(user, inv.event_id, c);
      if (inv.status !== 'invited') throw conflict(`Invitation is already ${inv.status}`);
      return (await c.query("UPDATE event_invitations SET status='withdrawn', responded_at=now() WHERE id=$1 RETURNING *", [inv.id])).rows[0];
    });
  },
});

// ---------------------------------------------------------------- seeds
async function standingsOrder(c, ev) {
  return (await standings(ev.id, c)).filter((r) => r.played > 0).map((r) => r.team_id);
}

/** Fill every non-manual seed number around the manual ones. Upserts only (history of earlier computations is overwritten in place, never deleted). */
async function computeSeeds(c, ev, method, userId) {
  const teams = await acceptedTeams(c, ev.id);
  if (teams.length < 2) throw badRequest('Need at least 2 accepted teams');
  const ratings = await loadTeamRatings(c, ev.sport_id);
  const rated = new Map(teams.map((t) => [t.team_id, ratingOf(ratings, t.team_id)]));
  const byRating = (a, b) => rated.get(b.team_id).rating - rated.get(a.team_id).rating || a.name.localeCompare(b.name);
  let order;
  if (method === 'standings') {
    const st = await standingsOrder(c, ev);
    order = [...st, ...teams.filter((t) => !st.includes(t.team_id)).sort(byRating).map((t) => t.team_id)];
  } else order = teams.slice().sort(byRating).map((t) => t.team_id);
  const live = new Set(teams.map((t) => t.team_id));
  const manual = new Map((await c.query("SELECT team_id, seed FROM event_seeds WHERE event_id=$1 AND source='manual'", [ev.id])).rows.filter((r) => live.has(r.team_id)).map((r) => [r.team_id, r.seed]));
  const taken = new Set(manual.values());
  let next = 1;
  for (const team of order) {
    if (manual.has(team)) continue;
    while (taken.has(next)) next++;
    await c.query(`INSERT INTO event_seeds(event_id, team_id, seed, source, rating, set_by) VALUES ($1,$2,$3,'computed',$4,$5)
                   ON CONFLICT (event_id, team_id) DO UPDATE SET seed=EXCLUDED.seed, source='computed', rating=EXCLUDED.rating, set_by=EXCLUDED.set_by, updated_at=now()`, [ev.id, team, next, rated.get(team).rating, userId]);
    taken.add(next);
  }
}

const seedingMethod = async (c, ev, asked) => asked ?? (await loadRules(c, ev.id)).find((r) => r.kind === 'seeding')?.params.method ?? 'rating';

cap({
  name: 'compute_event_seeds', method: 'POST', path: '/events/:id/seeds/compute', tag: 'Tournament',
  summary: 'Seed the accepted teams (1 = strongest) from past-result ratings, or from the current standings (method=standings, or the event’s seeding rule). Manual seeds are kept and the other teams fill the remaining numbers.',
  input: z.object({ id, method: z.enum(['rating', 'standings']).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await eventForOrganizer(user, i.id, c);
      const method = await seedingMethod(c, ev, i.method);
      await computeSeeds(c, ev, method, user.id);
      return { method, seeds: await seedRows(c, ev.id) };
    });
  },
});

const seedRows = (c, eventId) => c.query(
  'SELECT s.team_id, t.name, t.emoji, s.seed, s.source, s.rating FROM event_seeds s JOIN teams t ON t.id=s.team_id JOIN event_entries e ON e.event_id=s.event_id AND e.team_id=s.team_id AND e.status=\'accepted\' WHERE s.event_id=$1 ORDER BY s.seed',
  [eventId]).then((r) => r.rows);

cap({
  name: 'set_event_seed', method: 'POST', path: '/events/:id/seeds/:team_id', tag: 'Tournament',
  summary: 'Pin a team to a seed number (organiser override). Another team already holding that number must be moved first.',
  input: z.object({ id, team_id: id, seed: z.number().int().min(1).max(256) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await eventForOrganizer(user, i.id, c);
      const ok = await c.query("SELECT 1 FROM event_entries WHERE event_id=$1 AND team_id=$2 AND status='accepted'", [i.id, i.team_id]);
      if (!ok.rowCount) throw badRequest('That team is not an accepted entrant');
      const clash = await c.query("SELECT 1 FROM event_seeds s JOIN event_entries e ON e.event_id=s.event_id AND e.team_id=s.team_id AND e.status='accepted' WHERE s.event_id=$1 AND s.seed=$2 AND s.team_id <> $3 AND s.source='manual'", [i.id, i.seed, i.team_id]);
      if (clash.rowCount) throw conflict(`Seed ${i.seed} is already pinned to another team`);
      await c.query(`INSERT INTO event_seeds(event_id, team_id, seed, source, set_by) VALUES ($1,$2,$3,'manual',$4)
                     ON CONFLICT (event_id, team_id) DO UPDATE SET seed=EXCLUDED.seed, source='manual', set_by=EXCLUDED.set_by, updated_at=now()`, [i.id, i.team_id, i.seed, user.id]);
      if ((await acceptedTeams(c, i.id)).length >= 2) await computeSeeds(c, ev, await seedingMethod(c, ev), user.id); // other teams renumber around the pin
      return seedRows(c, i.id);
    });
  },
});

cap({
  name: 'list_event_seeds', method: 'GET', path: '/events/:id/seeds', tag: 'Tournament', auth: 'public', summary: 'Seed numbers of the accepted teams.', input: z.object({ id }),
  async handler(_, i) { await mustFind('events', i.id, 'id'); return seedRows(pool, i.id); },
});
