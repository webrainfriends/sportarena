// Team & delegation travel operations (#485), part 4: passport / visa readiness, youth trip consent and emergency contact.
// Only the minimum is kept: a status and an expiry. Document numbers and evidence references are encrypted (`*_enc`), shown only to the holder or a
// verified guardian, every reveal is audit-logged, no scans are stored, and numbers never reach a notification, log line, report or the history.
// This records operational readiness. It does not decide immigration eligibility and is not immigration advice.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, pool, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { guardianLink } from '../youth.js';
import { LIVE_PARTICIPANT, addMonths, assertOpen, audienceOf, guardiansOfMany, localDay, record, tripCtx, youthIdsAmong } from '../trips.js';

const TAG = 'Team travel';
const PASSPORT = ['held', 'not_held', 'unknown'];
const VISA = ['not_required', 'required', 'submitted', 'approved', 'unknown'];
const day = z.string().date();
const DOC_COLS = "id, trip_id, participant_id, kind, status, to_char(expires_on,'YYYY-MM-DD') AS expires_on, number_enc, evidence_ref_enc, updated_by, updated_at";

async function participantFor(c, ctx, pid) {
  const p = (await c.query('SELECT * FROM trip_participants WHERE id=$1 AND trip_id=$2 AND status = ANY($3)', [pid, ctx.trip.id, LIVE_PARTICIPANT])).rows[0];
  if (!p) throw notFound('Traveller');
  return p;
}
/** The holder, or a verified guardian of a young holder. Trip staff are deliberately not included: they need status, never the identifier. */
const isHolderOrGuardian = (ctx, p) => ctx.mine?.id === p.id || ctx.wardIds.has(p.id);

cap({
  name: 'set_trip_document', method: 'POST', path: '/trips/:id/party/:participant_id/documents/:kind', tag: TAG,
  summary: 'Record a traveller\'s passport or visa readiness: a status and, where needed, an expiry date. The holder (or a young holder\'s verified guardian) may also store the document number and an evidence reference; those are encrypted and never shown to trip staff. Trip staff can set status and expiry only. Notifications never contain a number.',
  input: z.object({ id, participant_id: id, kind: z.enum(['passport', 'visa']), status: z.string(), expires_on: day.nullable().optional(), number: z.string().trim().min(3).max(40).nullable().optional(), evidence_ref: z.string().trim().min(2).max(200).nullable().optional() }),
  async handler({ user }, i) {
    if (!(i.kind === 'passport' ? PASSPORT : VISA).includes(i.status)) throw badRequest(`Status for a ${i.kind} must be one of ${(i.kind === 'passport' ? PASSPORT : VISA).join(', ')}`);
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c);
      assertOpen(ctx.trip);
      const p = await participantFor(c, ctx, i.participant_id);
      const own = isHolderOrGuardian(ctx, p);
      if (!ctx.ops && !own) throw forbidden('You can update only your own documents, or those of a young traveller you are a verified guardian of');
      if ((i.number !== undefined || i.evidence_ref !== undefined) && !own) throw forbidden('Only the holder or their verified guardian can store a document number or evidence reference');
      const prev = (await c.query(`SELECT ${DOC_COLS} FROM trip_documents WHERE participant_id=$1 AND kind=$2`, [p.id, i.kind])).rows[0];
      const numberEnc = i.number === undefined ? prev?.number_enc ?? null : i.number ? encrypt(i.number, 'trip_documents.number') : null;
      const evEnc = i.evidence_ref === undefined ? prev?.evidence_ref_enc ?? null : i.evidence_ref ? encrypt(i.evidence_ref, 'trip_documents.evidence_ref') : null;
      const expires = i.expires_on === undefined ? prev?.expires_on ?? null : i.expires_on;
      const d = (await c.query(
        `INSERT INTO trip_documents(trip_id, participant_id, kind, status, expires_on, number_enc, evidence_ref_enc, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (participant_id, kind) DO UPDATE SET status=EXCLUDED.status, expires_on=EXCLUDED.expires_on, number_enc=EXCLUDED.number_enc, evidence_ref_enc=EXCLUDED.evidence_ref_enc, updated_by=EXCLUDED.updated_by, updated_at=now() RETURNING ${DOC_COLS}`,
        [ctx.trip.id, p.id, i.kind, i.status, expires, numberEnc, evEnc, user.id])).rows[0];
      await record(c, ctx.trip, user.id, { entity: 'document', entityId: d.id, action: prev ? 'updated' : 'recorded', snapshot: { participant_id: p.id, kind: i.kind, status: d.status, expires_on: d.expires_on } });
      const tooSoon = i.kind === 'passport' && ctx.trip.documents_required && d.expires_on && d.expires_on < addMonths(localDay(ctx.trip.return_at, ctx.trip.timezone), ctx.trip.passport_min_months);
      if (tooSoon) for (const u of [...new Set([p.user_id, ctx.trip.manager_id, ...(await guardiansOfMany(c, await youthIdsAmong(c, [p.user_id])))])]) if (u !== user.id)
        await notify(c, u, { kind: 'trip_document_alert', title: 'A passport expires too soon for this trip', body: ctx.trip.name, data: { trip_id: ctx.trip.id }, dedupe_key: `trip:doc-expiry:${d.id}:${d.expires_on}:${u}` });
      return { id: d.id, kind: d.kind, status: d.status, expires_on: d.expires_on, has_number: !!d.number_enc, has_evidence: !!d.evidence_ref_enc, expires_too_soon: !!tooSoon };
    });
  },
});

