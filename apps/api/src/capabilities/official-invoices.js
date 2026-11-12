// Referee invoices, expenses and settlement (#1008). Converts approved officiating engagements into formal
// payable/receivable financial records. Two kinds: self_issued (the official raises their own invoice) and
// rci (Recipient Created Invoice — organiser raises it on the official's behalf, as legally supported in
// some jurisdictions). Both kinds share the same state machine; the difference is who may create/submit
// and who must confirm. Money flows through the canonical settlement/payout path (#71, #701); this file
// only manages the invoice lifecycle and links it to fixture_officials.pay_status.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, money, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { eventForOrganizer } from './events.js';

const TAG = 'Officials';
const cur = z.string().regex(/^[A-Z]{3}$/);
const day = z.string().date();
const bps = z.coerce.number().int().min(0).max(5000); // max 50% withholding

// ── helpers ────────────────────────────────────────────────────────────────

async function loadOi(c, oiId) {
  const oi = (await c.query(
    `SELECT oi.*, f.event_id, e.organizer_id, fo.user_id AS official_user_id, fo.fee_minor AS fo_fee_minor, fo.fee_currency AS fo_fee_currency
     FROM official_invoices oi
     JOIN fixture_officials fo ON fo.id = oi.fixture_official_id
     JOIN fixtures f ON f.id = fo.fixture_id
     JOIN events e ON e.id = f.event_id
     WHERE oi.id = $1 FOR UPDATE OF oi`,
    [oiId],
  )).rows[0];
  if (!oi) throw notFound('official invoice');
  return oi;
}

function canRead(user, oi) {
  return isAdmin(user) || user.id === oi.official_id || user.id === oi.organizer_id;
}

async function emitEvent(c, oiId, event, actorId, actorRole, meta) {
  await c.query(
    'INSERT INTO official_invoice_events(official_invoice_id, event, actor_id, actor_role, meta) VALUES ($1,$2,$3,$4,$5)',
    [oiId, event, actorId ?? null, actorRole ?? null, meta ? JSON.stringify(meta) : null],
  );
}

async function payLog(c, fo, actor, from, to, note) {
  await c.query(
    'INSERT INTO fixture_official_pay_log(fixture_official_id, actor_id, fee_minor, fee_currency, from_status, to_status, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [fo.id, actor, fo.fee_minor ?? fo.fo_fee_minor, fo.fee_currency ?? fo.fo_fee_currency, from, to, note ?? null],
  );
}

function safeView(oi) {
  const { buyer_snapshot_enc, seller_snapshot_enc, ...rest } = oi;
  return rest;
}

// ── create draft ──────────────────────────────────────────────────────────

