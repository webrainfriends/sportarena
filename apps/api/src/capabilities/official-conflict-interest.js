// Official conflict-of-interest declarations for specific assignments (issue #1000, REF-R09).
// An official must declare any conflict (team relationship, family, club, financial, association, prior involvement)
// before the match if the event policy requires it, or whenever they discover one.
// The organiser then decides: waive, reassign, or escalate. GotMyGame never judges acceptability;
// it records who decided what and when. detail_enc is encrypted; counterparty (plain name) is not.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { hasRole } from '../helpers.js';
import { closeOfficial } from '../officials.js';

const TAG = 'Official eligibility';
const txt = (n) => z.string().trim().max(n);

export const CONFLICT_KINDS = ['team_relationship', 'family_member', 'club_membership', 'financial_interest', 'association_connection', 'previous_involvement', 'other'];

/** Load a fixture official and validate that the caller is the official or the organiser. */
async function loadFO(c, foId, user, { lock = false } = {}) {
  const sql = lock ? 'FOR UPDATE' : '';
  const fo = (await c.query(`SELECT fo.*, e.organizer_id, e.name AS event_name, f.home_team_id, f.away_team_id FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id JOIN events e ON e.id=f.event_id WHERE fo.id=$1 ${sql}`, [foId])).rows[0];
  if (!fo) throw notFound('Official assignment');
  const isOfficial = fo.user_id === user.id;
  const isOrg = fo.organizer_id === user.id || hasRole(user, 'admin');
  if (!isOfficial && !isOrg) throw notFound('Official assignment');
  return { fo, isOrg, isOfficial };
}

async function loadConflict(c, conflictId, user, { lock = false } = {}) {
  const sql = lock ? 'FOR UPDATE' : '';
  const oc = (await c.query(`SELECT oc.*, fo.user_id AS official_id, e.organizer_id FROM official_conflicts oc JOIN fixture_officials fo ON fo.id=oc.fixture_official_id JOIN fixtures f ON f.id=fo.fixture_id JOIN events e ON e.id=f.event_id WHERE oc.id=$1 ${sql}`, [conflictId])).rows[0];
  if (!oc) throw notFound('Conflict declaration');
  const isOfficial = oc.official_id === user.id;
  const isOrg = oc.organizer_id === user.id || hasRole(user, 'admin');
  if (!isOfficial && !isOrg) throw notFound('Conflict declaration');
  return { oc, isOrg, isOfficial };
}

const viewConflict = (oc, { showDetail = false } = {}) => ({
  id: oc.id, fixture_official_id: oc.fixture_official_id, kind: oc.kind, serious: oc.serious, counterparty: oc.counterparty,
  detail: showDetail && oc.detail_enc ? decrypt(oc.detail_enc, 'official_conflicts.detail') : null,
  status: oc.status, raised_by: oc.raised_by, raised_at: oc.raised_at,
  decided_by: oc.decided_by, decided_at: oc.decided_at,
  decision_note: showDetail && oc.decision_note_enc ? decrypt(oc.decision_note_enc, 'official_conflicts.decision_note') : null,
  version: oc.version,
});

// ─── Declare ──────────────────────────────────────────────────────────────────────────────────

