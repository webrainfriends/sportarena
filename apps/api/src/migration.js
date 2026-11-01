// The shared migration engine (#514). A project moves rows from a spreadsheet or another product into an organisation:
//   mapping -> dry run (validateProject) -> approved -> importing (runProject, resumable batches) -> reconciliation -> completed
// The dry run and the real import share one code path (resolveRow), so what the person reviewed is what is written.
// Safety rules enforced here, not in the app:
//   * a person is matched on a blind-indexed email only: a name alone never matches, merges or creates anyone;
//   * an email match whose name disagrees is an identity *conflict* a person must confirm or skip;
//   * a young person is never imported without a guardian email, and guardian links and consents are never created;
//   * importing creates invitations (the person accepts), never memberships, and is idempotent through migration_links;
//   * rollback only reverses what is still untouched; anything a person has since accepted is kept and reported.
import { one, many, tx, pool } from './db.js';
import { encrypt, decrypt, blindIndex } from './crypto.js';
import { audit } from './helpers.js';
import { notify } from './notify.js';
import { getPolicy, hasConsent } from './youth.js';
import { badRequest, conflict } from './errors.js';
import { normaliseRosterRow, maskEmail } from './migration-formats.js';

export const MAX_ROWS = 5000;
const BATCH = 100;
const RAW = 'migration_rows.raw', DATA = 'migration_rows.data';
export const seal = (obj, ctx) => encrypt(JSON.stringify(obj), ctx);
export const unseal = (s, ctx) => (s ? JSON.parse(decrypt(s, ctx)) : null);
export const sealRaw = (o) => seal(o, RAW);
export const openRaw = (s) => unseal(s, RAW);
export const openData = (s) => unseal(s, DATA);

const teamKey = (t) => (t ?? '').trim().toLowerCase();
const keyOf = (d) => blindIndex(`roster|${teamKey(d.team)}|${d.email}`);
const sameFirstName = (a, b) => {
  const x = String(a ?? '').trim().toLowerCase().split(/\s+/)[0], y = String(b ?? '').trim().toLowerCase().split(/\s+/)[0];
  return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x));
};

/** The account that owns this email, if any. Email is the only identifier a person is matched on. */
const accountByEmail = (db, emailIdx) => db.query('SELECT id, handle, display_name, youth_until FROM users WHERE email_idx=$1', [emailIdx]).then((r) => r.rows[0] ?? null);

