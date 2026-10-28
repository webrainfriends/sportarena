// Team charges in the canonical invoices table. A team charge (what one member, or the guardian paying for them, owes) gets one numbered invoice owned
// by the team; paying it pays the invoice, a waiver or cancellation voids it, and a reduction revises it while it is open. Numbers are gapless per team
// and kind, the same promise venue and academy invoices make. Nothing here moves money: payments and receipts stay in team-money.js.
import { encrypt } from './crypto.js';

async function numberFor(c, team) {
  const base = team.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3).padEnd(3, 'X');
  const prefix = `TM${base}${team.id.replace(/-/g, '').toUpperCase().slice(0, 5)}`;
  const { seq } = (await c.query(
    `INSERT INTO team_invoice_counters(team_id, kind, seq) VALUES ($1,'invoice',1) ON CONFLICT (team_id, kind) DO UPDATE SET seq = team_invoice_counters.seq + 1 RETURNING seq`, [team.id])).rows[0];
  return `${prefix}-${new Date().getUTCFullYear()}-${String(seq).padStart(6, '0')}`;
}

const contextOf = async (c, chargeId) => (await c.query(
  `SELECT ch.*, b.title, b.currency, t.name AS team_name, pu.display_name AS payer_name, mu.display_name AS member_name
     FROM team_charges ch JOIN team_charge_batches b ON b.id=ch.batch_id JOIN teams t ON t.id=ch.team_id JOIN users pu ON pu.id=ch.payer_id JOIN users mu ON mu.id=ch.member_id WHERE ch.id=$1`, [chargeId])).rows[0];

const linesOf = (x) => {
  const rows = [{ description: `${x.title} · ${x.team_name}`, amount_cents: Number(x.amount_minor), tax_cents: 0 }];
  if (Number(x.adjusted_minor) > 0) rows.push({ description: 'Reduction or waiver', amount_cents: -Number(x.adjusted_minor), tax_cents: 0 });
  return rows;
};
const owed = (x) => Number(x.amount_minor) - Number(x.adjusted_minor);

/**
 * Bring the invoice in line with the charge: create it when the charge first needs payment, revise it while it is open, void it when the charge is
 * cancelled or fully forgiven. A paid invoice is never edited. `settling` keeps the invoice alive for a charge that is being paid in this transaction.
 */
export async function syncTeamChargeInvoice(c, chargeId, { settling = false } = {}) {
  const x = await contextOf(c, chargeId);
  if (!x) return null;
  const inv = (await c.query("SELECT * FROM invoices WHERE team_charge_id=$1 AND kind='invoice' AND status IN ('open','paid') FOR UPDATE", [chargeId])).rows[0];
  if (inv?.status === 'paid') return inv;
  const wanted = (settling || x.status === 'awaiting_payment') && owed(x) > 0;
  if (!wanted) {
    if (inv) await c.query("UPDATE invoices SET status='void', voided_at=now() WHERE id=$1", [inv.id]);
    return null;
  }
  const seller = { name: x.team_name, tax_id: null, address: null, phone: null, email: null };
  if (inv) {
    const changed = Number(inv.total_cents) !== owed(x);
    return (await c.query('UPDATE invoices SET lines=$2, total_cents=$3, revision=revision+$4 WHERE id=$1 RETURNING *', [inv.id, JSON.stringify(linesOf(x)), owed(x), changed ? 1 : 0])).rows[0];
  }
  return (await c.query(
    `INSERT INTO invoices(kind, number, team_id, team_charge_id, user_id, currency, total_cents, tax_cents, tax_name, tax_rate_bp, tax_inclusive, seller, buyer_enc, lines)
     VALUES ('invoice',$1,$2,$3,$4,$5,$6,0,'Tax',0,true,$7,$8,$9) RETURNING *`,
    [await numberFor(c, { id: x.team_id, name: x.team_name }), x.team_id, chargeId, x.payer_id, x.currency, owed(x), JSON.stringify(seller),
      encrypt(JSON.stringify({ name: x.payer_name, for: x.payer_id === x.member_id ? null : x.member_name, address: null, tax_id: null }), 'invoices.buyer'), JSON.stringify(linesOf(x))])).rows[0];
}

/** The charge was paid in full: make sure there is an invoice, then settle it. Call before the charge row itself turns paid. */
export async function settleTeamChargeInvoice(c, chargeId, method) {
  await syncTeamChargeInvoice(c, chargeId, { settling: true });
  await c.query("UPDATE invoices SET status='paid', paid_at=now(), payment_method=$2 WHERE team_charge_id=$1 AND kind='invoice' AND status='open'", [chargeId, method === 'fronted' ? 'other' : method]);
}
