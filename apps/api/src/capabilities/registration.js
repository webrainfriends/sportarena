// Competition registration (issue #477): who is registered for which team in which competition, the policy that governs it (versioned),
// registration windows with exact timezone boundaries, divisions, roster lists and roster freeze. A competition season is the existing event;
// players, teams and team membership stay canonical and are only referenced. Eligibility checks, exceptions, clearance dependencies and match-lock
// snapshots live in registration-eligibility.js. Every rule is enforced here on the server, inside a transaction that locks the team's entry,
// so a stale or parallel client can never push a roster past its limit.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { hasOrgGrant } from '../org-access.js';
import { YOUTH_SQL, checkGuardianScope, guardianLink, requireConsent } from '../youth.js';
import { fromLocal, validTimezone } from '../booking/time.js';
import { canManageTeam } from './teams.js';
import { LIVE, LISTS, RULES, latestPolicy, protectedIds, PROTECTED_NAME } from '../registration.js';

const TAG = 'Competition registration';
const iso = z.string().date();
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');
const txt = (n) => z.string().trim().max(n);

export const REG_COLS = `r.id, r.event_id, r.team_id, t.name AS team_name, r.user_id, u.display_name, u.handle, u.avatar_emoji, u.avatar_color, r.division_id, d.name AS division_name,
  r.registration_no, r.status, r.roster_list, r.origin_class, r.source, r.window_kind, r.effective_from::text AS effective_from, r.effective_to::text AS effective_to,
  r.decided_at, r.row_version, r.created_at, r.updated_at`;
export const REG_FROM = `reg_registrations r JOIN teams t ON t.id=r.team_id JOIN users u ON u.id=r.user_id LEFT JOIN reg_divisions d ON d.id=r.division_id`;

/** Organiser, an organisation owner/admin, or the platform team. */
export async function isEventStaff(user, ev, c) {
  return isAdmin(user) || ev.organizer_id === user.id || (ev.organisation_id ? hasOrgGrant(user, ev.organisation_id, ['owner', 'admin'], c) : false);
}
export async function mustStaff(user, eventId, c) {
  const ev = (await (c ?? { query: (t, p) => one(t, p).then((r) => ({ rows: r ? [r] : [] })) }).query('SELECT * FROM events WHERE id=$1', [eventId])).rows[0];
  if (!ev) throw notFound('Event');
  if (!(await isEventStaff(user, ev, c))) throw forbidden('Only the organiser can do this');
  return ev;
}
export const getEvent = async (eventId, c) => {
  const ev = c ? (await c.query('SELECT * FROM events WHERE id=$1', [eventId])).rows[0] : await one('SELECT * FROM events WHERE id=$1', [eventId]);
  if (!ev) throw notFound('Event');
  return ev;
};

/** What the signed-in person may see of a competition's registrations: everything (staff), their managed teams, or only themselves. */
export async function viewer(user, ev) {
  if (await isEventStaff(user, ev)) return { staff: true, teams: new Set() };
  const entries = await many("SELECT t.* FROM event_entries e JOIN teams t ON t.id=e.team_id WHERE e.event_id=$1 AND e.status='accepted'", [ev.id]);
  const teams = new Set();
  for (const t of entries) if (await canManageTeam(user, t)) teams.add(t.id);
  return { staff: false, teams };
}

const mask = (rows, hidden) => rows.map((r) => (hidden.has(r.user_id) ? { ...r, display_name: PROTECTED_NAME, handle: null, avatar_emoji: null, avatar_url: null } : r));