/** Map and normalise every stored row of a project again (after a mapping change) and write its outcome. Writes only inside the project. */
export async function validateProject(projectId, actorId) {
  const p = (await pool.query('SELECT * FROM migration_projects WHERE id=$1', [projectId])).rows[0];
  const policy = await getPolicy('default');
  const opt = { date_format: p.options.date_format, default_role: p.options.default_role ?? 'player', independent_age: policy.independent_age };
  const team = p.options.default_team_id ? (await pool.query('SELECT name FROM teams WHERE id=$1 AND organisation_id=$2', [p.options.default_team_id, p.organisation_id])).rows[0] : null;
  if (team) opt.default_team = team.name;
  const rows = (await pool.query('SELECT id, row_no, raw_enc, review FROM migration_rows WHERE project_id=$1 ORDER BY row_no', [projectId])).rows;
  const teams = new Map((await pool.query('SELECT id, lower(name) AS k FROM teams WHERE organisation_id=$1 AND archived_at IS NULL', [p.organisation_id])).rows.map((t) => [t.k, t.id]));
  const seenKey = new Map(), seenEmail = new Map();
  const out = [];
  for (const r of rows) {
    const n = normaliseRosterRow(openRaw(r.raw_enc), p.mapping, opt);
    let status = n.ok ? (n.reasons.length ? 'warning' : 'valid') : 'rejected';
    const reasons = [...n.reasons];
    const d = n.data;
    if (n.skipped) { status = 'skipped'; reasons.push({ level: 'info', field: 'role', message: n.skipped }); }
    let idx = null, key = null;
    if (status !== 'rejected' && status !== 'skipped') {
      idx = blindIndex(d.email); key = keyOf(d);
      if (d.team && !teams.has(teamKey(d.team)) && !p.sport_id) { status = 'rejected'; reasons.push({ level: 'error', field: 'team', message: `Team "${d.team}" does not exist yet. Choose a sport so it can be created, or pick an existing team` }); }
      else if (d.team && !teams.has(teamKey(d.team))) reasons.push({ level: 'info', field: 'team', message: `Team "${d.team}" will be created` });
    }
    if (status !== 'rejected' && status !== 'skipped') {
      if (seenKey.has(key)) { status = 'duplicate'; reasons.push({ level: 'warning', field: 'email', message: `Same person and team as row ${seenKey.get(key)} in this file` }); }
      else {
        seenKey.set(key, r.row_no);
        const prev = seenEmail.get(idx);
        if (prev && !sameFirstName(prev.first, d.first_name)) { status = 'conflict'; reasons.push({ level: 'warning', field: 'email', message: `Row ${prev.row} uses this email for a different name (${prev.first}). Confirm only if they are the same person` }); }
        else if (!prev) seenEmail.set(idx, { row: r.row_no, first: d.first_name });
        const acct = status === 'conflict' ? null : await accountByEmail(pool, idx);
        if (acct && status !== 'conflict' && !sameFirstName(acct.display_name, d.first_name)) { status = 'conflict'; reasons.push({ level: 'warning', field: 'email', message: `This email belongs to an existing account named "${acct.display_name}", not "${d.first_name}". Confirm only if they are the same person` }); }
        else if (acct) reasons.push({ level: 'info', field: 'email', message: 'Already on Gotmygame: an invitation will be sent to their account' });
        const live = await pool.query('SELECT 1 FROM migration_links WHERE organisation_id=$1 AND domain=$2 AND key_hash=$3 AND released_at IS NULL AND project_id<>$4', [p.organisation_id, p.domain, key, projectId]);
        if (live.rowCount) { status = 'duplicate'; reasons.push({ level: 'warning', field: 'email', message: 'Already imported from an earlier file: skipped so nobody is invited twice' }); }
      }
    }
    // a reviewed conflict stays decided; only a person changes it
    if (status === 'conflict' && r.review === 'confirmed') { status = 'warning'; reasons.push({ level: 'info', field: 'email', message: 'Identity confirmed by a person' }); }
    if (status === 'conflict' && r.review === 'skipped') status = 'skipped';
    out.push({ id: r.id, status, reasons, data: status === 'rejected' && !d.email ? null : d, idx, key });
  }
  await tx(async (c) => {
    for (const o of out) {
      await c.query('UPDATE migration_rows SET check_status=$2, reasons=$3, data_enc=$4, email_idx=$5, key_hash=$6 WHERE id=$1',
        [o.id, o.status, JSON.stringify(o.reasons), o.data ? seal(o.data, DATA) : null, o.idx, o.key]);
    }
    await c.query("UPDATE migration_projects SET status='dry_run', updated_at=now() WHERE id=$1 AND status IN ('mapping','validation','dry_run')", [projectId]);
    await audit(c, actorId, 'validate_migration', 'migration_projects', projectId);
  });
  return summarise(projectId);
}

/** Counts per outcome plus what still blocks approval. Pure SQL over the project's own rows. */
export async function summarise(projectId) {
  const rows = (await pool.query('SELECT check_status AS s, count(*)::int AS n FROM migration_rows WHERE project_id=$1 GROUP BY 1', [projectId])).rows;
  const get = (s) => rows.find((r) => r.s === s)?.n ?? 0;
  const total = rows.reduce((a, r) => a + r.n, 0);
  const warnings = (await pool.query("SELECT count(*)::int AS n FROM migration_rows WHERE project_id=$1 AND check_status IN ('valid','warning') AND reasons @> '[{\"level\":\"warning\"}]'", [projectId])).rows[0].n;
  const needs_sport = (await pool.query("SELECT count(*)::int AS n FROM migration_rows WHERE project_id=$1 AND check_status='rejected' AND reasons @> '[{\"field\":\"team\",\"level\":\"error\"}]' AND EXISTS (SELECT 1 FROM migration_projects p WHERE p.id=$1 AND p.sport_id IS NULL)", [projectId])).rows[0].n;
  return { total, needs_sport, valid: get('valid'), warning: get('warning'), rejected: get('rejected'), duplicate: get('duplicate'), conflict: get('conflict'), skipped: get('skipped'), pending: get('pending'), with_warnings: warnings, importable: get('valid') + get('warning') };
}

/**
 * May this person be invited to a team now? An adult always; a young person only with a guardian's current consent. The stricter of the file
 * and the account wins: a row that says under 18 for an account with no date of birth cannot have consent recorded, so it waits until the
 * account carries the date of birth and a guardian has consented (safeguarding is never bypassed by a spreadsheet).
 */
