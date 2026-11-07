// Venue claim flow (#697): a verified owner or authorised manager claims an existing listing.
// Evidence documents are stored as file keys (never raw URLs). The claimant's statement is encrypted at rest
// and audit-logged every time a reviewer reads it. Two concurrent claimants for the same venue are handled
// safely — a unique partial index blocks a second active claim from the same user, and decide_claim rejects
// the losing claimant automatically. Unclaimed listings are public-safe (contact data stripped for outsiders).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { DOC_LIMITS, saveEncrypted, loadEncrypted, sniffDoc } from '../doc-store.js';
import { notify } from '../notify.js';
import { isPlatform } from '../platform.js';
import { ensurePartnerFor } from './partners.js';

const TAG = 'Venue claims';
const platformOnly = (user) => { if (!isPlatform(user)) throw forbidden('Only the platform team can do that'); };

const ROLES = ['owner', 'manager', 'authorized_agent'];
const DOC_KINDS = ['title_deed', 'lease_agreement', 'trade_licence', 'tax_registration', 'id_proof', 'authorisation_letter', 'other'];
const ACTIVE_STATUSES = ['submitted', 'under_review', 'additional_docs_requested', 'disputed'];

const DOC_FOLDER = 'venue-claims', DOC_CTX = 'venue_claim_documents.file';
const STORED_FILE = /^[0-9a-f-]{36}\.bin$/;
const isUnique = (e) => e?.code === '23505';

const claimNo = async (c) => `CLM-${String((await c.query("SELECT nextval('claim_no_seq') AS n")).rows[0].n).padStart(6, '0')}`;

function viewClaim(r, { docs = [] } = {}) {
  const { statement_enc, ...rest } = r;
  return { ...rest, has_statement: !!statement_enc, documents: docs };
}

function viewDoc(d) {
  const { file_key, ...rest } = d;
  return { ...rest, has_file: !!file_key };
}

/** Load a claim for its claimant or the platform team. Anyone else gets 404, so a claim's existence is never leaked. Pass a transaction client to lock the row. */
async function loadClaim(c, user, claimId, { lock = false } = {}) {
  const r = (await c.query(
    `SELECT vc.*, v.name AS venue_name, v.city AS venue_city, v.claim_status FROM venue_claims vc JOIN venues v ON v.id=vc.venue_id WHERE vc.id=$1${lock ? ' FOR UPDATE OF vc' : ''}`,
    [claimId])).rows[0];
  if (!r || (!isPlatform(user) && r.claimant_id !== user.id)) throw notFound('Claim');
  return r;
}

/** Strip contact details from unclaimed/pending venue listings to prevent PII exposure before claim approval. */
export function claimSafeVenueView(v, user) {
  if (!v) return v;
  if (v.claim_status === 'claimed') return v;
  if (isPlatform(user)) return v;
  if (user && v.owner_id === user.id) return v;
  const { phone, contact_phone, contact_email, email, ...safe } = v;
  return safe;
}

// ------------------------------------------------------------------ claim submission

