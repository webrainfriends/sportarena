// Wallet: stored value per currency. Every movement goes through here inside the caller's transaction, takes the account
// row lock, and writes the ledger row, so the balance can never drift from the ledger or go negative.
import { randomBytes } from 'node:crypto';
import { AppError, conflict } from './errors.js';
import { encrypt, decrypt, sha256 } from './crypto.js';
import { notify } from './notify.js';
import { toMajor } from './currency.js';

export const balanceOf = async (c, userId, currency) => Number((await c.query('SELECT balance_cents FROM wallet_accounts WHERE user_id=$1 AND currency=$2', [userId, currency])).rows[0]?.balance_cents ?? 0);

/** Put money in. Returns the ledger row. */
export async function walletCredit(c, userId, currency, amount, { kind, refType, refId, note, silent } = {}) {
  if (!(amount > 0)) throw new Error('credit must be positive');
  const acc = (await c.query(
    `INSERT INTO wallet_accounts(user_id, currency, balance_cents) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, currency) DO UPDATE SET balance_cents = wallet_accounts.balance_cents + $3, updated_at = now() RETURNING balance_cents`, [userId, currency, amount])).rows[0];
  const row = (await c.query(
    'INSERT INTO wallet_ledger(user_id, currency, amount_cents, balance_after, kind, ref_type, ref_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [userId, currency, amount, acc.balance_cents, kind, refType ?? null, refId ?? null, note ?? null])).rows[0];
  if (!silent) await notify(c, userId, { kind: 'wallet_credit', title: `${currency} ${toMajor(amount, currency)} added to your wallet`, body: note ?? 'Your wallet was topped up.', data: { currency, amount_cents: amount } });
  return row;
}

/** Take money out; refuses (409) when the balance is too low. */
export async function walletDebit(c, userId, currency, amount, { kind = 'spend', refType, refId, note } = {}) {
  if (!(amount > 0)) throw new Error('debit must be positive');
  const acc = (await c.query('UPDATE wallet_accounts SET balance_cents = balance_cents - $3, updated_at = now() WHERE user_id=$1 AND currency=$2 AND balance_cents >= $3 RETURNING balance_cents', [userId, currency, amount])).rows[0];
  if (!acc) throw conflict(`Not enough ${currency} in your wallet`);
  return (await c.query(
    'INSERT INTO wallet_ledger(user_id, currency, amount_cents, balance_after, kind, ref_type, ref_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [userId, currency, -amount, acc.balance_cents, kind, refType ?? null, refId ?? null, note ?? null])).rows[0];
}

// ------------------------------------------------------------------ top-ups
export async function completeTopup(c, topupId) {
  const t = (await c.query("UPDATE wallet_topups SET status='paid', paid_at=now() WHERE id=$1 AND status='awaiting_payment' RETURNING *", [topupId])).rows[0];
  if (!t) return false;
  await walletCredit(c, t.user_id, t.currency, Number(t.amount_cents), { kind: 'topup', refType: 'wallet_topup', refId: t.id, note: 'Top-up' });
  return true;
}

// ------------------------------------------------------------------ gift cards
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L: codes get read out and typed by hand
export const normalizeCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const newCode = () => { const b = randomBytes(12); return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('').replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3'); };
export const hashCode = (code) => sha256(`giftcard:${normalizeCode(code)}`);
export const giftCardCode = (g) => { try { return decrypt(g.code_enc, 'gift_cards.code'); } catch { return null; } };

/** After payment: generate the code and make the card live. */
export async function activateGiftCard(c, id, { expiryMonths = 12 } = {}) {
  const code = newCode();
  const g = (await c.query(
    `UPDATE gift_cards SET status='active', paid_at=now(), code_hash=$2, code_enc=$3, code_hint=$4, expires_at = now() + make_interval(months => $5)
      WHERE id=$1 AND status='awaiting_payment' RETURNING *`, [id, hashCode(code), encrypt(code, 'gift_cards.code'), code.slice(-4), expiryMonths])).rows[0];
  if (!g) return false;
  await notify(c, g.purchaser_id, { kind: 'gift_card_ready', title: 'Your gift card is ready 🎁', body: `${g.currency} ${toMajor(Number(g.amount_cents), g.currency)} gift card ending ${g.code_hint}. Open it in the app to share the code.`, data: { gift_card_id: g.id } });
  return true;
}

export async function redeemGiftCard(c, userId, code) {
  // brute-force guard: ten wrong guesses an hour
  const bad = Number((await c.query("SELECT count(*) AS n FROM gift_card_attempts WHERE user_id=$1 AND ok=false AND at > now() - interval '1 hour'", [userId])).rows[0].n);
  if (bad >= 10) throw new AppError(429, 'rate_limited', 'Too many wrong codes — try again in an hour');
  const g = (await c.query('SELECT * FROM gift_cards WHERE code_hash=$1 FOR UPDATE', [hashCode(code)])).rows[0];
  if (!g) {
    await c.query('INSERT INTO gift_card_attempts(user_id, ok) VALUES ($1,false)', [userId]);
    return { error: new AppError(404, 'not_found', "That code isn't valid") };
  }
  if (g.status === 'redeemed') return { error: conflict('That gift card has already been used') };
  if (g.status !== 'active' || (g.expires_at && g.expires_at < new Date())) return { error: conflict('That gift card has expired or is not active') };
  await c.query("UPDATE gift_cards SET status='redeemed', redeemed_by=$2, redeemed_at=now() WHERE id=$1", [g.id, userId]);
  await c.query('INSERT INTO gift_card_attempts(user_id, ok) VALUES ($1,true)', [userId]);
  const ledger = await walletCredit(c, userId, g.currency, Number(g.amount_cents), { kind: 'gift_card', refType: 'gift_card', refId: g.id, note: g.message ? `Gift card: ${g.message}` : 'Gift card' });
  if (g.purchaser_id !== userId) await notify(c, g.purchaser_id, { kind: 'gift_card_redeemed', title: 'Your gift card was used 🎉', body: `Someone redeemed your ${g.currency} ${toMajor(Number(g.amount_cents), g.currency)} gift card.`, data: { gift_card_id: g.id } });
  return { card: g, ledger };
}