async function mayInvite(db, userId, d) {
  const acct = (await db.query('SELECT youth_until FROM users WHERE id=$1', [userId])).rows[0];
  const accountYouth = !!(acct?.youth_until && new Date(acct.youth_until) > new Date());
  if (d.youth && !accountYouth) return false;
  return accountYouth ? hasConsent(userId, 'participation', db) : true;
}

/** One person -> one team invitation, written the same way invite_team_member does. Returns the commit status. */
async function inviteToTeam(c, { teamId, userId, role, jersey, invitedBy, teamName }) {
  const prior = (await c.query('SELECT status FROM team_members WHERE team_id=$1 AND user_id=$2', [teamId, userId])).rows[0];
  if (prior && prior.status !== 'left') return { status: 'already_member' };
  await c.query(
    `INSERT INTO team_members(team_id, user_id, role, jersey_no, status, invited_by) VALUES ($1,$2,$3,$4,'invited',$5)
     ON CONFLICT (team_id, user_id) DO UPDATE SET role=EXCLUDED.role, jersey_no=EXCLUDED.jersey_no, status='invited', invited_by=EXCLUDED.invited_by`,
    [teamId, userId, role, jersey, invitedBy]);
  await notify(c, userId, { kind: 'team_invite', title: `${teamName} invited you as ${role}`, body: 'Open the team to accept or decline.', data: { team_id: teamId } });
  return { status: 'invited' };
}

async function teamFor(c, p, name, actorId, created) {
  const hit = (await c.query('SELECT id, name, owner_id FROM teams WHERE organisation_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL ORDER BY created_at LIMIT 1', [p.organisation_id, name])).rows[0];
  if (hit) return hit;
  const t = (await c.query('INSERT INTO teams(name, sport_id, owner_id, organisation_id) VALUES ($1,$2,$3,$4) RETURNING id, name, owner_id', [name, p.sport_id, actorId, p.organisation_id])).rows[0];
  await c.query("INSERT INTO team_members(team_id, user_id, role) VALUES ($1,$2,'manager') ON CONFLICT DO NOTHING", [t.id, actorId]);
  await c.query("INSERT INTO migration_created(project_id, entity_kind, entity_id) VALUES ($1,'team',$2) ON CONFLICT DO NOTHING", [p.id, t.id]);
  created.add(t.id);
  return t;
}

/**
 * Import the approved rows in batches of 100, each batch in its own transaction, recording every row's outcome as it goes.
 * Safe to call again after an interruption (or to retry rows still waiting for a sign-up or consent): finished rows are not touched.
 */