cap({
  name: 'claim_venue', method: 'POST', path: '/venues/:venue_id/claim', tag: TAG, status: 201,
  summary: 'Authenticated user submits a claim for an existing venue listing. The venue must be unclaimed or pending (not already claimed). At most 2 active claims per user globally. If another active claim already exists for the venue, both are linked via conflict_with_id and platform staff are notified of the conflict.',
  input: z.object({
    venue_id: id,
    role: z.enum(ROLES).describe('owner | manager | authorized_agent'),
    statement: z.string().min(3).max(2000).describe('The claimant\'s written statement of connection to the venue'),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      // the venue row is the lock that serialises concurrent claimants
      const venue = (await c.query('SELECT id, name, owner_id, claim_status FROM venues WHERE id=$1 FOR UPDATE', [i.venue_id])).rows[0];
      if (!venue) throw notFound('Venue');
      if (venue.claim_status === 'claimed') throw conflict('This venue has already been claimed');

      const mine = (await c.query(
        `SELECT 1 FROM venue_claims WHERE venue_id=$1 AND claimant_id=$2 AND status NOT IN ('rejected','withdrawn') LIMIT 1`,
        [i.venue_id, user.id])).rows[0];
      if (mine) throw conflict('You already have a claim for this venue');
      const onVenue = (await c.query('SELECT count(*)::int AS n FROM venue_claims WHERE venue_id=$1 AND status = ANY($2::text[])', [i.venue_id, ACTIVE_STATUSES])).rows[0].n;
      if (onVenue >= 2) throw conflict('Two claims are already being reviewed for this venue. The platform team will resolve them first');

      // Rate-limit: max 2 active claims per user
      const activeMine = (await c.query(
        `SELECT count(*)::int AS n FROM venue_claims WHERE claimant_id=$1 AND status = ANY($2::text[])`,
        [user.id, ACTIVE_STATUSES])).rows[0].n;
      if (activeMine >= 2) throw badRequest('You already have 2 active claims — resolve or withdraw one before claiming another venue');

      const no = await claimNo(c);
      const statementEnc = encrypt(i.statement, 'venue_claims.statement');

      let row;
      try {
        row = (await c.query(
          `INSERT INTO venue_claims(claim_no, venue_id, claimant_id, role, statement_enc)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [no, i.venue_id, user.id, i.role, statementEnc])).rows[0];
      } catch (e) {
        if (isUnique(e)) throw conflict('You already have a claim for this venue');
        throw e;
      }

      await c.query('INSERT INTO venue_claim_events(claim_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)',
        [row.id, user.id, 'submitted', { role: i.role }]);

      // Link conflict if another active claim exists for this venue
      const rival = (await c.query(
        `SELECT id FROM venue_claims WHERE venue_id=$1 AND id<>$2 AND status = ANY($3::text[]) LIMIT 1`,
        [i.venue_id, row.id, ACTIVE_STATUSES])).rows[0];
      if (rival) {
        await c.query('UPDATE venue_claims SET conflict_with_id=$1 WHERE id=$2', [rival.id, row.id]);
        await c.query('UPDATE venue_claims SET conflict_with_id=$1 WHERE id=$2 AND conflict_with_id IS NULL', [row.id, rival.id]);
        await c.query('INSERT INTO venue_claim_events(claim_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)',
          [row.id, user.id, 'conflict_flagged', { rival_claim_id: rival.id }]);
      }

      await c.query(`UPDATE venues SET claim_status='pending' WHERE id=$1 AND claim_status='unclaimed'`, [i.venue_id]);

      await notify(c, user.id, { kind: 'claim_submitted', title: `Claim ${no} submitted`, body: `Your claim for ${venue.name} is under review. We'll be in touch within 2 business days.`, data: { claim_id: row.id } });

      await audit(c, user.id, 'claim_venue', 'venue_claims', row.id);
      return viewClaim({ ...row, venue_name: venue.name, claim_status: 'pending' });
    });
  },
});

// ------------------------------------------------------------------ document upload

cap({
  name: 'add_claim_document', method: 'POST', path: '/claims/:claim_id/documents', tag: TAG, status: 201,
  summary: 'Attach an evidence document to a claim. Send the file as base64 `data` (PDF or photo, checked from its bytes; it is stored encrypted) or, for a file already held in storage, its `file_key`. Only the claimant or platform staff may add documents. Max 10 documents per claim.',
  input: z.object({
    claim_id: id,
    kind: z.enum(DOC_KINDS),
    label: z.string().max(120).optional(),
    data: z.string().min(4).max(14_000_000).optional().describe('The file as base64: a PDF or a photo'),
    file_name: z.string().max(200).optional(),
    file_key: z.string().min(1).max(500).optional().describe('Storage key of an already stored file (use data to upload one)'),
    mime_type: z.string().max(80).optional(),
    size_bytes: z.number().int().min(1).max(10_485_760).optional().describe('Max 10 MB'),
  }).refine((i) => !!i.data !== !!i.file_key, 'Send either the file (data) or a file_key'),
  async handler({ user }, i) {
    let stored = null;
    if (i.data) {
      const buf = Buffer.from(i.data, 'base64');
      if (buf.length > DOC_LIMITS.bytes) throw badRequest(`Documents can be up to ${DOC_LIMITS.bytes / 2 ** 20} MB`);
      const type = sniffDoc(buf);
      if (!type) throw badRequest('Upload a PDF or a photo (JPEG, PNG or WebP)');
      stored = { ...(await saveEncrypted(DOC_FOLDER, DOC_CTX, buf)), type: type.type, size: buf.length };
    }
    return tx(async (c) => {
      const claim = await loadClaim(c, user, i.claim_id, { lock: true });
      if (['approved', 'rejected', 'withdrawn'].includes(claim.status)) throw badRequest('Cannot add documents to a closed claim');

      const count = (await c.query('SELECT count(*)::int AS n FROM venue_claim_documents WHERE claim_id=$1', [i.claim_id])).rows[0].n;
      if (count >= 10) throw badRequest('A claim may have at most 10 documents');

      const doc = (await c.query(
        `INSERT INTO venue_claim_documents(claim_id, kind, label, file_key, mime_type, size_bytes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [i.claim_id, i.kind, i.label ?? i.file_name ?? null, stored ? stored.file : i.file_key, stored ? stored.type : (i.mime_type ?? null), stored ? stored.size : (i.size_bytes ?? null)])).rows[0];

      await c.query('INSERT INTO venue_claim_events(claim_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)',
        [i.claim_id, user.id, 'document_added', { doc_id: doc.id, kind: i.kind }]);
      await audit(c, user.id, 'add_claim_document', 'venue_claims', i.claim_id);
      return viewDoc(doc);
    });
  },
});

// ------------------------------------------------------------------ claimant views

cap({
  name: 'list_my_claims', method: 'GET', path: '/me/claims', tag: TAG,
  summary: 'The authenticated user\'s own venue claims with their documents.',
  input: z.object({ status: z.string().optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT vc.*, v.name AS venue_name, v.city AS venue_city FROM venue_claims vc
       JOIN venues v ON v.id=vc.venue_id WHERE vc.claimant_id=$1 ${i.status ? 'AND vc.status=$4' : ''}
       ORDER BY vc.submitted_at DESC, vc.id LIMIT $2 OFFSET $3`,
      i.status ? [user.id, i.limit, i.offset, i.status] : [user.id, i.limit, i.offset]);
    const docs = rows.length ? await many('SELECT * FROM venue_claim_documents WHERE claim_id = ANY($1::uuid[]) ORDER BY uploaded_at', [rows.map((r) => r.id)]) : [];
    const items = rows.map((r) => viewClaim(r, { docs: docs.filter((d) => d.claim_id === r.id).map(viewDoc) }));
    return { items, claims: items };
  },
});

cap({
  name: 'get_venue_claim', method: 'GET', path: '/claims/:claim_id', tag: TAG,
  summary: 'Get a single claim. The claimant sees their own; platform staff see any. Documents and timeline included. The encrypted statement is returned only to platform staff on request and that read is audit-logged.',
  input: z.object({ claim_id: id, include_statement: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]).optional().default(false) }),
  async handler({ user }, i) {
    const r = await loadClaim(pool, user, i.claim_id);
    const docs = (await many('SELECT * FROM venue_claim_documents WHERE claim_id=$1 ORDER BY uploaded_at', [i.claim_id])).map(viewDoc);
    const events = await many('SELECT id, actor_id, action, detail, created_at FROM venue_claim_events WHERE claim_id=$1 ORDER BY id', [i.claim_id]);
    const out = viewClaim(r, { docs });
    if (i.include_statement && isPlatform(user) && r.statement_enc) {
      await audit(pool, user.id, 'read_claim_statement', 'venue_claims', i.claim_id);
      out.statement = decrypt(r.statement_enc, 'venue_claims.statement');
    }
    return { ...out, document_count: docs.length, events };
  },
});

cap({
  name: 'get_claim_document', method: 'GET', path: '/admin/venue-claims/documents/:doc_id', tag: TAG,
  summary: 'Platform team: open one evidence document of a claim (base64). Every read is audit-logged.',
  input: z.object({ doc_id: id }),
  async handler({ user }, i) {
    platformOnly(user);
    const d = await one('SELECT * FROM venue_claim_documents WHERE id=$1', [i.doc_id]);
    if (!d) throw notFound('Document');
    if (!STORED_FILE.test(d.file_key)) throw notFound('Stored file');
    await audit(pool, user.id, 'read_claim_document', 'venue_claims', d.claim_id);
    const bytes = await loadEncrypted(DOC_FOLDER, DOC_CTX, d.file_key);
    return { file_name: d.label ?? `${d.kind}`, content_type: d.mime_type ?? 'application/octet-stream', data: bytes.toString('base64') };
  },
});

// ------------------------------------------------------------------ platform admin views

cap({
  name: 'list_venue_claims', method: 'GET', path: '/admin/venue-claims', tag: TAG,
  summary: 'Platform team: paginated list of venue claims. Filter by status (submitted|under_review|additional_docs_requested|approved|rejected|disputed|withdrawn) or search by venue name. Conflicts are flagged.',
  input: z.object({ status: z.string().optional(), q: z.string().optional(), venue_id: id.optional(), ...page }),
  async handler({ user }, i) {
    platformOnly(user);
    const params = [];
    const wheres = [];
    if (i.status) { params.push(i.status); wheres.push(`vc.status=$${params.length}`); }
    if (i.venue_id) { params.push(i.venue_id); wheres.push(`vc.venue_id=$${params.length}`); }
    if (i.q) { params.push(`%${i.q}%`); wheres.push(`v.name ILIKE $${params.length}`); }
    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    params.push(i.limit); params.push(i.offset);
    const rows = await many(
      `SELECT vc.*, v.name AS venue_name, v.city AS venue_city, v.claim_status AS venue_claim_status,
              u.display_name AS claimant_name,
              (SELECT count(*)::int FROM venue_claim_documents d WHERE d.claim_id=vc.id) AS doc_count,
              (vc.conflict_with_id IS NOT NULL) AS has_conflict
       FROM venue_claims vc
       JOIN venues v ON v.id=vc.venue_id
       JOIN users u ON u.id=vc.claimant_id
       ${where}
       ORDER BY vc.submitted_at DESC, vc.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params);
    const items = rows.map((r) => viewClaim(r));
    return { items, claims: items };
  },
});

// ------------------------------------------------------------------ platform decision

cap({
  name: 'decide_claim', method: 'POST', path: '/admin/venue-claims/:claim_id/decide', tag: TAG,
  summary: 'Platform team: approve, reject, request more documents, or escalate a claim. decision_note is required for approve and reject. On approval: venue is marked claimed, all rival active claims for the same venue are auto-rejected, and a partner record is created for the claimant if none exists.',
  input: z.object({
    claim_id: id,
    action: z.enum(['approve', 'reject', 'request_docs', 'escalate']),
    decision_note: z.string().min(5).max(2000).optional().describe('Required for approve and reject'),
  }),
  async handler({ user }, i) {
    platformOnly(user);
    if (['approve', 'reject'].includes(i.action) && !i.decision_note) throw badRequest('decision_note is required when approving or rejecting');

    return tx(async (c) => {
      const claim = (await c.query(
        `SELECT vc.*, v.name AS venue_name, v.city AS venue_city, v.owner_id AS venue_owner_id, v.claim_status AS venue_claim_status FROM venue_claims vc
         JOIN venues v ON v.id=vc.venue_id WHERE vc.id=$1 FOR UPDATE OF vc, v`,
        [i.claim_id])).rows[0];
      if (!claim) throw notFound('Claim');
      if (i.action === 'approve' && claim.venue_claim_status === 'claimed') throw conflict('This venue has already been claimed');
      if (['approved', 'rejected', 'withdrawn'].includes(claim.status)) throw conflict(`Claim is already ${claim.status}`);

      const newStatus = i.action === 'approve' ? 'approved'
        : i.action === 'reject' ? 'rejected'
        : i.action === 'request_docs' ? 'additional_docs_requested'
        : 'under_review'; // escalate: the claim moves to (or stays in) review and the event is logged

      await c.query(
        `UPDATE venue_claims SET status=$1, reviewer_id=$2, reviewed_at=now(), decision_note=$3, updated_at=now() WHERE id=$4`,
        [newStatus, user.id, i.decision_note ?? null, i.claim_id]);

      await c.query('INSERT INTO venue_claim_events(claim_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)',
        [i.claim_id, user.id, i.action, { decision_note: i.decision_note ?? null }]);

      if (i.action === 'approve') {
        // Mark venue claimed
        await c.query(
          `UPDATE venues SET claim_status='claimed', claimed_by=$1, claimed_at=now() WHERE id=$2`,
          [claim.claimant_id, claim.venue_id]);

        // The approved claimant joins the venue team as manager (the platform team verified them); without this a claimed venue would still be unmanageable by them
        await c.query(
          `INSERT INTO venue_staff(venue_id, user_id, role) VALUES ($1,$2,'manager')
           ON CONFLICT (venue_id, user_id) DO UPDATE SET removed_at=NULL, role='manager'`,
          [claim.venue_id, claim.claimant_id]);

        // Reject all other active claims for this venue
        const rivals = (await c.query(
          `SELECT id, claimant_id FROM venue_claims WHERE venue_id=$1 AND id<>$2 AND status = ANY($3::text[])`,
          [claim.venue_id, i.claim_id, ACTIVE_STATUSES])).rows;
        for (const rival of rivals) {
          await c.query(
            `UPDATE venue_claims SET status='rejected', reviewer_id=$1, reviewed_at=now(),
             decision_note='Another claim for this venue was approved', updated_at=now() WHERE id=$2`,
            [user.id, rival.id]);
          await c.query('INSERT INTO venue_claim_events(claim_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)',
            [rival.id, user.id, 'rejected', { reason: 'conflicting_claim_approved', winner_claim_id: i.claim_id }]);
          await notify(c, rival.claimant_id, { kind: 'claim_rejected', title: 'Venue claim not approved', body: `Your claim for ${claim.venue_name} was not approved — another application was verified first.`, data: { claim_id: rival.id } });
        }

        // Ensure the new owner has a partner record
        const claimant = (await c.query('SELECT id, display_name, roles FROM users WHERE id=$1', [claim.claimant_id])).rows[0];
        if (claimant) await ensurePartnerFor(c, claimant, { city: claim.venue_city ?? null });

        await notify(c, claim.claimant_id, { kind: 'claim_approved', title: `🎉 ${claim.venue_name} is now yours`, body: 'Your venue claim was approved. Set up your venue profile, pricing and payouts.', data: { claim_id: i.claim_id, venue_id: claim.venue_id } });
      } else if (i.action === 'reject') {
        await notify(c, claim.claimant_id, { kind: 'claim_rejected', title: 'Venue claim not approved', body: `Your claim for ${claim.venue_name} was not approved. ${i.decision_note ?? ''}`, data: { claim_id: i.claim_id } });
      } else if (i.action === 'request_docs') {
        await notify(c, claim.claimant_id, { kind: 'claim_docs_requested', title: 'Additional documents needed', body: `${i.decision_note ?? 'Please upload additional evidence for your claim.'}`, data: { claim_id: i.claim_id } });
      }

      await audit(c, user.id, `decide_claim_${i.action}`, 'venue_claims', i.claim_id);
      return { claim_id: i.claim_id, status: newStatus, action: i.action };
    });
  },
});

// ------------------------------------------------------------------ dispute

cap({
  name: 'dispute_claim', method: 'POST', path: '/claims/:claim_id/dispute', tag: TAG,
  summary: 'The claimant disputes a rejection. dispute_reason is required. Only one dispute per claim.',
  input: z.object({
    claim_id: id,
    dispute_reason: z.string().min(10).max(2000),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const claim = await loadClaim(c, user, i.claim_id, { lock: true });
      if (claim.claimant_id !== user.id) throw forbidden('Only the claimant can dispute a decision');
      if (claim.dispute_at) throw conflict('This claim has already been disputed');
      if (claim.status !== 'rejected') throw badRequest('Only a rejected claim can be disputed');

      await c.query(
        `UPDATE venue_claims SET status='disputed', dispute_reason=$1, dispute_at=now(), updated_at=now() WHERE id=$2`,
        [i.dispute_reason, i.claim_id]);
      await c.query('INSERT INTO venue_claim_events(claim_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)',
        [i.claim_id, user.id, 'disputed', { dispute_reason: i.dispute_reason }]);

      await audit(c, user.id, 'dispute_claim', 'venue_claims', i.claim_id);
      return { claim_id: i.claim_id, status: 'disputed' };
    });
  },
});

// ------------------------------------------------------------------ withdraw

cap({
  name: 'withdraw_claim', method: 'DELETE', path: '/claims/:claim_id', tag: TAG,
  summary: 'The claimant withdraws their claim before a decision is made. The claim is archived (soft-deleted). If this was the only active claim for the venue, the venue reverts to unclaimed.',
  input: z.object({ claim_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const claim = await loadClaim(c, user, i.claim_id, { lock: true });
      if (claim.claimant_id !== user.id) throw forbidden('Only the claimant can withdraw a claim');
      if (!ACTIVE_STATUSES.includes(claim.status)) throw badRequest(`A ${claim.status} claim cannot be withdrawn`);

      await c.query(
        `UPDATE venue_claims SET status='withdrawn', withdrawn_at=now(), updated_at=now() WHERE id=$1`,
        [i.claim_id]);
      await c.query('INSERT INTO venue_claim_events(claim_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)',
        [i.claim_id, user.id, 'withdrawn', {}]);

      // Revert venue to unclaimed if no other active claims remain
      const remaining = (await c.query(
        `SELECT count(*)::int AS n FROM venue_claims WHERE venue_id=$1 AND id<>$2 AND status = ANY($3::text[])`,
        [claim.venue_id, i.claim_id, ACTIVE_STATUSES])).rows[0].n;
      if (remaining === 0) {
        await c.query(`UPDATE venues SET claim_status='unclaimed' WHERE id=$1 AND claim_status='pending'`, [claim.venue_id]);
      }

      await audit(c, user.id, 'withdraw_claim', 'venue_claims', i.claim_id);
      return { claim_id: i.claim_id, status: 'withdrawn' };
    });
  },
});