cap({
  name: 'create_official_invoice',
  method: 'POST',
  path: '/official-assignments/:id/invoice',
  tag: TAG,
  status: 201,
  summary: 'Create a draft invoice for an official assignment. Use kind=self_issued when the official raises their own invoice; kind=rci when the organiser creates it on the official\'s behalf (Recipient Created Invoice). Lines are pre-filled from the assignment fee; pass overrides as needed. Withholding rate in basis points (e.g. 2000 = 20%).',
  input: z.object({
    id,
    kind: z.enum(['self_issued', 'rci']),
    total_minor: money.optional(),
    tax_minor: money.optional().default(0),
    withholding_rate_bps: bps.optional().default(0),
    currency: cur.optional(),
    idempotency_key: z.string().max(128).optional(),
    // R36: optional discount link — references an already-applied official_discount_redemption
    discount_redemption_id: z.string().uuid().optional(),
    discount_code: z.string().max(32).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const fo = (await c.query(
        `SELECT fo.*, f.event_id, e.organizer_id FROM fixture_officials fo
         JOIN fixtures f ON f.id = fo.fixture_id
         JOIN events e ON e.id = f.event_id
         WHERE fo.id = $1 FOR UPDATE OF fo`,
        [i.id],
      )).rows[0];
      if (!fo) throw notFound('official assignment');

      if (i.kind === 'self_issued' && fo.user_id !== user.id) throw notFound('official assignment');
      if (i.kind === 'rci' && fo.organizer_id !== user.id && !isAdmin(user)) throw notFound('official assignment');
      if (!['invited', 'accepted', 'completed'].includes(fo.status)) throw conflict(`Assignment is ${fo.status}`);

      // idempotency: return existing draft if same key
      if (i.idempotency_key) {
        const existing = (await c.query('SELECT * FROM official_invoices WHERE idempotency_key=$1', [i.idempotency_key])).rows[0];
        if (existing) return safeView(existing);
      }

      const currency = i.currency ?? fo.fee_currency;
      if (!currency) throw badRequest('No currency on the assignment; pass currency explicitly');
      let listMinor = i.total_minor ?? fo.fee_minor ?? 0;
      let preDiscountGrossMinor = null;
      let discountMinor = 0;
      let discountFundedBy = null;

      // R36: apply discount redemption if supplied
      if (i.discount_redemption_id) {
        const redemption = (await c.query(
          `SELECT id, list_price_minor, discounted_price_minor, saving_minor, funded_by_snapshot, voided_at
           FROM official_discount_redemptions WHERE id = $1`,
          [i.discount_redemption_id],
        )).rows[0];
        if (!redemption) throw badRequest('Discount redemption not found');
        if (redemption.voided_at) throw badRequest('Discount redemption has been voided');
        preDiscountGrossMinor = listMinor;
        discountMinor = Number(redemption.saving_minor);
        discountFundedBy = redemption.funded_by_snapshot;
        // Tax is computed on the post-discount (discounted) amount
        listMinor = Math.max(0, listMinor - discountMinor);
      }

      const totalMinor = listMinor;
      const taxMinor = i.tax_minor ?? 0;
      const withholdingMinor = Math.floor(totalMinor * (i.withholding_rate_bps ?? 0) / 10000);
      const netMinor = totalMinor - withholdingMinor;

      // encrypt buyer and seller PII snapshots
      const buyerSnap = encrypt(JSON.stringify({ organisation_id: fo.organizer_id }), 'official_invoices.buyer');
      const sellerSnap = encrypt(JSON.stringify({ official_id: fo.user_id }), 'official_invoices.seller');

      const oi = (await c.query(
        `INSERT INTO official_invoices
           (fixture_official_id, organisation_id, official_id, currency, total_minor, tax_minor, net_minor, withholding_minor,
            kind, buyer_snapshot_enc, seller_snapshot_enc, idempotency_key,
            pre_discount_gross_minor, discount_minor, discount_redemption_id, discount_code, discount_funded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [fo.id, fo.organizer_id, fo.user_id, currency, totalMinor, taxMinor, netMinor, withholdingMinor,
          i.kind, buyerSnap, sellerSnap, i.idempotency_key ?? null,
          preDiscountGrossMinor, discountMinor, i.discount_redemption_id ?? null, i.discount_code ?? null, discountFundedBy],
      )).rows[0];

      if (i.withholding_rate_bps > 0) {
        await c.query(
          'INSERT INTO official_withholding(official_invoice_id, official_id, organisation_id, currency, gross_minor, rate_bps, withheld_minor) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [oi.id, fo.user_id, fo.organizer_id, currency, totalMinor, i.withholding_rate_bps, withholdingMinor],
        );
      }

      await emitEvent(c, oi.id, 'created', user.id, i.kind === 'rci' ? 'organiser' : 'official', { kind: i.kind });

      return safeView(oi);
    });
  },
});

// ── get invoice ───────────────────────────────────────────────────────────

cap({
  name: 'get_official_invoice',
  method: 'GET',
  path: '/official-invoices/:id',
  tag: TAG,
  summary: 'Full invoice detail including encrypted buyer/seller snapshots (decrypted for authorised callers only, audit-logged), withholding, payout items and event history.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const oi = await one(
      `SELECT oi.*, f.event_id, e.organizer_id, fo.user_id AS official_user_id,
              fo.fee_minor AS fo_fee_minor, fo.fee_currency AS fo_fee_currency,
              fo.status AS fo_status, fo.pay_status,
              e.name AS event_name, concat_ws(' v ', (SELECT t.name FROM teams t WHERE t.id=f.home_team_id), (SELECT t.name FROM teams t WHERE t.id=f.away_team_id)) AS fixture_name
       FROM official_invoices oi
       JOIN fixture_officials fo ON fo.id = oi.fixture_official_id
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       WHERE oi.id = $1`,
      [i.id],
    );
    if (!oi || !canRead(user, oi)) throw notFound('official invoice');

    await audit(null, user.id, 'read_official_invoice', 'official_invoices', oi.id);

    const buyerSnap = oi.buyer_snapshot_enc ? JSON.parse(decrypt(oi.buyer_snapshot_enc, 'official_invoices.buyer')) : null;
    const sellerSnap = oi.seller_snapshot_enc ? JSON.parse(decrypt(oi.seller_snapshot_enc, 'official_invoices.seller')) : null;

    const [withholding, payoutItems, events, discountRedemption] = await Promise.all([
      one('SELECT * FROM official_withholding WHERE official_invoice_id=$1', [oi.id]),
      many('SELECT * FROM official_invoice_payout_items WHERE official_invoice_id=$1 ORDER BY created_at', [oi.id]),
      many('SELECT oie.event, oie.actor_role, oie.meta, oie.created_at, u.display_name AS actor_name FROM official_invoice_events oie LEFT JOIN users u ON u.id=oie.actor_id WHERE oie.official_invoice_id=$1 ORDER BY oie.created_at', [oi.id]),
      // R36: load discount redemption detail if present
      oi.discount_redemption_id
        ? one(
            `SELECT odr.id, odr.applied_kind, odr.applied_value_bp, odr.applied_value_minor,
                    odr.saving_minor, odr.funded_by_snapshot, odr.applied_at,
                    od.name AS discount_name, od.discount_type
             FROM official_discount_redemptions odr
             JOIN official_discounts od ON od.id = odr.discount_id
             WHERE odr.id = $1`,
            [oi.discount_redemption_id],
          )
        : Promise.resolve(null),
    ]);

    const { buyer_snapshot_enc, seller_snapshot_enc, ...rest } = oi;
    return {
      ...rest,
      buyer: buyerSnap,
      seller: sellerSnap,
      withholding,
      payout_items: payoutItems,
      timeline: events,
      discount_redemption: discountRedemption,
    };
  },
});

// ── list invoices ─────────────────────────────────────────────────────────

cap({
  name: 'list_official_invoices',
  method: 'GET',
  path: '/official-invoices',
  tag: TAG,
  summary: 'Paginated list of official invoices. An official sees their own; an organiser sees invoices for their events; admins see all. No PII in list projection.',
  input: z.object({
    official_id: id.optional(),
    organisation_id: id.optional(),
    fixture_id: id.optional(),
    status: z.enum(['draft', 'submitted', 'approved', 'queried', 'disputed', 'void']).optional(),
    kind: z.enum(['self_issued', 'rci']).optional(),
    from: day.optional(),
    to: day.optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const params = [];
    const wheres = [];

    if (!isAdmin(user)) {
      wheres.push(`(oi.official_id=$${params.push(user.id)} OR oi.organisation_id = ANY(
        SELECT organisation_id FROM events e JOIN fixtures f ON f.event_id=e.id JOIN fixture_officials fo ON fo.fixture_id=f.id
        WHERE e.organizer_id=$${params.push(user.id)} LIMIT 1000
      ))`);
    }
    if (i.official_id) wheres.push(`oi.official_id=$${params.push(i.official_id)}`);
    if (i.organisation_id) wheres.push(`oi.organisation_id=$${params.push(i.organisation_id)}`);
    if (i.fixture_id) wheres.push(`f.id=$${params.push(i.fixture_id)}`);
    if (i.status) wheres.push(`oi.status=$${params.push(i.status)}`);
    if (i.kind) wheres.push(`oi.kind=$${params.push(i.kind)}`);
    if (i.from) wheres.push(`oi.created_at>=$${params.push(i.from)}`);
    if (i.to) wheres.push(`oi.created_at<$${params.push(i.to)}::date+1`);

    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

    const rows = await many(
      `SELECT oi.id, oi.kind, oi.status, oi.currency, oi.total_minor, oi.tax_minor, oi.net_minor,
              oi.withholding_minor, oi.invoice_number, oi.submitted_at, oi.approved_at,
              oi.created_at, oi.fixture_official_id, oi.organisation_id, oi.official_id,
              concat_ws(' v ', (SELECT t.name FROM teams t WHERE t.id=f.home_team_id), (SELECT t.name FROM teams t WHERE t.id=f.away_team_id)) AS fixture_name, e.name AS event_name, e.id AS event_id
       FROM official_invoices oi
       JOIN fixture_officials fo ON fo.id = oi.fixture_official_id
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       ${where}
       ORDER BY oi.created_at DESC
       LIMIT $${params.push(i.limit)} OFFSET $${params.push(i.offset)}`,
      params,
    );

    return { invoices: rows, limit: i.limit, offset: i.offset };
  },
});

// ── submit invoice ────────────────────────────────────────────────────────

cap({
  name: 'submit_official_invoice',
  method: 'POST',
  path: '/official-invoices/:id/submit',
  tag: TAG,
  summary: 'Submit a draft official invoice. Assigns an immutable sequential invoice number and notifies the counterparty. For self_issued, the official submits; for rci, the organiser submits.',
  input: z.object({ id, idempotency_key: z.string().max(128).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const oi = await loadOi(c, i.id);
      if (oi.status !== 'draft') throw conflict(`Invoice is already ${oi.status}`);

      if (oi.kind === 'self_issued' && oi.official_user_id !== user.id && !isAdmin(user)) throw notFound('official invoice');
      if (oi.kind === 'rci' && oi.organizer_id !== user.id && !isAdmin(user)) throw notFound('official invoice');

      if (i.idempotency_key && oi.idempotency_key && oi.idempotency_key !== i.idempotency_key) {
        // allow caller to supply a submit-specific idempotency key
      }

      // assign invoice number in a serialisable sub-transaction
      const kind = oi.kind === 'rci' ? 'official_rci' : 'official_self';
      const counter = (await c.query('SELECT prefix, next_seq FROM official_invoice_counters WHERE kind=$1 FOR UPDATE', [kind])).rows[0];
      if (!counter) throw conflict('Invoice counter not initialised — run migration 195');
      const invoiceNumber = `${counter.prefix}-${String(counter.next_seq).padStart(6, '0')}`;
      await c.query('UPDATE official_invoice_counters SET next_seq=next_seq+1 WHERE kind=$1', [kind]);

      await c.query(
        `UPDATE official_invoices SET status='submitted', invoice_number=$2, submitted_at=now(), updated_at=now() WHERE id=$1`,
        [oi.id, invoiceNumber],
      );
      await emitEvent(c, oi.id, 'submitted', user.id, oi.kind === 'rci' ? 'organiser' : 'official', { invoice_number: invoiceNumber });

      // notify counterparty
      if (oi.kind === 'self_issued') {
        await notify(c, oi.organizer_id, { kind: 'official_invoice', title: 'Official invoice submitted', body: `Invoice ${invoiceNumber} awaits your approval.`, data: { official_invoice_id: oi.id } });
      } else {
        await notify(c, oi.official_user_id, { kind: 'official_invoice', title: 'Invoice raised on your behalf', body: `RCI ${invoiceNumber} requires your confirmation.`, data: { official_invoice_id: oi.id } });
      }

      return (await c.query('SELECT id, status, invoice_number, submitted_at FROM official_invoices WHERE id=$1', [oi.id])).rows[0];
    });
  },
});

// ── confirm / reject RCI ──────────────────────────────────────────────────

cap({
  name: 'confirm_rci',
  method: 'POST',
  path: '/official-invoices/:id/confirm-rci',
  tag: TAG,
  summary: 'Official confirms a Recipient Created Invoice (RCI) raised by the organiser on their behalf. Transitions the invoice to approved.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const oi = await loadOi(c, i.id);
      if (oi.kind !== 'rci') throw badRequest('This is not a Recipient Created Invoice');
      if (oi.official_user_id !== user.id) throw notFound('official invoice');
      if (oi.status !== 'submitted') throw conflict(`Invoice is ${oi.status}; it must be submitted before confirmation`);

      await c.query(
        `UPDATE official_invoices SET status='approved', rci_confirmed_at=now(), approved_at=now(), updated_at=now() WHERE id=$1`,
        [oi.id],
      );
      await c.query(
        `UPDATE fixture_officials SET pay_status='due', official_invoice_id=$2, pay_updated_at=now(), pay_updated_by=$3 WHERE id=$1`,
        [oi.fixture_official_id, oi.id, user.id],
      );
      await payLog(c, { id: oi.fixture_official_id, fee_minor: oi.total_minor, fee_currency: oi.currency }, user.id, 'agreed', 'due', `RCI ${oi.invoice_number} confirmed by official`);
      await emitEvent(c, oi.id, 'rci_confirmed', user.id, 'official', null);
      await notify(c, oi.organizer_id, { kind: 'official_invoice', title: 'RCI confirmed', body: `${user.display_name ?? 'The official'} confirmed invoice ${oi.invoice_number}.`, data: { official_invoice_id: oi.id } });

      return (await c.query('SELECT id, status, rci_confirmed_at, approved_at FROM official_invoices WHERE id=$1', [oi.id])).rows[0];
    });
  },
});

cap({
  name: 'reject_rci',
  method: 'POST',
  path: '/official-invoices/:id/reject-rci',
  tag: TAG,
  summary: 'Official rejects a Recipient Created Invoice; the invoice is voided and the organiser is notified.',
  input: z.object({ id, reason: z.string().trim().min(5).max(300) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const oi = await loadOi(c, i.id);
      if (oi.kind !== 'rci') throw badRequest('This is not a Recipient Created Invoice');
      if (oi.official_user_id !== user.id) throw notFound('official invoice');
      if (oi.status !== 'submitted') throw conflict(`Invoice is ${oi.status}`);

      await c.query(
        `UPDATE official_invoices SET status='void', rci_rejected_at=now(), voided_at=now(), updated_at=now() WHERE id=$1`,
        [oi.id],
      );
      await emitEvent(c, oi.id, 'rci_rejected', user.id, 'official', { reason: i.reason });
      await notify(c, oi.organizer_id, { kind: 'official_invoice', title: 'RCI rejected', body: `Invoice ${oi.invoice_number} was rejected: ${i.reason}`, data: { official_invoice_id: oi.id } });

      return { id: oi.id, status: 'void', rci_rejected_at: new Date() };
    });
  },
});

// ── approve ───────────────────────────────────────────────────────────────

cap({
  name: 'approve_official_invoice',
  method: 'POST',
  path: '/official-invoices/:id/approve',
  tag: TAG,
  summary: 'Organiser approves a submitted (self-issued) official invoice. Sets the assignment payment status to due so it appears in payout runs.',
  input: z.object({ id, notes: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const oi = await loadOi(c, i.id);
      if (oi.organizer_id !== user.id && !isAdmin(user)) throw notFound('official invoice');
      if (oi.kind !== 'self_issued') throw badRequest('Use confirm_rci for Recipient Created Invoices');
      if (!['submitted', 'queried'].includes(oi.status)) throw conflict(`Invoice is ${oi.status}`);

      await c.query(
        `UPDATE official_invoices SET status='approved', approved_at=now(), updated_at=now() WHERE id=$1`,
        [oi.id],
      );
      await c.query(
        `UPDATE fixture_officials SET pay_status='due', official_invoice_id=$2, pay_updated_at=now(), pay_updated_by=$3 WHERE id=$1 AND (pay_status IS NULL OR pay_status IN ('none','agreed'))`,
        [oi.fixture_official_id, oi.id, user.id],
      );
      await payLog(c, { id: oi.fixture_official_id, fee_minor: oi.total_minor, fee_currency: oi.currency }, user.id, oi.fo_pay_status ?? 'agreed', 'due', `Invoice ${oi.invoice_number} approved`);
      await emitEvent(c, oi.id, 'approved', user.id, 'organiser', i.notes ? { notes: i.notes } : null);
      await notify(c, oi.official_user_id, { kind: 'official_invoice', title: 'Invoice approved', body: `Invoice ${oi.invoice_number} approved — payment is now due.`, data: { official_invoice_id: oi.id } });

      return (await c.query('SELECT id, status, approved_at FROM official_invoices WHERE id=$1', [oi.id])).rows[0];
    });
  },
});

// ── query ─────────────────────────────────────────────────────────────────

cap({
  name: 'query_official_invoice',
  method: 'POST',
  path: '/official-invoices/:id/query',
  tag: TAG,
  summary: 'Organiser queries a submitted or approved invoice before paying — the official is notified to clarify or resubmit.',
  input: z.object({ id, query_text: z.string().trim().min(5).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const oi = await loadOi(c, i.id);
      if (oi.organizer_id !== user.id && !isAdmin(user)) throw notFound('official invoice');
      if (!['submitted', 'approved'].includes(oi.status)) throw conflict(`Invoice is ${oi.status}`);

      await c.query(`UPDATE official_invoices SET status='queried', updated_at=now() WHERE id=$1`, [oi.id]);
      await emitEvent(c, oi.id, 'queried', user.id, 'organiser', { query: i.query_text });
      await notify(c, oi.official_user_id, { kind: 'official_invoice', title: 'Invoice query raised', body: i.query_text, data: { official_invoice_id: oi.id } });

      return { id: oi.id, status: 'queried' };
    });
  },
});

// ── dispute ───────────────────────────────────────────────────────────────

cap({
  name: 'dispute_official_invoice',
  method: 'POST',
  path: '/official-invoices/:id/dispute',
  tag: TAG,
  summary: 'Organiser formally disputes a submitted or queried invoice. The assignment pay_status is set to disputed; the official is notified.',
  input: z.object({ id, reason: z.string().trim().min(5).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const oi = await loadOi(c, i.id);
      if (oi.organizer_id !== user.id && !isAdmin(user)) throw notFound('official invoice');
      if (!['submitted', 'queried', 'approved'].includes(oi.status)) throw conflict(`Invoice is ${oi.status}`);

      await c.query(`UPDATE official_invoices SET status='disputed', updated_at=now() WHERE id=$1`, [oi.id]);
      await c.query(`UPDATE fixture_officials SET pay_status='disputed', pay_updated_at=now(), pay_updated_by=$2 WHERE id=$1`, [oi.fixture_official_id, user.id]);
      await payLog(c, { id: oi.fixture_official_id, fee_minor: oi.total_minor, fee_currency: oi.currency }, user.id, oi.status, 'disputed', `Invoice ${oi.invoice_number} disputed: ${i.reason}`);
      await emitEvent(c, oi.id, 'disputed', user.id, 'organiser', { reason: i.reason });
      await notify(c, oi.official_user_id, { kind: 'official_invoice', title: 'Invoice disputed', body: i.reason, data: { official_invoice_id: oi.id } });

      return { id: oi.id, status: 'disputed' };
    });
  },
});

// ── void ──────────────────────────────────────────────────────────────────

cap({
  name: 'void_official_invoice',
  method: 'POST',
  path: '/official-invoices/:id/void',
  tag: TAG,
  summary: 'Void a draft, submitted or queried invoice. The official may void their own; admins may void any.',
  input: z.object({ id, reason: z.string().trim().min(5).max(300) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const oi = await loadOi(c, i.id);
      const isOwnDraft = oi.official_id === user.id && ['draft', 'submitted', 'queried'].includes(oi.status);
      if (!isOwnDraft && !isAdmin(user)) throw notFound('official invoice');
      if (oi.status === 'void') throw conflict('Already voided');
      if (oi.status === 'approved') throw conflict('An approved invoice cannot be voided; dispute it instead or contact the platform team');

      await c.query(`UPDATE official_invoices SET status='void', voided_at=now(), updated_at=now() WHERE id=$1`, [oi.id]);
      await emitEvent(c, oi.id, 'void', user.id, isAdmin(user) && oi.official_id !== user.id ? 'admin' : 'official', { reason: i.reason });

      const otherParty = oi.official_id === user.id ? oi.organizer_id : oi.official_user_id;
      await notify(c, otherParty, { kind: 'official_invoice', title: 'Invoice voided', body: i.reason, data: { official_invoice_id: oi.id } });

      return { id: oi.id, status: 'void', voided_at: new Date() };
    });
  },
});

// ── link payout (called by settlement / payout batch) ─────────────────────

cap({
  name: 'link_official_payout',
  method: 'POST',
  path: '/official-invoices/:id/payout-link',
  tag: TAG,
  auth: ['admin'],
  summary: 'System/admin: record that a payout item settled (part of) this invoice. Prevents double-pay via unique index on (invoice, payout_item). When fully paid, sets assignment pay_status=paid.',
  input: z.object({ id, payout_item_id: id, amount_minor: money }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const oi = await loadOi(c, i.id);
      if (!['approved'].includes(oi.status)) throw conflict(`Invoice is ${oi.status}; only approved invoices can be settled`);

      // idempotent insert via unique index — ignore on conflict
      await c.query(
        'INSERT INTO official_invoice_payout_items(official_invoice_id, payout_item_id, amount_minor) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [oi.id, i.payout_item_id, i.amount_minor],
      );

      // sum all paid payout items for this invoice
      const { paid_minor } = (await c.query(
        'SELECT COALESCE(SUM(amount_minor),0)::bigint AS paid_minor FROM official_invoice_payout_items WHERE official_invoice_id=$1',
        [oi.id],
      )).rows[0];

      if (paid_minor >= oi.net_minor) {
        await c.query(`UPDATE fixture_officials SET pay_status='paid', pay_updated_at=now(), pay_updated_by=$2 WHERE id=$1`, [oi.fixture_official_id, user.id]);
        await payLog(c, { id: oi.fixture_official_id, fee_minor: oi.net_minor, fee_currency: oi.currency }, user.id, 'due', 'paid', `Settled via payout ${i.payout_item_id}`);
        await emitEvent(c, oi.id, 'payout_completed', user.id, 'system', { payout_item_id: i.payout_item_id, net_minor: oi.net_minor });
        await notify(c, oi.official_user_id, { kind: 'official_invoice', title: 'Invoice paid', body: `Invoice ${oi.invoice_number} has been fully settled.`, data: { official_invoice_id: oi.id } });
      } else {
        await emitEvent(c, oi.id, 'payout_linked', user.id, 'system', { payout_item_id: i.payout_item_id, amount_minor: i.amount_minor, paid_so_far: paid_minor });
      }

      return { id: oi.id, paid_minor: Number(paid_minor), net_minor: Number(oi.net_minor), fully_paid: paid_minor >= oi.net_minor };
    });
  },
});

// ── chargeback ────────────────────────────────────────────────────────────

cap({
  name: 'handle_official_chargeback',
  method: 'POST',
  path: '/official-invoices/:id/chargeback',
  tag: TAG,
  auth: ['admin'],
  summary: 'Admin: reverse a paid official invoice due to a chargeback or dispute resolution. Sets assignment pay_status to disputed and appends a reversal entry in the pay log.',
  input: z.object({ id, reason: z.string().trim().min(5).max(500), reversed_payout_item_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const oi = await loadOi(c, i.id);
      if (!isAdmin(user)) throw forbidden('Platform admin only');

      await c.query(`UPDATE official_invoices SET status='disputed', updated_at=now() WHERE id=$1`, [oi.id]);
      await c.query(`UPDATE fixture_officials SET pay_status='disputed', pay_updated_at=now(), pay_updated_by=$2 WHERE id=$1`, [oi.fixture_official_id, user.id]);
      await payLog(c, { id: oi.fixture_official_id, fee_minor: oi.net_minor, fee_currency: oi.currency }, user.id, 'paid', 'disputed', `Chargeback: ${i.reason}`);
      await emitEvent(c, oi.id, 'chargeback', user.id, 'admin', { reason: i.reason, reversed_payout_item_id: i.reversed_payout_item_id ?? null });
      await notify(c, oi.official_user_id, { kind: 'official_invoice', title: 'Payment reversed', body: `Invoice ${oi.invoice_number}: ${i.reason}`, data: { official_invoice_id: oi.id } });
      await notify(c, oi.organizer_id, { kind: 'official_invoice', title: 'Official payment reversed', body: `Invoice ${oi.invoice_number}: ${i.reason}`, data: { official_invoice_id: oi.id } });

      return { id: oi.id, status: 'disputed' };
    });
  },
});

// ── payable invoices (organiser view for payout batch) ────────────────────

cap({
  name: 'list_payable_official_invoices',
  method: 'GET',
  path: '/events/:id/officials/payable-invoices',
  tag: TAG,
  summary: 'Organiser: list all approved official invoices for fixtures in this event that are due for payment. Used to assemble a payout batch.',
  input: z.object({ id, currency: cur.optional(), ...page }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.id, null);
    const params = [i.id];
    const curClause = i.currency ? `AND oi.currency=$${params.push(i.currency)}` : '';
    const rows = await many(
      `SELECT oi.id, oi.invoice_number, oi.currency, oi.total_minor, oi.net_minor, oi.withholding_minor,
              oi.official_id, fo.role, f.scheduled_at, concat_ws(' v ', (SELECT t.name FROM teams t WHERE t.id=f.home_team_id), (SELECT t.name FROM teams t WHERE t.id=f.away_team_id)) AS fixture_name,
              u.display_name AS official_name
       FROM official_invoices oi
       JOIN fixture_officials fo ON fo.id = oi.fixture_official_id
       JOIN fixtures f ON f.id = fo.fixture_id
       LEFT JOIN users u ON u.id = oi.official_id
       WHERE f.event_id = $1
         AND oi.status = 'approved'
         AND fo.pay_status = 'due'
         ${curClause}
       ORDER BY f.scheduled_at NULLS LAST
       LIMIT $${params.push(i.limit)} OFFSET $${params.push(i.offset)}`,
      params,
    );
    return { invoices: rows, limit: i.limit, offset: i.offset };
  },
});

// ── reconciliation report ─────────────────────────────────────────────────

cap({
  name: 'get_official_reconciliation',
  method: 'GET',
  path: '/official-reconciliation',
  tag: TAG,
  summary: 'Period-end reconciliation report: invoices raised / approved / paid / outstanding, expenses submitted / reimbursed, and withholding deducted. An official sees only their own; an organiser sees their fixtures; admins pass either filter.',
  input: z.object({
    official_id: id.optional(),
    organisation_id: id.optional(),
    from: day,
    to: day,
    currency: cur.optional(),
  }),
  async handler({ user }, i) {
    const isOrg = !!(i.organisation_id);
    const isOff = !!(i.official_id);

    // authorisation
    if (!isAdmin(user)) {
      if (isOff && i.official_id !== user.id) throw forbidden();
      if (isOrg && !isOff) {
        const check = await one('SELECT 1 AS y FROM events WHERE organisation_id=$1 AND organizer_id=$2 LIMIT 1', [i.organisation_id, user.id]);
        if (!check) throw notFound('organisation');
      }
      if (!isOff && !isOrg) {
        // default: official sees own
        i = { ...i, official_id: user.id };
      }
    }

    const params = [i.from, i.to];
    const wheres = [`oi.created_at >= $1`, `oi.created_at < $2::date + 1`];
    if (i.official_id) wheres.push(`oi.official_id=$${params.push(i.official_id)}`);
    if (i.organisation_id) wheres.push(`oi.organisation_id=$${params.push(i.organisation_id)}`);
    if (i.currency) wheres.push(`oi.currency=$${params.push(i.currency)}`);
    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

    const invRows = await many(
      `SELECT
         oi.currency,
         COALESCE(COUNT(*) FILTER (WHERE TRUE),0)::int AS invoices_raised,
         COALESCE(SUM(oi.total_minor) FILTER (WHERE TRUE),0)::bigint AS invoices_raised_minor,
         COALESCE(COUNT(*) FILTER (WHERE oi.status='approved'),0)::int AS invoices_approved,
         COALESCE(SUM(oi.total_minor) FILTER (WHERE oi.status='approved'),0)::bigint AS invoices_approved_minor,
         COALESCE(SUM(oi.total_minor) FILTER (WHERE fo.pay_status='paid'),0)::bigint AS invoices_paid_minor,
         COALESCE(SUM(oi.total_minor) FILTER (WHERE oi.status='approved' AND fo.pay_status='due'),0)::bigint AS invoices_outstanding_minor
       FROM official_invoices oi
       JOIN fixture_officials fo ON fo.id = oi.fixture_official_id
       ${where}
       GROUP BY oi.currency`,
      params,
    );

    const expParams = [i.from, i.to];
    const expWheres = [`oe.created_at >= $1`, `oe.created_at < $2::date + 1`];
    if (i.official_id) expWheres.push(`oe.official_id=$${expParams.push(i.official_id)}`);
    if (i.organisation_id) expWheres.push(`oe.organisation_id=$${expParams.push(i.organisation_id)}`);
    if (i.currency) expWheres.push(`oe.currency=$${expParams.push(i.currency)}`);
    const expWhere = expWheres.length ? `WHERE ${expWheres.join(' AND ')}` : '';

    const expRows = await many(
      `SELECT
         oe.currency,
         COALESCE(SUM(oe.amount_minor) FILTER (WHERE oe.status IN ('submitted','approved','rejected')),0)::bigint AS expenses_submitted_minor,
         COALESCE(SUM(oe.amount_minor) FILTER (WHERE oe.status='approved'),0)::bigint AS expenses_approved_minor,
         COALESCE(SUM(oe.amount_minor) FILTER (WHERE oeb.status='paid'),0)::bigint AS expenses_reimbursed_minor
       FROM official_expenses oe
       LEFT JOIN official_expense_batches oeb ON oeb.id = oe.batch_id
       ${expWhere}
       GROUP BY oe.currency`,
      expParams,
    );

    const whParams = [i.from, i.to];
    const whWheres = [`ow.created_at >= $1`, `ow.created_at < $2::date + 1`];
    if (i.official_id) whWheres.push(`ow.official_id=$${whParams.push(i.official_id)}`);
    if (i.organisation_id) whWheres.push(`ow.organisation_id=$${whParams.push(i.organisation_id)}`);
    if (i.currency) whWheres.push(`ow.currency=$${whParams.push(i.currency)}`);
    const whWhere = whWheres.length ? `WHERE ${whWheres.join(' AND ')}` : '';

    const whRows = await many(
      `SELECT currency, COALESCE(SUM(withheld_minor),0)::bigint AS withholding_deducted_minor FROM official_withholding ${whWhere} GROUP BY currency`,
      whParams,
    );

    // merge by currency
    const currencies = [...new Set([...invRows.map((r) => r.currency), ...expRows.map((r) => r.currency), ...whRows.map((r) => r.currency)])];
    const invByCur = Object.fromEntries(invRows.map((r) => [r.currency, r]));
    const expByCur = Object.fromEntries(expRows.map((r) => [r.currency, r]));
    const whByCur = Object.fromEntries(whRows.map((r) => [r.currency, r]));

    const report = currencies.map((currency) => ({
      currency,
      invoices_raised: invByCur[currency]?.invoices_raised ?? 0,
      invoices_raised_minor: invByCur[currency]?.invoices_raised_minor ?? 0,
      invoices_approved_minor: invByCur[currency]?.invoices_approved_minor ?? 0,
      invoices_paid_minor: invByCur[currency]?.invoices_paid_minor ?? 0,
      invoices_outstanding_minor: invByCur[currency]?.invoices_outstanding_minor ?? 0,
      expenses_submitted_minor: expByCur[currency]?.expenses_submitted_minor ?? 0,
      expenses_approved_minor: expByCur[currency]?.expenses_approved_minor ?? 0,
      expenses_reimbursed_minor: expByCur[currency]?.expenses_reimbursed_minor ?? 0,
      withholding_deducted_minor: whByCur[currency]?.withholding_deducted_minor ?? 0,
    }));

    return { report, from: i.from, to: i.to };
  },
});