export async function runProject(projectId, actor) {
  const p = (await pool.query('SELECT * FROM migration_projects WHERE id=$1', [projectId])).rows[0];
  await pool.query("UPDATE migration_projects SET status='importing', started_at=coalesce(started_at, now()), updated_at=now() WHERE id=$1", [projectId]);
  const created = new Set();
  // every row still to do: never imported, or waiting on a sign-up / consent / a failed attempt worth retrying. Rows already invited are never touched again.
  const todo = (await pool.query(
    `SELECT id, row_no, data_enc, key_hash, email_idx FROM migration_rows
      WHERE project_id=$1 AND check_status IN ('valid','warning') AND (commit_status IS NULL OR commit_status IN ('awaiting_signup','awaiting_consent','failed'))
      ORDER BY row_no`, [projectId])).rows;
  for (let at = 0; at < todo.length; at += BATCH) {
    await tx(async (c) => {
      for (const r of todo.slice(at, at + BATCH)) {
        const d = openData(r.data_enc);
        let status = 'failed', userId = null, teamId = null, why = null;
        try {
          await c.query('SAVEPOINT row_sp');
          const team = d.team ? await teamFor(c, p, d.team, actor.id, created) : null;
          teamId = team?.id ?? null;
          const acct = await accountByEmail(c, r.email_idx);
          if (!acct) status = 'awaiting_signup';
          else {
            userId = acct.id;
            if (!(await mayInvite(c, acct.id, d))) status = 'awaiting_consent';
            else if (!team) status = 'already_member'; // matched, but the row names no team: nothing to invite to
            else if (d.role === 'manager' && team.owner_id !== actor.id && !actor.roles?.includes('admin')) why = 'Only the team owner can invite a manager';
            else status = (await inviteToTeam(c, { teamId: team.id, userId: acct.id, role: d.role, jersey: d.jersey_no, invitedBy: actor.id, teamName: team.name })).status;
          }
          await c.query('RELEASE SAVEPOINT row_sp');
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT row_sp');
          status = 'failed'; why = 'Could not be imported. Run the import again to retry';
        }
        if (why) status = 'failed';
        if (status !== 'failed' && teamId) {
          await c.query(`INSERT INTO migration_links(organisation_id, domain, key_hash, project_id, row_id) VALUES ($1,$2,$3,$4,$5)
                         ON CONFLICT (organisation_id, domain, key_hash) WHERE released_at IS NULL DO NOTHING`, [p.organisation_id, p.domain, r.key_hash, projectId, r.id]);
        }
        await c.query('UPDATE migration_rows SET commit_status=$2, team_id=$3, user_id=$4, committed_at=now(), reasons=CASE WHEN $5::text IS NULL THEN reasons ELSE reasons || $6::jsonb END WHERE id=$1',
          [r.id, status, teamId, userId, why, JSON.stringify(why ? [{ level: 'error', field: 'import', message: why }] : [])]);
      }
      await audit(c, actor.id, 'run_migration_batch', 'migration_projects', projectId);
    });
  }
  // rows that failed need a person (reconciliation); otherwise the import is complete and the report is the evidence
  const failed = (await pool.query("SELECT count(*)::int AS n FROM migration_rows WHERE project_id=$1 AND commit_status='failed'", [projectId])).rows[0].n;
  return one("UPDATE migration_projects SET status=$2, completed_at=CASE WHEN $2='completed' THEN coalesce(completed_at, now()) END, updated_at=now() WHERE id=$1 AND status='importing' RETURNING *", [projectId, failed ? 'reconciliation' : 'completed']);
}

/**
 * Someone registered: turn every row that was waiting for their email into a team invitation (they still accept it themselves).
 * Never throws into registration. A young person without current guardian consent stays waiting.
 */
export async function claimMigrationInvites(userId, email) {
  try {
    const idx = blindIndex(email);
    const waiting = await many(
      `SELECT r.id, r.team_id, r.data_enc, p.created_by, p.organisation_id FROM migration_rows r JOIN migration_projects p ON p.id=r.project_id
        WHERE r.email_idx=$1 AND r.commit_status IN ('awaiting_signup','awaiting_consent') AND p.status IN ('importing','completed','reconciliation')`, [idx]);
    for (const r of waiting) {
      const d = openData(r.data_enc);
      const u = await one('SELECT youth_until FROM users WHERE id=$1', [userId]);
      if (!(await mayInvite(pool, userId, d))) {
        await pool.query("UPDATE migration_rows SET commit_status='awaiting_consent', user_id=$2 WHERE id=$1", [r.id, userId]);
        continue;
      }
      const team = r.team_id ? await one('SELECT id, name FROM teams WHERE id=$1 AND archived_at IS NULL', [r.team_id]) : null;
      await tx(async (c) => {
        const res = team ? await inviteToTeam(c, { teamId: team.id, userId, role: d.role, jersey: d.jersey_no, invitedBy: r.created_by, teamName: team.name }) : { status: 'already_member' };
        await c.query('UPDATE migration_rows SET commit_status=$2, user_id=$3, committed_at=now() WHERE id=$1', [r.id, res.status, userId]);
      });
    }
    return waiting.length;
  } catch (e) { console.error('[migration] claim failed', e.message); return 0; }
}

