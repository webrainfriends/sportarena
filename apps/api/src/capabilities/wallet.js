// Wallet (stored value per currency), gift cards, and paying invoices with wallet credit.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, mustFind } from '../helpers.js';
import { isSupportedCurrency, CURRENCIES, exponent } from '../currency.js';
import { balanceOf, walletCredit, walletDebit, redeemGiftCard, giftCardCode } from '../wallet.js';
import { markInvoicePaid } from '../booking/invoices.js';
import { enabledProviders } from '../payments/service.js';

const TAG = 'Wallet & gift cards';
const currency = z.string().length(3).transform((s) => s.toUpperCase()).refine(isSupportedCurrency, `Supported currencies: ${Object.keys(CURRENCIES).join(', ')}`);
const MAX_UNITS = 100_000; // largest top-up / gift card, in whole currency units
const amountOk = (cents, cur) => {
  if (cents < 10 ** exponent(cur)) throw badRequest(`The minimum is 1 ${cur}`);
  if (cents > MAX_UNITS * 10 ** exponent(cur)) throw badRequest(`The maximum is ${MAX_UNITS} ${cur}`);
};
const needProviders = () => { if (!enabledProviders().length) throw conflict('Online payment is not switched on yet'); };

cap({
  name: 'get_wallet', method: 'GET', path: '/me/wallet', tag: TAG,
  summary: 'Your wallet: one balance per currency (minor units) and the latest movements. Wallet money pays booking invoices in the same currency (apply_wallet_to_invoice) and comes from top-ups, gift cards and refunds.',
  async handler({ user }) {
    const [balances, recent] = await Promise.all([
      many('SELECT currency, balance_cents FROM wallet_accounts WHERE user_id=$1 ORDER BY currency', [user.id]),
      many('SELECT id, currency, amount_cents, balance_after, kind, note, created_at FROM wallet_ledger WHERE user_id=$1 ORDER BY created_at DESC, id LIMIT 20', [user.id]),
    ]);
    return { balances, recent, online_payment: enabledProviders().length > 0 };
  },
});

cap({
  name: 'wallet_ledger', method: 'GET', path: '/me/wallet/ledger', tag: TAG, summary: 'Your full wallet statement, newest first (money in is positive, money out negative; balance_after is the running balance).',
  input: z.object({ currency: currency.optional(), ...page }),
  handler: ({ user }, i) => many('SELECT id, currency, amount_cents, balance_after, kind, ref_type, ref_id, note, created_at FROM wallet_ledger WHERE user_id=$1 AND ($2::text IS NULL OR currency=$2) ORDER BY created_at DESC, id LIMIT $3 OFFSET $4', [user.id, i.currency ?? null, i.limit, i.offset]),
});

cap({
  name: 'topup_wallet', method: 'POST', path: '/me/wallet/topups', tag: TAG, status: 201,
  summary: 'Start a wallet top-up in a currency. Then pay it with create_payment (purpose_type "wallet_topup", purpose_id = this id); the money lands in your wallet once the payment is confirmed.',
  input: z.object({ currency, amount_cents: z.number().int().min(1) }),
  async handler({ user }, i) {
    needProviders();
    amountOk(i.amount_cents, i.currency);
    return one('INSERT INTO wallet_topups(user_id, currency, amount_cents) VALUES ($1,$2,$3) RETURNING *', [user.id, i.currency, i.amount_cents]);
  },
});

cap({
  name: 'apply_wallet_to_invoice', method: 'POST', path: '/invoices/:id/wallet', tag: TAG,
  summary: 'Pay an open invoice (all of it, or `amount_cents` of it) from your wallet in the invoice currency. If that covers everything the invoice is paid; otherwise the remainder is still due (online or at the venue). Not allowed while a card checkout for the invoice is in progress.',
  input: z.object({ id, amount_cents: z.number().int().min(1).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const inv = (await c.query("SELECT * FROM invoices WHERE id=$1 AND kind='invoice' FOR UPDATE", [i.id])).rows[0];
      if (!inv) throw notFound('Invoice');
      if (inv.user_id !== user.id) throw forbidden('This is not your invoice');
      if (inv.status !== 'open') throw conflict('That invoice is not open');
      const due = inv.total_cents - inv.credits_cents;
      if (due <= 0) throw conflict('Nothing left to pay');
      if ((await c.query("SELECT 1 FROM payments WHERE purpose_type='venue_invoice' AND purpose_id=$1 AND status='pending' AND provider_ref IS NOT NULL AND created_at > now() - interval '30 minutes'", [i.id])).rowCount)
        throw conflict('A card checkout for this invoice is in progress — finish it, or try again in half an hour');
      const have = await balanceOf(c, user.id, inv.currency);
      const amount = Math.min(due, have, i.amount_cents ?? due);
      if (amount <= 0) throw conflict(`Your ${inv.currency} wallet is empty`);
      const ledger = await walletDebit(c, user.id, inv.currency, amount, { kind: 'spend', refType: 'invoice', refId: inv.id, note: `Invoice ${inv.number}` });
      await c.query("INSERT INTO invoice_credits(invoice_id, user_id, source, amount_cents) VALUES ($1,$2,'wallet',$3)", [inv.id, user.id, amount]);
      await c.query('UPDATE invoices SET credits_cents = credits_cents + $2 WHERE id=$1', [inv.id, amount]);
      const paid = amount === due ? await markInvoicePaid(c, inv.id, { method: 'wallet', by: user.id }) : false;
      return { applied_cents: amount, due_cents: due - amount, paid, wallet_balance_cents: ledger.balance_after, currency: inv.currency };
    });
  },
});