async function snapshotRow(c, regId, action, actorId, { from, note } = {}) {
  const r = (await c.query('SELECT * FROM reg_registrations WHERE id=$1', [regId])).rows[0];
  const { note_enc, ...rest } = r;
  await c.query(
    `INSERT INTO reg_history(registration_id, row_version, action, from_status, to_status, from_list, to_list, actor_id, snapshot, note_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [regId, r.row_version, action, from?.status ?? null, r.status, from?.roster_list ?? null, r.roster_list, actorId, JSON.stringify(rest), note ? encrypt(note, 'reg_history.note') : null]);
  return r;
}

const stale = (cur) => conflict('This registration changed since you loaded it. Reload and try again.', { code: 'stale_version', row_version: cur.row_version, status: cur.status });
const isDup = (e) => e?.code === '23505';

// ------------------------------------------------------------------ setup: policy, divisions, windows

cap({
  name: 'get_registration_setup', method: 'GET', path: '/events/:id/registration/setup', tag: TAG,
  summary: 'The registration set-up of a competition: the current policy version and its rules, every earlier version, divisions and registration windows (with whether each is open now). Visible to the organiser and to managers of teams entered in the event.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await getEvent(i.id);
    const v = await viewer(user, ev);
    if (!v.staff && !v.teams.size && !(await one('SELECT 1 FROM reg_registrations WHERE event_id=$1 AND user_id=$2', [ev.id, user.id]))) throw notFound('Event');
    const policies = await many('SELECT id, version, enforcement, rules, note, created_by, created_at FROM reg_policies WHERE event_id=$1 ORDER BY version DESC', [ev.id]);
    const windows = await many(`SELECT id, kind, label, opens_at, closes_at, timezone, retired_at, (retired_at IS NULL AND opens_at <= now() AND closes_at > now()) AS open_now FROM reg_windows WHERE event_id=$1 ORDER BY opens_at, id`, [ev.id]);
    const divisions = await many('SELECT id, name, grade, born_on_or_after::text AS born_on_or_after, born_on_or_before::text AS born_on_or_before, archived_at FROM reg_divisions WHERE event_id=$1 ORDER BY lower(name)', [ev.id]);
    return { event: { id: ev.id, name: ev.name, status: ev.status, starts_on: ev.starts_on, ends_on: ev.ends_on }, policy: policies[0] ?? null, versions: policies.map(({ rules, ...p }) => p), windows, divisions, can_manage: v.staff };
  },
});

cap({
  name: 'publish_registration_policy', method: 'POST', path: '/events/:id/registration/policy', tag: TAG, status: 201,
  summary: 'Publish a new version of the eligibility policy (roster limits, quotas, clearances, waivable rules, enforcement). Versions are append-only: earlier versions and the snapshots taken under them never change. Send expected_version (the version you loaded, 0 for none) so two editors cannot overwrite each other.',
  input: z.object({ id, enforcement: z.enum(['advisory', 'blocking']).default('blocking'), rules: RULES, note: txt(500).optional(), expected_version: z.number().int().min(0) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await mustStaff(user, i.id, c);
      await c.query('SELECT id FROM events WHERE id=$1 FOR UPDATE', [ev.id]);
      const cur = (await c.query('SELECT coalesce(max(version),0) AS v FROM reg_policies WHERE event_id=$1', [ev.id])).rows[0].v;
      if (cur !== i.expected_version) throw conflict('The policy changed since you loaded it', { code: 'stale_version', current_version: cur });
      const r = i.rules.roster ?? {};
      if (r.max_total != null && [r.max_active, r.max_reserve, r.max_development].some((x) => x != null && x > r.max_total)) throw badRequest('A list limit cannot exceed the total roster limit');
      const row = (await c.query(
        'INSERT INTO reg_policies(event_id, version, enforcement, rules, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, version, enforcement, rules, note, created_at',
        [ev.id, cur + 1, i.enforcement, JSON.stringify(i.rules), i.note ?? null, user.id])).rows[0];
      return row;
    });
  },
});

cap({
  name: 'add_registration_division', method: 'POST', path: '/events/:id/registration/divisions', tag: TAG, status: 201,
  summary: 'Add a division / grade. Age categories are explicit birth-date bounds (born on or after / on or before) set by the organiser; they are never inferred from names or other profile fields.',
  input: z.object({ id, name: txt(80).min(1), grade: txt(40).optional(), born_on_or_after: iso.optional(), born_on_or_before: iso.optional() }),
  async handler({ user }, i) {
    if (i.born_on_or_after && i.born_on_or_before && i.born_on_or_after > i.born_on_or_before) throw badRequest('The birth-date range is empty');
    const ev = await mustStaff(user, i.id);
    try {
      return await one('INSERT INTO reg_divisions(event_id, name, grade, born_on_or_after, born_on_or_before, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, grade, born_on_or_after::text AS born_on_or_after, born_on_or_before::text AS born_on_or_before',
        [ev.id, i.name, i.grade ?? null, i.born_on_or_after ?? null, i.born_on_or_before ?? null, user.id]);
    } catch (e) { throw isDup(e) ? conflict('A division with this name already exists') : e; }
  },
});

cap({
  name: 'archive_registration_division', method: 'POST', path: '/registration/divisions/:id/archive', tag: TAG,
  summary: 'Archive a division (registrations already in it keep it). Divisions are never deleted.', input: z.object({ id }),
  async handler({ user }, i) {
    const d = await one('SELECT * FROM reg_divisions WHERE id=$1', [i.id]);
    if (!d) throw notFound('Division');
    await mustStaff(user, d.event_id);
    return one('UPDATE reg_divisions SET archived_at=coalesce(archived_at, now()) WHERE id=$1 RETURNING id, name, archived_at', [i.id]);
  },
});

cap({
  name: 'add_registration_window', method: 'POST', path: '/events/:id/registration/windows', tag: TAG, status: 201,
  summary: 'Add a registration window. Give the local date and time and the IANA timezone the organiser works in; the exact instants are stored, so daylight-saving changes cannot shift a deadline. `late` and `emergency` windows accept registrations only with a stated reason and mark them as such. With no windows the competition is open.',
  input: z.object({ id, kind: z.enum(['regular', 'late', 'emergency']).default('regular'), label: txt(80).optional(), timezone: z.string().max(64),
    opens_on: iso, opens_at_time: hm.default('00:00'), closes_on: iso, closes_at_time: hm.default('23:59') }),
  async handler({ user }, i) {
    if (!validTimezone(i.timezone)) throw badRequest('Unknown timezone');
    const mins = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    const opens = fromLocal(i.opens_on, mins(i.opens_at_time), i.timezone), closes = fromLocal(i.closes_on, mins(i.closes_at_time), i.timezone);
    if (!(closes > opens)) throw badRequest('The window closes before it opens');
    const ev = await mustStaff(user, i.id);
    return one('INSERT INTO reg_windows(event_id, kind, label, opens_at, closes_at, timezone, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, kind, label, opens_at, closes_at, timezone',
      [ev.id, i.kind, i.label ?? null, opens, closes, i.timezone, user.id]);
  },
});

cap({
  name: 'retire_registration_window', method: 'POST', path: '/registration/windows/:id/retire', tag: TAG,
  summary: 'Retire a window (kept for the record; registrations made in it keep their window).', input: z.object({ id }),
  async handler({ user }, i) {
    const w = await one('SELECT * FROM reg_windows WHERE id=$1', [i.id]);
    if (!w) throw notFound('Window');
    await mustStaff(user, w.event_id);
    return one('UPDATE reg_windows SET retired_at=coalesce(retired_at, now()) WHERE id=$1 RETURNING id, kind, retired_at', [i.id]);
  },
});

// ------------------------------------------------------------------ rules that need the live roster

/** Waivable check: a live, un-revoked exception for this person and rule. */
const hasWaiver = async (c, eventId, userId, rule) => !!(await c.query(
  'SELECT 1 FROM reg_exceptions WHERE event_id=$1 AND user_id=$2 AND rule_key=$3 AND revoked_at IS NULL AND effective_from <= now() AND effective_to > now()', [eventId, userId, rule])).rows[0];

/** Roster frozen? New registrations and list changes are refused after the freeze unless the person holds a window exception. */
async function assertNotFrozen(c, ev, policy, userId) {
  const at = policy?.rules?.roster?.freeze_at;
  if (at && new Date(at) <= new Date() && !(await hasWaiver(c, ev.id, userId, 'window'))) throw conflict('The roster is frozen for this competition', { code: 'roster_frozen', frozen_at: at });
}

/** Roster limits and quotas for a team after a change. Counts the people who hold a slot (registered or suspended) inside the caller's locked transaction. */
async function assertCapacity(c, ev, policy, reg, next) {
  if (!policy) return;
  const roster = policy.rules.roster ?? {}, quotas = policy.rules.quotas ?? {};
  const rows = (await c.query(
    "SELECT roster_list, origin_class, count(*)::int AS n FROM reg_registrations WHERE event_id=$1 AND team_id=$2 AND status IN ('registered','suspended') AND id<>$3 GROUP BY 1,2", [ev.id, reg.team_id, reg.id])).rows;
  const sum = (f) => rows.filter(f).reduce((a, r) => a + r.n, 0);
  const total = sum(() => true) + 1, onList = sum((r) => r.roster_list === next.roster_list) + 1, foreign = sum((r) => r.origin_class === 'foreign') + (next.origin_class === 'foreign' ? 1 : 0);
  const fail = async (rule, msg, limit, current) => { if (!(await hasWaiver(c, ev.id, reg.user_id, rule))) throw conflict(msg, { code: 'roster_limit', rule, limit, current }); };
  if (roster.max_total != null && total > roster.max_total) await fail('roster_limit', `The team already has the maximum of ${roster.max_total} registered players`, roster.max_total, total - 1);
  const listMax = roster[`max_${next.roster_list}`];
  if (listMax != null && onList > listMax) await fail('roster_limit', `The ${next.roster_list} list is full (maximum ${listMax})`, listMax, onList - 1);
  if (next.origin_class === 'foreign' && quotas.max_foreign != null && foreign > quotas.max_foreign) await fail('quota', `The team already has the maximum of ${quotas.max_foreign} foreign players`, quotas.max_foreign, foreign - 1);
}

// ------------------------------------------------------------------ submit / list

cap({
  name: 'submit_registration', method: 'POST', path: '/events/:id/registrations', tag: TAG, status: 201,
  summary: 'Register a player for a team in this competition. A player registers themselves (they must be an active member of the team), a verified guardian registers a young person they look after, a team manager registers their own players, the organiser can register anyone. The server enforces the registration windows (late / emergency windows need a reason; an authorised window exception opens a closed one), the roster freeze, one live registration per person per competition, guardian consent for young people, and that the team is entered in the event. The registration starts as `submitted`; the organiser decides it.',
  input: z.object({ id, team_id: id, user_id: id.optional(), division_id: id.optional(), roster_list: z.enum(LISTS).default('active'), reason: txt(500).optional() }),
  async handler({ user }, i) {
    const target = i.user_id ?? user.id;
    return tx(async (c) => {
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [i.id])).rows[0];
      if (!ev) throw notFound('Event');
      if (['completed', 'cancelled'].includes(ev.status)) throw conflict(`The competition is ${ev.status}`);
      const team = (await c.query('SELECT * FROM teams WHERE id=$1', [i.team_id])).rows[0];
      if (!team) throw notFound('Team');
      const staff = await isEventStaff(user, ev, c), manager = await canManageTeam(user, team);
      // a verified guardian registers a young person they look after; the row records them as submitter and counts as a self-registration
      const guardian = !staff && !manager && target !== user.id && !!(await guardianLink(user.id, target, c));
      if (!(staff || manager || target === user.id || guardian)) throw notFound('Team');
      if (guardian) await checkGuardianScope(user.id, target, 'register', ev.organisation_id ?? null, c);
      const source = staff ? 'staff' : manager ? 'team' : 'self';
      // lock the team's entry: the per-team roster is decided one transaction at a time
      const entry = (await c.query("SELECT id FROM event_entries WHERE event_id=$1 AND team_id=$2 AND status='accepted' FOR UPDATE", [ev.id, team.id])).rows[0];
      if (!entry) throw conflict('This team is not entered in the competition');
      if (!(await c.query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [team.id, target])).rows[0]) throw badRequest('The player is not an active member of this team');
      await requireConsent(target, 'participation', 'a competition registration', c);
      if (i.division_id && !(await c.query('SELECT 1 FROM reg_divisions WHERE id=$1 AND event_id=$2 AND archived_at IS NULL', [i.division_id, ev.id])).rows[0]) throw badRequest('Unknown division for this competition');
      const policy = await latestPolicy(ev.id, c);
      await assertNotFrozen(c, ev, policy, target);
      // windows
      const windows = (await c.query('SELECT * FROM reg_windows WHERE event_id=$1 AND retired_at IS NULL ORDER BY opens_at', [ev.id])).rows;
      let win = null, windowKind = 'open', exceptionId = null;
      if (windows.length) {
        const now = Date.now();
        const rank = { regular: 0, late: 1, emergency: 2 };
        win = windows.filter((w) => w.opens_at.getTime() <= now && w.closes_at.getTime() > now).sort((a, b) => rank[a.kind] - rank[b.kind])[0] ?? null;
        if (win) windowKind = win.kind;
        else {
          const ex = (await c.query("SELECT id FROM reg_exceptions WHERE event_id=$1 AND user_id=$2 AND rule_key='window' AND revoked_at IS NULL AND effective_from <= now() AND effective_to > now() ORDER BY created_at DESC LIMIT 1", [ev.id, target])).rows[0];
          if (!ex) {
            const next = windows.find((w) => w.opens_at.getTime() > now);
            throw conflict('Registration is closed for this competition', { code: 'window_closed', next_opens_at: next?.opens_at ?? null, next_kind: next?.kind ?? null });
          }
          windowKind = 'exception'; exceptionId = ex.id;
        }
        if (['late', 'emergency'].includes(windowKind) && !(i.reason && i.reason.length >= 3)) throw badRequest(`A ${windowKind} registration needs a reason`);
      }
      let row;
      try {
        row = (await c.query(
          `INSERT INTO reg_registrations(event_id, team_id, user_id, division_id, roster_list, source, window_id, window_kind, exception_id, submitted_by, note_enc)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [ev.id, team.id, target, i.division_id ?? null, i.roster_list, source, win?.id ?? null, windowKind, exceptionId, user.id, i.reason ? encrypt(i.reason, 'reg_registrations.note') : null])).rows[0];
      } catch (e) { throw isDup(e) ? conflict('This player already has a live registration in this competition', { code: 'duplicate_registration' }) : e; }
      await snapshotRow(c, row.id, 'submitted', user.id, { note: i.reason });
      if (ev.organizer_id !== user.id) await notify(c, ev.organizer_id, { kind: 'registration', title: `${team.name}: a registration awaits review`, body: ev.name, data: { event_id: ev.id, registration_id: row.id } });
      return (await c.query(`SELECT ${REG_COLS} FROM ${REG_FROM} WHERE r.id=$1`, [row.id])).rows[0];
    });
  },
});