/** Reverse what is still untouched. Invitations nobody has accepted are withdrawn (status 'left'), teams the import created and nobody uses are archived. */
export async function rollbackProject(projectId, actorId) {
  return tx(async (c) => {
    const p = (await c.query('SELECT * FROM migration_projects WHERE id=$1 FOR UPDATE', [projectId])).rows[0];
    if (!['importing', 'reconciliation', 'completed', 'rolled_back_partially'].includes(p.status)) throw conflict('Only an import that has run can be rolled back');
    const rows = (await c.query("SELECT id, team_id, user_id, commit_status FROM migration_rows WHERE project_id=$1 AND commit_status IN ('invited','awaiting_signup','awaiting_consent')", [projectId])).rows;
    let withdrawn = 0, kept = 0;
    for (const r of rows) {
      if (r.commit_status === 'invited') {
        const m = (await c.query("UPDATE team_members SET status='left' WHERE team_id=$1 AND user_id=$2 AND status='invited' RETURNING 1", [r.team_id, r.user_id])).rows[0];
        if (!m) { kept++; continue; } // already accepted (or left): protected history, never undone here
      }
      await c.query("UPDATE migration_rows SET commit_status='rolled_back' WHERE id=$1", [r.id]);
      await c.query('UPDATE migration_links SET released_at=now() WHERE row_id=$1 AND released_at IS NULL', [r.id]);
      withdrawn++;
    }
    let archived = 0, protectedTeams = 0;
    for (const t of (await c.query("SELECT entity_id FROM migration_created WHERE project_id=$1 AND entity_kind='team'", [projectId])).rows) {
      const used = (await c.query(`SELECT (SELECT count(*) FROM team_members WHERE team_id=$1 AND status<>'left' AND role<>'manager')::int AS people,
                                          (SELECT count(*) FROM fixtures WHERE home_team_id=$1 OR away_team_id=$1)::int AS games`, [t.entity_id])).rows[0];
      if (used.people || used.games) { protectedTeams++; continue; }
      await c.query('UPDATE teams SET archived_at=coalesce(archived_at, now()) WHERE id=$1', [t.entity_id]);
      archived++;
    }
    await c.query("UPDATE migration_projects SET status='rolled_back_partially', rolled_back_at=now(), updated_at=now() WHERE id=$1", [projectId]);
    await audit(c, actorId, 'rollback_migration', 'migration_projects', projectId);
    return { withdrawn, kept_because_accepted: kept, teams_archived: archived, teams_kept_in_use: protectedTeams };
  });
}

/** Row-level evidence: counts, what was created, linked, skipped, failed and every unresolved item. Emails are masked. */
export async function buildReport(project, viewerId) {
  const check = await summarise(project.id);
  const commit = Object.fromEntries((await many('SELECT coalesce(commit_status, \'not_imported\') AS s, count(*)::int AS n FROM migration_rows WHERE project_id=$1 GROUP BY 1', [project.id])).map((r) => [r.s, r.n]));
  const teams = await many("SELECT t.id, t.name FROM migration_created c JOIN teams t ON t.id=c.entity_id WHERE c.project_id=$1 AND c.entity_kind='team' ORDER BY t.name", [project.id]);
  const unresolved = (await many(
    `SELECT row_no, check_status, commit_status, reasons, data_enc FROM migration_rows
      WHERE project_id=$1 AND (check_status IN ('rejected','duplicate','conflict','skipped') OR commit_status IN ('awaiting_signup','awaiting_consent','failed'))
      ORDER BY row_no LIMIT 500`, [project.id])).map((r) => {
    const d = r.data_enc ? openData(r.data_enc) : null;
    return { row: r.row_no, outcome: r.commit_status ?? r.check_status, name: d ? [d.first_name, d.last_name].filter(Boolean).join(' ') : null, email: d?.email ? maskEmail(d.email) : null, reasons: r.reasons.filter((x) => x.level !== 'info').map((x) => x.message) };
  });
  if (unresolved.some((u) => u.name)) await audit(null, viewerId, 'read_migration_report', 'migration_projects', project.id);
  return {
    project: { id: project.id, status: project.status, source: project.source, domain: project.domain, file_name: project.file_name, created_at: project.created_at, approved_at: project.approved_at, completed_at: project.completed_at, rolled_back_at: project.rolled_back_at, mapping_version: project.mapping_version },
    source_rows: project.source_rows,
    validation: check,
    result: {
      invited: commit.invited ?? 0, awaiting_signup: commit.awaiting_signup ?? 0, awaiting_consent: commit.awaiting_consent ?? 0, already_member: commit.already_member ?? 0,
      failed: commit.failed ?? 0, rolled_back: commit.rolled_back ?? 0, not_imported: commit.not_imported ?? 0,
    },
    teams_created: teams,
    financial: null,
    notes: ['Roster imports carry no money: opening balances and fees are not part of this import.', 'Nobody is added to a team directly. Everyone is invited and accepts; young people also need a guardian\'s consent, which an import never creates.'],
    unresolved,
  };
}

export const assertMappable = (headers, mapping) => {
  for (const [f, h] of Object.entries(mapping)) if (h && !headers.includes(h)) throw badRequest(`Column "${h}" is not in the file (${f})`);
};