cap({
  name: 'adjust_wallet', method: 'POST', path: '/admin/wallet/adjust', tag: TAG, auth: ['admin'],
  summary: 'Support tool: add or remove wallet money for a user with a written reason (audit-logged). Cannot take a balance below zero.',
  input: z.object({ user_id: id, currency, amount_cents: z.number().int().refine((n) => n !== 0, 'not zero'), note: z.string().min(3).max(200) }),
  async handler({ user }, i) {
    await mustFind('users', i.user_id, 'id');
    return tx(async (c) => {
      const row = i.amount_cents > 0
        ? await walletCredit(c, i.user_id, i.currency, i.amount_cents, { kind: 'adjustment', note: i.note })
        : await walletDebit(c, i.user_id, i.currency, -i.amount_cents, { kind: 'adjustment', note: i.note });
      await audit(c, user.id, 'adjust_wallet', 'users', i.user_id);
      return row;
    });
  },
});

// ------------------------------------------------------------------ gift cards
cap({
  name: 'buy_gift_card', method: 'POST', path: '/gift-cards', tag: TAG, status: 201,
  summary: 'Start buying a gift card (a prepaid code, in one currency, valid 12 months). Pay it with create_payment (purpose_type "gift_card"); once paid, get_gift_card shows the code to share. Whoever redeems it gets the amount in their wallet.',
  input: z.object({ currency, amount_cents: z.number().int().min(1), message: z.string().max(200).optional() }),
  async handler({ user }, i) {
    needProviders();
    amountOk(i.amount_cents, i.currency);
    return one('INSERT INTO gift_cards(currency, amount_cents, message, purchaser_id) VALUES ($1,$2,$3,$4) RETURNING id, currency, amount_cents, status, message, created_at', [i.currency, i.amount_cents, i.message ?? null, user.id]);
  },
});

const cardView = (g, code) => ({ id: g.id, currency: g.currency, amount_cents: Number(g.amount_cents), status: g.status, message: g.message, code_hint: g.code_hint, expires_at: g.expires_at, created_at: g.created_at, redeemed_at: g.redeemed_at, ...(code ? { code } : {}) });

cap({
  name: 'list_gift_cards', method: 'GET', path: '/me/gift-cards', tag: TAG, summary: 'Gift cards you bought (codes are not shown here; open one with get_gift_card).',
  handler: async ({ user }) => (await many("SELECT * FROM gift_cards WHERE purchaser_id=$1 ORDER BY created_at DESC LIMIT 100", [user.id])).map((g) => cardView(g)),
});

cap({
  name: 'get_gift_card', method: 'GET', path: '/gift-cards/:id', tag: TAG, summary: 'One of your gift cards including its code to share (the read is audit-logged). Unpaid cards have no code yet.', input: z.object({ id }),
  async handler({ user }, i) {
    const g = await one('SELECT * FROM gift_cards WHERE id=$1 AND purchaser_id=$2', [i.id, user.id]);
    if (!g) throw notFound('Gift card');
    if (g.code_enc) await audit(null, user.id, 'read_pii', 'gift_cards', g.id);
    return cardView(g, g.status === 'active' || g.status === 'redeemed' ? giftCardCode(g) : null);
  },
});

cap({
  name: 'redeem_gift_card', method: 'POST', path: '/gift-cards/redeem', tag: TAG,
  summary: 'Redeem a gift card code into your wallet (in the card\'s currency). A code works once; ten wrong guesses an hour locks you out for the rest of the hour.',
  input: z.object({ code: z.string().min(8).max(30) }),
  async handler({ user }, i) {
    const r = await tx((c) => redeemGiftCard(c, user.id, i.code));
    if (r.error) throw r.error;
    return { currency: r.card.currency, amount_cents: Number(r.card.amount_cents), wallet_balance_cents: Number(r.ledger.balance_after) };
  },
});