cap({
  name: 'reveal_trip_document', method: 'GET', path: '/trips/:id/party/:participant_id/documents/:kind/reveal', tag: TAG,
  summary: 'The holder (or a young holder\'s verified guardian) reads back the stored document number and evidence reference. Audit-logged. Trip staff cannot reveal it.',
  input: z.object({ id, participant_id: id, kind: z.enum(['passport', 'visa']) }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    const p = await participantFor(pool, ctx, i.participant_id);
    if (!isHolderOrGuardian(ctx, p)) throw notFound('Document');
    const d = (await pool.query(`SELECT ${DOC_COLS} FROM trip_documents WHERE participant_id=$1 AND kind=$2`, [p.id, i.kind])).rows[0];
    if (!d) throw notFound('Document');
    await audit(null, user.id, 'reveal_trip_document', 'trip_documents', d.id);
    return { kind: d.kind, status: d.status, expires_on: d.expires_on, number: d.number_enc ? decrypt(d.number_enc, 'trip_documents.number') : null, evidence_ref: d.evidence_ref_enc ? decrypt(d.evidence_ref_enc, 'trip_documents.evidence_ref') : null };
  },
});

cap({
  name: 'list_trip_compliance', method: 'GET', path: '/trips/:id/compliance', tag: TAG,
  summary: 'Per traveller: passport and visa status with expiry, and (for a young traveller) whether a verified guardian\'s trip consent is current. Never numbers. Trip staff see everyone; a traveller or guardian sees only their own.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    const mine = new Set([ctx.mine?.id, ...ctx.wards.map((w) => w.id)].filter(Boolean));
    const parts = await many(`SELECT p.id, p.user_id, p.role, p.status, u.display_name FROM trip_participants p JOIN users u ON u.id=p.user_id WHERE p.trip_id=$1 AND p.status = ANY($2) ORDER BY p.created_at`, [ctx.trip.id, LIVE_PARTICIPANT]);
    const docs = await many("SELECT participant_id, kind, status, to_char(expires_on,'YYYY-MM-DD') AS expires_on, (number_enc IS NOT NULL) AS has_number, (evidence_ref_enc IS NOT NULL) AS has_evidence FROM trip_documents WHERE trip_id=$1", [ctx.trip.id]);
    const cons = await many(`SELECT t.participant_id, t.emergency_contact_ok, t.expires_at, (t.expires_at > now() AND EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=t.guardian_id AND l.child_id=t.child_id AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()))) AS current FROM trip_consents t WHERE t.trip_id=$1 AND t.revoked_at IS NULL`, [ctx.trip.id]);
    const youth = new Set(await youthIdsAmong(pool, parts.map((p) => p.user_id)));
    return parts.filter((p) => ctx.ops || mine.has(p.id)).map((p) => ({
      participant_id: p.id, display_name: youth.has(p.user_id) && !ctx.ops && !mine.has(p.id) ? 'Young traveller' : p.display_name, role: p.role, status: p.status, young: youth.has(p.user_id),
      passport: docs.find((d) => d.participant_id === p.id && d.kind === 'passport') ?? null, visa: docs.find((d) => d.participant_id === p.id && d.kind === 'visa') ?? null,
      consent: youth.has(p.user_id) && p.role !== 'guardian' ? (cons.find((x) => x.participant_id === p.id) ?? { current: false }) : null,
    }));
  },
});