cap({
  name: 'list_registrations', method: 'GET', path: '/events/:id/registrations', tag: TAG,
  summary: 'The registration queue and registered players of a competition, newest first. The organiser sees everything; a team manager sees their own teams; a player sees their own. Filter by status, team, roster list or a name search. Young people without current guardian consent appear as "Protected participant".',
  input: z.object({ id, status: z.enum(['submitted', 'under_review', 'registered', 'rejected', 'withdrawn', 'suspended', 'expired', 'live']).optional(), team_id: id.optional(), roster_list: z.enum(LISTS).optional(), q: txt(60).optional(), ...page }),
  async handler({ user }, i) {
    const ev = await getEvent(i.id);
    const v = await viewer(user, ev);
    const args = [ev.id], w = ['r.event_id=$1'];
    const add = (sql, val) => { args.push(val); w.push(sql.replaceAll('?', `$${args.length}`)); };
    if (!v.staff) { args.push([...v.teams]); args.push(user.id); w.push(`(r.team_id = ANY($${args.length - 1}::uuid[]) OR r.user_id=$${args.length})`); }
    if (i.status === 'live') add('r.status = ANY(?::text[])', LIVE); else if (i.status) add('r.status=?', i.status);
    if (i.team_id) add('r.team_id=?', i.team_id);
    if (i.roster_list) add('r.roster_list=?', i.roster_list);
    if (i.q) add('(u.display_name ILIKE ? OR r.registration_no ILIKE ?)', `%${i.q.replace(/[%_]/g, '')}%`);
    args.push(i.limit, i.offset);
    const rows = await many(`SELECT ${REG_COLS}, (r.window_kind IN ('late','emergency','exception')) AS flagged FROM ${REG_FROM} WHERE ${w.join(' AND ')} ORDER BY r.created_at DESC, r.id LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    return mask(rows, await protectedIds(rows.map((r) => r.user_id)));
  },
});

cap({
  name: 'list_my_registrations', method: 'GET', path: '/me/registrations', tag: TAG,
  summary: 'Your own competition registrations with their state and what, if anything, you need to do next. No organiser notes are included. With include_dependents, also those of the young people you are a verified guardian of.',
  input: z.object({ include_dependents: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const who = [user.id, ...(i.include_dependents ? (await many(`SELECT l.child_id FROM guardian_links l JOIN users u ON u.id=l.child_id WHERE l.guardian_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND ${YOUTH_SQL}`, [user.id])).map((r) => r.child_id) : [])];
    const rows = await many(`SELECT r.id, r.user_id, pu.display_name AS player_name, r.event_id, e.name AS event_name, e.status AS event_status, r.team_id, t.name AS team_name, d.name AS division_name, r.registration_no, r.status, r.roster_list, r.window_kind,
        r.effective_from::text AS effective_from, r.effective_to::text AS effective_to, r.row_version, r.created_at
      FROM reg_registrations r JOIN users pu ON pu.id=r.user_id JOIN events e ON e.id=r.event_id JOIN teams t ON t.id=r.team_id LEFT JOIN reg_divisions d ON d.id=r.division_id WHERE r.user_id = ANY($1::uuid[]) ORDER BY r.created_at DESC, r.id LIMIT $2 OFFSET $3`, [who, i.limit, i.offset]);
    const NEXT = { submitted: 'Waiting for the organiser', under_review: 'Under review', registered: null, suspended: 'Suspended: contact the organiser', rejected: 'Not accepted', withdrawn: null, expired: 'Expired' };
    return rows.map((r) => ({ ...r, next_step: NEXT[r.status] ?? null }));
  },
});

// ------------------------------------------------------------------ decide / change list / withdraw

const LOCK = 'SELECT * FROM reg_registrations WHERE id=$1 FOR UPDATE';
async function lockedReg(c, regId) {
  const reg = (await c.query('SELECT event_id, team_id FROM reg_registrations WHERE id=$1', [regId])).rows[0];
  if (!reg) throw notFound('Registration');
  await c.query("SELECT id FROM event_entries WHERE event_id=$1 AND team_id=$2 FOR UPDATE", [reg.event_id, reg.team_id]);   // same lock order as submit
  return (await c.query(LOCK, [regId])).rows[0];
}
const shape = async (c, regId) => (await c.query(`SELECT ${REG_COLS} FROM ${REG_FROM} WHERE r.id=$1`, [regId])).rows[0];

cap({
  name: 'review_registration', method: 'POST', path: '/registrations/:id/review', tag: TAG,
  summary: 'The organiser decides a registration: start_review, register, reject, suspend, reinstate or expire. Registering checks the roster limits and quotas (and the freeze) under a lock on the team\'s entry, so concurrent decisions cannot exceed them; an authorised roster_limit / quota exception is the only way past a limit. Send the row_version you loaded; a stale one is refused. Reject and suspend need a reason. The reason is kept encrypted in the history, never shown to the player or team. Origin (local / homegrown / foreign) is declared here by the registrar, never inferred from a profile.',
  input: z.object({ id, action: z.enum(['start_review', 'register', 'reject', 'suspend', 'reinstate', 'expire']), row_version: z.number().int().min(1), reason: txt(500).optional(),
    registration_no: txt(40).min(1).optional(), origin_class: z.enum(['unclassified', 'local', 'homegrown', 'foreign']).optional(), division_id: id.optional(), roster_list: z.enum(LISTS).optional(), effective_from: iso.optional(), effective_to: iso.optional() }),
  async handler({ user }, i) {
    if (['reject', 'suspend'].includes(i.action) && !(i.reason && i.reason.length >= 3)) throw badRequest('A reason is required');
    return tx(async (c) => {
      const cur = await lockedReg(c, i.id);
      const ev = await mustStaff(user, cur.event_id, c).catch((e) => { throw e.status === 403 ? notFound('Registration') : e; });
      if (cur.row_version !== i.row_version) throw stale(cur);
      const FROM = { start_review: ['submitted'], register: ['submitted', 'under_review'], reject: ['submitted', 'under_review'], suspend: ['registered'], reinstate: ['suspended'], expire: ['registered', 'suspended'] };
      if (!FROM[i.action].includes(cur.status)) throw conflict(`A registration that is ${cur.status} cannot be ${i.action.replace('_', ' ')}ed`, { code: 'bad_transition' });
      const TO = { start_review: 'under_review', register: 'registered', reject: 'rejected', suspend: 'suspended', reinstate: 'registered', expire: 'expired' };
      const next = { roster_list: i.roster_list ?? cur.roster_list, origin_class: i.origin_class ?? cur.origin_class, division_id: i.division_id ?? cur.division_id };
      if (i.division_id && !(await c.query('SELECT 1 FROM reg_divisions WHERE id=$1 AND event_id=$2 AND archived_at IS NULL', [i.division_id, ev.id])).rows[0]) throw badRequest('Unknown division for this competition');
      let regNo = i.registration_no ?? cur.registration_no;
      if (i.action === 'register') {
        const policy = await latestPolicy(ev.id, c);
        await assertNotFrozen(c, ev, policy, cur.user_id);
        await assertCapacity(c, ev, policy, cur, next);
      }
      const from = { status: cur.status, roster_list: cur.roster_list };
      const today = new Date().toISOString().slice(0, 10);
      try {
        await c.query(
          `UPDATE reg_registrations SET status=$2, roster_list=$3, origin_class=$4, division_id=$5, registration_no=$6,
             effective_from=CASE WHEN $2='registered' THEN coalesce($7::date, effective_from, $9::date) ELSE effective_from END,
             effective_to=CASE WHEN $2='registered' THEN coalesce($8::date, effective_to, $10::date) WHEN $2='expired' THEN least(coalesce(effective_to, $9::date), $9::date) ELSE effective_to END,
             decided_by=$11, decided_at=now(), note_enc=coalesce($12, note_enc), row_version=row_version+1, updated_at=now() WHERE id=$1`,
          [i.id, TO[i.action], next.roster_list, next.origin_class, next.division_id, regNo, i.effective_from ?? null, i.effective_to ?? null, today, ev.ends_on ?? null, user.id, i.reason ? encrypt(i.reason, 'reg_registrations.note') : null]);
      } catch (e) { throw isDup(e) ? conflict('That registration number is already used in this competition') : e; }
      const row = await snapshotRow(c, i.id, ({ start_review: 'review_started', register: 'registered', reject: 'rejected', suspend: 'suspended', reinstate: 'reinstated', expire: 'expired' })[i.action], user.id, { from, note: i.reason });
      const team = (await c.query('SELECT name, owner_id FROM teams WHERE id=$1', [row.team_id])).rows[0];
      const says = { register: 'registered', reject: 'not accepted', suspend: 'suspended', reinstate: 'reinstated', expire: 'expired' }[i.action];
      if (says) {
        const body = `Registration for ${ev.name} is ${says}.`;
        await notify(c, row.user_id, { kind: 'registration', title: `${team.name}: your registration was ${says}`, body, data: { event_id: ev.id, registration_id: row.id } });
        if (team.owner_id !== row.user_id) await notify(c, team.owner_id, { kind: 'registration', title: `${team.name}: a registration was ${says}`, body: ev.name, data: { event_id: ev.id, registration_id: row.id } });
      }
      return shape(c, i.id);
    });
  },
});

cap({
  name: 'change_registration_list', method: 'POST', path: '/registrations/:id/list', tag: TAG,
  summary: 'Move a registered player between the active, reserve and development lists. The organiser or the team\'s managers can do it; list limits and the roster freeze apply server-side, and the change is recorded with who made it and when.',
  input: z.object({ id, roster_list: z.enum(LISTS), row_version: z.number().int().min(1), reason: txt(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = await lockedReg(c, i.id);
      if (!cur) throw notFound('Registration');
      const ev = await getEvent(cur.event_id, c);
      const team = (await c.query('SELECT * FROM teams WHERE id=$1', [cur.team_id])).rows[0];
      if (!(await isEventStaff(user, ev, c)) && !(await canManageTeam(user, team))) throw notFound('Registration');
      if (cur.row_version !== i.row_version) throw stale(cur);
      if (!LIVE.includes(cur.status)) throw conflict(`A registration that is ${cur.status} cannot change list`);
      if (cur.roster_list === i.roster_list) return shape(c, i.id);
      const policy = await latestPolicy(ev.id, c);
      await assertNotFrozen(c, ev, policy, cur.user_id);
      if (cur.status === 'registered') await assertCapacity(c, ev, policy, cur, { roster_list: i.roster_list, origin_class: cur.origin_class });
      await c.query('UPDATE reg_registrations SET roster_list=$2, row_version=row_version+1, updated_at=now() WHERE id=$1', [i.id, i.roster_list]);
      await snapshotRow(c, i.id, 'list_changed', user.id, { from: { status: cur.status, roster_list: cur.roster_list }, note: i.reason });
      return shape(c, i.id);
    });
  },
});

cap({
  name: 'withdraw_registration', method: 'POST', path: '/registrations/:id/withdraw', tag: TAG,
  summary: 'Withdraw a registration (the player, a team manager or the organiser). The slot is freed; the registration and its history are kept.',
  input: z.object({ id, row_version: z.number().int().min(1), reason: txt(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = await lockedReg(c, i.id);
      if (!cur) throw notFound('Registration');
      const ev = await getEvent(cur.event_id, c);
      const team = (await c.query('SELECT * FROM teams WHERE id=$1', [cur.team_id])).rows[0];
      if (cur.user_id !== user.id && !(await isEventStaff(user, ev, c)) && !(await canManageTeam(user, team))) throw notFound('Registration');
      if (cur.row_version !== i.row_version) throw stale(cur);
      if (!LIVE.includes(cur.status)) throw conflict(`A registration that is ${cur.status} cannot be withdrawn`);
      await c.query("UPDATE reg_registrations SET status='withdrawn', row_version=row_version+1, updated_at=now(), decided_by=$2, decided_at=now() WHERE id=$1", [i.id, user.id]);
      await snapshotRow(c, i.id, 'withdrawn', user.id, { from: { status: cur.status, roster_list: cur.roster_list }, note: i.reason });
      if (ev.organizer_id !== user.id) await notify(c, ev.organizer_id, { kind: 'registration', title: `${team.name}: a registration was withdrawn`, body: ev.name, data: { event_id: ev.id, registration_id: i.id } });
      return shape(c, i.id);
    });
  },
});

cap({
  name: 'get_registration_history', method: 'GET', path: '/registrations/:id/history', tag: TAG,
  summary: 'Who changed what and when for one registration, oldest first. The organiser also sees the (decrypted, audit-logged) reasons; the player and team managers see the steps only.', input: z.object({ id }),
  async handler({ user }, i) {
    const reg = await one('SELECT * FROM reg_registrations WHERE id=$1', [i.id]);
    if (!reg) throw notFound('Registration');
    const ev = await getEvent(reg.event_id);
    const staff = await isEventStaff(user, ev);
    if (!staff && reg.user_id !== user.id) {
      const team = await one('SELECT * FROM teams WHERE id=$1', [reg.team_id]);
      if (!(await canManageTeam(user, team))) throw notFound('Registration');
    }
    const rows = await many('SELECT h.id, h.row_version, h.action, h.from_status, h.to_status, h.from_list, h.to_list, h.actor_id, a.display_name AS actor_name, h.note_enc, h.created_at FROM reg_history h LEFT JOIN users a ON a.id=h.actor_id WHERE h.registration_id=$1 ORDER BY h.created_at, h.id', [i.id]);
    if (staff && rows.some((r) => r.note_enc)) await audit(null, user.id, 'read_registration_notes', 'reg_registrations', reg.id);
    return rows.map(({ note_enc, ...r }) => ({ ...r, ...(staff ? { note: note_enc ? decrypt(note_enc, 'reg_history.note') : null } : {}) }));
  },
});

// ------------------------------------------------------------------ rosters

export async function rosterSummary(ev, teamIds) {
  const policy = await latestPolicy(ev.id);
  const roster = policy?.rules.roster ?? {}, quotas = policy?.rules.quotas ?? {};
  const teams = await many(`SELECT t.id, t.name, t.emoji, t.color FROM event_entries e JOIN teams t ON t.id=e.team_id WHERE e.event_id=$1 AND e.status='accepted' ${teamIds ? 'AND t.id = ANY($2::uuid[])' : ''} ORDER BY t.name, t.id`, teamIds ? [ev.id, teamIds] : [ev.id]);
  const counts = await many("SELECT team_id, status, roster_list, origin_class, count(*)::int AS n FROM reg_registrations WHERE event_id=$1 GROUP BY 1,2,3,4", [ev.id]);
  const frozen = !!(roster.freeze_at && new Date(roster.freeze_at) <= new Date());
  return {
    policy_version: policy?.version ?? null, enforcement: policy?.enforcement ?? null, frozen, freeze_at: roster.freeze_at ?? null, limits: roster, quotas,
    teams: teams.map((t) => {
      const mine = counts.filter((x) => x.team_id === t.id);
      const sum = (f) => mine.filter(f).reduce((a, x) => a + x.n, 0);
      const held = (x) => ['registered', 'suspended'].includes(x.status);
      const total = sum(held), foreign = sum((x) => held(x) && x.origin_class === 'foreign'), homegrown = sum((x) => held(x) && x.origin_class === 'homegrown'), local = sum((x) => held(x) && x.origin_class === 'local');
      const warnings = [];
      if (roster.max_total != null && total >= roster.max_total) warnings.push('Roster is full');
      if (quotas.max_foreign != null && foreign > quotas.max_foreign) warnings.push('Above the foreign-player limit');
      if (quotas.min_homegrown != null && homegrown < quotas.min_homegrown) warnings.push(`Needs ${quotas.min_homegrown - homegrown} more homegrown`);
      if (quotas.min_local != null && local < quotas.min_local) warnings.push(`Needs ${quotas.min_local - local} more local`);
      return { team_id: t.id, team_name: t.name, emoji: t.emoji, color: t.color, total, active: sum((x) => held(x) && x.roster_list === 'active'), reserve: sum((x) => held(x) && x.roster_list === 'reserve'), development: sum((x) => held(x) && x.roster_list === 'development'),
        foreign, homegrown, local, awaiting: sum((x) => ['submitted', 'under_review'].includes(x.status)), suspended: sum((x) => x.status === 'suspended'), warnings };
    }),
  };
}

cap({
  name: 'get_roster_summary', method: 'GET', path: '/events/:id/rosters', tag: TAG,
  summary: 'Per-team roster numbers against the policy: registered, awaiting a decision, suspended, the active / reserve / development lists, foreign / homegrown / local counts, the limits, the roster-freeze state and plain-language warnings. The organiser sees every team; a team manager sees their own.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await getEvent(i.id);
    const v = await viewer(user, ev);
    if (!v.staff && !v.teams.size) throw notFound('Event');
    return rosterSummary(ev, v.staff ? null : [...v.teams]);
  },
});
