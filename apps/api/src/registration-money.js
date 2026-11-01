// Registration engine (#575): what happens when a registration instalment is paid through the canonical payments/finance path.
// Kept apart from the capabilities so the payments service can import it without loading the registry.
import { encrypt } from './crypto.js';

/** Mark an instalment paid. Returns false when it can no longer be paid (cancelled meanwhile), so the payment is refunded automatically. */
export async function fulfilInstalmentPaid(c, instalmentId, payment) {
  const r = (await c.query("UPDATE rx_instalments SET status='paid', paid_at=now(), payment_id=$2 WHERE id=$1 AND status='unpaid' RETURNING entry_id, seq", [instalmentId, payment.id])).rows[0];
  if (!r) return false;
  const e = (await c.query('SELECT status FROM rx_entries WHERE id=$1', [r.entry_id])).rows[0];
  await c.query("INSERT INTO rx_history(entry_id, action, from_status, to_status, actor_id, note_enc) VALUES ($1,'payment',$2,$2,$3,$4)", [r.entry_id, e.status, payment.payer_id, encrypt(`Instalment ${r.seq} paid`, 'rx_history.note')]);
  return true;
}