cap({
  name: 'decide_trip_consent', method: 'POST', path: '/trips/:id/party/:participant_id/consent', tag: TAG,
  summary: 'A young traveller\'s verified guardian grants, declines or revokes consent for THIS trip (separate from general participation consent). Granting confirms the young traveller on the trip; revoking returns them to invited and tells trip staff. Consent lapses a week after the trip ends and also stops counting the moment the guardian link is revoked.',
  input: z.object({ id, participant_id: id, decision: z.enum(['grant', 'decline', 'revoke']), emergency_contact_ok: z.boolean().default(false).describe('allow trip staff to reach you through the platform in an emergency during the trip') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      assertOpen(ctx.trip);
      const p = (await c.query('SELECT * FROM trip_participants WHERE id=$1 AND trip_id=$2 AND status = ANY($3) FOR UPDATE', [i.participant_id, ctx.trip.id, LIVE_PARTICIPANT])).rows[0];
      if (!p || !ctx.wardIds.has(p.id)) throw notFound('Traveller');
      if (!(await guardianLink(user.id, p.user_id, c))) throw forbidden('You are no longer a verified guardian of this young person');
      const live = (await c.query('SELECT * FROM trip_consents WHERE participant_id=$1 AND revoked_at IS NULL', [p.id])).rows[0];
      if (i.decision === 'grant') {
        if (live) throw conflict('Trip consent is already recorded. Revoke it first to change it.');
        const exp = new Date(Date.parse(ctx.trip.return_at) + 7 * 864e5).toISOString();
        await c.query('INSERT INTO trip_consents(trip_id, participant_id, child_id, guardian_id, emergency_contact_ok, expires_at) VALUES ($1,$2,$3,$4,$5,$6)', [ctx.trip.id, p.id, p.user_id, user.id, i.emergency_contact_ok, exp]);
        await c.query("UPDATE trip_participants SET status='confirmed', responded_at=now() WHERE id=$1 AND status='invited'", [p.id]);
      } else if (i.decision === 'decline') {
        if (p.status !== 'invited') throw conflict('Use revoke to withdraw consent already given');
        await c.query("UPDATE trip_participants SET status='declined', responded_at=now(), ended_at=now(), ended_reason='Guardian declined' WHERE id=$1", [p.id]);
      } else {
        if (!live) throw conflict('There is no consent to revoke');
        await c.query('UPDATE trip_consents SET revoked_at=now(), revoked_by=$2 WHERE id=$1', [live.id, user.id]);
        await c.query("UPDATE trip_participants SET status='invited' WHERE id=$1 AND status='confirmed'", [p.id]);
      }
      await record(c, ctx.trip, user.id, { entity: 'consent', entityId: p.id, action: `consent_${i.decision}`, snapshot: { participant_id: p.id, emergency_contact_ok: i.decision === 'grant' ? i.emergency_contact_ok : null },
        affected: [ctx.trip.manager_id], title: i.decision === 'grant' ? 'Guardian consent received' : i.decision === 'decline' ? 'A guardian declined a trip' : 'A guardian withdrew trip consent', body: ctx.trip.name });
      return { participant_id: p.id, decision: i.decision };
    });
  },
});

cap({
  name: 'get_trip_emergency_contacts', method: 'GET', path: '/trips/:id/party/:participant_id/emergency', tag: TAG,
  summary: 'Trip staff: who can be reached for a young traveller in an emergency, limited to guardians who agreed to it, and only from a day before departure until a day after return. Names only; contact happens through the platform (contact_trip_guardians). Every look is audit-logged.',
  input: z.object({ id, participant_id: id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    if (!ctx.ops) throw forbidden('Only trip staff can use emergency contacts');
    const t = ctx.trip, now = Date.now();
    if (now < Date.parse(t.depart_at) - 864e5 || now > Date.parse(t.return_at) + 864e5) throw conflict('Emergency contacts are available only from a day before departure until a day after return');
    const p = await participantFor(pool, ctx, i.participant_id);
    const rows = await many(
      `SELECT g.id AS guardian_id, g.display_name FROM trip_consents t JOIN users g ON g.id=t.guardian_id
        WHERE t.participant_id=$1 AND t.revoked_at IS NULL AND t.emergency_contact_ok AND t.expires_at > now()
          AND EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=t.guardian_id AND l.child_id=t.child_id AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()))`, [p.id]);
    await audit(null, user.id, 'view_trip_emergency_contacts', 'trip_participants', p.id);
    return rows;
  },
});

cap({
  name: 'contact_trip_guardians', method: 'POST', path: '/trips/:id/party/:participant_id/emergency/contact', tag: TAG,
  summary: 'Trip staff: send an urgent platform message to the guardians of a young traveller who agreed to emergency contact. The message and who sent it are audit-logged.',
  input: z.object({ id, participant_id: id, message: z.string().trim().min(2).max(500) }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    if (!ctx.ops) throw forbidden('Only trip staff can use emergency contacts');
    const t = ctx.trip, now = Date.now();
    if (now < Date.parse(t.depart_at) - 864e5 || now > Date.parse(t.return_at) + 864e5) throw conflict('Emergency contact is available only from a day before departure until a day after return');
    return tx(async (c) => {
      const p = await participantFor(c, ctx, i.participant_id);
      const who = (await c.query(
        `SELECT t.guardian_id FROM trip_consents t WHERE t.participant_id=$1 AND t.revoked_at IS NULL AND t.emergency_contact_ok AND t.expires_at > now()
            AND EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=t.guardian_id AND l.child_id=t.child_id AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()))`, [p.id])).rows.map((r) => r.guardian_id);
      if (!who.length) throw conflict('No guardian has agreed to emergency contact for this traveller');
      for (const g of who) await notify(c, g, { kind: 'trip_emergency', title: `Urgent from the trip team: ${t.name}`, body: i.message, data: { trip_id: t.id, participant_id: p.id } });
      await audit(c, user.id, 'contact_trip_guardians', 'trip_participants', p.id);
      await record(c, t, user.id, { entity: 'participant', entityId: p.id, action: 'guardians_contacted', snapshot: { count: who.length } });
      return { sent_to: who.length };
    });
  },
});