cap({
  name: 'declare_official_conflict', method: 'POST', path: '/official-assignments/:id/conflicts', tag: TAG, status: 201,
  summary: 'Official (or either party with knowledge of the situation) declares a conflict of interest on this assignment: team relationship, family member in the match, club membership, financial interest, association connection, prior close involvement, or other. `serious: true` means the official believes it is incompatible with impartiality. The event organiser is notified immediately.',
  input: z.object({
    id,
    kind: z.enum(CONFLICT_KINDS),
    counterparty: txt(200).optional(),
    detail: txt(1500).min(5),
    serious: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { fo, isOrg } = await loadFO(c, i.id, user);
      const row = (await c.query(
        'INSERT INTO official_conflicts(fixture_official_id, kind, serious, counterparty, detail_enc, raised_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [fo.id, i.kind, i.serious, i.counterparty ?? null, encrypt(i.detail, 'official_conflicts.detail'), user.id])).rows[0];
      await audit(c, user.id, 'declare_official_conflict', 'official_conflicts', row.id);
      const notifyId = isOrg ? fo.user_id : fo.organizer_id;
      await notify(c, notifyId, {
        kind: 'official_conflict', title: 'Conflict of interest declared',
        body: `A ${i.kind.replace(/_/g, ' ')} conflict was declared for ${fo.event_name}. Review and decide.`,
        data: { assignment_id: fo.id, conflict_id: row.id },
      });
      return viewConflict(row, { showDetail: true });
    });
  },
});

// ─── List ──────────────────────────────────────────────────────────────────────────────────────────

cap({
  name: 'list_official_conflicts', method: 'GET', path: '/official-assignments/:id/conflicts', tag: TAG,
  summary: 'Conflicts declared on an assignment. The declaring official and the event organiser can read them. The encrypted detail is decrypted for both parties. Use `status` to filter.',
  input: z.object({ id, status: z.enum([...CONFLICT_KINDS, 'open', 'waived', 'reassigned', 'escalated', 'withdrawn']).optional(), ...page }),
  async handler({ user }, i) {
    const { fo, isOrg, isOfficial } = await loadFO(pool, i.id, user);
    const rows = await many(
      `SELECT * FROM official_conflicts WHERE fixture_official_id=$1 ${i.status ? 'AND status=$4' : ''} ORDER BY raised_at DESC, id LIMIT $2 OFFSET $3`,
      [fo.id, i.limit, i.offset, ...(i.status ? [i.status] : [])]);
    return rows.map((r) => viewConflict(r, { showDetail: isOrg || r.raised_by === user.id }));
  },
});

// ─── Decide ──────────────────────────────────────────────────────────────────────────────────

cap({
  name: 'decide_official_conflict', method: 'POST', path: '/official-conflicts/:id/decision', tag: TAG,
  summary: 'Event organiser (or tournament director) decides an open conflict: waive (acceptable for this match, logged), reassign (official will be released), or escalate (refer to governing body). Decision note is encrypted. GotMyGame does not judge — this records who decided what and when.',
  input: z.object({
    id,
    decision: z.enum(['waive', 'reassign', 'escalate']),
    decision_note: txt(1000).optional(),
    row_version: z.number().int().min(1).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { oc, isOrg } = await loadConflict(c, i.id, user, { lock: true });
      if (!isOrg) throw forbidden('Only the event organiser can decide a conflict declaration');
      if (oc.status !== 'open') throw conflict(`Conflict is already ${oc.status}`);
      if (i.row_version != null && oc.version !== i.row_version) throw conflict('This record changed; reload and try again', { code: 'stale_version' });
      const statusMap = { waive: 'waived', reassign: 'reassigned', escalate: 'escalated' };
      const newStatus = statusMap[i.decision];
      const noteEnc = i.decision_note ? encrypt(i.decision_note, 'official_conflicts.decision_note') : null;
      await c.query(
        'UPDATE official_conflicts SET status=$2, decided_by=$3, decided_at=now(), decision_note_enc=$4, version=version+1 WHERE id=$1',
        [oc.id, newStatus, user.id, noteEnc]);
      await audit(c, user.id, 'decide_official_conflict', 'official_conflicts', oc.id);
      if (i.decision === 'reassign') {
        const fo = (await c.query('SELECT * FROM fixture_officials WHERE id=$1 FOR UPDATE', [oc.fixture_official_id])).rows[0];
        if (fo && ['invited', 'accepted'].includes(fo.status)) {
          await closeOfficial(c, fo, user.id, 'released', 'Released due to conflict of interest');
          await notify(c, fo.user_id, { kind: 'official_conflict', title: 'Reassigned due to conflict', body: 'The organiser has decided to reassign this fixture due to your declared conflict of interest.', data: { assignment_id: fo.id } });
        }
      } else {
        await notify(c, oc.official_id, { kind: 'official_conflict', title: `Conflict declaration ${newStatus}`, body: `The organiser has ${i.decision}d your conflict declaration.`, data: { assignment_id: oc.fixture_official_id } });
      }
      return viewConflict((await c.query('SELECT * FROM official_conflicts WHERE id=$1', [oc.id])).rows[0], { showDetail: true });
    });
  },
});

// ─── Withdraw ──────────────────────────────────────────────────────────────────────────────────────

cap({
  name: 'withdraw_official_conflict', method: 'POST', path: '/official-conflicts/:id/withdraw', tag: TAG,
  summary: 'The person who raised the conflict declaration withdraws it while it is still open (e.g. they raised it in error or the situation changed). Once withdrawn, it cannot be reopened; raise a new one if needed.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { oc, isOfficial } = await loadConflict(c, i.id, user, { lock: true });
      if (oc.raised_by !== user.id) throw forbidden('Only the person who raised this declaration can withdraw it');
      if (oc.status !== 'open') throw conflict(`Conflict is ${oc.status} and cannot be withdrawn`);
      await c.query('UPDATE official_conflicts SET status=$2, decided_by=$3, decided_at=now(), version=version+1 WHERE id=$1', [oc.id, 'withdrawn', user.id]);
      await audit(c, user.id, 'withdraw_official_conflict', 'official_conflicts', oc.id);
      await notify(c, oc.organizer_id, { kind: 'official_conflict', title: 'Conflict declaration withdrawn', body: 'The official has withdrawn their conflict of interest declaration.', data: { assignment_id: oc.fixture_official_id } });
      return { id: oc.id, status: 'withdrawn' };
    });
  },
});
